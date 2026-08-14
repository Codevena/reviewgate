# ReviewGate — Next-Session Handoff

_Last updated: 2026-08-14. Supersedes all earlier content._

## One-line state

**Slice 2A implementation is complete; Task 12's C4 R3 preregistered-Rig-anchor remediation is
unstaged, uncommitted, and ready for its limited delta review. Its permanent guards and two isolated
mutation families are green/killed; the disclosed composite-focus timeout limitation is resolved by
the individual current-source guard evidence below, without raising timeouts or retrying the
composite. No policy pass changed and no paid measurement ran.**

## Current Task 12 C4 R3 — ready for limited delta review

- The C4 R2 delta review found one remaining authority gap: the external publication verifier
  derived Rig singleton and stateful-group source bindings from the mutable published Rig/result
  graph, rather than the byte-verified preregistration. `stats` now passes the preregistered
  `stateful.manifest_ref`/`manifest_sha256` to the closure, requires the published Rig manifest and
  each stateful interaction artifact to match its copied-source binding exactly, and derives all
  expected Rig singleton/group events from that binding.
- Permanent current-primary probes first observed the exact self-consistent substitutions as RED:
  **0 pass / 2 fail / 28 filtered / 8 expects**. With the minimal anchor they are GREEN:
  **2 pass / 0 fail / 28 filtered / 8 expects**. The named green completed naturally after a
  foreign worker appeared post-start; no additional command was launched under contention.
- In the sole authorized disposable copy, both exact anchor-bypass families were killed at
  **0 pass / 1 fail / 29 filtered / 4 expects**: substituting prereg authority with the published
  Rig manifest, and again deriving stateful group sources from the persisted interaction artifact.
  Each source restore matches the primary `stats.ts` SHA-256
  `d8003164a3f998c604b04832d99faf2eb73b73f76280c263b25f2484c7704d56`;
  the complete tracked diff and untracked identity-event source also match the primary tree.
- The final current-source group-substitution guard is GREEN: `bun test
  tests/integration/policy-measurement-pipeline.test.ts -t 'rejects a self-consistent published Rig
  group source substitution'` returned **1 pass / 0 fail / 29 filtered / 4 expects** in **97.23s**.
  The same standalone singleton guard had independently returned **1/0/29/4** in 94.03s; the paired
  two-guard source run was **2/0/28/8** in 175.55s.
- The default-parallel eight-file focus was **124 pass / 2 timeout failures / 1,206 expects** and a
  serial diagnostic was **125 pass / 1 timeout failure / 1,206 expects**. The only failures were
  these individually passing substitution guards crossing their 120s test budget during composite
  scheduling. Controller direction is explicit: do not rerun that composite and do not raise its
  timeout; retain this limitation alongside the standalone current-source evidence.
- After a test-only `unknown`-spread type assertion and mechanical Biome formatting of the affected
  files, fresh `bunx tsc --noEmit` exited 0 and `bun run lint` checked **695 files, no fixes**.
  `git diff --check` and `git diff --cached --check` both exit 0; staging remains empty. No stage,
  commit, push, merge, build, provider, Gate, real Rig, credits, or measurement has run.

## Historical C4 R1 delta

- C4 replaces singleton-label attribution with closed paired-group identity causality. Every
  interaction persists exact sorted worsened/improved identities and its verified group raw refs;
  direct unique and required-backstop facts bind target singleton plus same-group comparison.
  Reproduction requires the target singleton not to worsen and a retained overlapping singleton to
  worsen the exact group identity. Any aggregate or identity-level group harm remains an
  `inconclusive` deletion veto until *every* worsened identity is covered by such a retained
  overlap. No source reread or group-to-pass allocation was added. R1 persists source-bound unit
  events: Bench remains stable at two worsened repeat units, while a verified Rig scenario/turn is
  independently stable at one. Persisted aggregate outcomes must exactly project those rows.
- C4 primary REDs were heuristic cofactor **0/1/1**, omitted group identity **0/1/4**, and
  net-zero uncovered identity wrongly deleting **0/1/3**. Eight disposable current-source mutants
  were killed at **0 pass / 1 fail** each and SHA-restored: same-group bypass, direct inversion,
  missing group refs, absent backstop, cofactor misassignment, any-vs-every coverage, net-zero
  inventory bypass, and signed-inventory closure bypass. R1 REDs were unreachable real Rig
  contribution **0/1/23/3**, count transfer **0/1/29/2**, self-declared zero-singleton retain and
  backstop, a non-retained cover, and source-incomparable event publication **0/1**.
- Final C4 R1 source SHA-256 is
  `identity-events=60a06f77e5fbc03fbf419f1af9dfdc51c3a4cd7055f10be75dc5ab57e79000a4`,
  `schema=14d00571c6c2eb7871c8f1643470b8727f5ecf9796e8ea36b19a346c27d720b0`,
  `assemble=fa76341e6944c791c80e4699c171d4ade339f66ae94b672ce3388b4aa0d0602a`,
  `classify=6afede32c8196582880a56516701eac9a95f223324e162f919649d279d41a1bf`, and
  `stats=68144c44bcab099144eb0e794b773ca1da57bb0aee622167b17777b3d28227ac`.
