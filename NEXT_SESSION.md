# ReviewGate — Next-Session Handoff

_Last updated: 2026-08-14. Supersedes all earlier content._

## One-line state

**Slice 2A implementation and Task 12 are complete. The two final Dogfood publication findings are
closed in review-clean commit `eb7f278` (`fix(policy): bind dogfood lane publication`); final
contract and security/failure-mode reviews both PASS with zero CRITICAL/WARN. The durable dossier,
focused/static/full/build/help evidence, and this handoff are complete. No policy pass changed and
no paid measurement ran.**

## Task 12 final Dogfood closure R2 — complete

- Permanent nonempty real assembly-to-publication RED: a frozen schema-valid Dogfood audit/trace
  pair owned only by `evidence.fact-location` made the prior all-entry assembler seed publish those
  unrelated refs in `judgment.hypothetical` and fail final verification: **0/1/40/1** in 35.04s.
  The fixture has an actual audit chain, complete trace, human attestation, nonempty manifest, and
  asserts both external verification and exact absence/presence of the two run refs.
- `dogfoodForPass` now seeds only the manifest and attestation bindings; its existing `ownsRun`
  loop remains the sole path that adds audit/trace entries. The named GREEN is **1/0/40/6** in
  42.35s. Reintroducing the all-entry seed in the sole copy is **0/1/40/1** in 37.25s; both copy
  and primary restore to `assemble.ts` SHA-256
  `7d77d97e023ed5b6d01eb939cdd89716ce77890c7f1b6d4de0b254da2bff3af7`.
- The prior marker-rebound trace-total guard remains **1/0/40/4** in 51.73s. Dogfood/publication
  focus is **28/0/89** in 1.217s; fresh `bunx tsc --noEmit`, Biome over 696 files/no fixes, and
  working/cached diff checks exit 0. No full suite/build/provider/Gate/live Rig/measurement ran.
- Limited R2 contract delta review: **PASS, zero CRITICAL/WARN**. The real nonempty publication
  guard was freshly **1/0/40/6**; the prior marker-rebound guard was **1/0/40/4**. Review-bound code
  and tests are committed as `eb7f278`.
- Independent security/failure-mode audit found **no exploitable vulnerabilities**. Its validated
  zero-finding report is `~/security-audit-skill/reviewgate/run-1/`; three defense-in-depth notes
  remain non-blocking (descriptor-relative ancestors, non-recursive empty-dir cleanup, stable draft
  attestation read).
- Next: prepare and dry-validate the real 15-scenario/Dogfood/attestation/roster inputs described
  below. Do not start providers, Gate, a real Rig, credits, or measurement—and do not push or
  merge—without Markus's separate authorization.

## Task 12 final Dogfood closure fix — complete

- Permanent real-publication RED: a schema-valid, marker-rebound Dogfood
  `lane_summaries[].trace_totals.applied + 1` bundle was accepted by the former external verifier
  (**0 pass / 1 fail / 39 filtered / 4 expects**, 86.63s). `stats.ts` now derives and exact-compares
  the complete Dogfood lane—opportunities, truth/trace totals, limitations, exclusions, statistics,
  and pass-owned raw refs—from the already byte-verified copied snapshot/manifest values. It adds no
  source reread and leaves `dogfood-snapshot.ts`, schema, and renderer untouched. Its originally
  stated pass-owned projection was correct for the verifier; R2 aligns the assembler producer with
  that same projection for nonempty manifests.
- Final current-source guard is **1/0/39/4** in 53.90s. Its sole-copy comparison-bypass mutant is
  **0/1/39/4** in 51.93s and restored `src/cli/commands/stats.ts` exactly to
  `81bf8e22ba426d9446fe4715281ece34822a14ce00c6a08b086aaaadb4eac066`.
- The only affected synthetic publication producer now generates the source-bound empty Dogfood
  lane rather than the historic placeholder. `tests/unit/policy-dogfood.test.ts` plus
  `tests/integration/policy-measurement-publication.test.ts` are **28/0/89** in 1.26s; fresh
  TypeScript, Biome (696 files/no fixes), and working/cached diff checks are green.
- The first delta review found the nonempty-manifest producer mismatch documented above; after R2,
  the final contract convergence review is PASS with zero CRITICAL/WARN.

## Task 12 final execution evidence

- The tracked dossier now closes every Task 1--10/C1--C5 family. Seven formerly compact Task 2--8
  families were recreated once in the sole authorized copy with numeric REDs, exact commands, and
  byte restores; restored combined GREEN is **7 pass / 0 fail / 114 filtered / 57 expects**. This
  is recorded as current-contract recovery, never as an invented historical result.
- Exact 13-file Task 12 focus: **173 pass / 0 fail / 2,115 expects** in **657.12 s**. Fresh
  `bunx tsc --noEmit` exit 0; `bun run lint` checked **696 files/no fixes**; working/cached diff
  checks exit 0.
- Exactly one post-fix full run executed and exited 0: **3,707 pass / 12 skip / 0 fail / 14,269
  expects**, 3,719 tests across 466 files in **843.08 s**. Its log is
  `/tmp/reviewgate-policy-slice2-full-postfix.txt`; it was neither piped, retried, nor retuned.
