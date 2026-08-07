# Reviewgate — Next-Session Handoff

_Last updated: 2026-08-07, after the Slice B revert plan passed its plan-gate.
Supersedes all earlier content._

## One-line state

**Both slice questions are measured and decided. Slice C: declined. Slice B: REVERT, and the revert
plan has PASSED its plan-gate (2 rounds, 2 independent slots, Slot A executing). The next session
IMPLEMENTS that plan — the four tasks are fully specified and every claim in it was verified by
execution, including in a simulated-revert repo copy.**

## Verified state (checked with commands at handoff time)

| | |
|---|---|
| `HEAD` | **`71ce138`** — Trailhead stamp. **7 commits ahead of `origin/master`, UNPUSHED.** |
| my commits this session | `709390d`, `64bcabc`, `fddc129`, `e3d115c`, `71ce138` |
| **NOT my commits** | `c7fd17e`, `490d746`, `e17de4e` (Qwen reviewer spec/plan) — a **second session** is committing to this same checkout, live. |
| working tree | one file modified, **not mine**: `.reviewgate/lore/approvals.jsonl` (two `cli:lore-approve` entries) |
| suite | **3191 pass / 12 skip / 0 fail**, exit 0 — last run at **`709390d`**. Everything after that is docs/plans only, from me AND the other session; **I did NOT re-run it at `71ce138`** |
| `tsc` / `lint` | clean at `709390d`; rig `tsc` + biome checked separately (rig/ is outside tsconfig) |
| build | **deliberately NOT run.** Installed binary still `sha256:fc9b8c18…` |
| Trailhead | stamped to `e17de4e`, `MAP OK`, 70/70 paths. Both GEÄNDERT rows (`src/rig/harvest.ts`, `rig/scripts/`) were mine and verified; entry point `src/rig/driver.ts` still correct |
| `src/` changed all session | **one `export` keyword** — `matchesAddedLine` in `src/rig/harvest.ts` |

⚠ **A SECOND SESSION IS COMMITTING TO THIS CHECKOUT.** Seven commits are unpushed and three are not
mine. Do not `git add -A`, and check `git log` before assuming what is yours. Isolating parallel
work in a `git worktree` is the standing recommendation.

## THE NEXT TASK — implement the approved Slice B revert

**Read `docs/superpowers/plans/2026-08-07-slice-b-revert.md` and execute its four tasks.** It passed
the plan-gate; do not re-open the decision, and do NOT resurrect "narrow" (refuted by execution —
see below).

**Why it is next:** the critic severity floor bars the critic from demoting a WARN
security/correctness finding below WARN. Measured across the whole recorded corpus it fired 3 times,
protected a false positive all 3 times, and protected 0 true positives. The one time the critic
proposed demoting a catch of a seed that actually landed, **corroboration** — not the floor — is what
saved it. It costs precision and has not yet bought anything.

**Entry point:** `src/core/aggregator.ts:611-619` (`isBlockingSecurity` / `isSecurityProtected`).

The four tasks, in short: (1) delete `isBlockingSecurity`, collapsing `isSecurityProtected` to the
CRITICAL-only check; (2) invert the two floor tests in `tests/unit/aggregator-critic.test.ts` and
update the cross-reference comment at `tests/unit/anchor-repair-cascade.test.ts:127-128` that quotes
the describe name; (3) confirm three neighbouring guards stay green **unchanged**; (4) record the
reversal in the design spec without deleting the original rationale.

**Then the POST-implementation pipeline** — a separate gate from the one already passed: static
checks, the mutation check in a **copy** (restore `isBlockingSecurity`; the two Task-2 tests must go
red), then two reviewer slots.

**One verification step is easy to miss:** `bun run rig/scripts/critic-floor-replay.ts` must go from
3 activations to **0** after the revert — and its self-check "pilot-03 reproduces its 1 field
activation" will then abort by design. Update that assertion to expect 0 **in the same commit**.
Slot A already confirmed by execution that 3 → 0 holds once that assertion is updated.

## What got done this session

1. **Slice C declined, on measurement** — `docs/dev/2026-08-07-in-range-mis-anchor-impact.md`.
   Repairing all 7 in-range mis-anchors changes **0 of 4** cluster partitions. That is not the
   trivial "offsets too small": region-merge **eligibility moved in 4 of 4 turns**, and the
   partition held only because the N6 high-stakes guard blocked the merge in both arms. The
   decisive case is `pilot-03 t4`, where the repair **creates** a co-location between two distinct
   defects 3 lines apart — the net-new harm Slice A structurally cannot cause. Tie-break exposure
   is 0/7 (every quote matches exactly one line), which lowers implementation risk but does nothing
   for the missing payoff.
2. **Slice B counterfactual + discriminator** —
   `docs/dev/2026-08-07-slice-b-critic-floor-counterfactual.md`. pilot-01/02 ran binaries WITHOUT
   the floor, so replaying their recorded findings + recorded critic verdicts through today's
   `aggregate()` is a free, unbiased counterfactual. 3 activations, 3 false positives, 0 true
   positives. The discriminator then asked whether the critic ever *proposes* demoting a real
   catch: it does (2 of 15 likely_fp verdicts hit a seed-tagged finding), but only 1 sat on a seed
   that actually **landed**, and **corroboration — not the floor — is what saved it**.
