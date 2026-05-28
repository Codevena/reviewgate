# Spec — Migrate the `gemini` reviewer to the Antigravity CLI (`agy`)

**Date:** 2026-05-28
**Status:** Approved (design), pending implementation plan
**Author:** brainstormed with Markus

## Problem / Motivation

Google is discontinuing the Gemini CLI. On **2026-06-18** the `gemini` CLI and the
Gemini Code Assist IDE extensions stop serving requests for Google AI Pro/Ultra
and free users (verified: developers.googleblog.com announcement, corroborated by
The Register, The New Stack, Hacker News, and GitHub discussion
google-gemini/gemini-cli#27274). Enterprise/API-key access survives, but
Reviewgate's `gemini` adapter is OAuth-first ($0 within the user's subscription),
which is exactly the access tier being cut.

The successor is the **Antigravity CLI (`agy`)**. Reviewgate must drive `agy`
before the cutoff or the `gemini` reviewer slot goes dark.

## Decisions (locked during brainstorming)

1. **In-place rebuild, provider id stays `gemini`.** The adapter
   `src/providers/gemini.ts` is rewritten to drive the `agy` binary, but the
   provider **id remains `"gemini"`**. This keeps the provider-id union, every zod
   schema, the registry, the dogfood/scaffold configs, and the ~40 test fixtures
   that use `"gemini"` as a generic provider-name string completely unchanged.
   No config migration is forced on existing users.
2. **`--dangerously-skip-permissions` without `--add-dir`** (not `--sandbox`).
   The diff is supplied inline in the prompt, so the reviewer needs no workspace
   access. Omitting `--add-dir` denies repo access entirely (no agentic file
   exploration, no edit capability); the skip flag only prevents a hang on the
   non-interactive permission prompt. `--sandbox` would be redundant since no
   tools are needed.
3. **`model` config field kept but not passed.** `agy` has no `-m`/`--model`
   flag (the model is fixed to its default Gemini). Keeping the `model` field in
   `ProviderConfig`/`ConfigSchema` avoids a breaking schema change for existing
   configs; the value becomes informational only (audit/research records), never
   a CLI argument.

## Verified facts about `agy` (v1.0.3, probed locally 2026-05-28)

- `agy -p / --print / --prompt "<text>"` — runs a single prompt non-interactively
  and **prints the response to stdout**. Confirmed: clean `PONG` and clean
  `{"verdict":"PASS","findings":[]}` on stdout, exit 0, no permission prompt for a
  tool-free task.
- **No `-m` / `--model`** flag — model selection is gone.
- **No `-o json`** flag — no `{response, stats.models}` envelope; output is the raw
  response text on stdout.
- `--dangerously-skip-permissions` — auto-approve all tool permission requests.
- `--add-dir <dir>` — add a workspace directory (repeatable). **Not used here.**
- `--sandbox` — terminal restrictions. **Not used here.**
- `--print-timeout <dur>` — Go-duration timeout for print mode (default `5m0s`).
- `--version` — prints `1.0.3` (used by preflight).
- Auth: Google OAuth (Antigravity account). No `GEMINI_API_KEY` path.

## Design

### 1. Adapter invocation — `src/providers/gemini.ts`

Add a top-of-file comment: *"Drives the Antigravity CLI (`agy`), successor to the
discontinued Gemini CLI. Provider id stays `gemini` for config compatibility."*

| Aspect | Old (gemini CLI) | New (agy) |
|---|---|---|
| binary | `gemini` | `agy` (default `binPath`) |
| args | `-p <prompt> -m <model> -o json --approval-mode plan` | `-p <prompt> --dangerously-skip-permissions --print-timeout <Ns>` |
| `--add-dir` / `--include-directories` | omitted | omitted (unchanged rationale) |
| output | parse `{response, stats.models}` envelope | `parseReviewOutput(stdoutText)` directly |
| token usage | summed from `stats.models` | `{inputTokens:0, outputTokens:0, costUsd:0, quotaUsedPct:null}` |
| auth | OAuth **or** `GEMINI_API_KEY` (apikey branch) | OAuth only — apikey branch + `GEMINI_API_KEY` env removed |

