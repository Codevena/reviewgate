# Reviewgate — Next-Session Handoff

_Last updated: 2026-08-05 20:05. Supersedes all earlier content._

## One-line state

**pilot-02 ran clean (12/12 turns, 39.8 min, zero failures). Both registered primary outcomes
were met — the critic runs on every eligible turn and suppresses — and the run's real finding is
that its first measured act was to demote a true positive.**

## What got done this session — and how it was verified

The task was pilot-02, the second longitudinal measurement run. It executed end to end:
preregistration frozen and pushed *before* the run, 12 turns driven, harvested, ablated,
replay-checked, written up.

### The headline

| | pilot-01 | pilot-02 |
|---|---|---|
| critic RAN (primary A) | 0/12 — **off by config** | **10/10 eligible turns** |
| critic SUPPRESSED (primary B) | 0 | **3** |
| M3 recall, landed seeds | 0.67 (2/3) | **0.33 (1/3)** |
| M4 escape, landed seeds | 0.00 (0/3) | 0.67 (2/3) |
| M2 slope | +0.0239/turn (n=10) | 0.0000/turn (n=9) |
| M1 iterations | median 1 · 1.58 ± 0.86 | median 1 · 1.17 ± 0.37 |
| M5 | $0.0236 est · $0.0166 billed | $0.0125 est · **critic excluded by construction** |

**The critic cost exactly one true-positive catch.** On turn 2 the panel detected the seeded
path traversal *twice*; both went to INFO — one via `critic_verdict: likely_fp`, one via
diff-scoping — so the turn recorded 2 findings / **0 blocking** and scored a miss. The critic
ablation is *exact* and differs from baseline in that one turn only: **1/3 with the critic, 2/3
without**, reproducing pilot-01 seed for seed.

All three true-positive protections failed to engage, each for a specific reason:
`isCriticalSecurity` is keyed to `severity === "CRITICAL"` (this was WARN + security); the
corroboration exemption never fired because the two detections carried different `rule_id`s and
never merged; `isProtected` saw an empty set — turn 2 ended 2.2 min into the run, the first
reputation sample landed 17 min later.

**Scope it honestly:** the gate passed turn 2 in *both* pilots (`softPassPolicy: "allow"`), so
the cost is to **surfacing**, not interception. n = 3 landed seeds.

### Three bugs this run found in the measurement tooling

1. **`rig ablate`'s recall denominator ignores `seedLanded`** (`ablate.ts:207` uses all 5 seeded;
   `harvest.ts:509` uses the 3 landed). `renderAblationMatrix` then subtracts across
   denominators and prints `+1/3` for layers that suppressed **nothing**. Every figure quoted in
   the write-up is recomputed from the ablated turn records instead. **Fix this first — it is
   the one that silently publishes wrong numbers.**
2. **M5 cannot see the critic**: `orchestrator.ts:2300` is `const criticCostUsd = 0`, never
   reassigned (`complete()` returns no usage envelope). Enabling a critic adds real spend that
   M5 reports as $0.
3. **Claim (A) is not harvestable**: `RigResult` carries only `suppressed.critic`, a *demotion*
   count — a critic that ran and kept everything is indistinguishable from one never configured.
   **FIXED** — `RigTurnRecord.criticRuns` + an `M6 critic invocation` report line; the
   stopgap `rig/scripts/critic-activity.ts` is deleted, one source of truth again.

None were fixed during the run: harvesting goes through the binary the preregistration pins, and
rebuilding mid-experiment would break the pin and deploy to every repo via the symlink.

### Why M2's 0.0000 is not good news

`rejectedAsFp` is 0 on **every** turn. The four applied decisions are **3× `tp` + 1× `declined`,
zero `fp`**, and `known_fp.jsonl` ends the run holding `"entries": []`. There were no false
positives to burden anyone with, so M2 has no signal — registered in advance as non-citable.

### Seed-landing verification worked on its first real outing

All five seeds carried a `landedPattern`. Turns 4 and 9 were excluded **automatically** and both
confirmed by reading the recorded source (`$1` + params array; `process.env.REPORTING_API_TOKEN`).
**The agent declined the same two prompts as in pilot-01** — plan for a landed denominator of
**3, not 5**. Patterns were calibrated against pilot-01's `working-tree.diff` before the run
(reproducing its hand-verified ground truth exactly) and mutation-checked both directions, which
caught one vacuous case (an inline `Bearer <literal>` header).

## Current metrics (measured, not recalled)

- Suite **3163 pass / 12 skip / 0 fail** · `bunx tsc --noEmit` clean · biome clean (643 files)
- Working tree **clean** · HEAD **`dd21408`**
- **origin/master = `33bc02f`** → **3 commits unpushed**: `ac2f5d5` (preregistration),
  `dd21408` (result + extractor), and this handoff commit itself.
  The 15 that were pending last session **were pushed** this session with Markus's OK
  (`04563ee..33bc02f`, verified `git rev-list --count` = 15).
- Binary **unchanged**: `sha256:7f92445b…` — pinned by the preregistration and deliberately not
  rebuilt. `dist/reviewgate.prev` (`879a87e5…`) is still the rollback target.
- Control plane approved, `pending: None`

