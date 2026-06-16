# Quota-Degraded Escalation Defer — Design (field-report #10)

**Date:** 2026-06-16
**Field-report item:** #10 — "Don't escalate on a quota-degraded panel — defer until quota reset."
**Status:** approved, pre-implementation.

## Problem

When a configured reviewer is quota-capped and its failover did not cover the
slot, the reviewer panel runs **degraded** (fewer reviewers than configured). A
degraded panel still produces a verdict, so a FAILing change can march to a
**give-up escalation** — `max-iterations` (the panel kept FAILing without
converging) or `stuck-signatures` (the same finding set repeated) — and the gate
summons the human / blocks.

That escalation rests on an incomplete panel: the capped reviewer could not
corroborate or refute the findings, and might have broken the stall once back.
Today the gate already **detects** the degradation (`quotaDegradationNote` appends
a "⚠ Quota-degraded panel" note to `ESCALATION.md` + the Stop reason) but still
escalates. #10 asks the gate to **defer** the give-up until the quota resets,
rather than giving up on a degraded panel.

## Scope

In scope: defer the two "the code won't converge, give up" escalations
(`max-iterations` **soft** case, `stuck-signatures`) when the panel is
quota-degraded, bounded by a new consecutive-defer counter + config cap, then
escalate as a fail-closed backstop.

