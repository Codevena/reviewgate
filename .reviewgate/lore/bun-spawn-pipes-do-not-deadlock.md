---
schema: reviewgate.lore.v1
id: bun-spawn-pipes-do-not-deadlock
status: draft
anchors:
  - "src/rig/driver.ts"
verified_at: 2026-07-30
verified_tree: "260f45b1b595a7276845afd31db84dfd29b5d04f079556f5bd1ebfda515de7d9"
tags: []
---
Why an undrained `stdout: "pipe"` is not a deadlock in this codebase, and why a reviewer
saying otherwise is reasoning from the wrong runtime.

The classic hazard is real in Node: `child_process.spawn` with piped stdio that nobody
reads fills the ~64KB OS pipe buffer, the child blocks in `write()`, the parent blocks
waiting for exit, and neither proceeds. Every LLM reviewer has seen that pattern, and it is
the single most confidently-reported finding this file has attracted.

`Bun.spawn` does not behave that way. It drains the pipe into its own buffer as data
arrives, independently of whether anything consumes `proc.stdout`. Measured on this
machine, undrained, through `await proc.exited`: 1MB in 47ms, 16MB in 107ms, 128MB in
1108ms — no blocking at any size. A regression test written to catch the "deadlock" passed
unchanged when the piped version was restored in a worktree copy, which is the second,
independent way of showing the failure mode is absent.

This was adjudicated once already, against a CRITICAL finding that two reviewers agreed on
at confidence 0.97. Both were wrong for the same reason, so consensus is no evidence here:
agreement between two models that share the Node prior is one prior, not two observations.

The driver does write to a file descriptor rather than a pipe, but for reasons that have
nothing to do with deadlock: it keeps the per-turn agent transcript the interview stage
reads, and it keeps a multi-megabyte turn out of the parent process's memory, which the
piped version would accumulate for the whole run. Do not "simplify" it back to a pipe on
the strength of the memory argument being small, and do not re-add a deadlock rationale to
justify it — the first is a judgement call, the second is false.
