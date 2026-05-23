# Reviewgate `setup` Wizard — Design

**Date:** 2026-05-23
**Status:** Draft (brainstorm complete; pending Codex design-review)
**Author:** brainstormed with Claude, decisions by Markus

## 1. What & why

New users configure Reviewgate by hand-editing `reviewgate.config.ts`. That is the
onboarding cliff. This feature adds **`reviewgate setup`** — an interactive, polished
TUI wizard that walks a user through reviewer/critic/brain/fp-ledger/contextDocs
choices, **probes which providers are actually usable** (CLI present, key set, model
reachable), and writes a clean `reviewgate.config.ts` (or a global default) for them.

The wizard is the "onboarding gamechanger": a newcomer runs one command, answers a few
prompts (or accepts a recommended preset), and ends with a validated, doctor-green
config without ever reading the schema.

### Goals
- A single interactive command that produces a valid config the gate can run.
- Only offer/encourage providers whose CLI/key/model actually work — surface the rest
  honestly rather than letting the user footgun silently.
- Re-runnable anytime to reconfigure; safe over an existing config.
- Support both a per-project config and a per-user **global default**.
- Output is a plain `export default {}` object (never a `defineConfig` import), minimal
  (only non-default keys), lightly commented.

### Non-goals (Phase 1)
- No editing of `loop` (cost/iteration caps), `sandbox`, `audit`, `notify`, or
  `docReview` from the wizard — those stay hand-edited (advanced). The wizard covers
  reviewers · critic · brain+curator · fpLedger · contextDocs only.
- No non-interactive/scripted `setup` (other than `--global`, `--print`); `init` remains
  the scriptable path.
- No migration/round-trip that preserves a user's hand-written comments (the `.bak`
  backup is the safety net; the wizard regenerates the file).

## 2. Decisions (resolved in brainstorm)

| # | Decision | Choice |
|---|---|---|
| 1 | Command structure | **Separate `reviewgate setup`**; `init` prints a TTY-only tip pointing to it. `init` behavior otherwise unchanged. |
| 2 | Scope | **Project + global now.** Phase 1 adds the global-config precedence layer to the loader (`defaults ← global ← project`). |
| 3 | TUI library | **`@clack/prompts`**, with a compiled-binary bundling spike as the FIRST task; fall back to `@inquirer/prompts` only if it can't bundle. |
| 4 | Flow shape | **Two-track: Quick (recommended preset) + Custom (full walk).** |
| 5 | Output | **Minimal diff + per-block comments**, plain `export default {}`; back up an existing file to `*.bak` before overwriting. |
| 6 | Model input | **Free-text, pre-filled with the provider default**, plus a **live `adapter.complete()` probe** (default-on, one skip gate) that confirms the model works under the chosen auth; on failure → re-enter or keep. |
| 7 | Unavailable providers | **Show all, annotate** (`(codex CLI not found)` / `(no API key)`), allow selection with a warning; the final `doctor` run flags it. |

Personas offered for reviewers: `security`, `architecture`, `adversarial` (the `plan`
persona is docReview-only and not offered here).

## 3. Command surface

- `reviewgate setup` — citty command in `src/cli/index.ts` → `runSetup({ repoRoot, ... })`.
- Flags:
  - `--global` — skip the target prompt; write the global config.
  - `--print` — dry-run: render the generated config to stdout, write nothing (also
    useful for tests/inspection).
- `init` change: after a successful install, **iff `process.stdout.isTTY`**, print
  `Tip: run \`reviewgate setup\` to configure reviewers, brain & critic interactively.`
  No auto-launch; CI/non-TTY output is byte-for-byte unchanged.

## 4. Flow