## THE NEXT TASK — decide between two, both justified by pilot-02

**(a) Fix the measurement tooling (small, protects every future number).** `rig ablate`'s
denominator first, then M5's critic cost and a `critic` invocation field on `RigResult`. Entry
points: `src/rig/ablate.ts:207`, `src/rig/harvest.ts:509`, `src/schemas/rig-result.ts`,
`src/core/orchestrator.ts:2300`. Note fixing 2–3 requires `bun run build`, which re-pins the
binary for any later pilot — do it *before* preregistering pilot-03, never during.

**(b) Close the true-positive hole the critic exposed (substantive, needs a pilot-03).** Two
candidates, in evidence order:
   1. Extend the critic's exemption **below CRITICAL** for security/correctness categories, or
      make `demoteOneStep` refuse to take a security finding below WARN — the current floor lets
      one step cross the blocking boundary (`aggregator.ts:604-618`, `:155`).
   2. Merge same-file/same-category detections **before** the critic sees them so the
      corroboration exemption can engage. Two reviewers agreeing under different phrasings
      currently reads as two lone, individually-demotable findings.

Recommendation: **(a) then (b)**, because (b) must be measured and (a) is what makes the
measurement trustworthy.

**Do NOT enable the critic in the `init` scaffold.** The spec's C1 made that conditional on
pilot-02 confirming the effect; what pilot-02 measured is one true positive lost against zero
measurable FP reduction. It is also not on its own a reason to turn it off here (n=3).

## Traps that still hold

- **`rig ablate` numbers are wrong until bug 1 is fixed.** Recompute from the ablated
  `RigTurnRecord`s (`caught` over `seedLanded !== false`) rather than quoting the matrix.
- **Turning the critic OFF needs a SECOND human TTY approval.** `safeStrengthening` auto-classifies
  only four sandbox/loop paths; `ControlPlaneStateSchema` stores one `approved_config` with no
  history, so the with-critic config *is* the last-known-good. Deleting the line does not undo it.
- **The critic only runs when the panel produced ≥1 finding** (`orchestrator.ts:2302`). Turns 1
  and 8 legitimately wrote no `critic` key. Not a misconfiguration, not an API-key problem.
- **`computeFpClusters` must stay on `ruleIdToken0`** — it feeds `orchestrator.ts:2364` → the
  aggregator's suppression map, and `aggregator.ts:783` independently reconstructs the same
  `<token0>@<file>` key. `computeFpSemanticClusters` is diagnosis-only.
- **Preregistered floors must be RATES, not counts.** pilot-02's M3 prediction said "at least 3
  of the seeds that LAND", which with 3 landing demands 3/3. Nothing hinged on it (0.33 fails
  either reading) but pilot-03 must not repeat it.
- **`rig run` takes `repoRoot` from `process.cwd()`** — run it from *inside* the sandbox with
  absolute `--script`/`--out` paths pointing back at this repo.
- **`bun run lint`/`tsc` do NOT cover `rig/scripts/`** (tsconfig includes only `src*`/`tests*`).
  Check files there explicitly or "clean" is vacuous.
- **`rig/results/` is gitignored and pilot-01's outputs were never tracked** — pilot-02's are
  local evidence too (`rig/results/pilot-02/`, incl. the 40-entry cassette and `final-tree/`).
- Older traps that still apply: never `git add -A` at the repo root; never put `*.test.ts` under
  `rig/results/`; the rig cassette must live INSIDE the repo under review with `$SB` as the
  PHYSICAL `/private/tmp/…` path; `exit = 0` proves nothing — `gateReviewed` is the real signal.

## Open, needs Markus

1. **3 commits unpushed** (`ac2f5d5` prereg, `dd21408` result, + this handoff). Push?
2. **Two `~/Developer` fixes**, diagnosed but still not applied (outside this repo):
   `~/Developer/.claude/settings.json` holds repo-local Reviewgate hooks pointing at
   `${CLAUDE_PROJECT_DIR}/.reviewgate/bin/…` while `~/Developer/.reviewgate/bin/` does not exist
   → `SessionStart hook error` in every new project that is not yet its own git repo. The hooks
   are redundant (user-scoped shims cover every repo). Second, a `control-plane.json` from 15.07.
   makes `~/Developer` count as an armed checkout.
3. **Four repos armed without ever being `init`ed** (`barrierefrei`, `fatemehdaily`,
   `viergewinnt`, `youtubeQuiz`) — unchanged; a policy call, not a bug.
4. **Sandbox `/private/tmp/rig-pilot02-kzYEoV` still exists** — delete once pilot-02 is closed
   out. `dist/reviewgate.prev` likewise.

## Read-first order

1. This file.
2. `docs/dev/2026-08-05-pilot-02-result.md` — the full run, its limits, and the three tooling bugs.
3. `docs/dev/2026-08-05-pilot-01-result.md` — the baseline it is compared against.
4. `rig/preregistrations/pilot-02.json` — what was committed to before any number existed.
5. `docs/superpowers/specs/2026-08-05-fp-ledger-evidence-unit-design.md` — the design of record
   (C1's "enable the critic" is the change pilot-02 measured; C3 is withdrawn).
