# Ollama in the Setup Wizard Design

Status: **approved for planning** (brainstorm 2026-07-09; revised after Plan-Gate r1). Wire the `ollama`
provider into the interactive `reviewgate setup` wizard so a fresh user can configure it (as reviewer /
critic / curator) with a freely-chosen model and endpoint — closing the deferred-wizard gap from
[[2026-07-08-ollama-cloud-reviewer-design]].

## Problem

The `ollama` provider ships and works, but `reviewgate setup` does **not** offer it: `REVIEWER_PROVIDERS`
(setup.ts) lists only `codex/gemini/claude-code/openrouter/opencode`. A new user can enable ollama
**only** by hand-editing `reviewgate.config.ts` — which fails the "beginner-friendly, self-explanatory"
bar. Ollama is actually the *lowest-friction* reviewer for a newcomer (an API key + subscription, no CLI
to install), so its absence from the guided flow is exactly the wrong gap. The wizard also isn't shaped
for a keyless-API provider: `authFor()` only returns `"oauth"|"openrouter"`, and the availability hint
would mislabel a keyless ollama as `"CLI not found"`.

## Scope & principle

Make ollama a **first-class, selectable option** in the Custom walk, routed through the **existing**
per-provider flow (persona → `promptModelWithProbe` → failover). **User picks the model** (Markus's
explicit requirement): `promptModelWithProbe` pre-fills `glm-5.2:cloud` (`MODEL_DEFAULT.ollama`) and the
user overrides it with any Ollama tag, live-verified via `OllamaAdapter.complete()`.

House principles:
- **No secrets stored.** Reference the `OLLAMA_API_KEY` env var and note when unset — never prompt to
  paste a key into config (same as `OPENROUTER_API_KEY`/brain).
- **Minimal generated config.** `providers.ollama.baseUrl` is written ONLY for Local; Cloud omits it
  (defaults supply `https://ollama.com/v1`).
- **Runtime-honest.** Only the **reviewer** role honors `providers.ollama.baseUrl` at gate time;
  critic/curator/grounding go through `complete()`, which targets Cloud (a documented limitation of the
  prior feature — the `complete()` call sites do NOT thread `baseUrl`). So the wizard offers the
  Cloud/Local endpoint **only for the reviewer role**, and warns when a Local reviewer is combined with
  an ollama critic/curator (see Feature 1) — no silent probe-green-but-runtime-Cloud footgun.
- **Quick mode + `RECOMMENDED_DEFAULTS` are UNTOUCHED** (ollama is a Custom-mode selectable option, not
  the fresh default).

Explicitly OUT (the "beginner-onboarding" scope Markus did NOT pick): changing the fresh-install default
to ollama; a "you have no providers, use ollama" proactive nudge; threading `baseUrl` into the
critic/curator `complete()` call sites at gate-run time (kept a documented limitation).

## Feature 1 — reviewer endpoint select (Cloud vs Local), asked once

The Cloud/Local prompt is offered **only when ollama is chosen as a reviewer** (the one role that honors
`baseUrl` at runtime). Asked **once**, the first time an ollama reviewer's model is configured, and cached:

> Ollama endpoint: **Cloud (ollama.com)** / **Local daemon (localhost:11434)**  — default Cloud

- Cached in a `runCustom`-local `ollamaBaseUrl: string | undefined` (undefined = Cloud), asked before the
  reviewer's first model probe (the probe must hit the chosen endpoint).
- Cloud → omitted from config. Local → `providers.ollama.baseUrl = "http://localhost:11434/v1"`.
- **Re-run seeding:** `WizardDefaults` gains an `ollamaEndpoint: "cloud" | "local"` derived by
  `answersFromConfig` from the existing `providers.ollama?.baseUrl` (loopback host → `"local"`), so a
  returning Local user sees Local pre-selected — preserving the wizard's prefill-seeds-everything
  invariant that model/persona/fallback already follow.
- If ollama is used **only** as critic/curator (never a reviewer), the endpoint prompt is skipped
  entirely — those roles always run Cloud, so a Local baseUrl would be meaningless.

## Feature 2 — model choice + live probe

ollama flows through the existing `promptModelWithProbe(provider, auth, initialModel, baseUrl?)`:
- `initialModel` = `MODEL_DEFAULT.ollama` = `"glm-5.2:cloud"` (already wired) — user edits freely.
- `auth = "apikey"` (Feature 3). The probe (`probe.ts`) already accepts `auth:"apikey"`; extend
  `ProbeInput` with an optional `baseUrl?` and forward it to `adapter.complete()`. `promptModelWithProbe`
  gains a `baseUrl?` param forwarded to `probeModel` (with `apiKeyEnv: "OLLAMA_API_KEY"` via `apiKeyEnvFor`).
- **Probe matches runtime:** the **reviewer** ollama probe is passed `ollamaBaseUrl` (Cloud or Local);
  the **critic/curator** ollama probe is passed `undefined` (Cloud), because those roles run Cloud at gate
  time — so a green probe reflects the real endpoint, never a Local-probe/Cloud-runtime mismatch.
- Existing probe outcomes (ok / un-verifiable-skip / fail→re-enter-or-keep) apply unchanged.

## Feature 3 — provider plumbing + honest notes

