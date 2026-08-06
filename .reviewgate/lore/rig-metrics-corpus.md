---
schema: reviewgate.lore.v1
id: rig-metrics-corpus
status: draft
anchors:
  - "rig/scripts/*.ts"
  - "src/rig/harvest.ts"
  - "src/rig/ablate.ts"
  - "src/rig/driver.ts"
verified_at: 2026-08-07
verified_tree: "fa4fce637e30172ef2be5d4c87dc30b7b5ae6e749c2986ec7fa04ca53d1ca677"
tags: []
---
Why rig analysis reads `cassette.jsonl` rather than the archived `pending.json`
reports, even though the reports are already parsed and turn-indexed.

`rig/results/*/turns/*/reports/*-pending.json` holds **post-aggregation
survivors**. A finding the critic dropped, one folded into a merge, or one
suppressed by any later layer is either absent or projected down into
`members[]`. Any rate computed over those files is therefore a rate over what
survived, which is the correct denominator only for questions about the gate's
final output.

For a pass that runs BEFORE aggregation, that denominator is wrong, and it is
wrong in the direction that makes the pass look useless: exactly the findings the
pass acted on are the ones most likely to have been dropped afterwards. This is
not hypothetical. Slice A's field record was published as "1 opportunity in 36
turns, mechanism unobserved" on that basis; replaying the raw reviewer output
found 7, all repaired, five of them in the single turn the feature was designed
from. The write-up conclusion inverted.

The pre-aggregation record is the cassette, which stores each provider call's raw
`Finding` objects before any gate pass touches them. Its entries carry no turn
field; attribution comes from `manifest.turns[].cassetteBytes {before, after}`,
sampled around each turn by the driver, which tiles the file exactly.

Two further properties of these artifacts are load-bearing and easy to get wrong:
`turns/<T>/diff.patch` is CUMULATIVE against the base commit and captured at END
of turn, so it is the tree the reviewer saw only for findings from the turn's
final panel run; and the audit tree is append-only and cumulative per snapshot,
so a turn's own iterations are the set difference against the previous turn's
snapshot. pilot-01 predates `diff.patch` entirely and has per-turn line counts
only, via `research.md`'s `+N/-0` changed-file rows.

Full derivation and the numbers: `docs/dev/2026-08-06-slice-a-corpus-replay.md`.