```
intro("reviewgate setup")
├─ Target?            › This project (./reviewgate.config.ts)
│                       My global default (<config>/reviewgate/reviewgate.config.ts)
│                      (skipped when --global)
├─ Mode?              › Quick (recommended preset)   |   Custom
│
│  ── Quick ──────────────────────────────────────────────
│     Apply the availability-gated preset (§5). No further prompts.
│
│  ── Custom ─────────────────────────────────────────────
│     Reviewers   multiselect (all providers, availability-annotated)
│        per reviewer:
│          persona   select [security | architecture | adversarial]
│          model     text (pre-filled default) → live probe (§6)
│          auth/key  only when relevant (openrouter → apiKeyEnv name; codex/gemini/
│                    claude-code default oauth; apikey → key env name)
│     Critic?     confirm (default off) → provider select
│     Brain?      confirm (default on iff OPENROUTER_API_KEY set) → curator provider
│     FP-ledger?  confirm (default on)
│     contextDocs? confirm (default off) → note about CONTEXT7_API_KEY (keyless ok)
│
├─ build partial config in memory → defineConfig() VALIDATE (§7)
├─ back up existing file → write minimal `export default {}` (§7)
├─ run doctor → print green/warn/fail summary (§8)
└─ outro (path written + next step)
```

## 5. Quick preset (availability-gated)

Mirrors today's `init` scaffold but never enables a feature whose dependency is missing:

- **codex `security`** reviewer — always (codex is the always-available default). Quick
  stays **codex-only** for true one-confirm simplicity; extra reviewers are a Custom
  concern (the simpler the Quick path, the better the onboarding).
- `fpLedger`: **on**.
- `brain` + codex `fp-filter` curator: **on only if `OPENROUTER_API_KEY` is set**
  (brain embeddings require it); otherwise off, with a printed note explaining why.
- `critic`: off.

So Quick = **codex security reviewer + fpLedger + (brain iff OPENROUTER_API_KEY)**, one
confirm, then write + doctor.

## 6. Live model probe

After a model is entered for a reviewer/critic/curator, and unless the user declined the
single `Verify models? (Y/n)` gate:

1. Build the provider adapter and call `adapter.complete("ok", { model, auth, apiKeyEnv,
   timeoutMs })` with a short timeout (e.g. 15s).
2. **Non-empty string returned** → `✓ model responds`.
3. **Throws / times out** → `✗ <reason>`; prompt `re-enter model / keep anyway / skip`.
4. The probe is bounded and best-effort: a network/quota failure is a warning, never a
   hard block. Declining the gate skips all probes (offline use).

This is the only validator that is truthful across auth modes — codex passes `--model`
even under OAuth (`codex.ts:91`), so whether a given slug is *granted* to the
subscription is only knowable empirically. The probe reuses the existing
`ProviderAdapter.complete()` implemented by all five adapters (no new provider code).

**Probe guard:** `complete?` is declared *optional* on `ProviderAdapter`
(`adapter-base.ts`), so the probe MUST not assume it exists — it guards
`typeof adapter.complete === "function"` and, if absent, skips with
`⚠ cannot verify (provider has no completion API)` rather than throwing. The probe is
strictly best-effort and never blocks the wizard. (Probe call shape:
`adapter.complete(prompt, opts)` where `prompt` is a trivial string like
`"Reply with OK."` and `opts: CompleteOptions = { model, auth, apiKeyEnv?, timeoutMs }`.)
A probe failure for an openrouter reviewer with no key is just the §7.1 missing-key case
surfaced early.

**Model defaults are not the spec's concern:** the pre-filled value is whatever
`defaults.ts` declares for that provider (e.g. codex `gpt-5.4`, openrouter
`deepseek/deepseek-v4-pro`). The spec does not assert any slug's validity — the live
probe is the source of truth, and the user can edit the pre-fill.

## 7. Output & safety

- **Validate before writing:** assemble the chosen settings into a partial object, run it
  through `defineConfig()` (the same path the loader uses). A serialization/normalization
  bug therefore fails loudly in-process and **never writes a broken file**.