Out of scope (these still escalate immediately even when degraded — none is "we
gave up because the code won't converge"):

- `cost-cap` — a hard budget stop; deferring then re-running would cost *more*.
- `max-iterations` **hard cap** (2× the soft cap) — the runaway backstop; must
  always fire.
- `decisions-unaddressed` — an agent-protocol violation (the agent never wrote
  decisions), not a panel-quality issue.
- `review-timeout` — handled by the incomplete-run path, not panel degradation.
- `infra-unavailable` — already the bounded-defer path for a *total* outage
  (`handleInfraUnavailable`).
- `reviewer-fp-streak` — a specific reviewer that *ran* and kept being wrong; a
  different reviewer being capped does not make it premature. Already allow_stop.
- `reject-rate-high` — the agent's confirmed-FP rate is high; a "the reviewers
  that ran are noisy" signal, not "the code won't converge." Excluded for the
  same reason as `reviewer-fp-streak`. (Handled automatically by the default-false
  param — it is one of the nine `escalateAndDecide` call sites, listed here for
  completeness.)

Also out of scope (decided during brainstorming): a fresh full-panel review round
on quota reset (Approach 2). This design is **defer-only** (Approach 1): while a
reviewer is in cooldown, do not give up; once the cooldown clears, normal
escalation semantics resume.

**What "defer-only" does and does NOT do (important, do not overstate this in
copy):** during a pure defer streak the `iteration` is NOT advanced — it stays at
the cap — so the `max-iterations`/`stuck-signatures` precondition re-fires at the
*top* of `run()` on every subsequent turn, **before any new panel runs**. The
defer therefore does **not** trigger a fresh full-panel review on its own, and a
plain edit (new dirty flag) while at the cap does **not** re-arm the cycle (the
re-arm paths require `escalated=true` or a completed review). The only exits from
a defer streak are: (a) the cooldown clears → the precondition escalates on the
existing history; (b) the defer cap is reached → escalate (fail-closed backstop);
or (c) the agent **commits** (HEAD moves), which re-arms a fresh cycle
(`iteration → 0`) so the next turn reviews the new batch with whatever panel is
then available. The value Approach 1 delivers is precisely: **the gate does not
give up / summon the human while the panel is provably incomplete**, for a bounded
window. Rationale for choosing it over Approach 2: lowest fail-open risk (no
iteration-cap bypass).

## Design

### Single choke point

All escalation reasons funnel through `escalateAndDecide(state, reasonCode,
summary)` in `src/core/loop-driver.ts`. Add a fourth parameter
`deferableOnQuota: boolean` (default `false`).

Set `deferableOnQuota: true` at exactly two call sites:

- the **soft** `max-iterations` escalation (`loop-driver.ts:~876`, the
  non-progressing branch) — **not** the hard-cap branch at `~867`.
- the `stuck-signatures` escalation (`loop-driver.ts:~904`).

Every other call site passes `false` (omits the arg) → behavior unchanged.

### Defer logic inside `escalateAndDecide`

Before the existing `firstAnnounce` logic:

```
const note = this.quotaDegradationNote(now);   // string | null; reused (not recomputed)
const degraded = note !== null;
const cap = this.i.config.loop.quotaDeferMaxConsecutive;

if (deferableOnQuota && degraded && cap > 0 && state.consecutive_quota_defers < cap) {
  const next = state.consecutive_quota_defers + 1;
  await this.i.state.update((cur) =>
    ReviewgateStateSchema.parse({ ...cur, consecutive_quota_defers: next, last_stop_ts: now.toISOString() }));
  // audit a gate.decision (defer) event, best-effort
  // EARLY RETURN — before unlinkDirtyFlagIfUnchanged(), so the dirty flag is KEPT
  // (next turn re-checks) and `iteration` is NOT advanced.
  return {
    kind: "allow_stop",
    reason: `🟠 Reviewgate · GATE DEFERRED (iteration ${state.iteration}) — a reviewer is in cooldown, so the panel is incomplete; NOT escalating on a degraded panel yet. Will escalate once the cooldown clears, or after ${cap - next} more degraded turn(s) (defer ${next}/${cap}); commit your work to re-review the change with the full panel.` + note,
  };
}
```

The detail string appended is the existing `quotaDegradationNote(now)` return
value (captured once in `note`, reused — it already names the provider + reset
time and begins with its own `\n\n⚠ …` prefix). The message deliberately does
**not** claim the change is "re-reviewed once quota resets" — per Approach 1 the
defer holds off the *give-up*; it does not itself re-run the panel (see "What
defer-only does and does NOT do" above).

If the guard is false (not deferable, not degraded, cap is 0, or the defer cap is
exhausted) → fall through to the **existing** escalation path unchanged (the ⚠
degraded note is still appended to `ESCALATION.md`/the Stop reason as it is today).
On that path, reset `consecutive_quota_defers` to `0` (so a future
re-degradation in a new cycle starts fresh) — folded into the existing
`escalation_announced: true` state update at `~1596`.

`now` is `new Date()`, computed once at the top of `escalateAndDecide` (it
already calls `this.quotaDegradationNote(new Date())`; collapse to one `now`).

### Dirty flag & iteration accounting (the safety crux)

The defer is an **early return** placed **before**
`this.unlinkDirtyFlagIfUnchanged()` (`loop-driver.ts:~1601`):

- the **dirty flag is KEPT** → the next turn re-enters `run()` and re-checks the
  cooldown store;
- `iteration` is **NOT advanced** and no panel runs — the defer just re-reads the
  cooldown store (cheap);
- `escalated` / `escalation_announced` / `escalation_reason` are **not** set —
  this is not an escalation.

This mirrors `handleAllQuotaLocked` / `handleInfraUnavailable`, which also keep
the flag and do not advance the iteration. No intra-turn loop: `allow_stop` ends
the turn; the Stop hook re-fires only on the next turn-end.

### New state field

`src/schemas/state.ts`:

```
// Consecutive turns the gate DEFERRED a give-up escalation (max-iterations /
// stuck-signatures) because the reviewer panel was quota-degraded. Bounded by
// loop.quotaDeferMaxConsecutive so a persistently-capped reviewer escalates to
// the human instead of deferring forever. Reset to 0 when a review completes or
// an escalation actually proceeds. .default(0) for back-compat.
consecutive_quota_defers: z.number().int().nonnegative().default(0),
```

Added to `initialState()` (`consecutive_quota_defers: 0`).

### Reset points

`consecutive_quota_defers` is reset to `0`:

1. on the normal post-review state update (`loop-driver.ts:~1269`, alongside
   `consecutive_infra_defers: 0`) — a real review completed, so the defer streak
   is broken;
2. whenever an escalation actually **proceeds** (folded into the
   `escalation_announced` update at `~1596`) — once we stop deferring and give up,
   the counter is clean for the next cycle.

(It does not need a dedicated reset in the commit/PASS re-arm blocks: re-arm
resets `iteration` to 0 and the next completed review resets the counter via
point 1 — the same lifecycle `consecutive_infra_defers` relies on.)

### New config

`src/config/define-config.ts` (under `loop`):

```
// Max consecutive turns to DEFER a give-up escalation (max-iterations /
// stuck-signatures) while a configured reviewer is in cooldown (quota cap or
// timeout/error backoff — see quotaDegradationNote), before escalating anyway.
// Mirrors infraDeferMaxConsecutive. 0 disables the defer (escalate immediately
// even when degraded — prior behavior).
quotaDeferMaxConsecutive: z.number().int().nonnegative().default(3),
```

`src/config/defaults.ts` (under `loop`): `quotaDeferMaxConsecutive: 3`.

### Degradation signal & its limitations

The signal is the existing `quotaDegradationNote(now)` cooldown-store check: a
configured reviewer's provider is currently in cooldown (`activeUntil(p, now) !==
null`). This reuses the *exact* signal the existing ⚠ note already uses — no new
detection logic.

Note on the trigger set: `activeUntil` does **not** discriminate on the cooldown
`source`, so a reviewer recorded via `recordBackoff` (a per-reviewer **timeout /
error backoff**, or a silent agy stall) reads as "degraded" too — not only a
hard quota cap. This is intentional: deferring the give-up on a *timeout*-degraded
panel is equally valid, and it matches the existing ⚠-note behavior exactly (no
regression). The `quota`-prefixed names (`quotaDeferMaxConsecutive`,
"GATE DEFERRED … reviewer is in cooldown") are kept to mirror `quotaDegradationNote`
and the field-report framing; the user-facing copy says "in cooldown" rather than
"quota-capped" to stay accurate.

Documented limitation: it slightly **over-defers** when a capped/backed-off
primary's failover actually covered the slot (the panel was effectively whole).
This errs toward *not* escalating (never wrongly summons the human) and is bounded
by `quotaDeferMaxConsecutive`. A more precise signal would require persisting
per-iteration genuine coverage from the orchestrator — deferred as a future
refinement, not needed for v1.

## Control-flow summary

At the top of `run()`, before a new panel runs, for a non-progressing change at
the iteration cap or a stuck signature set:

- **panel degraded + under cap** → DEFER (allow_stop, flag kept, iteration
  unchanged, counter +1).
- **panel degraded + cap exhausted** → escalate (with ⚠ degraded note), counter
  reset to 0.
- **panel not degraded** → escalate normally (counter stays/reset to 0).
- **`quotaDeferMaxConsecutive: 0`** → escalate immediately even when degraded
  (prior behavior).
- **hard cap (2× maxIter) / cost-cap / decisions-unaddressed / timeout / infra /
  fp-streak** → escalate as today (never deferred).

## Testing

Unit tests against `LoopDriver` (mirroring the existing infra-defer tests):

1. degraded + soft `max-iterations` → `allow_stop` DEFERRED; dirty flag still
   present; `iteration` unchanged; `consecutive_quota_defers` incremented.
2. degraded + `stuck-signatures` → DEFERRED (same assertions).
3. degraded, repeated for `quotaDeferMaxConsecutive` turns → the next turn
   ESCALATES (`escalated: true`, reason `max-iterations`/`stuck-signatures`),
   ESCALATION.md contains the ⚠ degraded note, counter reset to 0.
4. `quotaDeferMaxConsecutive: 0` + degraded + soft max-iter → escalates
   immediately (no defer).
5. **not** degraded + soft max-iter → escalates normally; counter stays 0.
6. degraded + `cost-cap` → escalates (not deferable). degraded + hard-cap
   max-iterations → escalates. degraded + `decisions-unaddressed` → escalates.
7. defer then quota clears (cooldown store no longer capped) → next turn
   escalates normally on the existing history (Approach 1 — no fresh round).

Plus: full `bun test tests/unit --timeout 20000`, `bunx tsc --noEmit`, `bun run
lint` clean.

## Files touched

- `src/core/loop-driver.ts` — `escalateAndDecide` signature + defer branch; two
  call-site flags; two reset points.
- `src/schemas/state.ts` — new `consecutive_quota_defers` field + `initialState`.
- `src/config/define-config.ts` — new `quotaDeferMaxConsecutive` zod field.
- `src/config/defaults.ts` — `quotaDeferMaxConsecutive: 3`.
- `tests/unit/` — new defer tests (likely alongside the existing loop-driver /
  infra-defer tests).
