# Reviewgate: failover + fp-streak intelligence fixes (2026-06-02)

Two field-reported logic bugs (agents in other projects) + approved policy +
progress. Branch: `fix/reviewer-failover-and-fpstreak` (off master `5c5ea32`).

## Bug 1 — failover collapses instead of using other providers

**Root cause (verified):** the failover loop (`src/core/orchestrator.ts`, the
`for (const fb of r.fallback)` walk) only tries a slot's DECLARED fallback chain.
When all chain members are quota-cooled/unavailable → 0 okRuns → `verdict: "ERROR"`
(`orchestrator.ts:1098`) → `loop-driver.ts` ERROR branch → hard **block**. A
working provider (claude/openrouter) that isn't in that slot's chain is never tried.

**Approved policy:** broaden failover to any enabled+available provider; and when
truly ALL providers are quota-locked (transient), **allow-stop + loud warning +
re-review next turn** (narrow, deliberate fail-open ONLY for all-quota-locked,
distinguishable from misconfig via cooldown reset times).

## Bug 2 — legit rejections of out-of-scope findings trip reviewer-fp-streak

**Root cause (verified):** `loop-driver.ts:583` escalates at
`cumulative_fp_rejects >= fpStreakThreshold` (default 3). `computeRejectRate`
counts EVERY `reviewer_was_wrong` rejection of a blocking finding — no distinction
between "reviewer hallucinated in the diff" and "agent correctly rejects a
pre-existing/out-of-scope tooling finding". The reviewer (repo read-access)
re-flags the same tooling findings (`.reviewgate/bin`, `.claude` hooks) every
turn; FP-ledger suppression also activates only at 3 (== streak threshold), so it
can't pre-empt. Escalation outcome was **block** → gate gives up on a correct agent.

**Approved policy:** when fp-streak fires, **allow-stop + escalation warning to
human** (the reviewer is the problem, not the code) — don't block.

---

## Status

| ID | Fix | Status | Commit |
|---|---|---|---|
| **1A** | Last-resort failover: after the declared chain, try any other enabled+available+non-cooled provider (deterministic, OAuth/$0 first). `LAST_RESORT_ORDER` in `orchestrator.ts`. | ✅ DONE | `656bae3` |
| **2c** | reviewer-fp-streak escalation → allow-stop + warning (writes ESCALATION.md, doesn't block). `ALLOW_STOP_ESCALATIONS` set in `loop-driver.ts`. | ✅ DONE | `c6208c9` |
| **1B** | All-quota-locked transient → allow-stop + warning + re-review next turn (don't block, keep dirty.flag). | ⏳ OPEN | — |
| **2a** | Drop reviewer findings on EXCLUDED paths (`.reviewgate/`, `reviewgate.config.ts`) — gate must never block on its own infra (kills F-003 at source). | ⏳ OPEN | — |
| **2b** | Per-cycle suppression: a finding the agent already rejected as `reviewer_was_wrong` in a prior iteration of the SAME cycle is demoted to INFO on recurrence (same signature) → no re-reject → streak never accumulates from it. | ⏳ OPEN | — |

**1A + 2c functionally address both reported complaints.** 1B/2a/2b are completeness/hardening.

## Remaining-work notes (for clean continuation)

### 1B — all-quota-locked → allow-stop (CAREFUL: state machine)
- **Signal:** add `allReviewersQuotaLocked?: boolean` to `IterationResult` (`orchestrator.ts:130`); set true in the `okRuns.length === 0` block (`orchestrator.ts:1098`) when there was ≥1 reviewer AND every settled run's `status === "quota-exhausted"`.
- **loop-driver:** on `verdict === "ERROR" && allReviewersQuotaLocked` → `allow_stop` + warning (cooldown reset times in the message via `QuotaCooldownStore.activeUntil`).
- **SUBTLETY (must handle):** `loop-driver.ts:695` does `iteration: passed ? 0 : nextIter` — an ERROR run ADVANCES the iteration. A quota-locked turn must NOT advance iteration (else N quota-locked turns hit the max-iterations BLOCK escalation, which is not in ALLOW_STOP_ESCALATIONS). Also the max-iter check runs BEFORE the verdict branch (~613-674) — ensure the quota case can't be pre-empted by it. Treat the quota allow-stop as a transient skip: keep `iteration` unchanged, keep dirty.flag (already not unlinked on non-passed), don't count it as a FAIL round.
- **TDD:** loop-driver test with a stub orchestrator returning `{verdict:"ERROR", allReviewersQuotaLocked:true}` → assert `allow_stop`, dirty.flag preserved, iteration unchanged.

### 2a — drop excluded-path findings
- Export `isExcludedFromReview` from `src/utils/git.ts` (currently private).
- Filter `allFindings` in `orchestrator.ts` before `aggregate()` (drop any finding whose `file` is excluded), OR add a guard in the aggregator. Prefer the orchestrator (keeps aggregator pure of git concerns).
- TDD: a finding on `.reviewgate/bin/trigger` is dropped (not in dedupedFindings, not blocking).
- Consider `.claude/` too (F-001/F-002) — but `.claude/` is NOT currently excluded; decide whether tooling findings about `.claude/` should also be non-blocking (likely yes for the hooks running the gate, but it's the user's config — flag as a smaller policy question).

### 2b — per-cycle suppression of already-rejected findings
- Track signatures the agent rejected as `reviewer_was_wrong` in prior iterations of the CURRENT cycle (state field, e.g. `cycle_rejected_signatures: string[]`, reset on re-arm like the fp accumulator).
- Pass them to `aggregate()` as a suppression set (like `fpActive`) → demote matching findings to INFO + tag.
- This breaks the loop: the agent rejects a finding once; on recurrence it's auto-demoted → never re-surfaced as blocking → never re-counted toward the streak.
- TDD: reject sig-X in iter 1 → iter 2 surfaces sig-X demoted to INFO (not in requiredIds).

## DoD note
Branch is green (unit + integration; the occasional single unit fail is the known
load-induced doctor/docreview 5s-timeout flake, passes in isolation). Codex DoD
pass deferred (provider quota — the very bug being fixed). Not pushed.