- Current C4 R1 five-file focus is **94 pass / 0 fail / 1,126 expects**; exact affected eight-file
  regression is **117/0/1,186**. Fresh `bunx tsc --noEmit`, `bun run lint` (Biome 695/no fixes),
  and working-tree/cached diff checks all exit 0.
- C2 separates the one bound suppressed dogfood TP counterexample from broad 5/3 corroboration;
  C3 adds strict additive per-lane Bench/Rig/Dogfood summaries while retaining legacy primary-only
  classification authority. R2 closes the persisted form: catalog-derived pass primary lanes,
  registered interaction authority (history Rig, remaining groups Bench), catalog-derived summary
  inventory, and exact selected-summary projections. R3 makes Dogfood the sole owner of
  supplementary runs/exclusions, keeps manifest/attestation refs lane-specific, and requires each
  top-level pass ref list to be the exact code-unit-sorted union of its lane and interaction refs.
- Four primary-tree R3 schema REDs were **0 pass / 4 fail / 18 filtered / 4 expects**; their GREEN
  is **4 pass / 0 fail / 18 filtered / 4 expects**. The real all-lanes/render fixture is **1 pass /
  0 fail / 18 filtered / 499 expects**.
- The four final-current-source R2 mutants (catalog lane, history promotion, pass parity,
  interaction parity) were killed at **0 pass / 1 fail / 17 filtered / 1 expect** each and
  restored to `policy-measurement.ts` SHA
  `c674523bc9b15509fadd7efa4754369fa6b036e4dd17379d6ce40169bc1389c9` in
  `/private/tmp/reviewgate-c3r2-mutants.v3nuol/repo`.
- The three R3 mutants (Dogfood ownership, selected-summary top-ref overwrite, aggregate-union
  closure) were **0/3**, **0/1**, and **0/1** respectively, each restored in
  `/private/tmp/reviewgate-c3r3-mutants.5F1DLG/repo` to
  `policy-measurement.ts=08eb2083f24069f9a5f907bd591875971a615e5f1273031d5b616c21e1450f63`
  and `assemble.ts=ba33482b07944c76bc2a3982af6124ab4244a90188fce81bc2d75db47a8825f9`.
- R3 convergence now closes persisted lane raw-ref ownership: there is no shared-lane exception
  (Bench profile, Rig replay, and Dogfood frozen-authority refs are distinct; interaction refs
  exist only in the top-level union). Schema/render RED was **0 pass / 3 fail / 22 filtered /
  3 expects**; GREEN is **3 pass / 0 fail / 22 filtered / 3 expects**. Removing the disjointness
  call in `/private/tmp/reviewgate-c3r3-r4-mutants.79wMgM/repo` was **0/3/22/3** and restored the
  current schema SHA `4bf9464b1d303376bfcbbfb9daa2df0322423db5a8d018ef4e0c86d70269063d`.
- Current residual focus is schema **25 pass / 0 fail / 73 expects** plus pipeline **18 pass /
  0 fail**; the prior broader C2/C3 focus remains **100 pass / 0 fail**.
  `bunx tsc --noEmit`, `bun run lint` (Biome 694/no fixes), and both diff checks exit 0. Full
  mutation detail is in `docs/dev/2026-08-11-policy-measurement-mutation-evidence.md` and ignored
  `final-report.md`.
- Next: conduct only the limited C4-R3 delta review of the preregistered Rig anchor, its two
  permanent guards, source-closure side effects, and the disclosed composite timing limitation. Do
  not stage, commit, push, merge, run a full suite, build, provider, Gate, real Rig, credits, or
  measurement before direction.

Immediate next checkpoint: host-clear Task 12 C4-R3 primary verification. The final
controller aggregate regression was fixture-only: stale Stats/publication/classification producers
reused one raw reference across Bench/Rig/Dogfood lane summaries, which the persisted no-sharing
contract correctly rejected. They now assign distinct inventory-bound lane refs and close only the
top-level lane-plus-interaction union; no production/schema exception was added. The exact
eight-file controller command is **105 pass / 0 fail**, with fresh TypeScript, Biome (694 files),
working-tree and cached diff checks clean. Only after Task 12 passes: author and dry-validate the
15 real stateful scenarios (three independent two-opportunity
sequences for each of five stateful passes); accrue explicit dogfood decisions with complete traces;
freeze the audit/trace inventory; obtain the TTY human attestation; then choose and cost the concrete
provider roster. Only after those inputs exist, write and review one committed attempt-specific
`reviewgate.policy-measurement.preregistration.v1` and run exactly one registered capture.
Qwen remains a separate parked measurement stream.

## Checkout state

