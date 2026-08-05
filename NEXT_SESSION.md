# Reviewgate — Next-Session Handoff

_Last updated: 2026-08-05 18:45. Supersedes all earlier content._

## One-line state

**The precision remediation shipped (3 of 4 changes; one was withdrawn on evidence), the critic is
live and verified, and the next task is `pilot-02` — the second measurement run, now finally
legal to start.**

## What got done this session — and how it was verified

The chosen task was (a) *Precision / FP-fragmentation* from the previous handoff.
**The measurement contradicted the task's own premise**, and that is the session's main result.

### The finding that turned it around

The old handoff said FP-ledger promotion was unreachable because reviewers fragment their
`rule_id`s, so better grouping would open the path. Measured against the live ledger
(29 entries, 30 rejects, 10 sessions, two months):

| Question | Answer |
|---|---|
| Signatures rejected more than once | **1 of 29** |
| Cross-**session** recurrence | **0 of 29** |
| Distinct runs per cluster | **1 — all five, no exception** |

Every cluster's rejects carry identical timestamps and one `run_id`. The panel emits several
differently-phrased findings about one thing in a single round; the agent rejects them in one
batch; the ledger counted that as three independent observations.

**So the first drafted fix was a fail-open.** Better clustering alone would have promoted
`driver.ts` to `active` — permanent suppression earned by *one review round*, through a demote
pass (`aggregator.ts`, the `fpActive` block) that has **no severity or category ceiling**, unlike
the `cycleRejected` pass beside it. It was dropped.

### What shipped instead

| | Change | Commit |
|---|---|---|
| C2 | Promotion counts **distinct runs**, not reject events — per signature and per cluster | `9808169`, `3cf3258` |
| C4 | Semantic cluster view (same file+category, ≥2 shared canonical tokens, union-find) — **diagnosis only** | `6bce17b` |
| C1 | `phases.critic` on (`openrouter` / deepseek-v4-flash) — the one measured precision lever | `a584020` |
| C3 | Reputation eligibility — **withdrawn before implementation** | — |

**Evidence on real data.** `reviewgate fp clusters` now finds **5 clusters instead of 2**. The
`deadlock@src/rig/driver.ts` cluster unites FP-021/022/023 for the first time (`ruleIdToken0` split
them on `pipe` vs `piped`) — 3 rejects from **2 providers**, but **1 run**. Under the old counting
it would now be `active`. It reads `candidate`. C4 makes the cluster visible; C2 stops visibility
from becoming suppression.

**C1 is verified, not merely configured:** `.reviewgate/pending.json` carries
`critic: {"provider":"openrouter","status":"ran","verdicts":7,"demoted":0}`.

### Why C3 was withdrawn

Markus delegated a reputation-flip decision (`newsletter-buddy`). Investigating *why* the flip
existed produced the reason to drop the change: that reviewer's 8 events are **2 review rounds on
one day**, 60 days ago. The inflation is systemic:

```
newsletter-buddy claude-code:security   8 events →  2 rounds, 1 day
reviewgate       openrouter:security   13 events →  4 rounds, 4 days
flashbuddy       opencode:plan         21 events →  1 round,  1 day
dealbarg         codex:plan             6 events →  1 round,  1 day
```

Reputation counts **findings judged**, not **times the reviewer was tested** — so C3's raw count
inherits exactly the event-vs-round inflation C2 removes. Switching the unit to rounds is the
principled fix but forces re-calibrating `minSamples: 8`, and choosing between 3 and 8 on two data
points is fitting noise. `src/core/reputation/` is byte-identical, so the flip cannot ship.
**The original bug is real and still open** — recorded in the spec's C3 section and the plan's
"Not in this plan".

### Plan gate: 3 rounds × 2 executing reviewers

| Round | Slot A (claims) | Slot B (safety) |
|---|---|---|
| 1 | FAIL — 6 WARN | FAIL — **1 CRITICAL**, 3 WARN |
| 2 | FAIL — **1 CRITICAL**, 1 WARN | FAIL — 3 WARN |
| 3 | FAIL — 1 WARN | **PASS** |

Both CRITICALs were mine. Round 2's was *created by round 1's fix* — which is what delta reviews
are for. Round 3 found that `reviewgate config approve` could not have worked where the plan put
it. All findings are mapped in the plan's three "Plan-gate findings mapping" sections.

## Current metrics (measured 18:42 on this tree, not recalled)

- Suite **3163 pass / 12 skip / 0 fail** · `bunx tsc --noEmit` clean · biome clean (643 files)
- Working tree **clean**
- HEAD **`4bda22f`** · `origin/master` = **`04563ee`** → ⚠️ **14 commits UNPUSHED**
  (verify: `git rev-parse HEAD @{u} | uniq -c` — one line with count 2 = pushed)
- Binary rebuilt: `879a87e5…` → **`7f92445b…`**, hash change verified; behaviour checked against
  the **installed** binary, not just `bun test`
- Control plane **APPROVED** 16:36 by Markus, effective fingerprint `3fe97fce9347`, `pending: None`

## THE NEXT TASK — `pilot-02`, and why

Pilot-01's headline was that **no suppression layer fired at all** and the M2 FP-burden slope came
out *positive* (+0.0239/turn, against the registered direction). Two of the four layers were off
**by config**, so their Δ was zero by construction rather than by measurement. `phases.critic` is
now on and observed running. **pilot-02 is the run that turns "we switched on the measured lever"
into "we measured what it did here."**

It could not legally start before now: until the TTY approval landed, the gate kept executing the
critic-off last-known-good policy while `reviewgate.config.ts` claimed otherwise — a preregistration
frozen then would have named a critic that was not running.

