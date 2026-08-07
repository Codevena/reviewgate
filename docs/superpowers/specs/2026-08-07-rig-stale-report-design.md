# Rig stale-report defect — design

_Written 2026-08-07. Status: design approved, not yet implemented._

## The defect

`src/rig/driver.ts` starts a fresh report archiver for every turn (`:338`), and that archiver
captures whatever `pending.json` sits in the live `.reviewgate/` — including the version the
*previous* turn left behind. Its docstring says it archives "every version of `pending.{json,md}`
that **appears** WHILE a turn runs" (`:201`); it was implemented as every version that **exists**
while a turn runs. The first poll fires 250 ms into the turn, long before the turn's own gate has
written anything, so the predecessor's final report is archived as this turn's `1-pending.json`.

`src/rig/harvest.ts` then counts it. `collectTurnFindings` (`:141`) reads every `*-pending.json`
in the turn's directory and folds their findings into that turn's totals.

### This is not an edge case — measured, not inferred

Across the three recorded pilots (36 turns):

| | pilot-01 | pilot-02 | pilot-03 | total |
|---|---|---|---|---|
| turns opening with the previous turn's final report | 11/12 | 11/12 | 9/12 | **31/36** |
| archived reports owned by the turn | 19 | 14 | 14 | **47** |
| archived reports inherited from an earlier turn | 11 | 11 | 9 | **31** |
| archived reports owned by no turn at all | 0 | 0 | 0 | **0** |

Every one of the 31 inherited reports is byte-identical to its predecessor's final archived report.

Turns whose finding count is inflated by findings they did not produce:

- pilot-01: turns 2, 3, 5, 8, 10 — of which 3, 8 and 10 have **zero** own findings
- pilot-02: turns 3, 5, 10, 12 — **all four** have zero own findings
- pilot-03: turns 4, 5, 8, 11 — of which 5 and 8 have zero own findings

**13 of 36 turns count findings they did not earn; 9 of those produced none of their own.**
The sharpest instance is pilot-03 turn 5: its audit delta is empty (the gate produced no
`run.complete` at all), yet it currently reports 3 findings — every one of them turn 4's.

### What it corrupts

- **Cross-turn double counting.** `collectTurnFindings` dedupes by signature *within* a turn
  precisely so a finding surviving three iterations is not counted three times — the comment at
  `:129-135` says counting it repeatedly "would inflate the M2 denominator and M6". That dedup is
  per-turn, so the same finding is counted once in turn N-1 and again in turn N, which is the exact
  failure the dedup exists to prevent.
- **M2** — `fpBurden = rejectedAsFp / findingsTotal` (`:450`) takes a polluted denominator, and each
  polluted point enters the OLS slope (`:549-551`).
- **M3 recall** — `caught` is computed from `blockingTexts` (`:454`), which include inherited findings.
- **M4 escape rate** — `flaggedLater` scans the same texts across turns (`:527`).
- **Suppression totals** (`:557`) double-count an inherited report's suppressions.
- **`criticRuns`** — an inherited report's critic object is attributed to the wrong turn.

### Why it has looked covered

The existing test `"a turn where the gate never ran is a warning, not a silent zero"`
(`tests/unit/rig-harvest.test.ts:609`) builds its dead turn with `reports: []` — it exercises the
case where nothing was inherited. The driver's `gateReviewed` flag does detect an unreviewed turn
(`driver.ts:365`, warned at `:382`), but **`harvest.ts` never reads it** — the flag exists and is
not consulted. The `iterations === 0` warning (`harvest.ts:420-424`) says such a turn is "EXCLUDED
from the M1/cost-per-turn samples", which is true and creates the false impression that dead turns
are handled; findings, recall, escape and suppression are not excluded.

## The rule

A report belongs to the turn whose audit delta contains its `run_id`.

| Report's `run_id` | Meaning | Treatment |
|---|---|---|
| in this turn's `runDelta.added` | **own** — this turn's gate produced it | counted, as today |
| in an earlier turn's audit set | **inherited** — already counted where produced | dropped, one warning per turn |
| in no turn's audit set | **orphan** — pruned audit or foreign snapshot | dropped, one loud warning per report |