- **Minimal diff:** `diffFromDefaults(chosen)` (pure) computes the minimal `DeepPartial`
  that differs from `defaultConfig`. It operates on two **fully-resolved** configs — the
  chosen config *after* `defineConfig` validation and `defaultConfig` — so there is no
  "explicit-null vs absent" ambiguity to lose: it compares concrete values and decides
  what to emit. Explicit nullable-field rules (the round-trip test pins each):
  - A nullable feature left at its default (`critic`/`brain`/`triage` = `null`,
    `contextDocs`/`weeklyReport` = `null`) → **key omitted entirely** (never emit a
    redundant `critic: null`).
  - A default-**on** feature being disabled (e.g. `fpLedger` default `{enabled:true}` →
    user turns it off) → emit `fpLedger: { enabled: false }` (the difference is real).
  - A feature being enabled → emit only its non-default sub-keys.
  - **Scalars** (boolean/number/string) → emitted only when they differ from the default
    (so e.g. a feature the wizard never touches stays omitted; a toggled boolean is
    emitted). `diffFromDefaults` does NOT deep-merge arrays — it compares them whole and
    re-emits the whole array on any difference (matching the §9 replace semantics, never
    an element-wise merge).
  - Equality is structural against `defaultConfig`; objects recurse, arrays compare whole
    (a single differing reviewer re-emits the whole `reviewers` array).
- **Serialize:** `serializeConfig(partial)` (pure) renders a plain
  `export default { ... };` string with a one-line comment per top-level block
  (`// Reviewers`, `// Brain (repo memory)`, …). No `defineConfig` import — ever. Comments
  are decorative; the round-trip test (`loadConfig` re-parse) ignores them.
- **Backup:** if the target file exists, copy it to `<file>.bak` before overwrite (same
  for the global file under `--global`). A pre-existing `.bak` is overwritten (git is the
  real history). `--print` writes nothing and creates no `.bak`. A backup-copy failure
  aborts the write (never clobber without a backup).
- **Re-run pre-fill:** prompt defaults are seeded from the current **effective** config via
  `loadEffectiveConfig` (§9) — i.e. `defaultConfig` when no file exists yet (NOT the
  `init` starter, which only exists once written to disk). Reconfiguring an existing repo
  shows the user's current values.

### 7.1 Environment variables & secrets

The wizard **never writes secrets into the config file** — the config stores only the
*name* of the env var (`apiKeyEnv`), never the key value. Two features depend on env
vars; the wizard detects presence and guides rather than capturing the secret:

- **`OPENROUTER_API_KEY`** (brain embeddings + openrouter reviewer/curator). Detected via
  the availability resolver.
  - **Quick:** brain is enabled *only if* the key is present; otherwise brain is left off
    and the wizard prints why (`brain needs OPENROUTER_API_KEY — set it and re-run setup`).
  - **Custom:** if the user selects brain (or an openrouter provider) and the key is
    **absent**, the wizard warns and offers `proceed anyway (config written; set the key
    later)` or `skip this feature`. It does not block. Bun auto-loads `.env`, so the hint
    points there: `add OPENROUTER_API_KEY=… to your .env or shell env`.
- **`CONTEXT7_API_KEY`** (contextDocs). Keyless access works (lower rate limit), so when
  contextDocs is enabled the wizard prints an informational note (`works keyless; set
  CONTEXT7_API_KEY for higher limits`) and never blocks.