Entry points: `rig/preregistrations/` (freeze a new one), `src/rig/driver.ts`, `src/rig/harvest.ts`,
and `docs/dev/2026-08-05-pilot-01-result.md` for the baseline it is compared against.

**Registered in advance, before any number exists:**

> **M6 `critic > 0` is the primary outcome, NOT the M2 slope.** Whether the critic fires is directly
> observable and robust at n=12. The slope is not: pilot-01 derived +0.0239/turn from 10 points, and
> the repo's own bench varies clean-FP 0.625–0.875 across *identical* repeats. A single 12-turn run
> cannot separate a real slope change from that variance. **A favourable slope must not be reported
> as evidence the critic lowered FP burden.**
>
> C2 and C4 are correctness fixes with **no expected effect** on today's data. If M6 shows
> `fp-ledger > 0`, something promoted on evidence this design says does not exist — investigate
> before celebrating.

Preconditions: `landedPattern` on **all five** seeds (pilot-01 had none, and two of five seeds never
landed); re-pin the binary hash to `7f92445b…`; **keep codex out of the panel via config**, not via
its quota state — its cooldown ends 2026-08-08, and a panel that gains a reviewer measures two
changes at once and is not comparable to pilot-01.

## Traps that still hold — including things to NOT change

- **`computeFpClusters` must stay on `ruleIdToken0`.** It feeds `orchestrator.ts:2364` → the
  aggregator's **suppression** map, and `aggregator.ts:783` *independently reconstructs* the same
  `<token0>@<file>` key to probe it. The format is frozen at both ends. `computeFpSemanticClusters`
  is the new one and is wired **only** to `fp clusters` and `learn status`. Broadening the
  suppression key on single-run evidence is exactly the fail-open this milestone removed.
- **Turning the critic back OFF now needs a SECOND human TTY approval.** `safeStrengthening`
  (`src/config/control-plane.ts`) auto-classifies only four sandbox/loop paths; everything else is
  `approval-required` **in both directions**, and `ControlPlaneStateSchema` stores one
  `approved_config` with **no history** — so the with-critic config *is* the last-known-good now.
  Deleting the config line does not undo it.
- **The critic only runs when the panel produced ≥1 finding** (`orchestrator.ts:2302`). A
  zero-finding PASS legitimately writes **no `critic` key**. That is not a misconfiguration and
  not an `OPENROUTER_API_KEY` problem.
- **`dist/reviewgate.prev`** (`879a87e5…`, ~65 MB, untracked) is the code rollback target. `bun run
  build` does not wipe `dist/`, so it survives a rebuild. Delete it only once pilot-02 concludes.
- **A green property test proved nothing here.** The run-based oracle in
  `fp-ledger-store.property.test.ts` was mutation-checked with the event-counting bug reintroduced:
  **green at default sampling and still green at `numRuns: 5000`.** It is kept because it is
  strictly more correct, but it is **not** a guard for C2 — the two unit tests in
  `fp-ledger-store.test.ts` are, and both were seen red first.
- **Repair test fixtures by INTENT, not by one blanket rule.** The `4× burst` fixture in
  `fp-ledger-clusters.test.ts` deliberately keeps its shared `run_id` — a burst *is* one round;
  giving it distinct run_ids would turn a guard into the evidence shape C2 rejects. The
  `isNearActive` literals are cast `as Parameters<…>`, so **`tsc` stays silent** on a missing field
  while `undefined >= 3` is quietly false.
- **Do not restore `learn-status.test.ts`'s old cluster key** (`prisma@…` → `attribut@…`) by giving
  `labelFor` a `ruleIdToken0` fallback. That would silently undo C4 while leaving every new test
  green. `labelFor` emits **stems** — `delet@`, `spac@`, `defang@` are expected output.
- Older traps that still apply: never `git add -A` at the repo root (stages `.reviewgate/` state);
  never put `*.test.ts` under `rig/results/`; the rig cassette must live INSIDE the repo under
  review and `$SB` must be the PHYSICAL `/private/tmp/…` path; use `collectDiff()` not
  `git diff HEAD` to capture what an agent wrote; `exit = 0` proves nothing about a turn —
  `gateReviewed` in the manifest is the real signal.

## Open, needs Markus

1. **14 commits unpushed.** Push freigeben?
2. **Two `~/Developer` fixes** (diagnosed, not applied — outside this repo, so I asked first):
   `~/Developer/.claude/settings.json` holds repo-local Reviewgate hooks pointing at
   `${CLAUDE_PROJECT_DIR}/.reviewgate/bin/…`, but `~/Developer/.reviewgate/bin/` does not exist →
   `SessionStart hook error` in every new project that is not yet its own git repo. The hooks are
   redundant (user-scoped shims in `~/.reviewgate/bin/` cover every repo). Second, a
   `control-plane.json` from 15.07. makes `~/Developer` count as an armed checkout.
3. **Four repos armed without ever being `init`ed** (`barrierefrei`, `fatemehdaily`, `viergewinnt`,
   `youtubeQuiz`) — unchanged from the last handoff; a policy call, not a bug.

## Read-first order

1. This file.
2. `docs/superpowers/specs/2026-08-05-fp-ledger-evidence-unit-design.md` — the design of record,
   including the withdrawn-C3 section and two dated in-place corrections of claims this session
   published and then disproved.
3. `docs/superpowers/plans/2026-08-05-precision-remediation.md` — the status table at the top, then
   the three "Plan-gate findings mapping" sections at the bottom (they record what each round found
   and what the fix was).
4. `docs/dev/2026-08-05-pilot-01-result.md` — the baseline pilot-02 is measured against.