`src/cli/commands/setup.ts` (exported pure helpers so the logic is unit-tested; the thin `@clack` glue is
not — the wizard walk has no automated test today, verified: no test imports `@clack/prompts` or drives
`runCustom`, so this increment adds no wizard-walk test infra and relies on the pure helpers + data-layer
tests + a functional check):
- `REVIEWER_PROVIDERS` gains `"ollama"` → appears in the reviewer multiselect and critic/curator selects.
- `authFor(p)` widens to `"oauth" | "openrouter" | "apikey"`; returns `"apikey"` for ollama.
- `apiKeyEnvFor(p): string | undefined` (new) — openrouter → `OPENROUTER_API_KEY`, ollama →
  `OLLAMA_API_KEY`, CLIs → undefined. Used by `avail()` AND `promptModelWithProbe`.
- `availabilityHint(p, available): string | undefined` (new, pure) — `available` → undefined; else
  `apiKeyEnvFor(p) ? "no API key" : "CLI not found"` (a provider needs a key iff it HAS a key env — no
  coupling to `SUBPROCESSLESS_PROVIDERS`).
- `avail(p)` passes `apiKeyEnvFor(p)` as the apiKeyEnv (generalizing the openrouter-only special-case).
- `ollamaNotes({ usedAsJudge, endpoint, keyPresent }): string[]` (new, pure) — the endpoint-aware
  advisory lines, so the tricky conditional wording is unit-tested (`endpoint` can only be `"local"`
  when ollama is a reviewer, so a separate `usedAsReviewer` flag is unnecessary):
  - key missing → "ollama needs `OLLAMA_API_KEY` (availability is key-based — even a local daemon needs
    one set; a placeholder works for localhost). Cloud keys: ollama.com → API Keys. Config is written but
    ollama stays inert until it's set."
  - `endpoint === "local"` AND `usedAsJudge` → "The Local endpoint applies to the ollama **reviewer**; an
    ollama critic/curator runs against Ollama **Cloud** regardless (needs `OLLAMA_API_KEY`)."
  `runCustom` emits each returned line via `note(...)`.

`src/cli/setup/build-config.ts`:
- `CustomAnswers` gains `ollamaBaseUrl?: string`. `providersFor(...)` sets `apiKeyEnv:"OLLAMA_API_KEY"` for
  ollama and writes `baseUrl` **only when** `ollamaBaseUrl` is set (Local). `DEFAULT_AUTH.ollama` is
  already `"apikey"`. `providersFor` already discovers provider ids from ALL roles (reviewers + critic +
  curator), so a critic/curator-only ollama is enabled correctly.

`src/cli/setup/prefill.ts`:
- `WizardDefaults` gains `ollamaEndpoint: "cloud" | "local"`; `answersFromConfig` derives it from
  `providers.ollama?.baseUrl` (loopback → `"local"`, else `"cloud"`); `RECOMMENDED_DEFAULTS.ollamaEndpoint
  = "cloud"`.

`src/cli/setup/probe.ts`:
- `ProbeInput` gains `baseUrl?: string`; `probeModel` forwards it into `adapter.complete({ …, baseUrl })`.

## Testing

- **probe** (`setup-probe.test.ts`): ollama probe forwards `baseUrl` + `apiKeyEnv` into `adapter.complete`
  (stub adapter captures opts).
- **build-config** (`setup-build-config.test.ts`): an ollama **reviewer** → `providers.ollama =
  {enabled, auth:"apikey", apiKeyEnv:"OLLAMA_API_KEY", model}`, baseUrl omitted for Cloud (partial
  `hasOwn` false; defineConfig then inherits `https://ollama.com/v1`) / written to localhost for Local; an
  ollama **critic-only** answer still enables `providers.ollama`.
- **setup pure helpers** (`setup-wizard-ollama.test.ts`, new): `REVIEWER_PROVIDERS` includes ollama;
  `authFor`/`apiKeyEnvFor`/`availabilityHint` mappings; **`ollamaNotes`** covers the four cases
  (key-present vs missing × Cloud vs Local-with-judge).
- **prefill** (`setup-prefill.test.ts`): `answersFromConfig` derives `ollamaEndpoint:"local"` from a
  localhost baseUrl, `"cloud"` otherwise.
- **functional** (scratchpad, no commit): a simulated "ollama **reviewer**, Local, model glm-5.2:cloud"
  answer → `buildCustomConfig` → `finalizeSetup({print})` → assert the serialized ollama block → build the
  real `OllamaAdapter` from it and `review()` a planted-bug diff against the **local daemon** (no key) →
  `status:"ok"` + a finding. Proves the wizard OUTPUT is a working reviewer config.
- The interactive `runCustom` glue (clack prompts, the `ollamaBaseUrl` memoization) is **not** unit-tested
  (matching the existing wizard) — verified manually via an optional TTY run.

## Touch-points summary

`src/cli/commands/setup.ts` (REVIEWER_PROVIDERS, authFor, apiKeyEnvFor, availabilityHint, ollamaNotes,
avail, reviewer-only endpoint select + threading) · `src/cli/setup/build-config.ts` (providersFor
apiKeyEnv/baseUrl, CustomAnswers.ollamaBaseUrl) · `src/cli/setup/prefill.ts` (WizardDefaults.ollamaEndpoint
+ answersFromConfig) · `src/cli/setup/probe.ts` (ProbeInput.baseUrl) · tests. No schema/adapter change.