### Why `run_id` alone, not `(run_id, iter)`

A gate run lives inside one Stop hook and therefore inside one turn. Verified across all 34
recorded gate runs in the three pilots: **no `run_id` appears in more than one turn's audit delta.**

Keying on the pair would be strictly worse: if a gate writes `pending.json` for iteration 3 and then
dies before appending `run.complete`, the pair-key calls that report an orphan and drops real data,
while the `run_id` key correctly keeps it. `criticRuns` retains its internal `run_id:iter` keying —
that answers a different question (invocation identity *within* a turn) and is unaffected.

### Why this discriminator and not content hashing

`harvest.ts:149-156` already rejects content hashing for exactly this class of question, in favour
of `run_id:iter`, because hashing "would silently collapse two genuinely distinct invocations that
happened to report equal counts". A cross-turn byte-hash dedup would re-introduce the rejected
approach, and it cannot distinguish "same report inherited" from "different run, identical bytes".

## Components

**`src/rig/harvest.ts` — the guard.** `collectTurnFindings` gains the owned-`run_id` set as a
parameter. `harvestTurn` already computes `runDelta` at `:405`, three lines before it calls
`collectTurnFindings` at `:413`, so the data is in hand and no new plumbing crosses a module
boundary. This half works retroactively on the recorded pilots and needs no rebuild.

Three consequences fall out rather than needing separate handling:

- `criticRuns` is repaired for free, since filtering upstream stops an inherited report's critic
  object reaching the wrong turn.
- A turn with `iterations === 0` drops to zero findings, because its audit delta is empty so nothing
  can be owned.
- `reportsRead` counts only owned reports, keeping the existing "the gate ran but NO `pending.json`
  was archived" warning (`:431`) truthful instead of masked by an inherited file.

**`src/rig/driver.ts` — the hygiene fix.** `startReportArchiver` seeds its `seen` set with the
hashes of `pending.json` and `pending.md` as they exist *before* the agent starts, so a version
unchanged since the previous turn is never archived. This makes the archiver match its own
docstring. It is not the guard — it reaches future runs only, and only after a rebuild.

Nothing is lost by skipping: all 31 inherited reports are byte-identical to a report the previous
turn's archiver already captured, because that archiver's final sweep (`:245`) records the file's
end-of-turn state, which is exactly what the next turn inherits.

## Failure handling

The rule removes findings from a turn, which makes it a suppressor, and a suppressor must fail safe.

- **Inherited → one warning per turn**, stating the count and the owning turn, and that the findings
  are not lost but counted where they were produced. Per-report warnings would bury the signal.
- **Orphan → one loud warning per report**, and the report is dropped. This is the branch with no
  real-data coverage (0 occurrences in 36 turns), so it gets the noisiest treatment. Dropping rather
  than keeping follows the rig's "missing data is not zero" stance: a report that cannot be
  attributed to a turn must not be silently attributed to *this* one.
- **Neither is fatal.** This is a deliberate judgement call against the nearest precedent:
  `harvestTurn` *does* throw when the audit log shrinks (`:407-411`). The closer precedent is the
  unreadable-report policy (`:174-179`, guarded by the test at `rig-harvest.test.ts:637`), whose
  rationale — losing a whole expensive run's numbers to one unreadable file is worse — applies here.
  A shrinking audit log invalidates every per-turn delta in the chain; one unattributable report
  does not.

Two behaviours stated explicitly rather than left to be discovered:

- **A snapshot with no audit tree turns every report into an orphan**, so the turn reports zero
  findings with loud warnings. This is consistent — such a turn already has `iterations === 0` and
  is already excluded from M1 — but it is a real behaviour change for any legacy run lacking an
  audit tree. There are none among the three pilots.
- **A report whose `run.complete` lands after its own turn's snapshot** would be an orphan in turn N
  and owned by turn N+1. `awaitQuiescent` waits for `gate.lock` release before snapshotting, so this
  should not arise; if it ever does, attributing the report to the turn whose audit actually contains
  it is still the defensible answer.

