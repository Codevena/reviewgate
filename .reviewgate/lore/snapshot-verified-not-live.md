---
schema: reviewgate.lore.v1
id: snapshot-verified-not-live
status: draft
anchors:
  - "src/cli/commands/gate.ts"
  - "src/core/orchestrator.ts"
  - "src/core/reviewed-snapshot.ts"
  - "src/utils/git.ts"
  - "src/core/workspace-settle.ts"
verified_at: 2026-07-23
verified_tree: "711ad3d6fa30f389a428ebeb603ccca0b4a71a2b9ebbff769fca29cd5e91311c"
tags: []
---
Why the review target needs post-capture verification: a single read of the live
working tree is not a safe review input. A cooperating parallel writer such as an
in-place mutation test or code generator can temporarily produce an internally
consistent state that never belongs to any commit, causing reviewers to report
phantom findings.

The gate therefore requires two consecutive agreeing diff, tree-fingerprint,
and per-file identity-manifest rounds before treating a capture as stable. The
manifest passed to delta/content-identity logic must come from that accepted
round, never from a later live-tree read. This is defense-in-depth, not an
isolation boundary: a mutation held across the entire verified window is
indistinguishable from real work. The guaranteed operational fix is to run
mutation tests and similar transient writers in a copy or worktree, never
in-place concurrently with turn-end.
