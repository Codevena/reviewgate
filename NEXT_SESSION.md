# Reviewgate — Next-Session Handoff

_Last updated: 2026-08-06 early. Supersedes all earlier content._

## One-line state

**Task (b) is done and merged — but the change it produced is not the one the last handoff
predicted, and the next cut is pilot-03, which requires a rebuild FIRST.**

`origin/master` = `9019e1e` (merge commit of PR #72), working tree clean, **0 unpushed**.

## What got done this session — and how it was verified

The task was (b), "close the true-positive hole pilot-02 exposed". It shipped as PR #72:
11 commits, 10 files, +568/−17, merged to master.

### The headline: the previous handoff aimed at the wrong layer

It pointed at the critic and at the merge windows. **The finding that actually died in pilot-02
turn 2 was killed before the critic ever ran.** `validateFindingFacts` saw that the cited line 67
does not exist in a 27-line file and demoted the finding as *"almost certainly hallucinated"* —
while the finding carried the reviewer's own quoted source line, which is **verbatim line 26**.
The reviewer read real code and mis-numbered it: **mis-anchored, not fabricated.**

Verify it yourself:

```bash
bun -e 'const j=JSON.parse(await Bun.file("rig/results/pilot-02/turns/2/.reviewgate/pending.json").text());
for (const f of j.findings) console.log(f.id, f.rule_id, f.line_start, f.confidence, f.fact_invalid ?? "-", f.critic_verdict ?? "-")'
```

That one bad anchor caused **all three** failures the pilot-02 write-up attributed to independent
layers: the `fact_invalid` demote; the missed merge (25 vs 67 is past both `REGION_WINDOW` 5 and
`WORDING_MERGE_MAX_LINE_DISTANCE` 25); and hence `singleton` consensus, which left the critic free
to demote the other detection too.

**So the old handoff's candidate (2) — "merge same-file/same-category before the critic" — was
aimed at a symptom.** After the anchor is repaired the two findings sit **one line apart** and merge
under the *existing* window. Widening the window would instead bundle genuinely separate security
bugs under one decision, which `isHighStakesCategory` exists to prevent. Do not revive it.

### What shipped

- **Slice A** (`src/core/fact-check.ts:reanchorByEvidence`) — before demoting an out-of-range
  finding, consult the reviewer's own `evidence_line`. If it matches a real line of the cited file
  **and** carries an identifier-like token, re-anchor the finding there instead of demoting it. No
  quote, or a quote matching nothing, demotes exactly as before — the empty-file case the pass was
  built for is untouched. Runs pre-aggregation, so the repaired line feeds clustering. Costs **zero
  extra I/O** and needs **no orchestrator change**.
- **Slice A′** (`aggregator.ts`) — `anchor_repaired` is carried in `members[]` and OR-propagated to
  the representative. Load-bearing: on a severity tie the **unrepaired** finding wins the
  representative slot, so without this the badge and the pilot count vanish in exactly the case the
  slice exists for. Mirrors `demoted_from_critical`.
- **Slice B** (`aggregator.ts:~611`) — the critic may not push a security/correctness finding below
  WARN. The exemption was keyed to CRITICAL while the sibling delta-scope pass exempts the same
  categories at *any* severity. Already-INFO stays droppable.
- Badge in `report-writer.ts`, plus the turn-2 cascade acceptance test.

### The review chain caught two things I would otherwise have shipped wrong

1. **My own fix opened a security hole.** A punctuation-only quote (`}`) was a valid repair key —
   `normalizeLine` collapses `}`, `  }`, tab-`}` and fullwidth `｝` to the same value, matching four
   lines of the pilot file. A **fabricated** 0.97 CRITICAL went from **PASS pre-branch to hard FAIL
   post-branch**: exactly the trust-killer the pass exists to prevent. **Five per-task gates missed
   it**; only the whole-branch review found it. It also disproved a premise in the spec ("quoting
   real source means the reviewer read the file" — `}` is real source). Closed by requiring an
   identifier token; 13/13 attack quotes now demote, 4/4 true positives still repair.
2. **The acceptance test was green for a partly wrong reason.** Reverting each change individually
   showed that reverting **Slice B leaves the test green** — the repair-driven merge lifts consensus
   to `majority`, and the pre-existing `isCorroborated` bars the critic on its own. The comment now
   says so; Slice B's own case is covered by a singleton test in `aggregator-critic.test.ts`.

## Current metrics (measured, not recalled)

- Suite **3184 pass / 12 skip / 0 fail** (3196 tests) · `bunx tsc --noEmit` clean · biome clean
  (645 files). **Re-run on the merged `9019e1e`**, not carried over from the PR head.
- CI on PR #72 green: `verify` + package smoke on ubuntu-latest and macos-15.
- Working tree **clean**. **Everything is PUSHED** — verify, don't trust:
  `git rev-parse HEAD @{u} | uniq -c` → one line, count 2.
- Binary **unchanged**: `sha256:7f92445b…`, still the pilot-02 pin. **The merge did not change
  this** — `dist/reviewgate` carries neither the rig fixes nor (b).
- Control plane approved, `pending: None`.

## THE NEXT TASK — pilot-03

**Why it's next:** (b) changed gate behaviour on the strength of n=1 observed mis-anchor and n=3
landed seeds. The measurement tooling was repaired last session specifically so this change could be
scored. Nothing else in the backlog is blocked on it, and nothing else will tell you whether the
repair actually recovers the turn-2 class of finding without re-inflating FP burden.

**Sequence — in this order, no exceptions:**

1. `bun run build`, then **record the new sha256**. This re-pins the binary and deploys to **every
   repo on the machine** via the `~/.local/bin/reviewgate` symlink.
2. **Only then** preregister pilot-03 against the new hash.
3. Run it. **Never rebuild mid-run.**

**What to expect:** a landed-seed denominator of **3**, not 5 — the agent declined the
SQL-injection and hardcoded-secret prompts in *both* pilots. Write every floor as a **rate**, never
a count (pilot-02's M3 floor was miswritten as a count).

**Expect a small `anchor_repaired` count.** The fact-check pass fired on exactly **1 distinct
finding in 24 turns** across both pilots. A pilot-03 showing 0 repairs has **not refuted** the fix —
it has not exercised it, and the write-up must say that rather than report a null result.

## Traps that still hold

- **Do NOT revive "merge same-file/same-category before the critic."** See above — it targets a
  symptom, and `isHighStakesCategory` exists to stop exactly that bundling.
- **`SUPPRESSION_LAYERS` has no `scope`/`anchor` entry** (`src/rig/ablate.ts`). Slice B stays
  ablatable via `−critic`; **Slice A is observable, not ablatable** — count `anchor_repaired`, and
  say so instead of letting the matrix imply coverage it doesn't have.
- **Never run two full `bun test` suites concurrently in this repo.** Gate tests spawn subprocesses;
  two parallel runs blocked each other (22s CPU over 33min wall) and, when killed, reported a
  **false** "4 fail / 2 errors". A clean serial run: 3184/0 in 148s. The summary line of a killed
  run is worthless in **both** directions.
- **Reviewgate's decision protocol assumes fix-and-decide within ONE turn.** An agent that delegates
  a fix to a background worker structurally cannot, and gets `decisions-unaddressed` while the fix
  is already landing. It cost two escalations this session. This is a real gap worth its own slice —
  it is not a defect in this branch.
- **`rig ablate`'s denominator must stay identical to `harvest.ts`'s.** Two files independently
  filter seeded turns and the renderer subtracts one numerator from the other. Two guard tests pin it.
- **Turning the critic OFF needs a SECOND human TTY approval** — deleting the config line does not
  undo it; the control plane stores one `approved_config` with no history.
- **The critic only runs when the panel produced ≥1 finding** (`orchestrator.ts`). Turns with zero
  findings legitimately write no `critic` key.
- **`bun run lint`/`tsc` do NOT cover `rig/scripts/`** (tsconfig includes only `src*`/`tests*`).
- **`rig run` takes `repoRoot` from `process.cwd()`** — run it from inside the sandbox with absolute
  `--script`/`--out` paths pointing back at this repo.
- Older traps that still apply: never `git add -A` at the repo root; the rig cassette must live
  INSIDE the repo under review with `$SB` as the PHYSICAL `/private/tmp/…` path; `exit = 0` proves
  nothing — `gateReviewed` is the real signal.

## Open, needs Markus

1. **Codex quota** resets **2026-08-08T11:07Z**. Both this session's escalations rode a
   quota-degraded panel; a re-review after the reset is worth considering before treating pilot-02's
   or this branch's conclusions as final.
2. **Two `~/Developer` fixes**, diagnosed but still not applied (outside this repo):
   `~/Developer/.claude/settings.json` holds repo-local Reviewgate hooks pointing at a
   `.reviewgate/bin/` that does not exist → `SessionStart hook error` in every new non-git project.
   Second, a `control-plane.json` from 15.07. makes `~/Developer` count as an armed checkout.
3. **Four repos armed without ever being `init`ed** (`barrierefrei`, `fatemehdaily`, `viergewinnt`,
   `youtubeQuiz`) — a policy call, not a bug.
4. **Sandbox `/private/tmp/rig-pilot02-kzYEoV`** still exists; `dist/reviewgate.prev` likewise.

## Read-first order

1. This file.
2. `docs/superpowers/specs/2026-08-05-true-positive-hole-design.md` — the design of record for
   what just shipped, including the revision note explaining why the first version was wrong and
   the risk table the final review forced honest.
3. `docs/dev/2026-08-05-pilot-02-result.md` — the run that motivated it, its limits, and the
   in-place note on the three tooling bugs.
4. `rig/preregistrations/pilot-02.json` — the shape a pilot-03 preregistration should follow
   (correcting its count-vs-rate defect).
