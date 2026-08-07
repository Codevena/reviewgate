# Reviewgate — Next-Session Handoff

_Last updated: 2026-08-07, after the rig stale-report defect was diagnosed, specced and planned.
Supersedes all earlier content._

## One-line state

**The rig stale-report defect is fully diagnosed and measured, the design and the implementation
plan are written and committed — but NOT ONE LINE OF THE FIX IS IMPLEMENTED. The next session
implements `docs/superpowers/plans/2026-08-07-rig-stale-report-fix.md`, Task 1 first.**

## Verified state (checked with commands at handoff time)

| | |
|---|---|
| my commits this session | **`384df2a`** (spec), **`f36abf1`** (plan), **`734f5eb`** (plan corrections) — docs only, zero code |
| pushed? | **NO.** ~~`master` is 8 ahead~~ → **12 ahead** of `origin/master` as of 2026-08-08 01:4x — 3 are mine, **9 are the Qwen session's** |
| ~~the other 5~~ the other 9 | `9fac6f8`, `ef54ed0`, `979bfea`, `e7c25e1`, `0f8b6cf`, `cef7022`, `56564ea`, `63a779f` (+ `b3032b3`, `9473973` already pushed) — **the SECOND SESSION's bench/Qwen work, now CLOSED OUT.** See "Second work stream" below |
| working tree | only `.reviewgate/lore/approvals.jsonl` (foreign gate state) — leave it alone |
| suite | **3209 pass / 12 skip / 0 fail**, exit 0 — re-run at `56564ea` by the Qwen session (139 s). ⚠ One earlier full run showed `1 fail` that did **not** reproduce in four subsequent runs; the name was never captured. Only hint: `cassette: prompt drift for codex-security` appeared solely in the failing run. Treat as flaky-unknown, not as green-by-proof |
| build | **deliberately NOT run.** Installed binary still `sha256:fc9b8c18…` |
| ~~Trailhead stamp left at `5543549` ON PURPOSE~~ | → **now `cef7022`, stamped 2026-08-08 (`56564ea`).** This is the completion of that decision, not an override: the 4 GEÄNDERT rows were the Qwen session's own work, and that session verified them (`bench.ts`/`runner.ts` entry points still correct, 0 FEHLT, 80/80 lines). The session that could honestly stamp them did |

⚠ **A SECOND SESSION IS COMMITTING TO THIS CHECKOUT.** Never `git add -A`; stage explicit paths and
check `git log` before assuming a commit is yours. A `git worktree` remains the standing fix.

## What got done — and how it was verified

**Nothing was implemented. What exists is a diagnosis backed by measurement, plus a gated plan.**

The handoff that suggested this task described it as "a dead turn inherits the previous turn's
`pending.json`". That was an order of magnitude too small. Measured against the recorded pilots:

| | pilot-01 | pilot-02 | pilot-03 | total |
|---|---|---|---|---|
| turns opening with the previous turn's final report | 11/12 | 11/12 | 9/12 | **31/36** |
| reports owned by the turn | 19 | 14 | 14 | **47** |
| reports inherited from an earlier turn | 11 | 11 | 9 | **31** |
| reports owned by **no** turn (orphans) | 0 | 0 | 0 | **0** |

**13 of 36 turns count findings they did not earn; 9 of those produced none of their own.**
Sharpest case: pilot-03 turn 5 has an EMPTY audit delta and still reports 3 findings, all turn 4's.

Root cause: `driver.ts:201` promises to archive every version that **appears** while a turn runs;
it was implemented as every version that **exists**. The first poll fires 250 ms in, while the
predecessor's `pending.json` is still on disk.

**Evidence, not adjectives — every number above came from a command run against
`rig/results/pilot-0{1,2,3}/`, not from reading code.** Also executed and confirmed:

- `run_id` maps **1:1 to a turn** across all **34** recorded gate runs — none spans two turns.
  This is what makes the ownership rule sound and retroactive.
- Every one of the 31 inherited reports is **byte-identical** to its predecessor's final report,
  so dropping it loses nothing.
- The **pre-fix baseline** for all three pilots is captured (table below) so the correction delta
  cannot be back-fitted.
