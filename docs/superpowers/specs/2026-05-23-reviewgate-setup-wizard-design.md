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

## 7. Output & safety

- **Validate before writing:** assemble the chosen settings into a partial object, run it
  through `defineConfig()` (the same path the loader uses). A serialization/normalization
  bug therefore fails loudly in-process and **never writes a broken file**.
- **Minimal diff:** `diffFromDefaults(chosen)` (pure) computes the minimal `DeepPartial`
  that differs from `defaultConfig`. Only those keys are serialized.
- **Serialize:** `serializeConfig(partial)` (pure) renders a plain
  `export default { ... };` string with a one-line comment per top-level block
  (`// Reviewers`, `// Brain (repo memory)`, …). No `defineConfig` import — ever.
- **Backup:** if the target file exists, copy it to `<file>.bak` before overwrite.
- **Re-run pre-fill:** prompt defaults are seeded from the current effective config via
  `loadEffectiveConfig` (§9), so reconfiguring shows the user's current values.

## 8. Doctor integration

- The wizard reuses doctor's provider-availability logic. Extract `PROVIDER_BIN` + the
  `available(id, apiKeyEnv)` resolver out of `doctor.ts` into a shared, injectable
  `src/providers/availability.ts`; `doctor.ts` and `setup` both import it (pure refactor,
  no behavior change — covered by existing doctor tests).
- Availability annotations in the reviewer multiselect come from this resolver.
- At the end, `setup` calls `runDoctor` (capture mode) and prints the summary so the user
  immediately sees green/warn/fail (e.g. "gemini reviewer selected but gemini CLI not
  found").

## 9. Global precedence layer (loader change)

The one change that ripples beyond the new command.

- New `resolveGlobalConfigPath(env, home)`:
  `(${XDG_CONFIG_HOME} || ${home}/.config)/reviewgate/reviewgate.config.ts`. Resolved from
  env/home, **independent of `cwd`**, so the compiled `gate` binary finds it in any repo.
- New `loadEffectiveConfig({ cwd, env, home })`:
  1. Read the **raw default-export partial** from the global file (if present) and the
     project file (if present) — NOT each run through `defineConfig` standalone.
  2. `deepMerge(globalPartial, projectPartial)` (project wins; arrays **replace**, per the
     existing `deepMerge` semantics).
  3. A single `defineConfig(merged)` validates → **defaults ← global ← project**.
- `loadConfig(path)` is kept as the low-level single-file primitive (direct loads + tests).
- Switch the live entry points to `loadEffectiveConfig`: the **gate** path, **doctor**,
  and **setup**. With no global file present, the result is **byte-identical to today**
  (regression test asserts this).

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
- Global dir not writable → surface the error, offer to fall back to project target.
- Backup-copy failure → abort the write (don't clobber without a backup).

## 12. Testing & verification strategy

- **Pure modules** (`serialize`, `diff-defaults`, `build-config` incl. the Quick preset,
  `resolveGlobalConfigPath`, `loadEffectiveConfig`, `availability`): full `bun test` unit
  coverage. Notably: serialize output re-parses through `loadConfig` round-trip; layered
  loader with/without a global file; preset gating on `OPENROUTER_API_KEY` presence.
- **Probe**: unit-tested with a stub adapter (success / throw / timeout paths).
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
