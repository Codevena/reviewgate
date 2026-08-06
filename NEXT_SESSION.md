# Reviewgate — Next-Session Handoff

_Last updated: 2026-08-07 00:35, at handoff after the offline Slice A corpus replay.
Supersedes all earlier content._

## One-line state

**The replay ran and it reversed pilot-03's weakest finding: Slice A is not an unobserved
mechanism, it has 7 field instances across the pilots and the shipped pass repairs all 7. The
"1 opportunity in 36 turns" figure was an artifact of counting post-aggregation survivors.**

## Verified state (checked with commands at handoff time, not from memory)

| | |
|---|---|
| `origin/master` | **`3967ba4`** — the replay commit, pushed and verified |
| unpushed | **2 commits** — `897d116` (the lore draft) and this handoff commit. Branch is 2 ahead of `origin/master`. **The lore draft needs Markus's OK before it is pushed.** |
| working tree | clean |
| suite | **3191 pass / 12 skip / 0 fail**, re-run at `897d116` (150s, exit 0). Only markdown changed after that |
| `tsc --noEmit` / `bun run lint` | clean |
| build | **deliberately NOT run.** `bun run build` re-pins the binary AND deploys machine-wide through the `~/.local/bin/reviewgate` symlink. Installed binary is still `sha256:fc9b8c18…` |

**The only `src/` change all session is two `export` keywords** — `normalizeLine` and `lineCount`
in `src/core/fact-check.ts`, so the replay imports them instead of keeping copies whose drift
nothing guarded. Verified line-by-line in the staged diff; no behaviour change.

## What got done this session

1. **`rig/scripts/anchor-replay.ts`** — the offline replay. Slices each pilot's `cassette.jsonl`
   by the manifest's per-turn byte offsets, reconstructs the turn's working tree from
   `diff.patch` into a throwaway `git init` dir, and runs the **real, imported**
   `validateFindingFacts` over the reviewers' raw findings. Read-only, no quota, no network.
2. **`docs/dev/2026-08-06-slice-a-corpus-replay.md`** — the write-up.
3. **Two documents corrected in place** (not appended to): the pilot-03 result and the design
   spec's "Scale" table both carried the wrong denominator.
4. **`.reviewgate/lore/rig-metrics-corpus.md`** — a lore **draft** (commit `897d116`, unpushed)
   recording the corpus invariant. `status: draft`, no `approvals.jsonl` line: canon promotion is
   Markus's trust decision.

**How it was verified — evidence, not adjectives:**

- the script's own four self-checks pass on every run (ground truth, cassette tiling, corpus size
  44/24/27, quote-reading agreement with `attestEvidence`);
- **five guard mutations seen RED in a copy of the repo**, original confirmed unmodified with
  `git diff` afterwards. The two that matter: disabling `reanchorByEvidence` flips the
  ground-truth assertion to `demoted`, and removing the audit condition collapses exactness
  39/95 → 0/95;
- the two turn-9 repairs were checked by hand against the reconstructed file (they land on the
  `sendReport` signature and on the hardcoded endpoint — semantically right, not just in-range);
- **review gate: 4 rounds, two slots, both PASS at the end** (`agy` executing + GLM-5.2). Rounds
  1–3 each found something real. Codex was quota-blocked, so `agy` held the executing slot.

**Entry points** for the next session: `rig/scripts/anchor-replay.ts:turnIterations` (the
two-record exactness check) and `src/core/fact-check.ts:reanchorByEvidence` (Slice A itself).
The in-range discriminator already exists at `src/core/fact-check.ts:attestEvidence`, called
render-only from `orchestrator.ts:2573`.

## The findings, in the order they matter

### 1. Slice A has 7 field instances, not 1, and the pass repairs all 7

| | archived reports | raw corpus replay |
|---|---:|---:|
| out-of-range citations (opportunities) | 1 | **7** |
| repaired | 0 (mechanism absent from those binaries) | **7** |
| demoted as fabricated | 1 | **0** |

All 7 are in **pilot-02** — 5 in turn 2, and **2 in turn 9 that no write-up ever mentioned**,
because both were gone before the report was written. Under the pilot-02 binary all seven were
told they were "almost certainly hallucinated", including a 0.90 CRITICAL path traversal.

All 7 sit on trees the reviewer saw, established on **two independent records**: the finding came
from its turn's final panel run (cassette) AND that turn's final gate iteration ran the panel
(audit log, `run_summary.source`). The two are cross-checked per turn on the panel-run count.
**pilot-03's own claim — denominator 0, not exercised — is confirmed by the replay and stands.**
So does pilot-01's 0.

### 2. The measurement lesson generalises past Slice A

Every rate this rig computes from `reports/*-pending.json` is a rate over **survivors**. For any
pass that runs BEFORE aggregation, that is the wrong denominator, and it errs in the direction
that makes the pass look useless. The cassette is the pre-aggregation record and was already
being written — nothing new had to be recorded to get this right.

### 3. The in-range mis-anchor population is now sized — and it is the bigger hole

On trees the reviewer provably saw, of 16 in-range findings carrying a quote:

| quote matches the cited line | **4** |
|---|---:|
| quote matches a **different** real line (in-range mis-anchor) | **7** |
| quote matches no line (already badged `evidence_mismatch`) | 5 |

**Only 4 of 16 are anchored to the line they quote.** The offsets are small (2, 3, 7 lines) and
the quotes are correct — this is arithmetic, not fabrication. The replay independently
rediscovered pilot-03 turn 4's `injection-via-case-mismatch` (cites 37, quotes 40), the one
instance found by hand, which is the closest thing to an external check the instrument has.

## THE NEXT TASK — Markus's call, not an obvious next step