- `--print-timeout` is rendered from `cfg.timeoutMs` as a Go duration using the
  `ms` suffix directly: `` `${cfg.timeoutMs}ms` `` (Go's `time.ParseDuration`
  accepts `"300000ms"`) — avoids a manual seconds division. `spawnSafely({ timeoutMs })`
  stays the hard kill, set at or just above the print-timeout. `zeroByteWatchdogMs
  = cfg.timeoutMs` (buffered,
  non-streaming — same reasoning as today: `agy` does not stream stdout in print
  mode, so the 60s idle watchdog must be neutralised).
- `GeminiEnvelope` interface and `parse()`'s envelope logic are removed. The new
  parse path reads the stdout file and calls `parseReviewOutput` on its text.
- `review()` verdict logic (CRITICAL/WARN → FAIL else PASS) is unchanged.
- Status mapping (`timeout`/`error`/`quota-exhausted` via `isQuotaExhausted`) is
  preserved; quota heuristic still runs over stderr + stdout.

### 2. `complete()` (curator / LLM-judge path)

Simplified to mirror `review()`: spawn `agy -p <prompt> --dangerously-skip-permissions
--print-timeout <Ns>`, return the stdout text verbatim (it *is* the completion).
Drop the envelope `JSON.parse`. Keep the existing timeout/watchdog/throw-on-failure
shape. (Relevant to `reference_llm_judge_complete`: `complete()` must not force the
review schema.)

### 3. Preflight / availability / doctor / setup

- `preflight` and `src/providers/availability.ts`: probe `agy --version`.
- `src/cli/commands/doctor.ts`: check `agy`; binary name + hint text updated; add a
  one-line note that the legacy `gemini` CLI sunsets 2026-06-18.
- `src/cli/commands/setup.ts`, `src/cli/setup/prefill.ts`,
  `src/cli/setup/build-config.ts`, `src/cli/commands/init.ts`: replace `gemini`
  binary references / prefill hints with `agy`.
- **OAuth-only auth (apikey degradation guard).** The `gemini` provider is now
  OAuth-only. `ProviderConfigSchema` still *permits* `auth:"apikey"` (kept for the
  other providers), but the gemini/agy adapter no longer honors it. To avoid a
  legacy `auth:"apikey"` gemini config failing opaquely, `doctor` warns when the
  gemini provider is configured with `auth:"apikey"` (it has no effect; agy uses
  the Antigravity OAuth session). No silent OAuth fallthrough without a surfaced
  message.
- `src/sandbox/profile-builder.ts`: this is more than a binary rename. The
  `gemini` entry must update **both** maps: `CREDENTIAL_PATHS.gemini` to include the
  Antigravity session dirs (`~/.antigravity`, `~/.gemini/antigravity-cli`), and
  `NETWORK_ALLOW.gemini` to include the agy endpoints
  (`oauth2.googleapis.com`, `accounts.google.com`, `cloudcode-pa.googleapis.com`,
  `www.googleapis.com`, and the Antigravity codeassist host). **Non-blocking for
  the migration** — sandbox is `mode:"off"` by default and `"strict"`/`"permissive"`
  fail closed, so no reviewer runs under this profile today — but the profile must
  be correct for when isolation ships.

### 4. Config defaults & dogfood config

- `src/config/defaults.ts`: `providers.gemini.bin = "agy"`, `auth = "oauth"`,
  `model` neutralised (informational default, never passed). Also scrub the stale
  legacy comments (gemini CLI `v0.40.1`, model-selection errors, `gemini-3-pro-preview`
  tier limits) — they no longer describe agy.
