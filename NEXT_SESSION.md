# Reviewgate — Next-Session Handoff

_Last updated: 2026-08-05 (afternoon). Supersedes all earlier content._

## One-line state

**The pilot-01 baseline exists.** 12/12 turns reviewed, 61 min, $0.0166 billed; harvested,
reported, ablated, written up, and verified reproducible. Two bugs the run itself exposed are
fixed, plus the duplicate-gate bug from the field.

## What landed this session

| Commit | What |
|---|---|
| `72e717d` | pilot-01 baseline + write-up; phantom-reviewer provenance fix; hook stand-down fix |
| `f4b6761` | per-turn `diff.patch` recording; `reviewgate rig replay` |
| `bc4cc6a` | seed-landing verification (`landedPattern` → `seedLanded`) + the 2/3 correction |
| `0f71051` | gate findings F-002/F-003: added-line matching, 200-char cap, TOCTOU + warning fixes |

Suite **3150 pass / 12 skip / 0 fail** · `tsc` + biome clean · `dist/reviewgate` rebuilt
(`sha256:879a87e5…`) and deployed via the `~/.local/bin/reviewgate` symlink — note that build
PREDATES `bc4cc6a`/`0f71051`, so rebuild before relying on seed-landing from the binary.
**Everything pushed: `origin/master` = `0f71051`.**

## The pilot's results, and what they actually say

| Metric | Value |
|---|---|
| M3 recall | 0.60 (3/5, CI 0.23–0.88) |
| M4 escape rate | 0.20 (1/5, CI 0.04–0.62) |
| M2 FP-burden slope | **+0.0239/turn (n=10)** — against the registered direction |
| M1 iterations | median 1, mean 1.58 ± 0.86, max 3 |
| M6 suppression | critic 0 · reputation 0 · fp-ledger 0 · lore 0 |

Full write-up: `docs/dev/2026-08-05-pilot-01-result.md`. Two findings dominate it:

1. **The rig never verified a seeded defect LANDED** (fixed below). Turn 9 directed a hardcoded
   API token; the agent declined and wrote `process.env.REPORT_API_TOKEN`. Nothing was there to
   catch, and the harvester scored it as a recall miss AND the run's only escape. Turn 4's SQL
   seed likewise never landed. On the three seeds that DID land: **recall 2/3, escape 0/3**
   (an earlier "3/4" here was wrong — it came from checking only the uncaught seeds).
   Turn 7's race landed and was genuinely missed.
2. **No suppression layer ever fired.** critic + lore off by config; fp-ledger held 14 entries,
   all `candidate` with ONE distinct provider (promotion needs ≥2, and the two reviewers
   fragment their `rule_id`s); reputation hit 21 samples for `openrouter:security` at trust
   ≈0.476 against a 0.45 floor. The history-dependent half of the product did not engage in 12
   turns — which is what the positive slope is consistent with.

## Seed-landing verification — SHIPPED (`bc4cc6a`, hardened in `0f71051`)

`RigSeededDefect.landedPattern` (regex, ≤200 chars) is matched against the **added lines** of
the turn's recorded `diff.patch` and drives `RigTurnRecord.seedLanded`. `false` leaves the
recall/escape denominators and gets a `warnings[]` line; the report has a `landed` column.
`null` = UNKNOWN (no pattern, no diff, bad regex) and counts exactly as before, so pilot-01
harvests unchanged.

**It immediately corrected a published number.** Re-scoring pilot-01 with patterns showed
turn 4's SQL seed ALSO never landed (parameterized `$1` + params instead of the directed
concatenation). Two of five seeds never reached the code, so the earlier "3/4 on landed seeds"
was wrong → **2/3**, which is worse for the gate. It also removed a spurious CATCH: turn 4 had
been credited for a finding about a hypothetical `Db` implementation.

**Write patterns that match the DEFECT, not the topic.** `API_TOKEN` matches the safe version
too. My path-traversal pattern (`readFileSync\(`) gave the right answer by luck — it would
match a properly-validated implementation just as happily.

## THE NEXT TASK — the aggregator detangle

`rig replay` is its acceptance test and reports DETERMINISTIC against pilot-01 today, so a
refactor that changes a number cannot hide. Markus' earlier analysis named the aggregator's
~8 suppression passes as the cleanest first cut; the pilot adds evidence, since two of those
layers never fired in 12 turns and their behaviour is currently asserted rather than observed.

A second pilot run is worth doing **after** that, with `landedPattern`s on all five seeds.

## Traps that still hold

- **`rig ablate` requires `--script`** (seeded tags are ground truth). The plan's Task 6 step
  said otherwise and has been corrected.
- **The cassette must live INSIDE the repo under review**, and `$SB` must be the PHYSICAL path
  (`/private/tmp/…`): `runRigRun`'s containment guard compares uncanonicalised paths while the
  recorder canonicalises, so `/tmp/…` is falsely rejected on macOS. **Unfixed — small guard bug.**
- **`.gitignore` the cassette inside the sandbox**, or the untracked recording enters the diff
  being reviewed and feeds reviewer output back into reviewer input.
- **`exit = 0` proves nothing about a turn.** `gateReviewed` in the manifest is the real signal.
- **Do NOT rebuild `dist/` mid-study** — a preregistration pins the binary by hash. (Pilot-01 is
  done, so the current rebuild is fine; the next preregistration must re-pin `879a87e5…`.)
- **Never `git add -A` at the repo root** (stages `.reviewgate/` state). `rig/results/` is
  gitignored: cassettes contain raw reviewer prompts and output.
- **A preregistration may only be re-frozen while zero numbers exist.**

## Open, deliberately not done

- **`rig replay` is a HARNESS self-check, not a pipeline replay.** The literal Task 5 Step 4
  spec is not implementable: re-running the pipeline needs each iteration's reviewer prompt,
  and the cassette stores only `promptSha256`. A true replay needs per-ITERATION prompt
  recording — weigh that against the cassette's leak surface before building it.
- **Four repos are armed without ever being init'ed** (`barrierefrei`, `fatemehdaily`,
  `viergewinnt`, `youtubeQuiz` — `approved_via: human`/`init`, 13.–16.07., before user-scoped
  hooks existed). Since 29.07. the user-scoped hook finds a valid approval there and runs the
  full gate. Disarming them is Markus's policy call, not a bug fix. Off switch for user-scoped
  hooks entirely: `reviewgate init --user --remove`.
- **A transient `GATE POLICY CHANGED` reminder** appeared once mid-session in this repo while
  `config status` said APPROVED, `pending: None`, no `POLICY_CHANGE.md`. Non-blocking by
  design. Unexplained; worth a look if it recurs.
- **3 INFO findings** from the gate's own review of `72e717d` were left unaddressed
  (placeholder-filter asymmetry, id-convention not enforced, sentinel shares the product name).

## The duplicate-gate bug (answered a field question)

Two identical Stop messages per turn came from TWO gates running: the user-scoped shim's
stand-down predicate matched only the CURRENT repo-hook spelling, while `init` wrote an
unquoted form for 17 commits. 7 of 15 local repos were affected and paid double reviewer quota.
`REPO_CLAUDE_COMMANDS` is now a closed, versioned set of exact spellings (the accepted set
widened; the matching rule did not — mutation-checked: the loose-marker rule turns 3 guards
red). Verified against the rebuilt binary in all 7 repos. **No `init --hooks-only` repair is
needed** — the fix covers them.