- `createHash`/`existsSync`/`readFileSync`/`join`/`reviewgateDir` are already imported in
  `driver.ts:6-20`; `window.runs`/`runDelta` are in scope at the harvest insertion point.

**Pre-fix baseline — capture this again only if you distrust it; do not overwrite it:**

| | pilot-01 | pilot-02 | pilot-03 |
|---|---|---|---|
| recall | 0.60 (3/5) | 0.33 (1/3) | 1.00 (2/2) |
| escape rate | 0.20 (1/5) | 0.67 (2/3) | 0.00 (0/2) |
| M2 slope | 0.0239/turn (n=10) | 0.0000/turn (n=9) | 0.0014/turn (n=9) |
| iterations median | 1 over 12 reviewed | 1 over 12 reviewed | 1 over 10 reviewed |
| cost | $0.0236 | $0.0125 | $0.0136 |

### Plan gate: ONE round, and only half a gate

- **agy (Slot B): PASS**, 0 CRITICAL / 0 WARN / 1 INFO. Findings file verified fresh (mtime
  11:14:35Z against a round start of 11:13:26Z), log 2767 bytes. Its INFO was **correct** and is
  fixed in `734f5eb`.
- **Slot A (executing): STILL OPEN.** agy's log shows a single `readFile` — it reviewed by reading,
  not by executing, despite being told to run the code.
- **The proof that this matters:** I found a plan-breaking defect agy missed while it asserted "the
  rule produces deterministic, safe outcomes in all cases" — four fixture turns declare `reports`
  but no `iterations`, so under the new rule their reports become orphans and **three existing
  `criticRuns` tests collapse to `[]`**. That is now Task 1 Step 4.

## THE NEXT TASK

**Implement the plan, Task 1 → Task 4, in order.**
`docs/superpowers/plans/2026-08-07-rig-stale-report-fix.md`

Why it is next: every future rig measurement rests on the harvester being right, and the corpus is
currently wrong in a way that is invisible from the reports themselves. The harvest half works
**retroactively and needs no rebuild**, so the three recorded pilots become usable again rather than
being written off.

Entry points: `src/rig/harvest.ts:141` (`collectTurnFindings`) and `:413` (its call site);
`src/rig/driver.ts:214` (`startReportArchiver`).

**Task 1 must land first** — it is a test-only refactor, and without its Step 4 Task 2 reddens three
existing tests for the wrong reason.

## Traps — NEW this session

- **`run_id` alone is the ownership key, never `(run_id, iter)`.** A gate that writes
  `pending.json` for iteration 3 and dies before appending `run.complete` would have its REAL report
  dropped as an orphan under a pair key. Verified 1:1 across 34 gate runs.
- **Four fixture turns model an impossible state** (`reports` with no `iterations`): the three
  `criticRuns` tests at `rig-harvest.test.ts:360`, `:384`, `:407`. They need a gate iteration added.
  Do NOT add one to `:609` ("a turn where the gate never ran") — that one is deliberately dead.
- **The trailhead stamp was deliberately NOT moved.** All 4 GEÄNDERT rows (`tests/unit/`,
  `src/cli/commands/bench.ts`, `src/bench/runner.ts`, `src/cli/commands/`) are the PARALLEL
  session's bench work, which this session never looked at. Stamping HEAD would claim a verification
  that did not happen. 0 FEHLT, 66/70 still valid, `CLAUDE.md` at exactly 80/80 lines.
- **The gate escalated on findings that are not mine and cannot be honestly dispositioned.**
  `F-002`/`F-003` on `src/providers/opencode.ts` are the parallel session's code, but the ownership
  snapshot marked them `session_attributable: true` (their edits landed inside my baseline window),
  so `out-of-scope` and `out-of-session` both fail closed. ~~They remain **open and escalated**~~ →
  **RESOLVED 2026-08-08 by the session that owns that code:** `F-002` **fixed** (the measurement
  scaffolding was removed from the reviewer path, `63a779f`), `F-003` **rejected with a reason** and
  carried as a named next task. Both decisions are in `.reviewgate/decisions/1.jsonl`. The
  quota-degraded-panel caveat still applies to any *re-run* (codex capped until 2026-08-08 11:07Z).
