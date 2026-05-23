# Reviewgate — Session Handoff (2026-05-23, session 8)

## ⭐ SESSION 8 (2026-05-23): `reviewgate setup` WIZARD — COMPLETE on `feat/setup-wizard` (NOT merged/pushed)

The headline onboarding feature shipped. Branch **`feat/setup-wizard`** (off local master
`c4fa567`); **8 commits, NOT merged to master, NOT pushed** — awaiting user decision
(finishing-a-development-branch). 650 pass / 9 skip / 0 fail; tsc + lint clean; binary rebuilt.
Working tree: only the pre-existing `M CLAUDE.md` (leave it) + untracked `.claude/` (harness
scheduling artifacts — do NOT commit).

**What shipped:** `reviewgate setup` — an interactive @clack/prompts wizard (Quick preset |
Custom walk) that gates providers on real availability, live-probes models via
`adapter.complete()`, and writes a **minimal plain-object `reviewgate.config.ts`** (project OR
global) with a `.bak` backup; runs `doctor` at the end. Plus a NEW config-precedence layer
**defaults ← global ← project** (`src/config/global.ts` `loadEffectiveConfig`, used by the gate
+ doctor; preserves the gate's graceful malformed-config fallback). `init` now prints a TTY-only
tip pointing at `setup`.

**New modules:** `src/providers/availability.ts` (injectable `isProviderAvailable`, extracted from
doctor), `src/config/diff-defaults.ts` (`diffFromDefaults` minimal structural diff),
`src/config/serialize.ts` (`serializeConfig` → plain `export default {}`, no defineConfig import),
`src/config/global.ts`, `src/cli/setup/build-config.ts` (`buildQuickPreset`/`buildCustomConfig`),
`src/cli/setup/probe.ts` (`probeModel`), `src/cli/commands/setup.ts` (flow + pure `finalizeSetup`/
`setupTip`). `define-config.ts` now exports `deepMerge`/`DeepPartial`.

**Spec** `docs/superpowers/specs/2026-05-23-reviewgate-setup-wizard-design.md` (OpenCode-reviewed —
3 rounds, mostly false positives, real findings folded in; codex was ratelimited). **Plan**
`docs/superpowers/plans/2026-05-23-reviewgate-setup-wizard.md` (8 TDD tasks, subagent-driven,
per-task spec+quality reviews + an Opus final review = **APPROVED FOR MERGE**, 0 critical/important).

**REAL compiled-binary E2E (per the ethos):** drove the Quick path via a PTY against
`dist/reviewgate setup` in a scratch repo → wrote a valid plain-object minimal config
(`phases.brain` + `fpLedger` only; codex reviewer omitted as default), OPENROUTER_API_KEY present
→ brain on with codex fp-filter curator, closing **doctor all-green**.

**Intentional decisions / deviations (don't "fix" without thought):**
- Declined features emit explicit-off (`contextDocs: null`, `fpLedger:{enabled:false}`) — REQUIRED
  so a project can OVERRIDE a global that enabled them; treating `null===undefined` as equal in the
  diff would BREAK override semantics.
- Enabling brain emits the whole resolved brain block incl. schema defaults (`maxPromptTokens` etc.)
  because `defaultConfig.phases.brain` is `null` — necessary for round-trip, harmless.

**Done post-merge (`98b158c`):** the model probe now offers **re-enter / keep-anyway** on a failed
probe (spec §6) — `promptModelWithProbe` loops; verified in the compiled binary via PTY (the
"…did not verify — what now?" select renders). Opus re-verification before this: **VERIFIED-SOLID**
(0 critical/important; tests/build/binary-E2E/round-trip/serialize-injection all checked).

**Deferred follow-ups:** (1) **re-run pre-fill** — prompts seed from `defaults.ts`, NOT the current
effective config (spec §7 wanted current-config pre-fill; fine for first-run onboarding, nice-to-have
for reconfigure). (2) critic/curator models are not live-probed (only reviewers are). (3) A contextDocs
line in `doctor` (it has none today; wizard prints the keyless note itself).

**DoD note:** codex ratelimited all session → used the OpenCode fallback; OpenCode was unreliable
(hallucinated spec findings; the final whole-diff review **stalled 20 min / killed, exit 144**). The
authoritative **codex review pass is still OWED** when codex is off ratelimit — run it over
`git diff master..feat/setup-wizard` before/after merge. See memory
[[reference-opencode-spec-review-fp]].

---

## ⭐ SESSION 7 (2026-05-22/23): CLI-adapter `complete()` (LLM judges for any provider) + follow-ups

**origin/master = `4391265`** — everything below is PUSHED & in sync (user OK).
627 pass / 9 skip / 0 fail; typecheck + lint clean; binary rebuilt. Working tree: only the
pre-existing `M CLAUDE.md` (untouched, per user — do NOT commit it; `.antigravitycli/` is now
gitignored).

> **➡️ The headline NEXT topic is a `reviewgate setup` wizard — see the "NEXT" section at the
> bottom; brainstorm it fresh in a new session.**

**What shipped this session (the whole arc):**
1. **CLI-adapter `complete()`** — the optional `ProviderAdapter.complete()` is now implemented by
   all four CLI adapters (claude/gemini/codex/opencode), so the brain **Curator** + **FP↔Brain
   Contradiction** judges work with ANY provider, not just OpenRouter (before: `typeof
   adapter.complete !== "function"` → judges silently no-op'd). New dedicated `CompleteOptions`
   type (optional `apiKeyEnv` + `auth`; doesn't weaken the embed-only `EmbedOptions`); OpenRouter's
   `?? "OPENROUTER_API_KEY"` fallback relocated INTO `OpenRouterAdapter.complete()`; cassette
   `CompleteFn` widened; both orchestrator judge call-sites forward `auth: pcfg.auth` + conditional
   `apiKeyEnv`. complete() diverges from review(): NO output-schema (codex drops `--output-schema`),
   no Finding mapping, fresh temp CWD, raw text / `""` on empty / throws on error (judge fails open
   to default). Spec `docs/superpowers/specs/2026-05-22-reviewgate-cli-complete-design.md` (Codex 5
   rounds → PASS), plan `docs/superpowers/plans/2026-05-22-reviewgate-cli-complete.md` (7 TDD tasks,
   subagent-driven, per-task spec+quality reviews).
2. **Follow-up polish** — shared `src/providers/complete-helpers.ts` `failureReason()` (timeout/
   watchdog vs exit in the error message) + each complete() rmSyncs its mkdtemp run dir (temp-dir
   hygiene at judge cadence).
3. **codex trust-dir fix** — **found by the LIVE e2e, invisible to all fake-`.sh` tests**:
   `codex exec --cd <fresh non-git temp dir>` refuses ("Not inside a trusted directory"). Fix: add
   `--skip-git-repo-check` to `codex.complete()` (review() unaffected — its `--cd` is the real
   repo). The fake fixture now requires the flag so unit tests lock it.
4. **init-scaffold defaults** — `reviewgate init` (NEW installs only; `defaultConfig` untouched →
   existing users unaffected) now ships `fpLedger:{enabled:true}` + `brain:{enabled:true}` (openrouter
   embeddings) + `curator:{provider:"codex"}` + `openrouter` enabled. `init.test.ts` loads the
   scaffold through `loadConfig()` to lock it.
5. **doctor brain/judge health checks** — `curatorCheck` + `criticCheck` + `brainEmbeddingsCheck`:
   warn (with fix hint) when a configured curator/critic provider's CLI/key is unavailable (the
   silent-no-op class) or when brain is on but OPENROUTER_API_KEY is unset (memory inert). KEY: the
   curator's adapter is ALWAYS built (consumed provider) so the check keys off CLI/key availability,
   NOT `providers.enabled`. The availability resolver reads the CONFIGURED `apiKeyEnv` (provider /
   `brain.embeddings`), not a hard-coded `OPENROUTER_API_KEY` (Codex caught the false-warning case).

6. **contextDocs `@/`-alias fix** (`7693cdf`) — **found by live observation B**: `specToPackage()`
   treated the tsconfig path alias `@/lib` as a scoped npm package and mis-resolved it on Context7.
   Reject empty-scope `@/...` (`parts[0]==="@"`). Follow-up noted: `~/` + other custom tsconfig
   path prefixes still leak; a fuller fix reads `compilerOptions.paths`.

**LIVE-e2e — ALL confirmed.** (1) CLI judge: seeded an active FP + contradicting brain memory
B-900, ran the real compiled gate (scratch w/ codex curator AND flashbuddy w/ opencode curator) →
`contradicts_brain_id:"B-900"` (no pairing). All four CLI complete() verified against REAL CLIs
(codex 4.3s post-fix, claude 5.2s, gemini 9.6s, opencode 7.9s). (2) **Live observations A/B/C done:**
**A** `reviewgate doctor` in flashbuddy → new critic/brain/curator lines all green on the real
4-panel config; **B** contextDocs → editing a zod-importing file injected current zod-v4 docs into
`research.md` (+ found the `@/`-alias bug, now fixed); **C** FP-ledger reactive demote via
Cassette-Replay → a recorded CRITICAL SQLi finding matched a seeded active FP → demoted to INFO
(`fp_ledger_match.suppressed:true`) → gate PASS instead of CLOSED (deterministic, in the binary).

**Reusable lessons (also in memory):** (a) subagent-driven dev shares the parent worktree HEAD — a
reviewer that ran `git checkout <sha>` left HEAD detached → next implementer orphaned a commit
(recovered via `git merge --ff-only`); forbid HEAD-moving git in every subagent prompt, use
`git add <explicit files>` not `-A`. (b) biome `lint/performance/noDelete` blocks `delete
process.env.X` → use `Reflect.deleteProperty(process.env,"X")` in tests. (c) codex needs
`--skip-git-repo-check` outside a git repo. (d) `spawnSafely` must settle on `"close"` (not
`"exit"`) + await WriteStream flush, else capture files truncate under load.

**Also shipped (later in the session):** (7) contextDocs reads tsconfig `compilerOptions.paths` and
excludes ALL declared path aliases (`~/`, mid-pattern `foo/*/bar`, exact) via a string-aware JSONC
stripper (`233b2a7`). (8) **`spawnSafely` output-capture fix** (`4391265`) — found while stabilising
a flaky test but a REAL product bug (reviewer output truncated under load); settles on `"close"` +
flush, clears kill-timers on `"exit"` + settle fallback (no spurious `killedByTimeout`), spawns
DETACHED and group-kills on timeout/watchdog so orphaned reviewer grandchildren can't hang the gate.
New `tests/unit/spawn.test.ts`. (Watchdog still polls every 5s → `zeroByteWatchdogMs` < 5000 floored
at ~5s; minor, untouched.)

### ➡️ NEXT — the big one: a `reviewgate setup` WIZARD (brainstorm fresh)
The headline next feature (the user calls it the gamechanger for onboarding): an interactive,
polished config wizard so new users don't hand-edit `reviewgate.config.ts`. Run it through the repo's
flow: **brainstorm → spec (Codex-reviewed) → plan → subagent-driven**. My recommended starting
position (confirm in brainstorm):
- **Separate `reviewgate setup` command** — NOT baked into `init` (init must stay fast/scriptable);
  `init` can OFFER to launch it at the end. Re-runnable anytime to reconfigure.
- **Phase 1 = project-level** (writes `reviewgate.config.ts`) — fits the existing per-repo deep-merge
  model, no loader change. **Phase 2 (optional) = global defaults** (`~/.config/reviewgate/`) needs a
  NEW config-precedence layer in the loader (global → project → defaults); bigger → defer.
- **Reuse the new doctor probes** (`curatorCheck`/`criticCheck`/`brainEmbeddingsCheck` + the
  CLI-availability resolver in `src/cli/commands/doctor.ts`) so the wizard only offers providers whose
  CLI/key is actually present, and run `doctor` at the end to confirm green.
- Steps: per-reviewer (provider → persona → model → oauth/apikey + key-env) · critic on/off ·
  brain+curator on/off (prefer a non-reviewer judge like opencode) · fpLedger · contextDocs.
- **TUI:** a polished prompts lib (e.g. `@clack/prompts`) bundled at build for the "visuell
  ansprechend" feel — VERIFY it bundles into the `bun --compile` binary (cf. the M3 wasm lesson:
  test the COMPILED binary, not just `bun test`).

### Other open items (lower priority)
- **Roadmap: native sandbox** still BLOCKED (`@anthropic-ai/sandbox-runtime` unpublished).
- contextDocs does not follow tsconfig `extends` (root tsconfig only) — minor.
- Pre-existing `M CLAUDE.md` in the working tree — leave it (user: do NOT commit). `.antigravitycli/`
  is now gitignored.

---

## SESSION 6 (2026-05-22): Weekly Reports (`reviewgate report`) — COMPLETE & MERGED (now pushed; see session-7 origin)
**master HEAD `4ce6b2b`** (15 feature commits FF-merged off `feat/weekly-reports`; branch deleted, worktree removed). **NOT pushed — origin/master still at `27bb89d` (session 5). Ask before pushing.** 581 pass / 9 skip / 0 fail; typecheck + lint clean. Binary rebuilt from master (`dist/reviewgate report --help` verified). Working tree: only the pre-existing `M CLAUDE.md` (untouched).

**What shipped:** `reviewgate report [--week <iso>] [--json]` — a per-ISO-week report (snapshot **+ week-over-week trend + highlights**), Markdown to stdout + `.reviewgate/reports/<iso>.md`; PLUS an **opt-in** `config.weeklyReport.autoSnapshot` (default off) that writes the last-complete-week report on weekly rollover, wired as the **trailing** side-effect of the loop-driver iteration path (after state/dirty-flag/gate.decision commit; own try/catch; autoSnapshot-off is a true no-op). Spec `docs/superpowers/specs/2026-05-22-reviewgate-weekly-reports-design.md` (Codex design-reviewed, **9 rounds → PASS**), plan `docs/superpowers/plans/2026-05-22-reviewgate-weekly-reports.md` (12 TDD tasks, subagent-driven). Roadmap remaining: **native sandbox** (blocked — `@anthropic-ai/sandbox-runtime` unpublished); flashbuddy live-e2e of contextDocs/FP-ledger/brain.

**New modules** (`src/stats/`): `iso-week.ts` (pure ISO-8601 UTC week math — Thursday rule, half-open `[since,until)`, W53, `lastCompleteWeek`), `weekly.ts` (pure `buildWeeklyReport` — deltas + highlights + `meta.status` complete/partial/future), `weekly-render.ts` (Markdown, ▲/▼/▬), `weekly-assemble.ts` (I/O: loads both weeks + dir-existence `hasPartitionBefore` prior-history probe → `aggregate()` ×2), `report-file.ts` (atomic writer: `renameSync` overwrite vs `linkSync`+unlink exclusive-create), `snapshot.ts` (`maybeWriteWeeklySnapshot` — `.empty`/`.failed`-cooldown sentinels, idempotent, injectable clock). **Modified:** `load.ts` (exclusive `until` + partition-scoped scan w/ −1-day midnight-crossing guard), `paths.ts` (reportsDir/weekReportPath), `define-config.ts`+`defaults.ts` (opt-in `weeklyReport`), `cli/index.ts`+`init.ts`, `core/loop-driver.ts` (trailing snapshot wiring).

**Non-obvious gotchas surfaced:** (1) `RunSummary.providers[]` (`ProviderStatSchema`) **requires `personas: []`** — seed test data with it or `RunSummarySchema.parse` silently drops the run in load.ts's catch. (2) Persisted signatures are capped at `SIGNATURE_CAP=20`/run (`buildRunSummary`) — `newSignatures` accepts this. (3) `AuditLogger.currentFilePath()` memoizes the partition path for the whole process → midnight-crossing events land in the prior day's partition → the −1-day guard in `dayDirsInRange` recovers them. (4) Brain has **no `promoted_at`** → "new brain entries" uses `created_at` (created, not promoted).

**Known limitation (documented in spec):** a CLI-rendered **partial** report for the *current* week (`reviewgate report --week <in-progress>`) is NOT later refreshed by the auto-snapshot when that week completes (the `existsSync(<iso>.md)` short-circuit treats any existing file as authoritative) — re-run `reviewgate report --week <iso>` to refresh. **Advisory cosmetic (left):** `weekly-render` deltaCell puts the minus inside the number (`▼ $-0.50` not `▼ -$0.50`) — arrow conveys direction.

**DoD:** static checks green → Codex Agent A **PASS** (0 CRIT/0 WARN) → Claude Agent A **PASS** (0 CRIT/0 WARN, 3 advisory INFO) → both gates clean. Per-task spec+quality reviews throughout (subagent-driven); core `weekly.ts` got an extra test-coverage polish round; `snapshot.ts` cooldown path got a required test added after the quality review flagged it.

---

## SESSION 5 (2026-05-22): Cassette-Replay + `reviewgate stats` — COMPLETE & MERGED & PUSHED
**origin/master = master HEAD `27bb89d`** (M6 + Cassette + Stats all on origin; `git push` done per user OK). 538 pass / 9 skip / 0 fail; typecheck + lint clean. Binary rebuilt. Working tree: only the pre-existing `M CLAUDE.md`.

**Roadmap progress this session:** M6 (session 4, pushed) · **Cassette-Replay** (this session) · **`reviewgate stats`** (this session). Remaining roadmap: **Weekly Reports (#3, builds on the stats aggregation)** · native sandbox (blocked — `@anthropic-ai/sandbox-runtime` unpublished).

### Live-e2e (#1, observation only — no code)
Controlled scratch-repo runs (codex+claude-code) confirmed **diff-scoping works at the reviewer level**: the panel no longer FPs on unchanged/out-of-diff code (a planted SQLi was anchored to the changed line; a planted unrelated `eval()` was ignored). So Phase-A's aggregator demote (the safety net) rarely fires live — and FP-ledger/Brain live-e2e are hard to provoke with well-behaved reviewers → **this motivated Cassette-Replay** (deterministic recorded reviewers). See [[project-reviewer-fp-unchanged-code]] (updated).

### Cassette-Replay (#4) — `feat/cassette-replay`, FF-merged
VCR-style record/replay at the `ProviderAdapter` seam. `RecordingAdapter`/`ReplayAdapter` (decorators), JSONL append-only store, `REVIEWGATE_CASSETTE=record|replay:<path>` env, content-keyed `embed` + FIFO `review`/`complete` (keyed by `reviewerId`, filtered by explicit `provider` field), strict-drift, `buildAdapters` builds the FULL consumed provider set (fixed a latent gate gap where brain embeddings/curator adapters only existed if also reviewers). Spec `docs/superpowers/specs/2026-05-22-reviewgate-cassette-replay-design.md` (3 Codex design rounds), plan `…/plans/2026-05-22-reviewgate-cassette-replay.md`. **Now unblocks deterministic FP-ledger/Brain/Phase-A pipeline tests.** DoD: Codex took 4 rounds (complete()-always-present broke brain feature-detection; cache short-circuit defeated record/replay; forced-persona reviewerId collapse; schema didn't validate result-vs-method) → PASS. Compiled-binary verified (0.2s replay drove a unique-marker verdict).

### `reviewgate stats` (#2) — `feat/stats`, FF-merged
Records a rich `run.complete` audit event per review (`run_summary`: verdict, source panel/cache/skipped, counts, cost, per-PROVIDER runs/findings/demoted/errors/cost/duration [representative-only attribution], demoted total, capped signatures) via a pure `buildRunSummary` + `IterationResult.summary` + LoopDriver emit. New `reviewgate stats [--since|--last|--json]` aggregates the audit log + FP-ledger/brain snapshots (`src/stats/{load,aggregate,render}`). Escalation rate from existing `escalation` events; panel-only denominators. Also: thrown reviewer adapters now captured as error runs (fail-closed intact). Spec `…/specs/2026-05-22-reviewgate-stats-design.md` (6 Codex design rounds — sparse-audit reframing, escalation-not-in-summary, provider-vs-persona attribution), plan `…/plans/2026-05-22-reviewgate-stats.md`. DoD: Codex 1 round (`--last` escalation-window >100% bug) → Codex+Claude PASS. Compiled-binary verified (rendered a seeded audit log + `--json`).
- **Known-limitation / follow-up (Claude INFO, advisory):** rendered `cost.total` includes critic cost but the per-provider lines don't, so they don't sum — add a "critic: $X" render line (needs `aggregate` to expose critic cost separately) if it bothers anyone.

### Reusable how-tos written to memory this session
[[reference-context7-http-api]], [[reference-gate-stdin-dirtyflag]]. NEW idioms worth knowing: cassettes give deterministic reviewer outputs for tests; `reviewgate stats` reads the date-partitioned `.reviewgate/audit/`.

### ➡️ NEXT SESSION
- **#3 Weekly Reports** is the natural next milestone — it builds directly on `src/stats/aggregate.ts` (same data, periodic output/cadence). Brainstorm → spec → plan → subagent-driven.
- Optional polish: the cassette audit-logger follow-up (M6) + the stats critic-cost render line.
- flashbuddy has `contextDocs` + `docReview` enabled in its (uncommitted) config; `CONTEXT7_API_KEY` in its `.env`.

---

## SESSION 4 (2026-05-22): M6 Context7 docs injection — COMPLETE & MERGED (local→pushed)
**master HEAD `9eb5767`** (+12 M6 commits, FF-merge off local master, **pushed to origin per user OK at end of session 4**). 439 pass / 9 skip / 0 fail; typecheck + lint clean. Binary rebuilt (`dist/reviewgate`).
- Executed `docs/superpowers/plans/2026-05-22-reviewgate-context7-docs.md` (executing-plans, worktree-isolated, 8 TDD tasks). Opt-in `phases.contextDocs` (default null/off): detect changed-file imports (tree-sitter, reuses symbol-graph `getLanguage`) → version (package.json + bun.lock JSONC) → fetch current docs from Context7 HTTP API (NEW SSRF-hardened `safeApiFetch`, NOT brain's safeFetch) → TTL'd per-lib cache → UNTRUSTED-labelled/fenced/budgeted section in `research.md` → every reviewer sees it. Docs-corpus identity feeds `computeBehaviorHash` PRE-CACHE (docs change invalidates cached verdict — the B2a cache-bug class). Best-effort/non-blocking (30s overall deadline + bounded DNS).
- **New files:** `src/research/safe-api-fetch.ts`, `src/research/imports.ts`, `src/cache/docs-cache.ts`, `src/research/context7.ts`. **Modified:** research-writer, sanitizer (exported `neutralizeInjectionMarkers`), behavior-hash (docs segment), define-config, orchestrator, symbol-graph (exported `getLanguage`).
- **DoD: Codex Agent A took 4 fix-rounds** (all real: maxBytes truncation→reject + content-length precheck; strict TOTAL budget incl. heading/caveat/note; byte-accurate multibyte truncation; defang textual injection markers via zero-width space; bound DNS + overall docs deadline; read-time TTL policy) → then Codex A + Claude A PASS.
- **Live-verified (real, not stubs):** MUST-VERIFY against live Context7 (key provided) — `query` param REQUIRED, version-pin `<id>@v<version>`, keyless ok ([[reference-context7-http-api]]); real e2e through the client; **COMPILED-BINARY e2e** (scratch repo gate → tree-sitter detected zod → fetched `/colinhacks/zod@v3.24.2` → research.md section) → no M3-class wasm regression. To drive the gate manually see [[reference-gate-stdin-dirtyflag]].
- **Deviation (documented):** per-lib outcomes → debug artifact `.reviewgate/cache/docs/last-run.json` (NOT the audit log — orchestrator has no logger, audit schema is hash-chained). Follow-up if wanted: thread the AuditLogger + add a `context_docs.fetch` EventType.
- **Next:** rest of M6 roadmap (cassette replay / weekly reports / `reviewgate stats` / native sandbox); flashbuddy live-e2e of the docs feature (set `CONTEXT7_API_KEY`, enable `phases.contextDocs`, edit a file importing a lib → reviewer sees current docs).

---

## Session 3 (2026-05-21) — earlier handoff (kept for context)

**Status:** M1–M4 shipped + live-tested. **M5 (FP reduction) — FULLY COMPLETE** (A diff-scoping · B0 merge-provenance · B1 FP-ledger core · B2a proactive few-shot+behavior-hash · B2b FP CLI+reject-rate · B3-core Brain↔Ledger coupling · B3b contradiction-check, all merged). Also this session: gate fail-open FIXED + doctor warning, brain-promotion root cause FIXED, 3 polish items. Remaining: live e2e (blocked only by LLM non-determinism), polish residue.
**master HEAD:** `e55f221` (local; +any handoff commit). **origin/master pushed to `f3d0038` (M5 A/B0/B1) + then B2a; B2b (7 commits incl. plan) local-only — confirm before pushing.**
**Runtime:** Bun (`export PATH="$HOME/.bun/bin:$PATH"`). 373 tests pass / 9 skip / 0 fail; typecheck + lint clean. Binary: `bun run build` → `dist/reviewgate` (rebuilt this session, `fp` CLI verified in the binary), symlinked `~/.local/bin/reviewgate`.

## ⚠️ FIRST: unpushed commits
`git rev-list origin/master..master` = **33 commits** (session 1–2 work + M5 Phase A/B0/B1), all local-only per "never push without OK". `origin/master` = `051ac18`. **Ask the user before pushing.** Working tree has a pre-existing `M CLAUDE.md` (NOT from sessions 2/3 — leave it).

## ✅ Session 3 — M5 Phase B1 (FP-ledger core) MERGED (`88efe1d`..`2af7dfc`, 10 commits)
Executed `docs/superpowers/plans/2026-05-21-reviewgate-m5-phase-b1-fp-ledger.md` (executing-plans, worktree-isolated, FF-merged). Signature-keyed FP learning + reactive demote, **opt-in via `phases.fpLedger` (default off)**.
- **New:** `src/schemas/fp-ledger.ts` (FpLedgerEntry/Index), `src/core/fp-ledger/store.ts` (flock+atomic store, candidate→active@≥3rejects/60d/≥2-distinct-providers→sticky@≥5/90d|pin, decayPass, monotonic ids), `src/core/fp-ledger/learn.ts` (learn from `reviewer_was_wrong:true` rejections, per-(signature,provider) dedup). Storage: `.reviewgate/learnings/known_fp.jsonl` (single JSON doc).
- **Modified:** `aggregator.ts` (reactive demote-to-INFO stage after scopeToDiff, never drops/escalates), `orchestrator.ts` (learn+decayPass at runIteration start — ahead of the sandbox early-return; active-ledger identity folded into the review cache key), `define-config.ts` (`phases.fpLedger`), `paths.ts`.
- **DoD:** Codex Agent A took **4 fix-rounds** before PASS — all 5 findings were real and fixed (each TDD'd): (1) decayPass had no caller → wired per-run, mirroring brain; (2) id reuse after decay → high-water-mark allocation; (3) one decision could inflate the quorum via duplicate same-provider members → dedup by (signature,provider); (4) **literal NUL byte** in a dedup key made git treat learn.ts as binary → structured `JSON.stringify([sig,provider])` key; (5) **cached PASS/SOFT-PASS bypassed the demote** → active-ledger identity now folds into the cache key (regression test verified to fail without the fix). Claude Agent A then PASS (4 INFO only).
- **4 advisory INFO (not blocking — candidates for B2 polish):** `distinct_providers` stored field is all-time not window-filtered (display only; gate uses windowed counts); `FpReject.run_id` holds a finding-id not a run-id (never read back); `fp_ledger_match.matched_count` hardcoded to 1 even when several members match (display only); `rejects[]` never prunes expired entries (slow unbounded growth, no practical impact at human cadence).
- **Live e2e — ATTEMPTED on the compiled binary (session 3), partial:** drove `dist/reviewgate gate --hook stop` against a scratch repo with `phases.fpLedger:{enabled:true}` + a real OpenRouter/deepseek reviewer. **Verified live on the binary:** config loads + applies; a real review runs (~37s, produced a CRITICAL `sql-injection`, gate correctly CLOSED/blocked); `fp list`/`fp audit` read a seeded `active` ledger correctly; learn/decay run in-path without error. **NOT cleanly observed:** the reactive demote firing on a real re-review — because deepseek does NOT reproduce a stable `rule_id` across runs (saw `sql-injection`, `hardcoded-secret`, `hardcoded-api-key`, `hardcoded-credentials` for the same code), and the signature includes `rule_id`, so a seeded signature rarely matches a fresh real review. **Same LLM non-determinism wall as brain-promotion** ([[project-brain-never-promotes]]) — the demote itself is proven by `tests/integration/fp-ledger-pipeline.test.ts` (controlled signatures). Two findings surfaced (below). (Also still owed: Phase-A scopeToDiff live check.)
  - **✅ FINDING A (fail-open) — FIXED** (`bc01383`, session 3, full DoD: OpenCode codex-slot + Claude A PASS): the orchestrator's fail-closed guard was `settled.length > 0 && okRuns.length === 0`, so it only caught reviewers that ran-and-errored; when ALL reviewers THREW (0 settled) or none were enabled/available, it aggregated an empty findings list → **PASS**. Broadened to `okRuns.length === 0` → verdict **ERROR** (the LoopDriver already blocks ERROR with a reviewer-error message; repeated ERRORs hit stuck-signatures escalation). Also fixed a latent bug: error-path `costUsd` was hardcoded 0, now sums `settled` usage. Tests: `tests/unit/orchestrator-fail-closed.test.ts`. **Config-gotcha UX also FIXED** (`63f1130`, DoD passed): `reviewgate doctor` now loads the effective config and warns "reviewer providers enabled: configured but NOT enabled in providers: <id> → the gate cannot review and will ERROR" with a fix hint (pure `reviewersEnabledCheck`, `tests/unit/doctor-reviewers.test.ts`, verified in the binary). Finding A fully closed.
  - **FINDING B (minor):** the same finding gets a DIFFERENT signature in source-mode vs the compiled binary (symbol resolution differs source-vs-binary). Internally consistent (prod is always the binary), but capture seed signatures FROM THE BINARY for any live FP-ledger test.

## 🚧 M5 — FP reduction (in progress)
Spec: `docs/superpowers/specs/2026-05-21-reviewgate-m5-fp-ledger-design.md` (v4, Codex-reviewed). Two parts: **A** diff-scoping (out-of-diff findings → INFO, default on) + **B** FP-ledger (signature learning, opt-in). 6 phases: A → B0 → B1 → B2a → B2b → B3.
- **Phase A — MERGED** (`f96659d`): `scopeToDiff` aggregator stage (range-intersection demote-to-INFO), decisions-gate scoped to CRITICAL/WARN (so demote-to-INFO actually unblocks), hunk parser (`src/diff/hunks.ts`, diff-state-aware), `phases.review.scopeToDiff` (default true), report-writer advisory section, tightened preamble. DoD PASS (Codex+Claude found+fixed 2 bugs: details-cap overflow, `+++` content-line misparse).
- **Phase B0 — MERGED** (`49474dd`): `Finding.members` provenance recorded by the aggregator (each merged member's signature + trusted `reviewer.provider`) — poison-safe prerequisite for B1.
- **Phase B1 — MERGED** (session 3). Note vs the plan: decayPass is now actually wired (per-run, in the orchestrator); the cache key folds in the active-ledger identity (was not in the plan — found by DoD review); `fp_ledger_match.matched_count` is still cosmetic.
- **Phase B2a — MERGED** (session 3, `fc09446`..`ce2be26`, 5 commits). Plan: `docs/superpowers/plans/2026-05-21-reviewgate-m5-phase-b2a-proactive-fewshot.md`. (1) Proactive negative few-shot: `src/core/fp-ledger/few-shot.ts` renders active/sticky FP entries matching the changed files into a trusted reviewer-preamble block ("Known false positives … do NOT re-report"), injected alongside brain context in `orchestrator.ts`. (2) `src/cache/behavior-hash.ts` (`computeBehaviorHash`): brain (`id:status`) + FP (`signature:stage`) now flow through ONE structured hash for the cache key (replaced B1's ad-hoc append; brain-only output byte-identical to legacy → cache continuity). **DoD:** Codex Agent A took 2 fix-rounds (all real): few-shot prompt-injection via untrusted ledger fields → defanged to safe charset `[A-Za-z0-9._/-]` (also kills the literal-control-byte-in-source hazard, cf. B1's NUL bug); non-strict budget → worst-case tail reserved + "" when nothing fits. Then Codex A + Claude A PASS (1 advisory INFO: few-shot computed before the cache short-circuit — pure, harmless, could move after).
- **Phase B2b — MERGED** (session 3, `fd2af6b`..`e55f221`, plan `docs/superpowers/plans/2026-05-21-reviewgate-m5-phase-b2b-cli-rejectrate.md`). (1) `reviewgate fp list/show/pin/unpin/audit` (`src/cli/commands/fp.ts`, mirrors brain CLI; pin by `--id`|`--signature`, pin=advisory-not-hidden, audit groups by first-seen provider; verified in the compiled binary). (2) `reject-rate-high` escalation wired (`src/core/fp-ledger/reject-rate.ts` + loop-driver precondition AFTER the decisions-gate): fires when this iteration's confirmed-FP rate over the REAL blocking findings ≥ `rejectRateEscalation` (0.8) with ≥4 such decisions. **decayPass was already per-run from B1** (no extra B2b work). **DoD:** Codex Agent A took 3 rounds — round 1 (no fabrication guard), round 2 (dedup added but fake ids still padded), round 3 (cross-iteration spec deviation). **Design decision (user-approved): reject-rate is SINGLE-ITERATION scoped to real findings** — fabrication-proof; max-iterations backstops cross-iteration accumulation. Recorded in the spec (B2b note) + reject-rate.ts. Codex hit its usage limit on the final round → used the **OpenCode fallback** (MiniMax) for the codex slot → PASS; Claude A PASS. (1 advisory INFO: `previousFindingIds` read twice in one sync path.)
- **🧠 Brain promotion LIVE-CONFIRMED** (2026-05-22): first real promotion ever — 2 reviewers (openrouter+gemini) independently proposed the same UTC-epoch-seconds convention → cross-provider quorum → promoted candidate (real 768-dim embedding). Also: B3b contradiction confirmed LIVE with the real deepseek judge (FP flagged `contradicts_brain_id`, no pairing). The brain works.
- **Brain promotion ROOT CAUSE FIXED** (`cb90ea6`, session 3, full DoD) — the brain had NEVER promoted because `quorumOk` required `reviewerEv >= 3` (3 evidence ITEMS) but the panel synthesizes ~1 item/proposal, so realistic 2-provider convergence (2 items) always failed; existing tests masked it with 2-3 items/proposal. Now scales the item floor to `provNeed` (non-diff ≥2 items/≥2 providers; diff-derived unchanged ≥3/≥3). Anti-collusion fully intact. **2-provider convergence is now promotable** → this UNBLOCKS B3 and brain-live-verification. See `project_brain_never_promotes` (now marked fixed).
- **Phase B3 core — MERGED** (`5c5adaa`+`5e7df5f`, session 3, full DoD; plan `docs/superpowers/plans/2026-05-21-reviewgate-m5-phase-b3-brain-ledger-coupling.md`). `src/core/brain/fp-coupling.ts` `pairActiveFpEntries`: every active/sticky FP entry gets a paired brain `convention` entry ("Known false positive: <rule> in <file>") cross-linked `linked_brain_id`↔`linked_fp_id` (`linked_fp_id` added to BrainEntrySchema). Idempotent (`!linked_brain_id` filter), non-blocking, post-verdict; wired in the orchestrator (extracted `buildEmbedder` shared with the curator), gated on brain+fpLedger, independent of proposals. Unit + integration tests (pairing fires through `runIteration`). DoD: OpenCode codex-slot + Claude A PASS. **2 advisory INFO (deferred, best-effort design):** (a) partial-write orphan — if `fpStore.mutate` fails AFTER the brain write succeeds, the FP stays unlinked → next run creates a 2nd brain entry (cheap guard: check existing `linked_fp_id==e.id` before creating); (b) concurrent-run race on shared worktrees. **CONTRADICTION-CHECK deferred to B3b** (fuzzy/LLM-judge — out of scope this pass).
- **Phase B3b — MERGED** (`86cac69`, session 3, full DoD). Contradiction-check: `pairActiveFpEntries` gains an optional `ContradictionJudge` (built from the curator provider via `buildContradictionJudge`, only when `phases.brain.curator` set). Before creating a paired brain note for an active FP, the judge checks whether treating it as a known-FP CONTRADICTS a pre-existing active brain memory; on contradiction → set `contradicts_brain_id` on the FP entry (surfaced via `fp show`; doubles as a don't-re-check marker), skip the pairing, never create a conflicting note. Judge errors fail OPEN. Schema: `contradicts_brain_id` on FpLedgerEntry. Unit-tested with stub judges (contradiction/no/error/idempotent). DoD: OpenCode codex-slot + Claude A PASS.
- **B3 orphan-on-partial-write edge — FIXED** (`cdf7c91`, TDD-only per the small-fix precedent): `pairActiveFpEntries` now re-links an existing brain entry whose `linked_fp_id` matches (partial-write recovery) instead of creating a duplicate.
- **⚡ LLM judges were DEAD no-ops — FIXED** (`2d55d23`, full DoD; found by a LIVE B3b test). Both judges (curator accept/reject hybrid M4 + B3b contradiction) reused `adapter.review()`, which forces the strict review json_schema → the model returned review-shaped JSON, never `{accept}`/`{contradicts}` → both silently returned their default. Added `OpenRouterAdapter.complete()` (free-form chat, no response_format) + optional `complete?()` on ProviderAdapter; both judges now use it. B3b contradiction now fires (integration-proven). **CLI providers (codex/gemini/claude) don't implement complete() yet → judges no-op for them; only OpenRouter works as a judge.** See memory `reference_llm_judge_complete`.
- **➡ M5 IS FULLY COMPLETE** (A · B0 · B1 · B2a · B2b · B3-core · B3b). Remaining: **live e2e in flashbuddy** (FP-ledger demote/few-shot + brain promotion + FP↔brain pairing + contradiction — all blocked only by LLM non-determinism, not by missing code), and the genuinely-cosmetic polish residue I deliberately LEFT (distinct_providers all-time-vs-windowed display, FpReject.run_id naming, rejects[] pruning — all marked no-practical-impact by reviewers). **M6 roadmap** (cassette replay / weekly reports / `reviewgate stats` / native sandbox) is the next milestone — start fresh.
- **Polish backlog — 3 done** (`0b0fb49`, DoD passed): honest `matched_count` (counts matched signatures, not hardcoded 1), few-shot built after the cache short-circuit, single `previousFindingIds` read in the loop-driver. **Remaining (lower value, deferred):** `distinct_providers` is all-time not windowed (display only — arguably fine as a summary); `FpReject.run_id` holds a finding-id not a run-id (never read back); `rejects[]` never prunes expired entries (slow unbounded growth, no practical impact at human cadence).
- **Live e2e still owed:** Phase A in flashbuddy (restart → a FP on unchanged code lands as INFO/advisory, doesn't block).

## This session's 6 fixes (all on master, local; first 4 went through full Codex+Claude DoD)
1. **`162ea18` decisions-rearm clear** — the decisions-gate matched by `finding_id` only; on a re-arm the iteration counter resets to 0 and reuses `decisions/<iter>.jsonl`, so a stale `F-001 fixed` line satisfied the next cycle's colliding F-001. Now wipes `decisions/` at both re-arm sites (PASS + escalated-commit). *Found by T2.*
2. **`306a115` symbol-graph wasm** — `bun build --compile` didn't bundle web-tree-sitter's engine runtime (`web-tree-sitter.wasm`); `Parser.init()` aborted ENOENT in the binary → **M3 symbol graph was silently DEAD in every real review since M3** (source-mode `bun test` hid it). Build now copies it to `dist/grammars` (fail-hard); `resolveRuntimeWasm()` + `Parser.init({locateFile})`. Verified at the compiled-binary level. *Found by T5.*
3. **`a16a5cf` brain promotion** — curator never promoted ANY memory (brain.json empty after a week). 3 barriers: diff-derived quorum needed ≥6 items (unreachable w/ ≤5 reviewers + no web-fetch) → now ≥3 distinct providers; GROUP_THRESHOLD 0.85→0.78 (paraphrases cluster; DEDUP stays 0.85); evidence synthesized when a proposal has none. Anti-collusion intact. *Found by T9.*
4. **`e95d2a4` brain type-default + schema_detail** — unknown reviewer `type` labels now default to "convention" (4th barrier); curator logs `schema_detail` sub-reason in curator-decisions. *Follow-up to T9.*
5. **`b5aa220` enrich keep-citation** *(TDD only, no DoD — small)* — `enrichProposal` dropped citations whose `safeFetch` failed (egress off → ALL fail) → emptied evidence → schema reject. Now keeps the item as reviewer evidence. *Found by T9 via schema_detail.*
6. **`b862cc7` ESCALATION.md findings** *(TDD only, no DoD — small)* — report's "Final findings" was always empty (`topFindings:[]` hardcoded) + per-iter CRIT/WARN always 0. Now populated from pending.json (FindingSchema-validated). *Found by T12.*

## Test series result (T1–T13, live in flashbuddy)
T1✅ T2✅ T3✅(critic ran, demoted 2) T4✅(doc-skip, after tree cleanup) T5✅(symbol graph populated, after fix #2) T6✅(cache hit, $0/1ms) T7✅(no false undefined-symbol — full-file context) T8✅(via T3 dedup) T9⚠️(machinery fixed+verified; **live promotion not yet observed** — needs ≥2–3 reviewers to converge on the same convention, non-deterministic) T10⏭(moot, brain empty) T11✅(brain CLI list/show/revoke — note the `--id <id>` flag) T12✅(escalation + re-arm) T13⏭(opportunistic, no reviewer ever failed: 4/4 ok throughout).

## Open findings / next-session candidates
- **M5 (FP-ledger) is the clear priority.** Across T4/T7/T9 the panel repeatedly produced FALSE POSITIVES on UNCHANGED code far from the diff (one was a hallucinated line 389 in a 362-line file; a minority CRITICAL FP forced a block in T7). Findings aren't scoped to the diff. M5's FP-ledger directly targets this; also consider scoping reviewer findings to the change. See memory `project_reviewer_fp_unchanged_code`.
- **Brain live promotion** still unobserved — machinery is sound (proposals reach quorum) but promotion needs reviewer convergence (≥2–3 providers proposing the same convention). T10 read-path can't be tested until a promotion exists. See `project_brain_never_promotes`.
- **Reset wrapper trap:** `.reviewgate/bin/gate` is the STOP hook, `.reviewgate/bin/reset` is reset. The escalation message says `reviewgate gate --hook reset` — use it verbatim (Agent A used bin/gate by mistake in T12 and left the gate escalated; recovered with the correct command).
- **Triage trigger gap (by-design, minor):** a change carried across a SessionStart reset that the agent doesn't re-touch via Edit/Write isn't reviewed until the next Edit (PostToolUse trigger is tool-based, not working-tree-state-based).
- Roadmap: **M5** FP-ledger, **M6** cassette replay / weekly reports / `reviewgate stats` / native sandbox.

## flashbuddy state
Gate re-armed (T12's escalation reset properly). `brain.json` empty. Working tree: `M reviewgate.config.ts` (test config, review-excluded) + untracked `.reviewgate/brain/`. Config: 4 reviewers (codex/openrouter[deepseek-v4-pro]/gemini[gemini-3-flash-preview]/claude-code[sonnet-4-6]) + critic opencode/`default` (MiniMax) + brain enabled (embeddings baai/bge-base-en-v1.5, egressAllowlist []). flashbuddy must RESTART to pick up a freshly rebuilt binary (SessionStart reset also clears stale `.reviewgate/` state).

## Working-environment gotchas
- **Shared checkout with a PARALLEL session** (branch `feat/plan-doc-review`) — HEAD has jumped unnoticed. This session used **git worktrees** for every fix (branch from local HEAD → TDD → review → FF-merge → remove worktree → rebuild binary). origin is stale; integration was **local FF-merge only, no push**. After each merge tell the parallel session to rebase.
- **codex worked reliably this session** (contradicts session 1's "often hangs"): `codex exec "$(<file)" </dev/null` foreground. opencode not needed.
- Never commit Claude attribution (commits authored Codevena). Never push without explicit OK.
- DoD for big fixes: TDD → `bun test`/typecheck/lint → Codex+Claude review subagents (`.review/*.md`, PASS=0 CRIT/WARN) → fix → re-review → `rm -rf .review/` → commit → FF-merge → rebuild. **Small fixes: TDD only, no DoD** (user's call this session).
- Memory dir: `/Users/markus/.claude/projects/-Users-markus-Developer-reviewgate/memory/` (German-speaking senior eng, milestone/subagent workflow, insists on REAL e2e — this session's 6 bugs were all source-mode-invisible, vindicating that). New memories this session: `project_reviewer_fp_unchanged_code`, `reference_compiled_binary_wasm`, `project_brain_never_promotes`.

## ➡️ NEXT SESSION (M6 Context7 docs — DONE; pick the next milestone)
**M6 Context7 library-docs injection is COMPLETE & MERGED** (see the session-4 block at the top). Spec `docs/superpowers/specs/2026-05-22-reviewgate-context7-docs-design.md`, plan `docs/superpowers/plans/2026-05-22-reviewgate-context7-docs.md` — both fully executed.
Candidates for the next session:
- **flashbuddy live-e2e of contextDocs**: set `CONTEXT7_API_KEY`, add `phases.contextDocs:{enabled:true}` to flashbuddy's config, restart, edit a file importing a real lib → confirm the reviewer sees current docs and stale-API FPs drop. (Binary already verified; this is the in-the-wild confirmation.)
- **Rest of the M6 roadmap**: cassette replay / weekly reports / `reviewgate stats` / native sandbox.
- **Optional follow-up**: thread the AuditLogger into the Orchestrator + add a `context_docs.fetch` EventType so docs outcomes land in the hash-chained audit log (today they go to the `.reviewgate/cache/docs/last-run.json` debug artifact).