After writing, the final `doctor` run (§8) re-checks the keys it *already* knows about:
`OPENROUTER_API_KEY` (via `reviewersEnabledCheck`/`brainEmbeddingsCheck`/`curatorCheck`/
the explicit `OPENROUTER_API_KEY` check). **Note:** `doctor` has **no** contextDocs /
`CONTEXT7_API_KEY` check today (it isn't surfaced there), and contextDocs works keyless
anyway — so the contextDocs key note is printed by the **wizard itself**, not deferred to
doctor. (Adding a contextDocs line to `doctor` is a possible small follow-up, out of
scope here.) The OpenRouter gaps remain a single consistent place the user sees them.

## 8. Doctor integration

- The wizard reuses doctor's provider-availability logic. Extract `PROVIDER_BIN` + the
  resolver out of `doctor.ts` into a shared `src/providers/availability.ts`. To be truly
  testable it takes its dependencies as parameters —
  `available(id, apiKeyEnv, { env, probeBin })` — rather than closing over `process.env`
  directly (the current `doctor.ts:200` closure does close over it). It must cover all
  five provider ids (`codex`/`gemini`/`claude-code`/`opencode`/`openrouter`) — noting that
  the four CLI providers resolve via a binary probe (`PROVIDER_BIN`) while **openrouter has
  no binary** (`PROVIDER_BIN.openrouter = null`, `doctor.ts:198`) and resolves purely by
  the presence of its configured key env var. `doctor.ts`
  is re-pointed at it (pure refactor; existing doctor tests pass with `process.env`
  injected as the default).
- Availability annotations in the reviewer multiselect come from this resolver.
- At the end, `setup` calls `runDoctor` (capture mode) and prints the summary so the user
  immediately sees green/warn/fail (e.g. "gemini reviewer selected but gemini CLI not
  found").

## 9. Global precedence layer (loader change)

The one change that ripples beyond the new command.

- New `resolveGlobalConfigPath(env, home)` → `string | null`:
  `(${XDG_CONFIG_HOME} || ${home}/.config)/reviewgate/reviewgate.config.ts`, resolved from
  env/home **independent of `cwd`** so the compiled `gate` binary finds it in any repo.
  **Returns `null`** when neither `XDG_CONFIG_HOME` is set nor `home` is a usable absolute
  path (empty string / unset `HOME` in minimal containers). A `null` global path means:
  the loader simply has no global layer; the wizard's target prompt hides/disables the
  global option; `setup --global` exits with a clear error ("no resolvable global config
  dir — set XDG_CONFIG_HOME or HOME").
- New `loadEffectiveConfig({ cwd, env, home })`:
  1. Read the **raw default-export partial** from the global file (if its path is non-null
     and present) and the project file (if present) — NOT each run through `defineConfig`
     standalone.
  2. `deepMerge(globalPartial, projectPartial)` (project wins).
  3. A single `defineConfig(merged)` validates → **defaults ← global ← project**.
- **Array semantics are intentional, not a bug:** `deepMerge` (`define-config.ts:142`)
  **replaces** arrays wholesale (it only recurses into non-array objects). So a project's
  `phases.review.reviewers` fully *replaces* the global reviewers — it does not append. A
  project that wants "global reviewers plus mine" must relist them. This is the desired
  behavior (a project should be able to fully override the panel); the spec calls it out
  so it isn't mistaken for accidental concatenation.
- `loadConfig(path)` is kept as the low-level single-file primitive (direct loads + tests).
- Switch the live entry points to `loadEffectiveConfig`: the **gate** path (which today
  has its OWN inline `loadEffectiveConfig` at `gate.ts:33-44` doing project-or-defaults —
  that inline function is **replaced** by the shared one, gaining the global layer),
  **doctor** (today `loadConfig(cfgExists ? cfgPath : null)` at `doctor.ts:187`), and
  **setup**. With no global file present, the result is **byte-identical to today**
  (regression test asserts this).
- **Preserve gate.ts's graceful-fallback semantics:** the current inline function
  `try/catch`es a failed project-config load and falls back to defaults so "the gate
  remains functional" (`gate.ts:37-42`). The shared `loadEffectiveConfig` MUST keep this:
  a global or project file that fails to load/parse is caught and that layer is dropped
  (fall back to the lower layers), never thrown out of the gate path. So "byte-identical
  to today" includes the **error path** (a broken project config still degrades to
  defaults), not just the happy path — the regression test covers a malformed file too.

## 10. Module decomposition

| Module | Responsibility | Pure? |
|---|---|---|
| `src/cli/commands/setup.ts` | `runSetup` — orchestrates @clack prompts, calls the pieces | no (TTY) |
| `src/cli/setup/build-config.ts` | answers → in-memory config partial; the Quick-preset builder | ✅ |
| `src/cli/setup/probe.ts` | live model probe (wraps `adapter.complete`) | injectable |
| `src/config/serialize.ts` | partial → plain `export default {}` TS string + block comments | ✅ |
| `src/config/diff-defaults.ts` | minimal diff of chosen vs `defaultConfig` | ✅ |
| `src/config/global.ts` | `resolveGlobalConfigPath` + `loadEffectiveConfig` | path-pure + IO |
| `src/providers/availability.ts` | extracted `PROVIDER_BIN` + `available(id, keyEnv)` resolver | injectable |

The @clack/TTY layer (`setup.ts`) is intentionally thin; everything else is pure or
injectable and unit-tested without a TTY.

## 11. Error handling

- Aborted prompt (Ctrl-C / clack `isCancel`) → print `setup cancelled, no changes
  written`, exit non-zero, write nothing.
- `defineConfig()` validation failure on the assembled config → print the zod error,
  write nothing, exit non-zero (this should be unreachable if the wizard constrains
  inputs; it's the last-line guard).
- Model probe failure → warning + re-enter/keep/skip (never aborts the wizard).
- Provider without `complete()` → probe prints `⚠ cannot verify` and continues (§6 guard).
- `resolveGlobalConfigPath` returns `null` (no XDG/HOME) → global target hidden; `--global`
  exits with a clear error; project target unaffected.
- Missing `OPENROUTER_API_KEY`/`CONTEXT7_API_KEY` for a selected feature → warn + proceed
  or skip (§7.1); never silently writes a feature that can't run without telling the user.
- Global dir not writable → surface the error, offer to fall back to project target.
- Backup-copy failure → abort the write (don't clobber without a backup).

## 12. Testing & verification strategy

- **Pure modules** (`serialize`, `diff-defaults`, `build-config` incl. the Quick preset,
  `resolveGlobalConfigPath`, `loadEffectiveConfig`, `availability`): full `bun test` unit
  coverage. Notably:
  - serialize → `loadConfig` round-trip, including each nullable-field rule (§7): omitted
    default-null fields, an explicit `fpLedger:{enabled:false}` disable, a whole-array
    reviewer re-emit;
  - layered loader: no global file → byte-identical to today; global+project merge with
    project winning and the reviewers array *replacing* (not appending);
  - `resolveGlobalConfigPath`: XDG set, HOME-only, and the **null case** (neither set);
  - `availability` with an injected `env` map (no reliance on real `process.env`), all
    five provider ids;
  - Quick preset gating: brain on/off across `OPENROUTER_API_KEY` present/absent.
- **Probe**: unit-tested with a stub adapter — success / throw / timeout / **adapter
  without a `complete` method** (the §6 guard).
- **TTY layer**: can't be unit-tested cleanly — covered by the compiled-binary run.
- **Compiled-binary spike (Task 1, MANDATORY):** add `@clack/prompts`, `bun run build`,
  run `dist/reviewgate setup` from the **compiled binary**, confirm prompts render and a
  config writes (cf. the M3 wasm regression — `bun test` would NOT catch a bundle drop).
  If clack can't bundle, switch to `@inquirer/prompts` before building the rest.
- **End-to-end manual pass** on the binary: Quick path → writes config → doctor green;
  Custom path with a bad model → probe flags it; `--global` → writes to the resolved
  global path → a gate run in another repo picks it up.

## 13. Build sequence (outline for the plan)

1. **Bundling spike** — `@clack/prompts` into the compiled binary (gate decision).
2. `src/providers/availability.ts` — extract from doctor; re-point doctor; tests stay green.
3. `src/config/diff-defaults.ts` + `src/config/serialize.ts` (+ round-trip test).
4. `src/config/global.ts` — `resolveGlobalConfigPath` + `loadEffectiveConfig`; switch gate
   /doctor entry points; no-global regression test.
5. `src/cli/setup/build-config.ts` — answers→config + Quick preset (availability-gated).
6. `src/cli/setup/probe.ts` — live model probe.
7. `src/cli/commands/setup.ts` — the @clack flow tying it together; register in
   `cli/index.ts`; `init` TTY tip.
8. Compiled-binary e2e + doctor-green confirmation.

## 14. Open questions for Codex review

- Quick is codex-only (§5). Sanity-check: is one-confirm-codex too minimal, or right for
  onboarding? (Custom covers breadth.)
- Should `--global` config also be reachable for `stats`/`report`/`review-plan`, or only
  the gate/doctor/setup paths in Phase 1? (Leaning: switch all config-reading entry points
  to `loadEffectiveConfig` for consistency.)
- Backup naming when both a project AND a `.bak` already exist (overwrite `.bak` vs
  timestamped). Leaning: single `.bak`, overwrite (git is the real history).
