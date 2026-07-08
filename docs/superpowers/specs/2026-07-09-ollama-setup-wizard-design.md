# Ollama in the Setup Wizard Design

Status: **approved for planning** (brainstorm 2026-07-09). Wire the `ollama` provider into the
interactive `reviewgate setup` wizard so a fresh user can configure it (as reviewer / critic /
curator) with a freely-chosen model and endpoint — closing the deferred-wizard gap from
[[2026-07-08-ollama-cloud-reviewer-design]].

## Problem

The `ollama` provider ships and works, but `reviewgate setup` does **not** offer it: `REVIEWER_PROVIDERS`
(setup.ts) lists only `codex/gemini/claude-code/openrouter/opencode`. A new user can enable ollama
**only** by hand-editing `reviewgate.config.ts` — which fails the "beginner-friendly, self-explanatory"
bar. Ollama is actually the *lowest-friction* reviewer for a newcomer (an API key + subscription, no
CLI to install), so its absence from the guided flow is exactly the wrong gap.

The wizard also isn't shaped for a keyless-API provider: `authFor()` only returns `"oauth"|"openrouter"`,
and the availability hint would mislabel a keyless ollama as `"CLI not found"` (it has no CLI).

## Scope & principle

Make ollama a **first-class, selectable option** in the Custom walk of `reviewgate setup`, routed
through the **existing** per-provider flow (persona → model-with-live-probe → failover), so it inherits
the wizard's polish for free. **User picks the model** (Markus's explicit requirement): the standard
`promptModelWithProbe` pre-fills `glm-5.2:cloud` (`MODEL_DEFAULT.ollama`) and the user overrides it with
any Ollama tag (`qwen3-coder:480b-cloud`, `gpt-oss:120b`, …), live-verified via `OllamaAdapter.complete()`.

House principles:
- **The wizard stores no secrets.** It references the `OLLAMA_API_KEY` env var and notes when it's
  unset — it never prompts the user to paste a key into the config (same as `OPENROUTER_API_KEY`/brain).
- **Minimal generated config.** Cloud is the default endpoint, so `baseUrl` is written ONLY when the
  user picks Local (Cloud omits it → `defaults.ts` supplies `https://ollama.com/v1`), preserving the
  wizard's diff-from-defaults minimalism.
