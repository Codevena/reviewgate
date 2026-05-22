# Reviewgate — `complete()` for CLI adapters (design)

**Date:** 2026-05-22 · **Status:** design (brainstormed, approved) · **Milestone:** roadmap / judge-enablement · **Default:** no behaviour change unless a CLI provider is configured as `phases.brain.curator` (judges are already opt-in).

## Problem

The two LLM judges — the brain Curator accept/reject (M4, `orchestrator.ts:887`) and the FP↔Brain Contradiction check (M5 B3b, `orchestrator.ts:769`) — need a **free-form** model completion. They cannot use `review()`, because `review()` forces the strict review output-schema, so the model returns review-shaped JSON instead of the judge's `{accept}`/`{contradicts}` verdict (the silent no-op that `2d55d23` fixed for OpenRouter). The judges therefore call the optional `ProviderAdapter.complete()`.

Today **only `OpenRouterAdapter` implements `complete()`** (`openrouter.ts:208`). For every CLI-backed provider (`claude-code`, `gemini`, `codex`, `opencode`) `complete` is absent, so both judges hit the `typeof adapter.complete !== "function"` guard and **return their default** (`{accept:true}` / `{contradicts:false}`). Result: anyone who configures a CLI provider as `phases.brain.curator` gets a judge that never actually judges — curator accept/reject and contradiction-detection are dead unless the curator is the OpenRouter provider.

## Approach (decided)

Add a self-contained `complete()` method to each of the four CLI adapters — `claude.ts`, `gemini.ts`, `codex.ts`, `opencode.ts`. Each spawns its CLI **without** the review output-schema and returns the raw model text; the judges already extract their JSON from free-form text (first `{` … last `}`, tolerant of surrounding prose), so **no judge-side code changes are required** beyond passing the provider's auth mode (below).

Three decisions, all approved:

1. **Scope:** all four CLI adapters (so any `ProviderId` configurable as `curator.provider` can act as a judge).
2. **Auth = full parity with `review()`:** `complete()` honours the per-provider configured `auth` mode exactly as `review()` does (per-provider `oauth`/`apikey` flexibility is a core product property and must not regress).
3. **Structure = isolated `complete()` per adapter** with its own `spawnSafely` block. The DoD-hardened `review()` path is **not touched** (zero regression risk; minor, contained duplication is acceptable).

## Architecture

