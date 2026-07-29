---
schema: reviewgate.lore.v1
id: codex-sandbox-readonly-by-design
status: canon
anchors:
  - "src/providers/codex.ts"
verified_at: 2026-07-29
verified_tree: "bc890a0c8c85cd90a3bd4951f652377facd5a87472557396dd1a6b7eb1ebef01"
tags: []
---
Why the codex reviewer adapter pins codex to a READ-ONLY sandbox even though the
human review pipeline requires `--sandbox workspace-write`: the two use codex
differently. A human-driven codex review must WRITE a findings file, so it needs
workspace-write. The reviewer adapter instead parses codex's STDOUT and never
writes a findings file, so it deliberately keeps codex read-only — a reviewer of
untrusted diff content should have the least privilege that still works.

Do not "fix" the adapter to pass workspace-write to match the docs: that would be
a needless privilege escalation for a component that only reads. The adapter is
intentionally immune to the workspace-write requirement. (Separately: `codex exec`
must run in the foreground with stdin closed — backgrounding or an open stdin
makes it hang on "Reading additional input from stdin…".)