- **Quick mode is untouched** (it's codex-only; ollama is reachable via Custom mode only).

Explicitly OUT (the "beginner-onboarding" scope Markus did NOT pick): changing `RECOMMENDED_DEFAULTS`
(ollama stays a selectable option, not the fresh-install default); a "you have no providers, use ollama"
proactive nudge; threading `baseUrl` into the critic/curator `complete()` call sites at gate-run time
(a separate documented limitation — the wizard *probe* threads baseUrl, but the running critic/curator
still target Cloud per [[2026-07-08-ollama-cloud-reviewer-design]]'s known limitation).

## Feature 1 — endpoint selection (Cloud vs Local), asked once

When ollama is first configured in ANY role during the Custom walk, a memoized prompt asks:

> Ollama endpoint: **Cloud (ollama.com)** / **Local daemon (localhost:11434)**  — default Cloud

- Result is cached in a local `ollamaBaseUrl: string | undefined` (undefined = Cloud) threaded through
  `runCustom`, so it is asked **once** even when ollama is used as reviewer AND critic AND curator
  (`baseUrl` is a single `providers.ollama` property, shared across roles).
- It is asked **before** ollama's first model probe, because the probe must hit the right endpoint.
- Cloud → `ollamaBaseUrl = undefined` (omitted from config). Local → `ollamaBaseUrl =
  "http://localhost:11434/v1"` (written to `providers.ollama.baseUrl`).

## Feature 2 — model choice + live probe (already 90% there)

ollama flows through the existing `promptModelWithProbe(provider, auth, initialModel)`:
- `initialModel` = `MODEL_DEFAULT.ollama` = `"glm-5.2:cloud"` (already wired) — user edits freely.
- `auth` = `"apikey"` (see Feature 3).
- The probe (`probe.ts`) already accepts `auth: "apikey"`; extend `ProbeInput` with an optional
  `baseUrl?: string` and pass it through to `adapter.complete()`, so a Local-endpoint probe hits the
  daemon rather than Cloud. `promptModelWithProbe` gains an optional `baseUrl?` param and forwards it
  to `probeModel` (along with `apiKeyEnv: "OLLAMA_API_KEY"` for ollama); the ollama call sites pass the
  memoized `ollamaBaseUrl`.
- Existing probe outcomes (ok / un-verifiable-skip / fail→re-enter-or-keep) apply unchanged.

## Feature 3 — provider plumbing in the wizard

`src/cli/commands/setup.ts`:
- `REVIEWER_PROVIDERS` gains `"ollama"` → it appears in the reviewer multiselect and the critic /
  curator selects (all three iterate `REVIEWER_PROVIDERS`).
- `authFor(p)` return type widens to `"oauth" | "openrouter" | "apikey"`; returns `"apikey"` for ollama.
- Availability hint: replace the `p === "openrouter" ? "no API key" : "CLI not found"` special-case with
  `SUBPROCESSLESS_PROVIDERS.has(p) ? "no API key" : "CLI not found"` (openrouter + ollama are exactly the
  API-key/HTTP providers) — so a keyless ollama reads "no API key", not "CLI not found".
- `avail(p)` passes `"OLLAMA_API_KEY"` as the apiKeyEnv for ollama (openrouter already passes its own);
  generalize the ternary to map each API-key provider to its env var.
- When ollama is used in any role and `OLLAMA_API_KEY` is unset, emit a `note(...)` mirroring the brain
  one: "ollama needs OLLAMA_API_KEY — config is written but ollama stays inert until you set it (from
  ollama.com → API Keys)."

`src/cli/setup/build-config.ts`:
- `providersFor(...)` sets `apiKeyEnv: "OLLAMA_API_KEY"` for ollama (like openrouter gets
  `OPENROUTER_API_KEY`), and writes `baseUrl` for ollama **only when Local** (a passed
  `ollamaBaseUrl`). `DEFAULT_AUTH.ollama` is already `"apikey"`.
- Plumb the selected `ollamaBaseUrl` from `runCustom` → `buildCustomConfig` → `providersFor`
  (a new optional field on `CustomAnswers`, alongside `openrouterProvider`).

`src/cli/setup/probe.ts`:
- `ProbeInput` gains `baseUrl?: string`; `probeModel` forwards it into `adapter.complete({ …, baseUrl })`
  when present. (`OllamaAdapter.complete` already reads `opts.baseUrl`.)

## Data flow (Custom walk, ollama picked)

```
reviewer multiselect (ollama shown, hint "no API key" if OLLAMA_API_KEY unset)
  → for ollama: ensureOllamaEndpoint() [memoized Cloud/Local select]
             → persona select
             → promptModelWithProbe("ollama", "apikey", "glm-5.2:cloud", baseUrl)  [user edits + live probe]
             → failover multiselect
  → (critic / curator selects may also pick ollama → reuse cached ollamaBaseUrl)
  → if OLLAMA_API_KEY unset: note(...)
  → buildCustomConfig({ …, ollamaBaseUrl })
       → providers.ollama = { enabled, auth:"apikey", apiKeyEnv:"OLLAMA_API_KEY", model:<chosen>,
                              ...(Local ? { baseUrl:"http://localhost:11434/v1" } : {}) }
```

## Testing

- **setup unit tests** (mirror the existing `setup.ts`/`build-config` test convention, injected `env`
  + stubbed prompts / adapter): ollama appears in `REVIEWER_PROVIDERS`; `authFor("ollama") === "apikey"`;
  availability hint is "no API key" for ollama when `OLLAMA_API_KEY` unset (via `SUBPROCESSLESS_PROVIDERS`);
  `buildCustomConfig` with an ollama reviewer emits `providers.ollama = { enabled, auth:"apikey",
  apiKeyEnv:"OLLAMA_API_KEY", model }` and **omits** baseUrl for Cloud / **writes**
  `http://localhost:11434/v1` for Local.
- **probe unit test:** `probeModel({ provider:"ollama", auth:"apikey", apiKeyEnv:"OLLAMA_API_KEY",
  baseUrl })` forwards `baseUrl` into `adapter.complete` (assert via a stub adapter capturing opts).
- The interactive walk itself is exercised through the existing `runCustom`/`finalizeSetup` seam the
  current wizard tests use (stubbed `@clack/prompts`), not a live TTY.

## Touch-points summary

`src/cli/commands/setup.ts` (REVIEWER_PROVIDERS, authFor, hint, avail, endpoint select, key note) ·
`src/cli/setup/build-config.ts` (providersFor apiKeyEnv+baseUrl, CustomAnswers.ollamaBaseUrl) ·
`src/cli/setup/probe.ts` (ProbeInput.baseUrl) · tests · (no schema/adapter change — those shipped in the
prior feature).