`complete()` follows `review()`'s spawn shape per adapter but **deliberately diverges in four ways**: (a) **no** output-schema constraint (codex drops `--output-schema`); (b) **no** `Finding[]` mapping — it returns the unwrapped model text; (c) a fresh temp CWD for every adapter (not `input.workingDir`), since a judge prompt needs no repo tree — note this means any project-local CLI trust/config that `review()` sees in `workingDir` is NOT visible to `complete()`, which is intended (judges are repo-context-free); (d) extraction returns the model's answer field or `""` — it does NOT echo a parseable-but-answer-less envelope as if it were model text (this differs from `review()`'s `env.result ?? fileText` fallback; see the table). The interface signature changes only by two backward-compatible opts fields.

### Interface change — `src/providers/adapter-base.ts`

Extend the `complete()` opts with an optional auth mode:

```
complete?(
  prompt: string,
  opts: { model: string; apiKeyEnv?: string; timeoutMs?: number; auth?: "oauth" | "apikey" | "openrouter" },
): Promise<string>;
```

Two backward-compatible opts changes: `apiKeyEnv` becomes **optional** (CLI providers in oauth mode have none), and a new optional `auth` is added. `OpenRouterAdapter.complete()` ignores `auth` (it always authenticates via `apiKeyEnv`) and defaults a missing `apiKeyEnv` to `"OPENROUTER_API_KEY"` internally (the fallback relocated from the call-site). CLI adapters use `auth` to decide key injection and treat a missing `apiKeyEnv` as "no key → use the CLI's own credential store". (The shared opts type currently used by OpenRouter — `EmbedOptions` — gains the optional `auth?` field and relaxes `apiKeyEnv` to optional; the plan keeps OpenRouter's observable behaviour byte-identical via the internal default.)

### Judge call-sites — `src/core/orchestrator.ts` (modify, 2 sites)

Both judge call-sites (`:789` contradiction, `:915` curator) currently pass:
```
{ model: curatorCfg.model ?? pcfg.model,
  apiKeyEnv: (pcfg as { apiKeyEnv?: string }).apiKeyEnv ?? "OPENROUTER_API_KEY",
  timeoutMs: brainCfg.curatorTimeoutMs }
```
Change to pass **the provider's own `apiKeyEnv` (no fallback)** plus the auth mode. Because the repo sets `exactOptionalPropertyTypes: true`, an optional `apiKeyEnv?: string` may not be assigned a `string | undefined` value directly — the key must be **conditionally omitted** when undefined (the spread pattern already used elsewhere in these judges):
```
{ model: curatorCfg.model ?? pcfg.model,
  ...((pcfg as { apiKeyEnv?: string }).apiKeyEnv
    ? { apiKeyEnv: (pcfg as { apiKeyEnv?: string }).apiKeyEnv }
    : {}),
  auth: pcfg.auth,
  timeoutMs: brainCfg.curatorTimeoutMs }
```
**The `?? "OPENROUTER_API_KEY"` fallback moves INTO `OpenRouterAdapter.complete()`** (it is the only consumer that always needs a key; it already throws if the env is unset). This is the fix for the parity hazard: `review()` injects a provider key only when `cfg.apiKeyEnv` is *actually configured*, so the judge must pass the real (possibly `undefined`) value — never the OpenRouter fallback string — or an `apikey`-mode CLI provider with no configured `apiKeyEnv` would wrongly inject `OPENROUTER_API_KEY` as `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`GEMINI_API_KEY`. With the raw value, a CLI adapter sees `apiKeyEnv === undefined` → no injection → falls back to the CLI's own auth, exactly like `review()`. `apiKeyEnv` thus becomes optional in the opts type. No other judge logic changes; the existing `try/catch → default` and the first-`{`-to-last-`}` parse are unchanged.

### Per-adapter `complete()` behaviour

**Working directory (deliberate divergence from `review()`):** a judge prompt is fully self-contained — it needs no repo tree (same rationale the reviewers rely on, getting the diff in-prompt). So **all four** `complete()` methods create a fresh `mkdtempSync` temp dir and spawn with that as `cwd` (and, for codex, `--cd <tempdir>`). This intentionally does NOT mirror `review()`'s cwd handling — `review()` uses a temp CWD only for claude, while gemini/codex/opencode pass `input.workingDir`; `complete()` has no `workingDir` input and wants none.

**Timeout:** the CLI adapters have **no** adapter-local review default (their `review()` always receives `cfg.timeoutMs` from config). The judges always pass `timeoutMs: brainCfg.curatorTimeoutMs` (Zod default `20_000`), so `opts.timeoutMs` is effectively always set; for the omitted case each `complete()` defines its own module-level fallback constant (e.g. `COMPLETE_TIMEOUT_MS = 20_000`), mirroring how `openrouter.ts` uses `EMBED_TIMEOUT_MS` — i.e. `opts.timeoutMs ?? COMPLETE_TIMEOUT_MS`. Each returns raw model text:

| Adapter | Args (review-schema OMITTED) | Output extraction | Key injection (auth=apikey only) |
|---------|------------------------------|-------------------|----------------------------------|
| **claude** | `-p <prompt> --model <model> --output-format json --disallowedTools <DISALLOWED> --permission-mode dontAsk --no-session-persistence` | JSON envelope → `.result`; if envelope parses but `result` is absent → `""`; if JSON parse fails entirely → raw file text (an unwrapped answer) | `ANTHROPIC_API_KEY` ← `process.env[apiKeyEnv]` |
| **gemini** | `-p <prompt> -m <model> -o json --approval-mode plan` (env `GEMINI_CLI_TRUST_WORKSPACE=true`) | JSON envelope → `.response`; parse failure or missing field → `""` | `GEMINI_API_KEY` ← `process.env[apiKeyEnv]` |
| **codex** | `exec --sandbox read-only --json --output-last-message <file> --cd <tmp> --model <model> <prompt>` | contents of `<file>`; unreadable/missing → `""` | `OPENAI_API_KEY` ← `process.env[apiKeyEnv]` |
| **opencode** | `run --dangerously-skip-permissions --format default [-m <model> when ≠ "default"] <prompt>` | stdout text (empty → `""`) | none (opencode uses its own config/credential store, like its `review()`) |

`--output-schema` (codex) is the only schema-forcing flag in any `review()` and is **deliberately omitted** here. claude/gemini's `--output-format json` / `-o json` are envelope wrappers (not schema constraints); the model's review-shaped output in `review()` comes from the *prompt*, so reusing the same envelope flags for a judge prompt is correct. claude's `--disallowedTools` + `--permission-mode dontAsk` and codex's `--sandbox read-only` are retained (a judge should answer, not run tools).

**Auth (full parity):** the spawn env is always `{...process.env}` (like `review()`); the only auth-dependent step is **remapping**. For `auth === "apikey"` with a non-empty `process.env[apiKeyEnv]`, claude/gemini/codex remap that value into the provider's expected key var (`ANTHROPIC_API_KEY`/`GEMINI_API_KEY`/`OPENAI_API_KEY`) — exactly mirroring their `review()`. For `auth === "oauth"` (or any other value, or a missing `apiKeyEnv`) **no remapping** occurs and the CLI uses its own login/credential store. Note: "no remapping" does NOT scrub ambient provider-key vars already in `process.env` — it only declines to set them from `apiKeyEnv`, identical to `review()`'s semantics. opencode never remaps (its `review()` doesn't either). The OpenRouter "key + model for any reviewer" workflow is already covered by configuring that reviewer as the `openrouter` provider — which already has `complete()`.

## Error handling

Per the interface contract ("Throws on error so the caller can fall back to its default"):

- **Throw** on spawn failure, timeout/watchdog kill, or non-zero exit. The judges' `try/catch` turns this into their default verdict (`{accept:true}` / `{contradicts:false}`) — **fail-open**, by design (a judge hiccup must never lose a brain proposal or an FP pairing).
- **Empty output** (model returns empty, or the envelope has no `result`/`response`) → return `""`, **do not throw** (parity with `OpenRouterAdapter.complete()`, which returns `""` on empty `choices`). The judge finds no `{` → default. Coherent and quiet.

## Cassette interaction

`RecordingAdapter`/`ReplayAdapter` wrap `complete` via `typeof real.complete === "function"`. Once CLI adapters implement `complete()`, CLI judge calls are **automatically recorded/replayed** (previously invisible no-ops) — desirable for deterministic judge tests, and requires no extra *wiring*.

**One required type change:** `recording-adapter.ts` declares a local `CompleteFn` type (`opts: { model: string; apiKeyEnv: string; timeoutMs?: number }`) that must be widened to mirror the relaxed interface (`apiKeyEnv?: string` + optional `auth?`), or under the project's strict / `exactOptionalPropertyTypes` settings the wrapper callback is no longer assignable to the adapter contract. This is a one-line type edit, not a behavioural change. (`ReplayAdapter.complete` takes only `prompt`, so it is unaffected.)

**Specified behaviour for pre-existing cassettes** (verified against `ReplayAdapter`, which only assigns `this.complete` when the cassette holds ≥1 `complete` entry, and pops FIFO per provider key):
- A cassette recorded *before* this change has **no** `complete` entries for CLI providers → `ReplayAdapter.complete` stays **undefined** → the judge hits `typeof adapter.complete !== "function"` and returns its default. This is **identical to the pre-feature behaviour** (the judges no-op'd anyway) → **no regression**, no action needed.
- A cassette with *some but too few* `complete` entries → `pop()` throws on exhaustion → the judge's `try/catch` turns it into its fail-open default (after a console error). Acceptable and consistent with the error semantics above.
- **New** recordings made after this change capture CLI `complete` entries normally → deterministic CLI-judge replay works. No schema or store change is required.

## Testing

Existing pattern: `binPath` constructor option + fake `.sh` fixtures in `tests/fixtures/`, per-adapter unit tests.

Per adapter (`tests/unit/<provider>-adapter.test.ts`, extend):

1. **Happy path** — fake CLI emits a judge-style payload (`{"contradicts":true,...}` / `{"accept":false,...}`) in its envelope/last-message/stdout → `complete()` returns raw text containing that JSON.
2. **Schema-drop (codex)** — fake codex asserts **no** `--output-schema` arg is present (e.g. exits non-zero or writes a marker if it sees one) → guarantees `complete()` never forces the review schema.
3. **Auth remapping (claude/gemini/codex)** — the fake CLI echoes the target key var (`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`GEMINI_API_KEY`) so the test reads what arrived. To avoid flakiness from ambient keys, the test first **deletes** the target var from the env, then sets a sentinel under a test-only `apiKeyEnv` (e.g. `RG_TEST_KEY=sentinel`). Assert: `auth:"apikey"` → target var === `sentinel` (remapped); `auth:"oauth"` → target var is unset (no remapping). The test must restore/clean env vars it touched.
4. **Error → throw** — fake CLI exits non-zero → `expect(complete()).rejects`.
5. **Empty → ""** — fake CLI emits an empty/`result`-less envelope → `complete()` resolves to `""` (no throw).

OpenRouter regression (`tests/unit/openrouter-adapter.test.ts`, extend): `complete()` called with `apiKeyEnv` omitted still authenticates via `OPENROUTER_API_KEY` (the relocated internal default) → observable behaviour byte-identical to today.

Integration (1): drive the Contradiction judge (or Curator) through a faked CLI adapter end-to-end → proves the judge now **fires** instead of no-op'ing (the feature's actual goal), mirroring the existing B3b stub-judge integration tests.

New/extended fixtures: `fake-claude-complete.sh`, `fake-gemini-complete.sh`, `fake-codex-complete.sh`, `fake-opencode-complete.sh` (or a "no-schema → judge output" branch added to the existing fakes).

## Non-goals

- No change to the `review()` path or its DoD-hardened output mapping.
- No new `complete()` features beyond what the two judges need (no streaming, no token accounting — `complete()` returns text only, like OpenRouter's).
- No support for `auth:"openrouter"` on a CLI adapter (nonsensical: a CLI tool can't route through OpenRouter; configure the `openrouter` provider for that). Behaviour matches `review()`: the `apikey` branch simply doesn't fire, falling back to the CLI's own auth.
- No per-`provider:persona` judge selection; the curator is a single configured provider, unchanged.
