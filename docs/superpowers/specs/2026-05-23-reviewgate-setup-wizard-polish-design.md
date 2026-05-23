# Reviewgate `setup` Wizard — Polish Batch — Design

**Date:** 2026-05-23
**Status:** Draft (brainstorm complete)
**Author:** brainstormed with Claude, decisions by Markus
**Builds on:** `2026-05-23-reviewgate-setup-wizard-design.md` (the wizard, shipped on master)

## 1. What & why

Three deferred follow-ups from the `reviewgate setup` wizard, batched into one spec/plan:

1. **Re-run pre-fill** — when a config already exists, seed the Custom walk from the current
   effective config (spec §7 of the wizard design) so re-running is "edit my current setup",
   not "start over".
2. **Critic & curator model prompt + probe** — the wizard live-probes reviewer models but not
   the critic/curator (Opus final-review finding). Give judges the same model prompt + probe +
   re-enter/keep loop.
3. **`doctor` contextDocs line** — `doctor` has no contextDocs/`CONTEXT7_API_KEY` surface today;
   add one (keyless works, so it's informational).

### Non-goals
- No change to the wizard's overall flow (target → mode → Quick/Custom), the Quick preset, the
  global-precedence loader, or serialization. This is additive polish only.
- No new config schema fields (the schema already supports `phases.review.reviewers[].model`,
  `phases.critic.model`, `phases.brain.curator.model`, and `phases.contextDocs`).

## 2. Decisions (resolved in brainstorm)

| # | Decision | Choice |
|---|---|---|
| 1 | Pre-fill scope | **Full** — reviewers (provider preselect + persona + model) + critic + brain/curator + fpLedger + contextDocs, from the current **effective** config. |
| 2 | Fresh vs existing | Pre-fill from config **only when a config file exists** (project OR global); with no file, keep today's *recommended* defaults (so fresh onboarding is unchanged — notably fpLedger stays recommended-ON). |
| 3 | Judge model verification | **Full** — reuse `promptModelWithProbe` for critic & curator; store the model in `phases.critic.model` / `phases.brain.curator.model`. |
| 4 | doctor contextDocs | An **ok** (informational) line when contextDocs is enabled, noting `CONTEXT7_API_KEY` set/unset (keyless ok). |

## 3. Re-run pre-fill

**Load point:** at the start of `runSetup`, before the target prompt, compute the current
effective config: `const current = await loadEffectiveConfig({ cwd: repoRoot, env, home })`. (This
is the import that was removed as unused when pre-fill was deferred — it returns back.)

**Existing-config detection:** `existsSync(<repoRoot>/reviewgate.config.ts)` OR
(`resolveGlobalConfigPath(env,home)` non-null AND `existsSync` of it). If neither exists → use
recommended defaults (below); else derive defaults from `current`.

**New pure helper** `answersFromConfig(cfg: ReviewgateConfig): WizardDefaults` where:

```ts
interface WizardDefaults {
  reviewerProviders: ProviderId[];                 // multiselect initialValues
  perReviewer: Record<string, { persona: string; model: string }>; // by provider id
  critic: { provider: ProviderId; model: string } | null;
  brainCurator: { provider: ProviderId; model: string } | null;
  fpLedger: boolean;
  contextDocs: boolean;
}
```

Extraction rules from `cfg`:
- `reviewerProviders` = distinct `cfg.phases.review.reviewers[].provider` (dedup, preserve order).
- `perReviewer[p].persona` = the reviewer entry's persona; `.model` = the reviewer entry's `model`
  if set, else `cfg.providers[p]?.model`, else `MODEL_DEFAULT[p]`.
- `critic` = `cfg.phases.critic` ? `{ provider, model: critic.model ?? providers[provider]?.model ?? MODEL_DEFAULT[provider] }` : null.
- `brainCurator` = `cfg.phases.brain?.curator` ? same shape : null.
- `fpLedger` = `Boolean(cfg.phases.fpLedger?.enabled)`.
- `contextDocs` = `Boolean(cfg.phases.contextDocs?.enabled)`.

**Recommended defaults** (the fresh-setup branch — preserves today's behavior) as a constant
`RECOMMENDED_DEFAULTS: WizardDefaults`: reviewerProviders `["codex"]`, perReviewer codex
`{persona:"security", model: MODEL_DEFAULT.codex}`, critic null, brainCurator null, fpLedger **true**,
contextDocs false. (Brain enable still defaults to `orKey` at the prompt, independent of this.)

**`runCustom(env, orKey, defaults: WizardDefaults)`** uses `defaults` for every prompt seed:
- reviewer multiselect `initialValues: defaults.reviewerProviders`.
- per reviewer: persona `select` initial = `defaults.perReviewer[p]?.persona ?? "security"`;
  model prompt initial = `defaults.perReviewer[p]?.model ?? MODEL_DEFAULT[p]`.
- critic confirm initial = `Boolean(defaults.critic)`; if yes, provider select initial =
  `defaults.critic?.provider ?? "codex"`, then `promptModelWithProbe` seeded with the critic model.
- brain confirm initial = `defaults.brainCurator ? true : orKey`; curator provider initial =
  `defaults.brainCurator?.provider ?? "codex"`, then probe seeded with the curator model.
- fpLedger confirm initial = `defaults.fpLedger`.
- contextDocs confirm initial = `defaults.contextDocs`.

`promptModelWithProbe` gains an optional `initialModel` param (defaults to `MODEL_DEFAULT[provider]`
when omitted) so the seed flows through.

**Pre-fill source:** the *effective* merged config (global+project), per the wizard design §7. A
re-run targeting the project while a global layer set something will pre-fill with the effective
value; accepting it writes it into the project (redundant with global but harmless, and explicit).
Note: `finalizeSetup` → `diffFromDefaults` strips values equal to **defaults** but NOT values that
merely echo the **global layer** (the diff only knows defaults), so such a re-run can write
project entries that duplicate global ones. This is expected, not a regression.

**Model-precedence test honesty:** because `defaultConfig` gives every provider a `model`, the
effective config always populates `cfg.providers[p].model` — so `answersFromConfig(effectiveCfg)`
resolves models via that tier and the `MODEL_DEFAULT[p]` third tier is only reachable through the
RECOMMENDED_DEFAULTS (no-config) branch or a hand-built partial. The §8 precedence test must build
the partial it needs to exercise the intended tier (don't assert a tier the path can't reach).

## 4. Critic & curator model prompt + probe

- `CustomAnswers.critic`: `{ provider, persona, model } | null` (add `model`).
- `CustomAnswers.brain`: `{ curator: { provider, persona, model } } | null` (add `model`).
- In `runCustom`, after the critic provider `select`, call
  `promptModelWithProbe(criticProvider, authFor(criticProvider), initialCriticModel)` → model (null
  → cancel). Same for the curator.
- `buildCustomConfig` emits `phases.critic = { provider, persona, model }` and
  `phases.brain.curator = { provider, persona, model }`.
- `providersFor` is **unchanged** — it keeps pushing judge providers WITHOUT a model, so a provider
  that is both a reviewer and a judge keeps its reviewer `providers.<id>.model`; the judge's
  per-role `phases.{critic,brain.curator}.model` overrides for the judge call.
- **Orchestrator per-role model resolution — VERIFIED (Opus spec review, 2026-05-23):** the critic
  spreads `criticCfg.model` into the adapter cfg (`orchestrator.ts:620`) and the curator uses
  `curatorCfg.model ?? pcfg.model` (`orchestrator.ts:790`, `:917`). So a model stored in
  `phases.critic.model` / `phases.brain.curator.model` IS honored at run time — no silent-ignore. No
  orchestrator change needed.
- **Existing test must be MODIFIED, not just extended:** `tests/unit/setup-build-config.test.ts:39`
  asserts `cfg.phases.critic` equals exactly `{ provider, persona }` — emitting `{ provider, persona,
  model }` breaks that exact-equality. The plan must update that assertion (and any curator one).
- **Quick preset is unchanged:** `buildQuickPreset`'s curator stays `{ provider, persona }` (no
  model) — §4 only touches the Custom path. The Quick-curator test assertion stays as-is.

## 5. `doctor` contextDocs line

New pure check in `doctor.ts`, mirroring the existing `criticCheck`/`brainEmbeddingsCheck` shape:

```ts
export function contextDocsCheck(
  cfg: ReviewgateConfig,
  env: Record<string, string | undefined>,
): Check | null {
  const cd = cfg.phases.contextDocs;
  if (!cd?.enabled) return null;                 // off → nothing to show
  const keyName = cd.apiKeyEnv;                  // schema-defaulted to CONTEXT7_API_KEY; always set
  const set = Boolean(env[keyName]);
  return {
    name: "contextDocs",
    status: "ok",                                 // keyless works → never a warn
    detail: set
      ? `enabled (${keyName} set)`
      : `enabled (${keyName} unset — keyless works; set it for higher rate limits)`,
  };
}
```

Wired into `runDoctor` next to the other config-derived checks. Never affects the exit code beyond
the existing ok/warn/fail tally (it's always `ok`).

**Signature note (deliberate departure):** the other config checks take
`(cfg, available: ProviderAvailable)` because they probe a *provider*; contextDocs only needs to read
an env-var name, so this check takes `(cfg, env)` instead — `runDoctor` passes `process.env`. This is
an intentional, minimal signature, not an oversight. `cd.apiKeyEnv` is non-empty whenever
`cd.enabled` (zod `.default("CONTEXT7_API_KEY")` applied by `defineConfig`), so no `??` fallback is
needed — `cfg` here is the validated effective config.

## 6. Module touchpoints

| File | Change |
|---|---|
| `src/cli/setup/prefill.ts` (NEW) | `WizardDefaults`, `RECOMMENDED_DEFAULTS`, `answersFromConfig(cfg)` (pure) |
| `src/cli/setup/probe.ts` or `setup.ts` | `promptModelWithProbe` gains optional `initialModel` |
| `src/cli/commands/setup.ts` | load effective config + existing-detection; pass `WizardDefaults` into `runCustom`; seed every prompt; critic/curator model prompt+probe |
| `src/cli/setup/build-config.ts` | `CustomAnswers.critic/.brain.curator` gain `model`; `buildCustomConfig` emits per-role model |
| `src/cli/commands/doctor.ts` | `contextDocsCheck` + wiring |
| tests | `prefill.test.ts`, extend `setup-build-config.test.ts`, `doctor` test for contextDocsCheck |

`answersFromConfig` lives in its own `src/cli/setup/prefill.ts` (one clear responsibility: config →
prompt defaults), keeping `setup.ts` from growing further.

## 7. Error handling
- Pre-fill is best-effort: if `loadEffectiveConfig` somehow returns defaults (no/broken config), the
  existing-detection falls to RECOMMENDED_DEFAULTS — no crash, no empty multiselect.
- A pre-filled reviewer provider that is no longer available is still shown (availability-annotated,
  same as today) — pre-fill never hides it.
- Judge probe failure → same re-enter/keep loop as reviewers (already built).

## 8. Testing & verification
- **Pure unit tests:** `answersFromConfig` for (a) a brain+gemini+critic config → expected defaults,
  (b) defaults/empty → the codex-only shape, (c) per-reviewer model precedence (reviewer.model vs
  providers.model vs MODEL_DEFAULT); `RECOMMENDED_DEFAULTS` shape; `buildCustomConfig` with judge
  models lands them in `phases.critic.model`/`phases.brain.curator.model`; `contextDocsCheck`
  on/off × key set/unset.
- **Compiled-binary PTY E2E:** (1) write a config with gemini+brain, re-run `setup` → Custom →
  confirm gemini is pre-selected and brain confirm defaults to Yes; (2) a judge model probe renders
  (✓ or the re-enter prompt on a forced failure). Per the project's real-verification ethos.
- Full `bun test` + `bunx tsc --noEmit` + `bun run lint` clean.

## 9. Open questions
- None blocking. The one runtime dependency to verify during implementation is §4's orchestrator
  per-role model resolution.