- **`harvest.ts` never reads `manifest.turns[].gateReviewed`** — the flag exists, is written by
  the driver, and is consulted by nothing. The plan subsumes it rather than adding a second signal.
- **An `iterations === 0` warning that says "EXCLUDED from the M1/cost-per-turn samples" is true and
  misleading** — findings, recall, escape and suppression were never excluded.

## Traps — still standing

- **Never run `bun run build` casually** — re-pins the binary AND deploys machine-wide via the
  `~/.local/bin/reviewgate` symlink. Build → record sha → preregister → run. **Task 3's driver fix
  reaches no real `rig run` until someone rebuilds; that is deliberately out of scope.**
- **Never pipe `bun test` through `tail`** — a red test's identity is lost. Redirect to a file.
- **`bun run lint`/`tsc` do NOT cover `rig/scripts/`.** Check it explicitly (needs `typeRoots`
  pointing at `node_modules` — `bun-types` is not under `@types/`).
- **`agy` fails 0-byte intermittently, and reviews shallowly even when it does not.** A missing
  findings file is an OPEN slot; so, arguably, is a PASS whose log shows no execution.
- **Codex quota resets 2026-08-08 11:07Z.** Until then the executing slot is agy or a Claude
  subagent; that is the normal configuration, not a degraded one.
- **A rate over `reports/*-pending.json` is a rate over SURVIVORS.** Use `cassette.jsonl`.
- **`rig/results/` is gitignored** — every number here is reproducible only on this machine.
- **Never reimplement a shipped helper in a rig script** — import it.
- **`applySymbolSignatures` runs BEFORE `validateFindingFacts`** (`orchestrator.ts:2219`, `:2226`).
- Reviewgate's decision protocol assumes fix-and-decide within ONE turn; an agent that delegates a
  fix to a background worker structurally cannot. Still unaddressed.

## Open Trailhead note (carried forward)

`CLAUDE.md`'s Mess-Rig row points at `src/rig/driver.ts` rather than the offline replays under
`rig/scripts/`. After this session's work the row is arguably *more* correct than before — the next
task's entry points are `src/rig/driver.ts` and `src/rig/harvest.ts`. Left as-is; `CLAUDE.md` is at
exactly 80/80 lines, so any change is a swap, not an addition.

## Read-first order

1. This file.
2. `docs/superpowers/plans/2026-08-07-rig-stale-report-fix.md` — the plan to execute.
3. `docs/superpowers/specs/2026-08-07-rig-stale-report-design.md` — why the rule is what it is,
   especially §"Why `run_id` alone" and §"Failure handling".
4. `.reviewgate/ESCALATION.md` — the open, not-mine findings, before ending your first turn.

---

# Second work stream — Qwen3.8-Max as a measured reviewer (session of 2026-08-07/08)

_Independent of the rig stale-report task above. Both are live in this checkout._

## One-line state

**The cost question is answered and the tooling is built and committed; the *quality* question is
untouched. Phase 2 (the 30-case exploratory bench) is the next step — but run it on a Standard tier,
not on Lite.**

## What got done — and how it was verified

