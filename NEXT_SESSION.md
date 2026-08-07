# Reviewgate — Next-Session Handoff

_Last updated: 2026-08-07, after the Slice B revert was implemented, gated and pushed.
Supersedes all earlier content._

## One-line state

**All three slice questions are now closed: Slice A shipped, Slice C declined on measurement,
Slice B implemented as a REVERT and pushed (`27c29f7`). Nothing is half-done — the next session
picks a new task rather than continuing one.**

## Verified state (checked with commands at handoff time)

| | |
|---|---|
| my commit this session | **`27c29f7`** — "revert Slice B: the critic WARN security/correctness floor" |
| pushed? | **YES** — `709390d..27c29f7`, confirmed present on `origin/master` |
| `HEAD` | **`b3032b3`** — *not mine.* A **second session** is committing to this checkout live |
| unpushed | **1 commit, `b3032b3`** (the other session's Qwen plan, docs-only). **Not mine to push** |
| working tree | `.reviewgate/lore/approvals.jsonl` modified + two untracked `measure-opencode-tokens` files — **all foreign**, leave them alone |
| suite | **3191 pass / 12 skip / 0 fail**, exit 0 — run at the reviewed tree of `27c29f7` |
| `tsc` / `lint` | clean. `rig/` checked SEPARATELY (it is outside `tsconfig.include`) — 0 errors in the changed file |
| build | **deliberately NOT run.** Installed binary still `sha256:fc9b8c18…` |
| Trailhead | stamped to `b3032b3`; 3 GEÄNDERT rows were all mine and re-checked, entry points unchanged, 0 FEHLT, `CLAUDE.md` at exactly 80/80 lines |

⚠ **A SECOND SESSION IS COMMITTING TO THIS CHECKOUT.** Never `git add -A`; stage explicit paths and
check `git log` before assuming a commit is yours. A `git worktree` remains the standing fix.

## What got done — and how it was verified

The four tasks of `docs/superpowers/plans/2026-08-07-slice-b-revert.md`, all of them:

1. `isBlockingSecurity` deleted; `src/core/aggregator.ts:621` is the CRITICAL-only check again.
2. The two floor tests inverted (WARN/`"keep"` → INFO/`"likely_fp"`).
3. Three boundary guards confirmed green with assertions untouched.
4. Design spec carries a dated REVERTED banner; original rationale preserved.

**Evidence, not adjectives:**

- **Mutation check in a COPY** — restoring `isBlockingSecurity` reddens **exactly** the two inverted
  tests, the other 16 stay green. Copy discarded, `git diff` confirmed the original untouched.
- **The new abort path was itself mutation-checked** — failure-only code that would otherwise ship
  untested. Floor restored → replay exits 1, prints all 3 activations with both diagnostic flags
  `false`, and the `die()` guidance then correctly points at `aggregator.ts:621`.
- **Replay 3 → 0 activations** with signature-match unchanged at **15/19** — the 0 comes from the
  revert, not from a broken instrument.
- Suite unchanged at 3191/12/0, exactly as the plan predicted.

**Post-implementation gate: 3 rounds** (Slot A = executing Claude subagent, Slot B = agy). Round 1
FAIL/2 WARN, round 2 FAIL/2 WARN, round 3 PASS/PASS.

## THE NEXT TASK — pick one; none is a continuation

Nothing is left mid-flight. The strongest candidate, and why:

**The rig stale-report defect** — a dead turn inherits the previous turn's `pending.json`, so a turn
that produced nothing looks like it produced the previous turn's findings. It silently corrupts any
metric read from `turns/*/reports/`, which is the exact failure class this rig has already been
burned by twice. It is next because every future measurement rests on it, and because it **cannot
ride along inside a pilot** — it needs a rebuild, so it must be its own task with its own
preregistration. Entry point: `src/rig/driver.ts` (turn loop) plus `src/rig/harvest.ts`.

Alternatives, all still open and all smaller:

1. **`isFloorActivation` is not floor-exclusive** — documented in a comment this session, **not**
   guarded by a test. See the trap below. A test would be cheap.
2. **Two `~/Developer` fixes**, diagnosed, still not applied: stale repo-local hooks in
   `~/Developer/.claude/settings.json`; a 15.07. `control-plane.json` that makes `~/Developer` count
   as an armed checkout.
3. **Four repos armed without ever being `init`ed** (`barrierefrei`, `fatemehdaily`, `viergewinnt`,
   `youtubeQuiz`) — a policy call, not a code task.
4. **Sandboxes to reap:** `/private/tmp/rig-pilot01-NZHKOT`, `/private/tmp/rig-pilot02-kzYEoV`,
   `/private/tmp/rig-pilot03-a3doEy`, and `dist/reviewgate.prev`. Neither replay depends on them.

## Traps — NEW this session

- **`isFloorActivation` (`rig/scripts/critic-floor-replay.ts`) is NOT floor-exclusive, and its 0 is
  a property of the CORPUS, not a theorem about the code.** A CRITICAL **correctness** singleton
  kept by the surviving CRITICAL exemption, then clamped CRITICAL→WARN by the reputation pass
  (`aggregator.ts:903-914`), reproduces the same marker. Not security — `touchesSecurity` returns
  early at `:883`. It cannot fire in the replay only because that script's `aggregate()` call site
  passes **no** reputation inputs and the pass is gated on `repUnreliable.size > 0` (`:876-877`).
  **If that call site ever gains reputation inputs, the tripwire will false-alarm.** Documented in
  the script's header; NOT covered by a test.
- **The flag-based diagnosis in that script rests on an unguarded invariant:** every CRITICAL→WARN
  transition inside `aggregate()` stamps `demoted_from_critical` (`:165`, `:854`, `:911`, `:1061`),
  and the two non-reputation paths early-return on security/correctness (`:838`, `:1051`).
  Re-check that list after ANY change to the demote passes, or the guidance points at the wrong line.
- **A "VERIFIED BY EXECUTION" stamp does not protect the sentence it is attached to.** This session
  executed the *existence* of that second producer and then invented a *cause* for it — and marked
  the invented cause as execution-verified. The reviewer caught it. Execute the claim you are
  actually writing down, not a neighbouring one.
- **A vendor-diverse PASS is not independent confirmation when the second slot cannot run the code.**
  agy passed all three rounds and found nothing; in round 2 it explicitly confirmed the false causal
  claim as "accurately described against the aggregator implementation". Every substantive finding
  came from the executing slot. Treat a non-executing PASS as one voice, never as corroboration.
- **Failure-only code is untested code.** The new abort branch had never run once during
  development. Mutate deliberately to make it run before believing its output.

## Traps — still standing

- **Never run `bun run build` casually** — it re-pins the binary AND deploys machine-wide via the
  `~/.local/bin/reviewgate` symlink. Build → record sha → preregister → run.
- **Never pipe `bun test` through `tail`** — a red test's identity is lost. Redirect to a file.
- **`bun run lint`/`tsc` do NOT cover `rig/scripts/`.** Check it explicitly: `bunx biome check` plus
  a `tsc --noEmit` with an include that reaches `rig/` (needs `typeRoots` pointing at
  `node_modules` — `bun-types` is not under `@types/`).
- **`agy` fails 0-byte intermittently.** A reviewer with no findings file is an OPEN slot, not a
  pass — check log size AND findings-file **mtime against the round's start time**.
- **Codex quota resets 2026-08-08 11:07Z.** Until then the executing slot is agy or a Claude
  subagent; that is the normal configuration, not a degraded one.
- **A rate over `reports/*-pending.json` is a rate over SURVIVORS.** Use `cassette.jsonl`.
- **`rig/results/` is gitignored** — every number in the write-ups is reproducible only on this
  machine.
- **Never reimplement a shipped helper in a rig script** — import it. `seedLanded` got the landing
  semantics wrong that way and the whole discriminator hung off it.
- **`applySymbolSignatures` runs BEFORE `validateFindingFacts`** (`orchestrator.ts:2219`, `:2226`).
- Reviewgate's decision protocol assumes fix-and-decide within ONE turn; an agent that delegates a
  fix to a background worker structurally cannot. Still unaddressed.

## Open Trailhead note (carried forward, still unresolved)

`CLAUDE.md`'s Mess-Rig row points at `src/rig/driver.ts`, not at the offline replays under
`rig/scripts/` — which are now load-bearing (this session's revert check *is* one of them).
`CLAUDE.md` sits at exactly 80/80 lines, so this can only be a **swap**, not an addition. Deliberately
left as-is: it is a judgement call about which entry point serves a cold reader better.

## Read-first order

1. This file.
2. `docs/dev/2026-08-07-slice-b-critic-floor-counterfactual.md` — the evidence behind the revert.
3. `rig/scripts/critic-floor-replay.ts` — read its HEADER before running it; it explains what the 0
   does and does not prove.
4. `docs/superpowers/specs/2026-08-05-true-positive-hole-design.md` §Slice B — the REVERTED banner.
