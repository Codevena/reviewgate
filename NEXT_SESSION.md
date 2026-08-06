# Reviewgate — Next-Session Handoff

_Last updated: 2026-08-06, after pilot-03. Supersedes all earlier content._

## One-line state

**pilot-03 ran and scored task (b). Both slices came back weak: Slice A was never exercised,
and Slice B's single activation protected a false positive. Nothing needs reverting; the next
cut is an OFFLINE measurement, not another pilot.**

`origin/master` = `8737489`, working tree clean, **0 unpushed** (verified: `git rev-parse HEAD @{u}
| uniq -c` → one line, count 2).

**Suite NOT re-run this session, deliberately: no `src/` or `tests/` file was touched** (only
`docs/` and `rig/`). The last green run stands — **3184 pass / 12 skip / 0 fail** on `9019e1e`.
`bun run build` succeeded and the binary is pinned at **`sha256:fc9b8c18c62977ba…`**.

## What got done this session

1. **Rebuilt and re-pinned the binary.** `sha256:fc9b8c18c62977ba5e82a4e0bdb4d842626a2c3a69c620643fae00c72278bca4`
   (was `7f92445b…`). Verified in **both** directions — `reanchorByEvidence`/`anchor_repaired`
   present in the new binary, absent from `dist/reviewgate.prev`. Live machine-wide via the
   `~/.local/bin/reviewgate` symlink.
2. **Preregistered pilot-03** (`9f9400f`, amended pre-run in `6ab4ca6`), frozen and pushed
   before the run.
3. **Ran pilot-03** — 12 turns, 53 min, $0.009139 billed. Full write-up:
   `docs/dev/2026-08-06-pilot-03-result.md`.

## The findings, in the order they matter

### 1. Slice B's one activation protected a false positive

Turn 4, `injection-via-case-mismatch`, WARN/security/singleton — the exact firing signature
registered in advance, so the attribution is not a post-hoc reading:

```
"SQL query uses positional placeholder but may still allow injection via
 case-insensitive collation bypass"
      against:  db.query('SELECT id, email FROM users WHERE email = $1', [email])
```

Correctly parameterized. Collation governs comparison semantics, not whether a **bound**
parameter can inject. **The critic called it `likely_fp` and was right; Slice B overrode it.**
That is the first datum on the design's open "does Slice B re-inflate FP burden" risk row and
it is unfavourable. **n = 1 — not grounds to revert, but stop calling the floor cost-free.**

### 2. Slice A was never exercised — a different statement from "no effect"

Opportunity denominator (`anchor_repaired + fact_invalid`) = **0**. The pass only ever runs on
an out-of-range citation and none occurred. Across pilots 01–03: **1 opportunity in 36 turns.**

### 3. The recall jump is real and is NOT the fix's

