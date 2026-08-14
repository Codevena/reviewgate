# ReviewGate — Next-Session Handoff

_Last updated: 2026-08-14. Supersedes all earlier content._

## One-line state

**Task 9 is review-clean and locally committed as `0bb0114`. Exact focus is 109/0/571, affected
Task2–8 is 180/0/1,034, and TypeScript/Biome/diff gates are clean. The next implementation task is
Task 10 (atomic publication plus CLI/report). No push, merge, build, provider, Rig, Gate, credits,
or measurement has occurred.**

## Checkout and publication state

| | |
|---|---|
| branch | `feat/policy-measurement-pruning` |
| isolated worktree | `/Users/markus/.config/superpowers/worktrees/reviewgate/policy-measurement-pruning` |
| HEAD | `0bb0114963aef84aec42337976d33c04d0ea4652` — `feat(stats): assemble authoritative policy evidence` |
| upstream | none; branch is 28 commits ahead of `origin/master`, 0 behind |
| pushed? | **NO** — do not push/merge without Markus’s explicit authorization |
| locks/processes | `.reviewgate/gate.lock` absent; `.git/index.lock` absent; Task-9 subagent interrupted at a safe boundary; no ReviewGate Bun/tsc/Biome process left running |
| main checkout | out of scope; preserve its foreign `.reviewgate/lore/approvals.jsonl` |

## Done and verified

- Tasks 1–8 are committed through `e86fd56`. Their commits/evidence live in
  `.superpowers/sdd/2026-08-11-policy-measurement-pruning/progress.md` and the ignored task reports.
- Task 8’s final evidence was 103/103 Bench focus, 19/19 Task-2/3 regressions, 11/11 mutation
  families, TypeScript/Biome/Diff clean, independent review PASS without CRITICAL/WARN.
- Task 9’s original implementation reached focused 4/4 (66 assertions), schema/dogfood 32/32,
  Task-7 Rig 5/5 and the original 8/8 mutation families. These are prior implementer evidence, not
  a final claim for the current post-review diff.
- Independent Task-9 review correctly stopped the commit on authority/evidence gaps A–G. The
  current worktree addresses exact HEAD-bound preregistration, no-reread Bench/Rig verifier
  returns, complete provenance/inventory, real canonical Bench verification, identity-level
  unique/reproduced evidence, sequence-level Rig statistics, Dogfood effect attribution and typed
  exclusions.
- Review finding E has a fresh TDD witness on the current tree: exact full Rig artifact closure was
  RED at 0 pass / 1 fail / 2 expectations with 13 refs missing, then GREEN at 1 pass / 0 fail /
  2 filtered / 25 expectations after the in-memory no-reread fix.
- Review finding G’s suspected Git bug was retracted with a corrected disposable-repo proof:
  `git ls-files --others` does include ignored files when `.gitignore` is committed. Preserve the
  current bounded scan; its valid mutant removes the scan entirely (expected reject count 2→0).
- The later independent review found four real Bench/assembly gaps and all have current local
  RED→GREEN evidence: trace-set identity fields and prereg-derived config provenance; exact
  30-case id/kind/content hash plus `case.json` label-count truth manifest; fail-closed
  no-opportunity singleton/interaction output differences; and `blocking-fn` to
  `preserved-blocking-tp`. Details and SHA-restored mutations are in the ignored Task 9 report.

## Task 9 committed and verified

Task 9 committed exactly these 16 implementation/test/plan paths; this handoff remains the only
separate tracked documentation change:

- `docs/superpowers/plans/2026-08-11-policy-measurement-pruning.md`
- `src/bench/runner.ts`
- `src/cli/commands/bench.ts`
- `src/rig/policy-replay-state.ts`
- `src/schemas/bench-result.ts`
- `src/schemas/policy-measurement.ts`
- `src/stats/policy/{assemble,dogfood,rig}.ts`
- `tests/unit/policy-{assemble,dogfood,measurement-schema,rig-evidence}.test.ts`
- `tests/unit/bench-policy.test.ts`
- `tests/unit/rig-replay.test.ts`
- `tests/integration/policy-measurement-pipeline.test.ts`

The latest B hardening independently accumulates the trusted scenario + validator artifact union
and compares it to the emitted Rig inventory. Its real fixture expects exactly 217 refs
(15 cassette / 30 trace / 126 state / 61 declared). The first 0/1 run only corrected a mistaken
expected state count (111→126) and is **not** behavioral RED evidence. The real-fixture GREEN and
injected-extra mutant are recorded in the Task 9 report: the exact compare admits 217 refs, while
the bypass admits 218 and makes the named assertion RED.

