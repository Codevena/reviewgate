# ReviewGate — Next-Session Handoff

_Last updated: 2026-08-14. Supersedes all earlier content._

## One-line state

**Slice 2A implementation is complete; final verification remains pending in Task 12. No policy
pass changed and no paid measurement ran.**

Immediate next checkpoint: complete Task 12 final verification, static/build checks, compiled CLI
smokes, and final contract/security review. Only after Task 12 passes: author and dry-validate the
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