- `reviewgate.config.ts` (this repo's dogfood config): the gemini failover entry
  stays valid; the `model` field is harmless (unused).
- `src/config/define-config.ts`: `ProviderConfig`/`ConfigSchema` keep the `model`
  field (no breaking change).

### 5. Tests (TDD; real verification per project policy)

- **Rewrite `tests/unit/gemini-adapter.test.ts`:** assert the new argv (contains
  `-p` and `--dangerously-skip-permissions`; does NOT contain `-m`, `-o`/`json`,
  `--add-dir`, `--approval-mode`), and stdout-text parsing instead of envelope
  parsing. Explicitly **remove** the obsolete
  `"remaps apiKeyEnv -> GEMINI_API_KEY only under auth=apikey"` case (the apikey
  branch is gone).
- **Update `tests/unit/availability.test.ts`:** the CLI-providers probe test
  asserts the gemini binary name — update its expectation to `agy`.
- **Rewrite fakes** `tests/fixtures/fake-gemini.sh` and
  `tests/fixtures/fake-gemini-complete.sh`: emit review JSON / completion text
  directly on stdout (no `{response,...}` envelope). `tests/unit/temp-cleanup.test.ts`
  consumes `fake-gemini.sh` — confirm it still passes after the fake changes.
- **`tests/e2e/gemini-real.test.ts`:** issue a real `agy -p` review call on a tiny
  diff; assert the result parses into findings. Skipped when `agy` is unavailable
  or unauthenticated (CI-safe), but part of the local DoD verification.
- Full `bun test` must stay green; the ~40 fixtures using `"gemini"` as a
  provider-id string are untouched.

## Non-goals / YAGNI

- No new provider id `agy`; no dual gemini-CLI + agy support. The OAuth gemini CLI
  path is being removed entirely (it dies 2026-06-18).
- No attempt to recover token-usage stats from `agy` (it exposes none) — usage is
  reported as zero, which the cost-cap logic tolerates ($0 OAuth reviewer).
- No model-selection plumbing for `agy` (the flag does not exist).

## Risks & mitigations

- **agy emits prose around the JSON.** Mitigation: `parseReviewOutput` already
  extracts JSON from reviewer text; the e2e test pins real-output parseability.
- **agy hangs on a permission prompt.** Mitigation: `--dangerously-skip-permissions`
  + no `--add-dir` (no tools to approve); buffered-watchdog tied to timeout.
- **agy not authenticated in an environment.** Mitigation: preflight/doctor surface
  it; reviewer fails closed via existing failover, not silently.
- **Concurrent agy invocations (reviewer + curator) contend on an internal lock.**
  Raised by the agy spec-review (the "knowledge.lock" claim) — **investigated and
  rejected.** Two independent `agy -p` processes launched concurrently both
  completed in ~4s with correct output and no error (a serializing lock would have
  forced the second to ~8s). The hang observed during the review was a *nested*
  `agy`-inside-`agy` subtask; the orchestrator spawns `agy` as an independent
  subprocess (never nested), so this does not apply. No mitigation needed.

## Review feedback incorporated (agy spec-review, 2026-05-28)

The spec was reviewed by `agy` against the live code + its own `--help`. Verdict
FAIL with 7 findings. After verification: 1 CRITICAL rejected as a false positive
(concurrency lock, see Risks), the rest folded in as refinements — OAuth-only
apikey-degradation doctor warning, the fuller `profile-builder.ts` credential/network
update, the `${cfg.timeoutMs}ms` Go-duration form, the `availability.test.ts` and
`temp-cleanup.test.ts` test updates, and the `defaults.ts` stale-comment scrub.

## Acceptance criteria

1. `gemini` adapter spawns `agy` with the agreed argv and parses stdout text.
2. `bunx tsc --noEmit` and `bun run lint` clean.
3. Full `bun test` green, including rewritten unit + fakes.
4. `tests/e2e/gemini-real.test.ts` passes against a real `agy` call locally
   (skips cleanly when agy is absent).
5. `reviewgate doctor` reports `agy` health and the gemini-CLI sunset note.