| | |
|---|---|
| branch | `feat/policy-measurement-pruning` |
| isolated worktree | `/Users/markus/.config/superpowers/worktrees/reviewgate/policy-measurement-pruning` |
| Task-10 code baseline | `34447eaeb33dd08d6e76200197ccd75616b7719a` — `feat(cli): expose policy measurement commands` |
| upstream | none; observed at this checkpoint: branch was 30 commits ahead of `origin/master`, 0 behind |
| pushed? | **NO** — do not push/merge without Markus's explicit authorization |
| locks | `.reviewgate/gate.lock` and Git index lock absent before Task-10 commit |
| main checkout | out of scope; preserve its foreign `.reviewgate/lore/approvals.jsonl` |

## Slice 2A implementation delivered

- `bench policy --preregistration <path> --out <path>` exposes the preregistered one-capture,
  offline-counterfactual Bench boundary without changing existing Bench commands.
- `stats policy --preregistration <path> --bench <path> --rig <path> --out <attempt-dir>` assembles
  Task 9's authoritative in-memory evidence, publishes canonical source copies, `result.json`, and
  `report.md`, and maps typed authority failures to exit 4.
- `stats policy attest-dogfood` is TTY-only, shows the full defanged audit/trace dossier before the
  exact challenge, re-preflights manifest and adjudication after confirmation, and writes one
  content-addressed mode-0600 attestation only on an exact match.
- Existing bare `reviewgate stats [--since|--last|--json]` bytes and semantics remain unchanged.
- The Markdown report renders all 18 passes, four interactions, exclusions, statistics, vetoes,
  raw evidence, unique contributions, and every identity-evidence relationship from the JSON.

## Portable publication contract

The original plan's one-directory-rename/no-replace premise was disproved on this macOS/Bun host:
`renameSync(stage, existingEmptyOutputDir)` replaced the existing empty directory. Task 10 therefore
uses no experimental FFI or native dependency.

The implemented fail-closed protocol is:

1. assemble and validate fully before any final output;
2. build a private sibling stage;
3. reserve final `out` exclusively via non-recursive `mkdir(0700)`, never tolerating `EEXIST`;
4. move staged contents into the reservation and reverify result/report/sources through bounded,
   stable, no-follow FDs at exact private modes;
5. create and reverify canonical mode-0600 `complete.json` last, binding result/report hashes and
   the complete original source ref/SHA inventory;
6. treat any directory without a valid marker as non-authoritative and clean only the exact
   creation-time dev/inode stage/reservation on failure.

## Task 10 evidence

- Final controller focus: **90 pass / 0 fail / 705 assertions**, seven files, 33.36s.
- `bunx tsc --noEmit`: exit 0, empty output.
- `bun run lint`: exit 0, **693 files**, no fixes.
- `git diff --check`, cached diff check, and reviewed payload SHA: clean.
- Eleven publication/CLI mutation families plus three review regressions and the relationship guard
  were killed in disposable copies and restored to recorded SHAs.
- Slot A Round 1 found three CRITICALs: stage-cleanup identity, missing report identity evidence,
  and hidden TTY source identities. Round 2 found one vacuous `reproduced_by` assertion. After the
  fixes, Slot A Round 3 **PASS** and Slot B **PASS**, both with zero CRITICAL/WARN.
- Task-10 code commit: `34447eaeb33dd08d6e76200197ccd75616b7719a`.
- Task-11 documentation commit: `f23b930` — `docs: document policy measurement workflow`.
- Ignored evidence report:
  `.superpowers/sdd/2026-08-11-policy-measurement-pruning/task-10-report.md`.

## Immediate next task — Task 12 final verification

Task 12 owns final serial verification, build/smoke, and final review. The human-authorized
preregistration preparation described above begins only after Task 12 passes. Preserve the
no-provider/no-credits boundary until a separate Markus authorization.

## Traps that still hold

- Never `git add -A`; stage exact paths only.
- Never overlap a local build/test/lint with foreign workers; stop at the next safe boundary.
- A named policy output directory without valid `complete.json` is non-authoritative even if files
  are visible inside it.
- Publication rereads sources only after Task 9 classification and never feeds those bytes back into
  the measurement result.
- Tracked preregistration input may retain repository mode; generated/staged/final artifacts require
  exact private modes.
- Do not run full/static/build/smoke gates early in Task 11; Task 12 owns them. Never run providers,
  paid Bench, real Rig, Gate, credits, or measurement in either task.
- Do not push or merge without Markus's explicit authorization.
- `verify-map.js` was STALE before Task 10; Task 11 must perform the real map audit before advancing
  any verified stamp.

## Read first

1. `.superpowers/sdd/2026-08-11-policy-measurement-pruning/task-10-report.md`
2. `.superpowers/sdd/2026-08-11-policy-measurement-pruning/progress.md`
3. `docs/superpowers/specs/2026-08-11-policy-measurement-pruning-design.md`
4. Task 12 in `docs/superpowers/plans/2026-08-11-policy-measurement-pruning.md`