| | |
|---|---|
| `scripts/measure-opencode-tokens.ts` (`9473973`, **pushed**) | Token oracle over opencode's SQLite session DB. 6/6 green; mutation seen red (coefficient 1.21 → 2.42 ⇒ 4 pass / 2 fail, measured value `118.68406`) |
| `bench --provider-model` (`ef54ed0`) | Pins a reviewer's upstream model into provenance. 12/12 green; mutation reddened **exactly the 4 predicted cases**, the sentinel test stayed green. Verified end-to-end: a real `bench run` wrote `"model": "alibaba-token-plan/qwen3.8-max"`, not `"default"` |
| Overhead + caching measurements (`9fac6f8`, `979bfea`, `e7c25e1`, `0f8b6cf`) | Artifacts under `bench/results/qwen-overhead/`. Every credit number is **console-read**, not modelled |
| Risk-control scope correction (`cef7022`) | Markus: the block suspends **purchases only**; renewal and tier changes are unaffected |
| Trailhead stamp (`56564ea`) | `verify-map.js`: 0 FEHLT, 4 GEÄNDERT (all this stream's), entry points re-checked |
| F-002 fix (`63a779f`) | Measurement scaffolding removed from the live reviewer path |

**The numbers, all console-verified:**

| | credits/call | | |
|---|---|---|---|
| baseline, default agent | 31.01 | 30 × 1 | 30 × 3 |
| + reduced tool set (`--agent`) | 22.86 | | |
| + warm cache | 9.17 | | |
| **real case** (2 calls/case, 1st cold) | **28.2 /case** | **846 cr** | **2,538 cr** |
| …as % of a **Lite** window (2,500) | | 34 % | **102 % — does not fit** |
| …as % of a **Standard** window (10,000) | | 8.5 % | **25.4 % — fits** |

Smoke run: `2/2 cases scored → precision 1, recall 1, clean-FP 0`. **N=2 — that is a pipeline test,
not evidence about review quality. The acceptance bar in the spec is untouched.**

## THE NEXT TASK — and why

**Decide the tier before spending anything.** Phase 2 costs 34 % of a Lite window but 8.5 % of a
Standard one, and Phase 3 is impossible on Lite and routine on Standard. Running Phase 2 on Lite is
the expensive ordering: it burns a third of the week to answer a question whose follow-up you then
cannot afford. $12/month decides this, and the risk-control block does **not** stand in the way.

Once the tier is settled, Phase 2 is `reviewgate bench run --corpus bench/cases --providers
opencode,ollama,claude-code --provider-model opencode=alibaba-token-plan/qwen3.8-max`. The bar is
preregistered in the spec §6: Qwen earns a slot if it finds **≥1 seeded bug that GLM-5.2 and
claude-code both miss**, at a clean-FP rate no worse than GLM-5.2's.

**Second task, small and independent:** finding **F-003** (rejected, carried forward) —
`src/providers/opencode.ts` `complete()` still passes `--dangerously-skip-permissions`, which does
not exist in opencode 1.18.10. Own commit, own gate: it changes curator runtime behaviour.

## Traps — NEW from this stream

- **`--dangerously-skip-permissions` does not exist in opencode 1.18.10.** The flag is `--auto`, and
  opencode **exits 0 on unknown flags** instead of rejecting them, so the dead flag was silently
  ignored on every call for an unknown span of time. Fixed at `:97`, still live at `:242`.
- **Credits are read, never computed.** Fitting the uncached/cached coefficients across three
  calibration points does **not converge** (1.25–1.71 and 0.05–0.43 per 1K). The console shows two
  decimals (±0.125 credits). The token model ran **9 % low** on its one real test. Any credit figure
  in a future doc must cite a console delta.
- **A bench case costs ~2 LLM calls, not 1**, and the first call of a run pays a cold cache. Any
  per-*call* figure understates the per-*case* cost by ~3×.
- **`bench.ts` rejects a corpus with zero clean cases** (exit 4). A "just run one case" smoke test is
  invalid; take one clean + one seeded.
- **The reduced-tool `--agent rg-reviewer` win (23.5K → 17.8K input tokens) is real but not shipped.**
  It depended on `~/.config/opencode/agent/rg-reviewer.md`, which exists only on Markus's machine.
  Make it a config option before reintroducing it — do not hard-code it in the adapter again.
- **`phases.brain.curator` points at `opencode` with `model: "minimax-m2"`, whose plan has expired.**
  The call **hangs** instead of erroring — killed after 150 s. Independent of everything above.
- **Pay-per-token DashScope is blocked**, account-wide (`AccessDenied.Unpurchased` on all 5 models
  tested), root cause `RISK.RISK_CONTROL_REJECTION`. KYC would unblock it but costs a passport scan
  and a month of bank transactions — and buys only pay-as-you-go and Extra Bundles, **neither of
  which this work needs**. Do not treat it as a prerequisite.

## Read-first order for this stream

1. `bench/results/qwen-overhead/DECISION.md` — the go/no-go and every caveat.
2. `docs/superpowers/specs/2026-08-07-qwen-reviewer-measurement-design.md` §5a (the live options) and
   §6 (the preregistered acceptance bar).
3. `docs/superpowers/plans/2026-08-07-qwen-overhead-and-provider-model.md` — the three findings
   mappings at the end are the record of what three gate rounds actually caught.