The evidence now points at the in-range half, and the mechanism is cheap: the comparison
`attestEvidence` already computes at `orchestrator.ts:2573` (render-only, post-aggregation) is
exactly the discriminator. Moving it pre-aggregation would repair in-range mis-anchors the same
way Slice A repairs out-of-range ones.

**But it is a genuinely riskier change than Slice A, and the decision is Markus's:**

- Slice A only ever ran on citations **past EOF**, where the finding was going to be demoted
  anyway — it could only ever improve on a demote. An in-range repair **moves a finding that
  nothing was going to touch**, so a wrong repair is a net-new harm with no failure mode today.
- n = 16 for the measurement, one panel, two models.

Options: (a) spec it as Slice C with the same guard discipline; (b) ship it render-only first
(badge, no move) and measure agreement for a run; (c) leave it and spend the effort on Slice B's
open FP question instead. **Do not start (a) without asking.**

## Also queued, unchanged

1. **Slice B's FP cost is still n = 1** and unfavourable (pilot-03 turn 4 protected a false
   positive over a correct critic). Keep / narrow / revert is still open. This replay says
   nothing about it.
2. **The rig stale-report defect** (a dead turn inherits the previous turn's `pending.json`) —
   needs a rebuild, so it cannot ride along inside a pilot.
3. **Codex quota resets 2026-08-08T11:07Z.** Until then the executing reviewer slot is `agy` or
   a Claude subagent. (`agy` filled the plan gate this session and caught a real miscount.)
4. **Two `~/Developer` fixes**, diagnosed, still not applied: stale repo-local hooks in
   `~/Developer/.claude/settings.json`; a 15.07. `control-plane.json` that makes `~/Developer`
   count as an armed checkout.
5. **Four repos armed without ever being `init`ed** (`barrierefrei`, `fatemehdaily`,
   `viergewinnt`, `youtubeQuiz`) — a policy call.
6. **Sandboxes to reap:** `/private/tmp/rig-pilot02-kzYEoV`, `/private/tmp/rig-pilot03-a3doEy`,
   and `dist/reviewgate.prev`. **NOTE:** the replay does NOT depend on them (it reconstructs from
   `diff.patch` into a temp dir), so they are safe to delete. `/private/tmp/rig-pilot01-NZHKOT`
   is likewise not needed.

## Traps that still hold

- **NEW — a rate over `reports/*-pending.json` is a rate over SURVIVORS.** Never use it as a
  denominator for a pre-aggregation pass. Use `cassette.jsonl`, sliced per turn by
  `manifest.turns[].cassetteBytes`.
- **NEW — pilot-01 recorded no `diff.patch`** (the driver gained it afterwards). Its per-turn
  line counts come from `.reviewgate/research.md`'s `+N/-0` rows, validated 26/26 against
  reconstructed trees on pilots 02/03. That gives line counts, never content.
- **NEW — never pipe `bun test` through `tail`.** Doing that cost a re-run this session: the
  summary said `1 fail` and the failing test's name had already been discarded. Redirect the
  whole log to a file, then read the tail of the FILE. (That failure did not reproduce in three
  subsequent full runs, so it is unidentified — treat a lone red as "re-run and capture", not as
  a known flake.)
- **NEW — `agy` still fails 0-byte intermittently.** It worked for the plan gate, then produced a
  4-byte log and no findings file on the very next invocation with an identical command line. A
  reviewer that produced no findings file is an OPEN slot, not a pass — re-run it. Always check
  the log size AND the findings-file mtime, never just that the file exists.
- **NEW — `diff.patch` is captured at END of turn.** A finding from a non-final panel run may
  have been reviewed against a different file. That error has **no sign** (the agent's fix can
  lengthen or shorten), so such findings are UNVERIFIABLE, not a bound. Do not call them one.
- **Never rebuild mid-run.** The build re-pins the binary AND deploys to every repo via the
  `~/.local/bin/reviewgate` symlink. Build → record sha → preregister → run.
- **Write every floor as a RATE, and check the DENOMINATOR** before comparing across runs.
- **`SUPPRESSION_LAYERS` has no `scope`/`anchor` entry.** Slice B stays ablatable via `−critic`;
  **Slice A is observable, not ablatable.**
- **The agent declines seeds unpredictably.** SQL-injection and hardcoded-secret were declined in
  all three pilots; `missing-await` landed in 01 and 02 but not 03. Never assume 3.
- **Attribute catches by MARKER, never by outcome.**
- **`rig/results/` is gitignored** — the artifacts are local only, and so are every number in the
  replay write-up.
- **Never run two full `bun test` suites concurrently.** Serial: 3191/0 in ~150s.
- **`bun run lint`/`tsc` do NOT cover `rig/scripts/`** (tsconfig includes only `src*`/`tests*`).
  Check new rig scripts explicitly — `bunx biome check rig/scripts/<f>.ts` plus a `tsc --noEmit`
  with the project's flags passed by hand.
- **Reviewgate's decision protocol assumes fix-and-decide within ONE turn.** An agent that
  delegates a fix to a background worker structurally cannot. Still unaddressed.
- Older traps that still apply: never `git add -A` at the repo root; `exit = 0` proves nothing —
  `gateReviewed` is the real signal.

## Read-first order

1. This file.
2. `docs/dev/2026-08-06-slice-a-corpus-replay.md` — the result and the instrument's limits.
3. `rig/scripts/anchor-replay.ts` — run it; its four self-checks state their own integrity.
4. `docs/superpowers/specs/2026-08-05-true-positive-hole-design.md` — the design, now carrying a
   correction note on its "Scale" table.
5. `docs/dev/2026-08-06-pilot-03-result.md` — the field run, now carrying the same correction.
