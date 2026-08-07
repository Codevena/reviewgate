# Reviewgate — Next-Session Handoff

_Last updated: 2026-08-07, after the offline Slice C decision and the Slice B counterfactual.
Supersedes all earlier content._

## One-line state

**Both open slice questions are now measured and answered. Slice C is declined on evidence
(zero measured benefit, a demonstrated net-new harm). Slice B's floor has 3 field activations, all
3 protected a false positive, and its one genuinely-protective opportunity was already covered by a
pre-existing mechanism. The remaining decision is narrow-vs-revert on Slice B.**

## Verified state (checked with commands, not from memory)

| | |
|---|---|
| `origin/master` | **`709390d`** — pushed, branch in sync, nothing unpushed |
| working tree | one file modified, **NOT mine**: `.reviewgate/lore/approvals.jsonl` (two `cli:lore-approve` entries from a real terminal) |
| suite | **3191 pass / 12 skip / 0 fail**, exit 0 (170s) |
| `tsc --noEmit` / `bun run lint` | clean. rig `tsc` + biome checked SEPARATELY (rig/ is outside tsconfig include) |
| build | **deliberately NOT run.** Installed binary still `sha256:fc9b8c18…` |
| `src/` changed this session | **one `export` keyword** — `matchesAddedLine` in `src/rig/harvest.ts`, so the replay imports the shipped landing check instead of reimplementing it. No behaviour change |

**⚠ ANOTHER SESSION IS COMMITTING TO THIS CHECKOUT.** Four commits (`2a2516a`, `aa89772`,
`c558f10`, `1b15093` — CLAUDE.md Trailhead format + Brain pointer fixes) landed between
`5ef9ab6` and `709390d`. Isolate concurrent work in a `git worktree` before it causes a real
collision.

## THE NEXT TASK — Slice B: narrow or revert

The measurement is done; this is a decision plus an implementation, and it touches
`src/core/aggregator.ts`, so **the plan-gate runs BEFORE any code**.

**Recommendation: narrow.** All 3 activations are hedged speculation ("may lead to", "may cause",
"may still allow") at WARN with singleton consensus. The repo already has a detector for exactly
that framing — the pass that demotes a CRITICAL whose own text frames it as hypothetical or
currently-safe — and it does **not** apply at WARN, which is precisely where every activation sits.
Reusing it as a floor *exclusion* would have suppressed all 3 without touching the confident case
the design was written for.

**Revert** (restore the CRITICAL-only exemption) is the other defensible answer. **Keep** is not
supported by the evidence.

Plan-gate note: **Codex quota resets 2026-08-08T11:07Z.** Until then the executing reviewer slot is
`agy` or a Claude subagent. The gate reviewer MUST be able to run the code the plan makes claims
about — a non-executing model is an extra voice, never the deciding one.

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