## Tests

**Fixture rework first, because it gates everything.** `auditLine` emits
`run_id: "session-<turnIndex>"` (`rig-harvest.test.ts:93`) but `pendingReport` hardcodes
`run_id: "session-x"` for every report (`:144`). Under the new rule every existing fixture report
becomes an orphan and every existing finding-count assertion breaks. `pendingReport` must take the
turn index and emit the matching `run_id`, with a per-report override so a test can deliberately
construct an inherited or orphan report.

Each test carries its two numbers, so a vacuous test is caught on paper before it is written:

| Test | Without the fix | With the fix |
|---|---|---|
| an inherited report is not counted again in the turn that merely saw it | 2 findings | 1 |
| a turn the gate never reviewed reports nothing, not its predecessor's findings | 3 | 0 |
| a report owned by no turn is dropped and warned about | 1, no warning | 0, warning |
| `criticRuns` is not attributed to a turn that only inherited the report | 1 critic run | 0 |
| `reportsRead` counts only owned reports, so the unmeasured-turn warning fires | no warning | warning |
| driver: a `pending.json` unchanged since before the turn is not archived | 1 file | 0 |
| driver: a `pending.json` that changes during the turn is still archived | 1 file | 1 file |

The last row has identical numbers on both sides by design. It is not vacuous but an
over-suppression guard: a driver fix that skipped on filename, or on "a file existed", rather than
on content hash would redden exactly there and nowhere else.

Every test is mutation-checked in a **copy** of the repo and seen red once before being believed.

## The correction deliverable

The pre-fix baseline is already captured, so the delta cannot be back-fitted:

| | pilot-01 | pilot-02 | pilot-03 |
|---|---|---|---|
| recall | 0.60 (3/5) | 0.33 (1/3) | 1.00 (2/2) |
| escape rate | 0.20 (1/5) | 0.67 (2/3) | 0.00 (0/2) |
| M2 slope | 0.0239/turn (n=10) | 0.0000/turn (n=9) | 0.0014/turn (n=9) |
| iterations median | 1 over 12 reviewed | 1 over 12 reviewed | 1 over 10 reviewed |
| cost | $0.0236 | $0.0125 | $0.0136 |

After the fix is green, re-harvest all three pilots offline (`bun run dev rig harvest` — no binary,
no agent quota) and write `docs/dev/2026-08-07-rig-stale-report-correction.md` with before/after per
pilot and per metric, plus a correction to any write-up quoting the superseded numbers. Because
`rig/results/` is gitignored, the table belongs in the document — the numbers are otherwise
reproducible only on this machine.

**No deltas are predicted here, deliberately.** What is established is that finding counts, the M2
denominator and slope, suppression totals and `criticRuns` attribution are wrong on 13 of 36 turns.
Whether recall or escape rate move is an open question the re-harvest answers. The one seeded turn
checked by hand — pilot-01 turn 2 — was caught by a `path-traversal-readtemplate` finding in its
**own** report (run `01KZ8C82`); its two inherited findings are an INFO `generic-interface-coverage`
and a WARN `no-type-constraints`, neither matching the seed tags. So at least one plausible recall
inflation is ruled out, and the rest is unknown until measured.

A re-harvest is deterministic offline recomputation, so it needs no preregistration in the sense the
pilot runs did. The guard against tuning the rule until the numbers look better is that the rule is
fixed **in this document, before** the deltas are computed.

## Out of scope, deliberately

- **`bun run build`.** The driver fix reaches future runs only after a rebuild, which stays a
  separate, deliberately-taken step with its own sha notation. The installed binary stays
  `sha256:fc9b8c18…` for this work, and a second session committing live into this checkout stays
  undisturbed.
- Reading `manifest.turns[].gateReviewed` in the harvester. The `run_id` rule subsumes it: a turn
  the gate never reviewed has an empty audit delta and therefore owns nothing. Adding a second,
  weaker signal would give two sources of truth for one question.
