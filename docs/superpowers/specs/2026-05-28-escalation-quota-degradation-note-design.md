# Spec — Honest escalation under quota-degraded panel (Bug 3b)

**Date:** 2026-05-28
**Status:** Approved (design), pending implementation plan
**Author:** brainstormed with Markus

## Problem / Motivation

In the flashbuddy escalation, codex was quota-capped all 3 rounds, so the panel
ran degraded (3/4 reviewers). A capped reviewer can't corroborate or refute the
others' findings, so a degraded panel surfaces more uncorroborated (often false)
findings — yet the gate escalated as if the panel were at full strength, with only
a soft "reduced coverage" note on the *end-of-iteration* path.

The **precondition escalations** — `max-iterations`, `stuck-signatures`,
`reviewer-fp-streak` (loop-driver `escalateAndDecide`) — fire BEFORE a new
iteration runs, so they have no fresh `RunSummary` and never mention degradation at
all. The human reading `ESCALATION.md` can't tell that the escalation rests on a
degraded panel.

After Bugs 3a + the FP-source slice, the unfair-escalation pressure is largely
gone; what remains for 3b is **honesty**: when the gate escalates with a
quota-capped reviewer, say so. **Diagnostic only — no change to blocking or
escalation behavior** (the chosen direction; "pause the clock" / "wait for reset"
were considered and deferred).

## Decisions (locked during brainstorming)

1. **Diagnostic only.** Escalation fires exactly as today; we only append a note.
2. **Scope: quota-capped CONFIGURED reviewers**, via the `QuotaCooldownStore`
   (`activeUntil`). Error/timeout degradation is already surfaced on the ERROR path
   (`formatCoverageNote` / `formatErrorBreakdown`); 3b is specifically the
   persistent-quota case the precondition escalations miss.
3. **Note lands in BOTH** `ESCALATION.md` (via the `summary` passed to `escalate()`)
   and the Stop-hook block reason (a short suffix).
4. **No failover cross-reference** (don't try to prove the slot went uncovered) and
   **no clock injection** — `new Date()` is fine; tests control via the store's
   `reset_at`.

## Background — verified code

- `escalateAndDecide(state, reasonCode, summary)` (loop-driver ~797): on first
  announce calls `this.escalate(...)` which passes `summary` to
  `ReportWriter.writeEscalation({ ..., summary, ... })` → rendered into
  `ESCALATION.md`. Returns the `block` reason string referencing ESCALATION.md.
- `QuotaCooldownStore(repoRoot).activeUntil(provider, now)` (quota-cooldown.ts ~96):
  "ISO reset time if `provider` is still capped at `now`, else null" — exactly what
  `doctor` uses to SHOW a cooldown (independent of the re-probe window). This is
  available at precondition-escalation time (a persisted JSON store).
- Configured reviewers: `config.phases.review.reviewers` — each `{ provider,
  persona, fallback }`. Their `.provider` values are the reviewer slots.

## Design

### 1. Helper `quotaDegradationNote` (`src/core/loop-driver.ts`, LoopDriver method)

```ts
private quotaDegradationNote(now: Date): string | null {
  const reviewers = this.i.config.phases.review.reviewers ?? [];
  const providers = [...new Set(reviewers.map((r) => r.provider))];
  const store = new QuotaCooldownStore(this.i.repoRoot);
  const capped = providers
    .map((p) => ({ p, until: store.activeUntil(p, now) }))
    .filter((x): x is { p: string; until: string } => x.until !== null);
  if (capped.length === 0) return null;
  const list = capped.map((x) => `${x.p} (capped until ${x.until})`).join(", ");
  return (
    `\n\n⚠ Quota-degraded panel: ${list} could not review this cycle. A capped ` +
    `reviewer cannot corroborate or refute the others' findings — if its failover ` +
    `did not cover the slot, this escalation rests on a degraded panel. Consider ` +
    `waiting for the quota reset, then re-run \`reviewgate gate --hook reset\` ` +
    `before treating these findings as final.`
  );
}
```

(Import `QuotaCooldownStore` from `./quota-cooldown.ts` — already imported in
`orchestrator.ts`; add the import to `loop-driver.ts`.)

### 2. Inject into `escalateAndDecide` (`src/core/loop-driver.ts` ~797-832)

At the top of the method:

```ts
    const degraded = this.quotaDegradationNote(new Date());
    const fullSummary = degraded ? summary + degraded : summary;
```

- Pass `fullSummary` (not `summary`) to `this.escalate(...)` → the note renders into
  `ESCALATION.md`.
- Append a short suffix to BOTH returned block/allow_stop reasons when `degraded`:
  ` · ⚠ degraded panel (quota) — see ESCALATION.md`.

No other behavior changes; the first-announce/re-stop logic and the dirty-flag
unlink stay as-is.

## Components / isolation

Single file: `src/core/loop-driver.ts` (one new private method + a few lines in
`escalateAndDecide`). Reuses `QuotaCooldownStore` (unchanged) and the existing
`ReportWriter.writeEscalation` (summary already flows through). No schema/config
change.

## Testing (`tests/unit/loop-driver.test.ts`)

Use the existing harness. Seed `.reviewgate/quota-cooldowns.json` via
`QuotaCooldownStore(repo).record(provider, resetAtFuture, now)` (or write the JSON
directly), force a precondition escalation (e.g. the existing max-iterations /
stuck setup), and assert:

1. **Capped configured reviewer** (`codex` capped, `reset_at` in the future, and
   `codex` is in `config.phases.review.reviewers`) → escalation `block`; the note
   appears in `ESCALATION.md` (read the file) AND the block reason contains
   `degraded panel`.
2. **No cooldowns** → no note in ESCALATION.md / reason (escalation otherwise
   identical to today).
3. **Capped provider that is NOT a configured reviewer** (e.g. `openrouter` capped
   but only `codex` is configured) → no note (we only flag reviewer slots).
4. **Expired cooldown** (`reset_at` in the past) → `activeUntil` returns null → no
   note.

## Non-goals / YAGNI

- No change to escalation/blocking behavior (no "pause the clock", no "wait for
  reset").
- No failover-coverage cross-reference (we state the capped-reviewer fact + an
  honest "if its failover didn't cover the slot" hedge).
- No clock injection; `new Date()` + store `reset_at` suffices for tests.
- Error/timeout degradation unchanged (already on the ERROR path).

## Acceptance criteria

1. A precondition escalation (max-iterations / stuck-signatures / reviewer-fp-streak)
   with a quota-capped configured reviewer appends the degradation note to both
   `ESCALATION.md` and the Stop-hook reason.
2. No capped configured reviewer → escalation output is byte-identical to today.
3. A capped non-reviewer provider does not trigger the note.
4. `bunx tsc --noEmit`, `bun run lint`, full `bun test` clean.