0.33 → 1.00, but **neither catch carries a marker**: both were `consensus: majority` with no
`anchor_repaired`. On turn 2 the agent wrote the byte-identical unsafe line and the panel
simply anchored it correctly this time — pilot-02's failure mode did not recur. The denominator
also changed (2 seeds landed, not 3; `missing-await` didn't land). The comparison that survives
is the **paired** one over seeds landing in both runs: **0/2 → 2/2**.

### 4. Fourth rig defect: a dead turn inherits the previous turn's report

Turn 5's agent died on an API error and wrote nothing; the archiver re-captured turn 4's
on-disk `pending.json` and the harvester credited turn 5 with its 3 findings / 3 blocking.
Proved twice: byte-identical `diff.patch` sha, and a strict signature subset. Corrected totals
22/19 → **19/16**; no headline number moves. **Not yet fixed.**

## THE NEXT TASK — the offline Slice A corpus replay

**Why it's next, and why it is NOT pilot-04.** At 1 opportunity in 36 turns a 12-turn run has
no power to characterise Slice A, and three more pilots would not change that. The instrument
that fits is offline, free, and needs no agent quota: **replay every recorded reviewer output
across all three pilots through `validateFindingFacts` and count how many mis-anchored findings
it repairs versus demotes.** The corpus already exists (`rig/results/pilot-0*/turns/*/reports/`)
and `rig/scripts/anchor-markers.ts` already reads it.

**Then the gap both pilots keep circling:** reviewers mis-numbering lines they quote correctly.
pilot-02 gave an out-of-range instance; pilot-03 gave an **in-range** one (turn 4 cites line 37,
quotes line 40) that no pass inspects — `validateFindingFacts` only ever runs past EOF. The
same comparison `attestEvidence` already computes at `orchestrator.ts:2573` (render-only, post
aggregation) would detect it. That is a candidate slice, not a decided one.

**Also queued:** fix the rig stale-report defect (§4) — it needs a rebuild, so it cannot ride
along inside a pilot.

## Traps that still hold

- **Never rebuild mid-run.** The build re-pins the binary AND deploys to every repo via the
  symlink. Build → record sha → preregister → run.
- **Write every floor as a RATE.** And check the DENOMINATOR before comparing rates across
  runs: pilot-03's landed-seed denominator was 2, pilot-02's 3, and the seeds differ.
- **`SUPPRESSION_LAYERS` has no `scope`/`anchor` entry.** Slice B stays ablatable via
  `−critic`; **Slice A is observable, not ablatable** — count `anchor_repaired` and say so.
- **The agent declines seeds unpredictably.** SQL-injection and hardcoded-secret were declined
  in all three pilots; `missing-await` landed in 01 and 02 but **not** in 03. Never assume 3.
- **Attribute catches by MARKER, never by outcome.** A turn flipping missed→caught is panel
  variance until a marker says otherwise. This is the whole reason pilot-03 did not overclaim.
- **`rig/results/` is gitignored** — the artifacts are local only. The write-ups reference paths
  that exist on this machine and nowhere else.
- **Never run two full `bun test` suites concurrently.** Serial: 3184/0 in 148s. A killed run's
  summary line is worthless in both directions.
- **`rig run` takes `repoRoot` from `process.cwd()`** — run from inside the sandbox with
  absolute `--script`/`--out`. Cassette must be an ABSOLUTE path INSIDE the sandbox.
- **`bun run lint`/`tsc` do NOT cover `rig/scripts/`** (tsconfig includes only `src*`/`tests*`).
- **Reviewgate's decision protocol assumes fix-and-decide within ONE turn.** An agent that
  delegates a fix to a background worker structurally cannot, and gets `decisions-unaddressed`
  while the fix is already landing. A product gap for multi-agent hosts, still unaddressed.
- Older traps that still apply: never `git add -A` at the repo root; `exit = 0` proves nothing —
  `gateReviewed` is the real signal.

## Open, needs Markus

1. **Codex quota resets 2026-08-08T11:07Z.** Still the reason the executing reviewer slot is
   `agy` or a Claude subagent.
2. **Slice B's FP cost is n = 1.** Decision to make once there is more evidence: keep the floor,
   narrow it (e.g. require corroboration OR confidence above a threshold), or revert it.
   Reverting needs no TTY approval — it is code, not config.
3. **Two `~/Developer` fixes**, diagnosed, still not applied (outside this repo): stale
   repo-local Reviewgate hooks in `~/Developer/.claude/settings.json` pointing at a
   non-existent `.reviewgate/bin/`; and a `control-plane.json` from 15.07. that makes
   `~/Developer` count as an armed checkout.
4. **Four repos armed without ever being `init`ed** (`barrierefrei`, `fatemehdaily`,
   `viergewinnt`, `youtubeQuiz`) — a policy call, not a bug.
5. **Sandboxes to reap:** `/private/tmp/rig-pilot02-kzYEoV`, `/private/tmp/rig-pilot03-a3doEy`,
   and `dist/reviewgate.prev`.

## Read-first order

1. This file.
2. `docs/dev/2026-08-06-pilot-03-result.md` — what the fix actually did in the field.
3. `docs/superpowers/specs/2026-08-05-true-positive-hole-design.md` — the design under test,
   including the risk row pilot-03 supplied the first datum for.
4. `rig/preregistrations/pilot-03.json` — the shape to follow, including the opportunity
   denominator and the marker-attribution rule that stopped pilot-03 overclaiming.