3. **`rig/scripts/lib/corpus.ts`** — the shared corpus/tree machinery, extracted so the two replays
   cannot drift. Verified by anchor-replay's output being **byte-identical** before and after.
4. **Six gate findings fixed** (`709390d`), one of which was a real correctness bug — see traps.

## Traps — NEW this session

- **Never reimplement a shipped helper in a rig script.** `seedLanded` reimplemented
  `harvest.ts`'s landing check and got the semantics wrong: it tested the WHOLE patch text instead
  of only lines the agent **ADDED**, so a seed matching a context line or a **removed** line —
  exactly where the defect is gone — would score as "landed". The whole discriminator rests on that
  flag. It also re-introduced the `m` flag and the `existsSync`-then-read TOCTOU that `harvest.ts`
  had already fixed in its own gate. Import the helper; the reviewers caught all three.
- **`applySymbolSignatures` runs BEFORE `validateFindingFacts`** (`orchestrator.ts:2219` then
  `:2226`). Reversed, Slice A's `line_start` rewrite makes every critic signature miss — and an
  empty critic map masquerades as "the mechanism never fired".
- **"Last critic call = final panel run" is WRONG when a turn re-reviews.** pilot-02 t7 ran the
  panel twice (2 findings, then 0); its critic call belongs to the FIRST iteration. Pair each
  critic call to its iteration by **signature containment** — self-verifying, because a wrong
  reproduction contains nothing.
- **`reviewersTotal` must count reviewers that RAN, not reviewers that RETURNED FINDINGS.** The
  wrong count reported "1 reviewer" for 3 of 4 turns and would have made a consensus result look
  powerless. It is 2 for all of them.
- **A rate over `reports/*-pending.json` is a rate over SURVIVORS** (still true, still the most
  expensive trap in this rig). Use `cassette.jsonl`, sliced by `manifest.turns[].cassetteBytes`.
- **Adjudicate a seed catch by MARKER *and* by LANDING.** A seed the agent declined to write has no
  defect to catch, so a verdict on it is not evidence about a protection mechanism.

## Traps — still standing

- **Never run `bun run build` casually** — it re-pins the binary AND deploys machine-wide via the
  `~/.local/bin/reviewgate` symlink. Build → record sha → preregister → run.
- **Never pipe `bun test` through `tail`** — a red test's identity is lost. Redirect to a file.
- **`bun run lint`/`tsc` do NOT cover `rig/scripts/`.** Check new rig scripts explicitly with
  `bunx biome check` plus a hand-flagged `tsc --noEmit`.
- **`agy` fails 0-byte intermittently** between identical invocations. A reviewer with no findings
  file is an OPEN slot, not a pass — check log size AND findings-file mtime.
- **`rig/results/` is gitignored** — every number in both write-ups is reproducible only on this
  machine.
- **Never `git add -A` at the repo root** (it tracks `.reviewgate/` state), and with a second
  session active it also sweeps up foreign files.
- Reviewgate's decision protocol assumes fix-and-decide within ONE turn; an agent that delegates a
  fix to a background worker structurally cannot. Still unaddressed.

## Also queued, unchanged

1. **The rig stale-report defect** (a dead turn inherits the previous turn's `pending.json`) —
   needs a rebuild, so it cannot ride along inside a pilot.
2. **Two `~/Developer` fixes**, diagnosed, still not applied: stale repo-local hooks in
   `~/Developer/.claude/settings.json`; a 15.07. `control-plane.json` that makes `~/Developer`
   count as an armed checkout.
3. **Four repos armed without ever being `init`ed** (`barrierefrei`, `fatemehdaily`, `viergewinnt`,
   `youtubeQuiz`) — a policy call.
4. **Sandboxes to reap:** `/private/tmp/rig-pilot01-NZHKOT`, `/private/tmp/rig-pilot02-kzYEoV`,
   `/private/tmp/rig-pilot03-a3doEy`, and `dist/reviewgate.prev`. Neither replay depends on them
   (both reconstruct from `diff.patch`).

## Read-first order

1. This file.
2. `docs/dev/2026-08-07-slice-b-critic-floor-counterfactual.md` — the live decision.
3. `docs/dev/2026-08-07-in-range-mis-anchor-impact.md` — the closed one, and why.
4. `rig/scripts/critic-floor-replay.ts` — run it; its self-checks state their own integrity.
5. `rig/scripts/anchor-replay.ts` — run it; four self-checks, byte-stable output.


## Plan-gate record (for the post-implementation reviewers)

- **Slot A — Claude subagent, EXECUTING** (Codex quota-blocked until **2026-08-08 11:07Z**, so an
  executing Claude reviewer held Slot A; that is the normal configuration while Codex is capped, not
  a degraded one). Round 1 PASS. Verified in a `/tmp` repo copy: both Task-2 guard numbers
  non-vacuous, all three Task-3 guards green after a simulated revert (plus 159 further tests), and
  the replay's 3 → 0 prediction confirmed.
- **Slot B — agy/Gemini** (different vendor). Round 1 **FAIL** on one WARN: the plan did not name
  what protects an uncorroborated WARN security finding once the floor is gone. Valid —
  `isProtected`/`protected_high_precision` (`aggregator.ts:630`) fires in exactly that branch but is
  **cold-start-inert** (`PROTECT_MIN_DECISIONS = 8`), so the residual case has no downstream gate.
  Now stated in the plan's Risks table.
- **Round 2 delta review: both slots PASS.** Findings mapping is appended to the plan itself.
