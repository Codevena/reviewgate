# In-range mis-anchors — the population is real, the cost is not (yet) measurable above zero

_2026-08-07. Decision input for "Slice C", the in-range half of the anchor-repair question left open
by `docs/dev/2026-08-06-slice-a-corpus-replay.md`. Instrument: the IMPACT section of
`rig/scripts/anchor-replay.ts`. Offline: no network, no quota, no rebuild, no `src/` change._

## Question

The corpus replay found that only **4 of 16** in-range findings carrying a quote are anchored to the
line they quote; **7** quote a different real line. It called that "the bigger hole". But sizing a
population is not the same as showing it matters: unlike a Slice A victim — demoted to INFO and told
it was "almost certainly hallucinated" — an in-range mis-anchor **keeps its severity, its file, and
its correct quote**. It is off by a few lines.

So: **does being off by a few lines cost anything the gate actually does?**

## Answer

**In this corpus, no measurable cost — and the repair itself is the more dangerous operation.**

| | |
|---|---:|
| turns whose cluster partition changes when the 7 mis-anchors are repaired | **0 of 4** |
| turns where the repair changed region-merge *eligibility* | **4 of 4** |
| mis-anchors whose `computeSignature` identity changes when repaired | **2 of 7** |
| mis-anchored quotes matching more than one line (tie-break exposure) | **0 of 7** |

The zero is not the trivial "the offsets are too small to reach the merge window". Eligibility moved
in **every** affected turn — the repair destroys a co-location in `pilot-02 t9`, creates one in
`pilot-03 t4` and `pilot-03 t10`, and reshuffles five in `pilot-02 t2`. The partition survives
anyway, because in every case the N6 high-stakes category guard (`aggregator.ts:279-281`) blocks the
region merge across the security/correctness boundary in **both** arms.

That makes the zero **real but contingent**: it holds because of the category mix in this corpus, not
because a 1–7 line offset is beneath the mechanism's resolution.

## The finding that decides it

`pilot-03 t4`, repaired arm:

```
REPAIR-CREATED: src/db.ts:21(correctness)↔18(architecture)  ← did not merge here
```

`no-db-handle-validation-race` sits at line 21. `global-state-dependency` cites line 15 and quotes
line **18**. Repairing it moves the two findings to **3 lines apart** — inside `REGION_WINDOW` — where
`aggregate()` would merge two plainly distinct defects under **one** representative and **one**
agent decision. Only the high-stakes guard stopped it, and only because `architecture` is not a
high-stakes category. Had both been `correctness`, the repair would have bundled them.

This is the net-new harm class stated abstractly in the handoff, now demonstrated concretely: **an
in-range repair moves a finding nothing currently touches, and the move can manufacture a merge that
buries a real defect.** Slice A can never do this — it only ever fires past EOF on a finding already
headed for a demote.

Against that, the measured upside over the same 7 instances is: zero merges recovered, zero
corroborations recovered, and 2 signature identities changed (which is a cost as often as a benefit —
it is what the FP-ledger, the per-cycle rejection suppression, the fix-verification pin and
location-recurrence all key on).

## Recommendation: do not spec Slice C

Not "never" — **not on this evidence**. The measured benefit is zero, the demonstrated risk is a
manufactured merge, and the change would additionally have to overturn a documented fail-safe:
`attestEvidence:234` deliberately treats "quote matches a different line" as *the agent moved the
code — ambiguous*, and declines to act. Reversing that on n = 7, of which 3 were hand-verified,
inverts an adjudicated decision on thin evidence.

One genuine surprise argues *for* feasibility if this is ever revisited: **tie-break exposure is 0 of
7** — every mis-anchored quote matches exactly one line. The determinism objection (that
`reanchorByEvidence`'s "nearest == last, no tie possible" argument holds only past EOF) is real in
principle but did not bind once in this corpus. That lowers the implementation risk; it does nothing
for the payoff, which is the part that is missing.

## How it was measured

- **Real functions, never reimplementations.** `aggregate()` from `src/core/aggregator.ts`,
  `computeSignature` from `src/diff/signature.ts`, `enclosingSymbol` from
  `src/research/symbol-graph.ts`, `REGION_WINDOW` imported rather than written as `5`.
- **Real inputs.** Each turn's arm A is the post-`validateFindingFacts` finding set of that turn's
  final panel run — exactly what the field run handed to `aggregate()`. Arm B differs *only* in the
  `line_start`/`line_end` of the mis-anchors.
- **Repair target chosen as the shipped code would**: nearest match to the cited line, ties to the
  earlier line (`reanchorByEvidence`'s strict `<` over an ascending scan).
- **GUARD 7 (new).** A finding's real signature is line-derived, so it cannot label a finding across
  two arms that differ in line; the script substitutes a stable per-row id. That substitution would
  invalidate the comparison if clustering read `signature`, so the script re-runs arm A with the
  **real** signatures and aborts if the cluster shape differs. It does not.
- **One measurement error found and fixed mid-run.** `reviewersTotal` was first counted from
  reviewers that *returned findings*, which reported 1 reviewer for three of the four turns and would
  have made the consensus comparison look powerless. Counted from reviewers that *ran* (the field's
  own definition, what `computeConsensus` divides by) it is **2 for all four turns**, so a lost
  corroboration was observable everywhere. The four original self-checks are unchanged and still gate
  every number above.

## Limits

- **n = 7 mis-anchors across 4 turns, one panel** (`deepseek-v3.2` security + `glm-5.2:cloud`
  correctness), 3 pilot runs. A different panel is a different system.
- **The zero is contingent on the category mix.** Every blocked merge was blocked by the high-stakes
  guard. A corpus where co-located findings share a stakes class would very likely show partition
  changes — in *both* directions.
- **`rig/results/` is gitignored.** The script is committed; its inputs are local to this machine, so
  every number here is reproducible only here.

```bash
bun run rig/scripts/anchor-replay.ts     # the IMPACT section is the last block
```