- `bun run build` exit 0 (259 modules), then compiled `bench policy`, bare `stats`, and `stats
  policy` help each exit 0. The C4 eight-file composite timing limitation is historical and still
  disclosed; it was not rerun.
- The exact full/build evidence predates the narrow final Dogfood review fix and was deliberately not
  rerun. That fix instead has its named end-to-end guards, mutation reversions, fresh TypeScript,
  Biome, diff checks, and two independent clean delta/security verdicts. No Gate, provider, credits,
  live Rig, real measurement, push, or merge occurred.

## Completed Task 12 C5 checkpoint

- Authoritative Bench lane statistics now persist all 90 case/repeat observations and exact source
  dossiers, their raw projection, case-level mean/median, three preregistered repeat directions,
  FP/FN, precision/recall, final-trace blocking/severity/verdict deltas, and explicit limitations.
  Dogfood `declined` is a separate signed disposition, never a missing attestation. Markdown renders
  each persisted statistic and dossier from the same result JSON.
- The canonical real 30-case fixture intentionally lacks TP/FP/FN denominators and renders explicit
  unavailable triples plus limitations. A distinct non-vacuous 30-case fixture has baseline
  `TP/FP/FN=2/0/1` and singleton `1/1/2`; its current-source guard proves precision
  `1 -> 1/2` (`-1/2`) and recall `2/3 -> 1/3` (`-1/3`) in JSON and Markdown: **1/0/33/4** in
  46.35s. The complete 90-effect/complete-dossier parity guard is **1/0/33/115** in 49.88s.
- An exact two-file integration run was **39/1/40** (468.54s). The sole failure was a real C5
  behavior regression: empty no-opportunity repeat directions selected `direction-conflict` before
  `insufficient-opportunities`. Test-first RED **0/1/19/1**, minimal threshold-precedence GREEN
  **1/0/19/2**, and current real output GREEN **1/0/33/2** restore the baseline semantics. Removing
  the prerequisite in the sole copy is **0/1/19/1** and restores `classify.ts` byte-exactly to
  `1cf41c723c5e00bf2f8c863a88e1b06c894972a860aef10d4dc392232f96cf68`.
- C5 calculation/omission mutations for finite precision, finite recall, and rendered rate details
  are killed/restored at **0/1/33/2**, **0/1/33/3**, and **0/1/33/4**. C5 R1 closes the later
  external-authority review: copied-source Bench/Rig statistics and case dossiers, Dogfood snapshot
  and `declined`, Holm adjustment, and exact Markdown projection are recomputed before publication.
  The pure Dogfood core shares its verified entry buffer with audit/trace validation; removing its
  cache is **0/1/21/1** (three reads instead of two) and is SHA-restored in the sole copy.
- Current final C5 evidence is five-file units **93/0/270**, eight named pipeline guards
  **8/0/687**, publication **6/0/30**, C1--C4 sample **6/0/20**, fresh `tsc` exit 0, and Biome
  **696 files/no fixes**; working and cached diff checks are both clean. The first TypeScript RED
  found only nullable-delta narrowing plus missing typed fixture limitations; all are minimally
  fixed. The independent C5 R1 delta review is **PASS, zero CRITICAL/WARN** and reproduced the
  permanent authority/parity guards and bypass mutations. The exact 19-path C5 checkpoint is commit
  **`39fdacb`**. No push, merge, build, provider, Gate, real Rig, credits, or measurement has run.

## Completed Task 12 C4 R3 checkpoint

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
- The limited convergence review is **PASS, zero CRITICAL/WARN**. It independently reproduced both
  permanent guards and both anchor-bypass mutants, verified byte-exact restoration, and passed the
  immediate fixture side-effect checks. After a test-only `unknown`-spread assertion and mechanical
  Biome formatting, fresh `bunx tsc --noEmit` exited 0, `bun run lint` checked **695 files/no fixes**,
  and both diff checks passed. The exact 15-path checkpoint is commit **`68b2b0e`**. No push, merge,
  build, provider, Gate, real Rig, credits, or measurement has run.

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

Task 12 has now passed its final contract and security gates. Its earlier final controller
aggregate regression was fixture-only: stale Stats/publication/classification producers
reused one raw reference across Bench/Rig/Dogfood lane summaries, which the persisted no-sharing
contract correctly rejected. They now assign distinct inventory-bound lane refs and close only the
top-level lane-plus-interaction union; no production/schema exception was added. The exact
eight-file controller command is **105 pass / 0 fail**, with fresh TypeScript, Biome (694 files),
working-tree and cached diff checks clean. Next, author and dry-validate the
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

## Immediate next task — measurement input preparation (no paid run yet)

Task 12 passed. Prepare and dry-validate the 15 real stateful scenarios, accrue/freeze the complete
Dogfood audit/trace inventory, obtain the TTY human attestation, and then choose/cost the concrete
provider roster. Only after those inputs exist should one attempt-specific preregistration be
written and reviewed. Preserve the no-provider/no-credits boundary until a separate Markus
authorization; Qwen remains a separate parked measurement stream.

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