The earlier complete pipeline was 11/0 (138 assertions), final exact Task-9 focus 103/0 (556
assertions), affected Task-2–8 regression 180/0 (1,031 assertions), and static/diff gates green.
Those predate the residual delta-review finding. The current remediation has a named unmocked
request RED of 0/1/11 filtered/1 expect (expected exit 4, received 0) and raw-response closure RED
of 0/1/12 filtered/1 expect; their minimal GREENs are in the ignored Task 9 report. The final-source
focus is now 108/0/569. The four request/reorder/reuse/partial mutations each killed the named guard
at 0/1/15 filtered/1 expect and were restored. The affected current source is green as
`bench-policy` 6/0/87 plus the remaining ten files 174/0/947 (180/0/1,034); a single bundled run
timed out only the corpus test at 5,001 ms amid post-reboot system CPU activity, but that test then
completed isolated in 176.78 ms. Fresh tsc, lint, and diff checks passed. The implemented owner/schema expansion is
`src/bench/runner.ts`, `src/schemas/bench-result.ts`, and `tests/unit/bench-policy.test.ts`; it is
limited to closing authoritative policy bundles while retaining additive legacy parsing. No full
suite or build was attempted; Task 11 owns those. No provider, paid Bench, real Rig, Gate, credits
or measurement ran.

Delta-review3 then found one further authority gap: optional legacy `raw_response_sha256` combined
with an omission-filtering `flatMap` accepted deletion of the same digest in a manifest and trace.
The named real RED was 0/1/16 filtered/1 expect (exit 0 instead of required 4); policy authority
now requires every consumed span entry to be successful, case-bound and digest-present before direct
sequence comparison. GREEN is 1/0/16 filtered/2 expects; a disposable presence/direct-map bypass
returned 0/1/16 filtered/1 expect, then restored to 1/0/16 filtered/2 expects at
`bench.ts=e08e83d…`. The following focus was contaminated by a newly appearing foreign Vitest
worker and ended 108/1/571 only on a 5,027 ms Blocking-FN timeout. Its missing-digest test passed.

Round 4 closed the delta review: both independent slots returned PASS with no CRITICAL/WARN. Slot A
reran the exact missing-digest authority test at 1/0/2 (16 filtered) in 14.43 s; Slot B's reading
review also passed. The review observed unchanged source witnesses and green diff checks. The exact
16-path commit is `0bb0114963aef84aec42337976d33c04d0ea4652`; no Task-9 code remains uncommitted.

## Current machine condition

The current volume had about 17 GiB free after the final gates. The response-mutation clone was
`/private/tmp/reviewgate-task9-response-mutants.ZusYlz/repo`; it is disposable and must never be
used for production edits. The final static preflight found no foreign test/build/tsc/lint worker
and no locks. Recheck before any future runtime command.

`verify-map.js` reports STALE: the AGENTS trailhead stamp `eb602b3` is 63 commits behind and many
areas changed. No trailhead stamp was advanced because the required full map audit was not done;
`AGENTS.md` remains exactly 80 lines and untouched.

## THE NEXT TASK — Task 10: atomic publication and CLI/report

Start from committed Task 9 `0bb0114` and execute Task 10 in the written plan. It must publish the
authoritative in-memory result atomically, render the report, and expose the CLI without changing
policy semantics or spending provider credits.

1. Read Task 10 in the plan plus the Task-9 report/ledger interfaces it consumes.
2. Begin with the specified report-parity and fail-closed publication REDs before production edits.
3. Preserve Task 9's no-reread contract and exact closed artifact inventory.
4. Use explicit paths for every checkpoint commit; keep this `NEXT_SESSION.md` handoff separate.
5. Do not run a real provider, paid Bench, real Rig, Gate, measurement, build, push, or merge without
   the corresponding later task or Markus's explicit authorization.

## Traps that still hold

- Never reread persisted Bench/Rig artifacts in Task 9. Existing verifiers return already verified
  parsed values, refs, hashes, state files and source identity in memory.
- Never create directory pseudo-authority or exempt a broad generated root. Only concrete files in
  the closed verified inventory may be untracked; a rogue sibling must reject.
- Do not add a second self-declared Rig inventory merely so a manually forged schema object can
  detect its own extra row. The reachable authority is the collector’s independent union of trusted
  verifier results.
- History interaction raw refs mean the **complete** relevant verified Rig closure on the
  interaction and every member, including cassette/trace/state—not a subset.
- Protected Dogfood evidence is preserved observation, not automatically a unique contribution of
  the demoter itself. Retain requires attribution-valid protection or observed counterfactual loss.
- Rig sequences are independent sequence-level effects, never synthetic repeats. A `ran` pass with
  zero opportunity is no evidence.
- Do not invent preregistration fields that do not exist (for example CLI version or route). Bind
  only persisted source/release/runner/cap/attempt/roster facts actually present.
- Never `git add -A`; stage exact paths. Never touch main-checkout lore state. No push, merge,
  build, Gate, provider, paid measurement or real Rig without explicit authorization.

## Read first

1. `.superpowers/sdd/2026-08-11-policy-measurement-pruning/progress.md`
2. `.superpowers/sdd/2026-08-11-policy-measurement-pruning/task-9-report.md` (especially all
   `Recovery` sections at the end)
3. `docs/superpowers/specs/2026-08-11-policy-measurement-pruning-design.md`
4. Task 9 in `docs/superpowers/plans/2026-08-11-policy-measurement-pruning.md`
