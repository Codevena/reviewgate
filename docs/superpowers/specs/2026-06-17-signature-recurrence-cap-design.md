# Per-Signature Recurrence Cap + Off-Ramp Guidance — Design (field-report #5)

**Date:** 2026-06-17
**Field-report item:** #5 — "Break the iteration treadmill (cap same-signature re-raises harder; surface a 'stop changing code, only reject' off-ramp)."
**Status:** approved, pre-implementation.

## Problem & scope

The loop already has extensive treadmill defenses: `stuck-signatures` (whole finding
*set* identical for `stuckThreshold` iters), `max-iterations` with N3 convergence-grace
(progressing → continue to a 2× hard cap; non-progressing → escalate at the cap),
`reviewer-fp-streak`, `cycleRejected` suppression (a finding the agent rejected-as-wrong
is demoted on recurrence), `claimed_fixed_recurred`, N1 size-gating, and the N2
acknowledged-low-value off-ramp. The loop is already bounded.

The residual gap #5 names: on a large changeset the finding *set churns* (fresh findings
each round) while **one stubborn blocking finding recurs amid the churn**. The whole-set
`stuck-signatures` check never trips, and N3 convergence-grace counts the loop as
"progressing" (overall count dropping / churn) — so it runs to the 2× hard cap. There is
**no per-signature recurrence cap**, and the gate never *surfaces* the off-ramp (reject /
fix-definitively instead of editing more, which spawns fresh reviews).

In scope (Approach A): a per-signature recurrence **escalation** (fail-safe — surfaces to
the human, never suppresses) + proactive off-ramp **guidance** in the report.

Out of scope: auto-suppressing/demoting a recurring signature (violates the project's
"a suppressor must fail-safe" rule — it would silently hide a real recurring bug); and
modifying the N3 `progressing` convergence math (kept intact — this is additive).

## Components

### 1. `src/core/signature-recurrence.ts` (new, pure)

```ts
// Signatures in `blocking` that appear in EACH of the last `threshold` rows of
// `history` (a per-iteration list of finding signatures). Requires history.length
// >= threshold and threshold >= 1. An empty/ERROR row that lacks the signature
// breaks its streak. Returns the recurring blocking signatures (sorted, deduped).
export function recurringBlockingSignatures(
  history: string[][],
  blocking: Set<string>,
  threshold: number,
): string[];
```

Logic: if `threshold < 1` or `history.length < threshold` → `[]`. Take the last
`threshold` rows. A signature recurs iff it is in `blocking` AND present in every one
of those rows. Return the sorted unique set.

### 2. loop-driver escalation precondition — `src/core/loop-driver.ts`

Immediately AFTER the existing `stuck-signatures` check (~line 909), before the
`iteration > 0` decisions block:

```ts
// #5: per-signature recurrence — break the treadmill where ONE blocking finding
// recurs amid a churning set (the whole-set stuck check above misses it). Fires
// only on a signature that is CURRENTLY blocking (CRITICAL/WARN in pending.json)
// AND present in the last `maxSignatureRecurrence` reviewed iterations. Fail-safe:
// escalate (surface to the human), never suppress.
const sigRecurThreshold = this.i.config.loop.maxSignatureRecurrence;
if (sigRecurThreshold > 0) {
  const blocking = new Set(
    readPendingReport(this.i.repoRoot)
      .findings.filter((f) => f.severity === "CRITICAL" || f.severity === "WARN")
      .map((f) => f.signature),
  );
  const recurring = recurringBlockingSignatures(state.signature_history, blocking, sigRecurThreshold);
  if (recurring.length > 0) {
    return this.escalateAndDecide(
      state,
      "signature-recurrence",
      `${recurring.length} blocking finding(s) recurred across ${sigRecurThreshold} consecutive reviews without resolving (e.g. \`${recurring[0]}\`). To converge: fix each definitively, or — if it is a false positive — reject it (\`reviewer_was_wrong\`) so it is suppressed on recurrence. Further edits spawn fresh reviews and prolong the loop.`,
      true, // #10: deferable on a quota-degraded panel (a "code won't converge" reason)
    );
  }
}
```

- `state.signature_history` is the per-iteration signature list (all deduped finding
  signatures; `orchestrator.ts:1829`). Cross-referencing with the CURRENT pending.json's
  CRITICAL/WARN signatures restricts the trigger to a currently-blocking finding — an
  advisory/INFO recurrence never treadmill-escalates.
- Placed after `stuck-signatures` so a *total* stall (whole set identical) escalates
  faster via that check (threshold 2 < default 3); per-signature catches the
  one-finding-amid-churn case.
- Reachability: with `maxIterations 3` / `maxSignatureRecurrence 3`, the loop only
  reaches ≥3 history rows past `maxIter` via convergence-grace (the treadmill case),
  so this fires before the 2× hard cap. With a higher `maxIterations` the benefit scales.

### 3. `EscalationReason` — `src/schemas/state.ts`

Add `"signature-recurrence"` to the enum (with a comment). Block-once like
`stuck-signatures` — NOT added to `ALLOW_STOP_ESCALATIONS`. The call passes
`deferableOnQuota: true` (component 2), so #10's quota-defer covers it.

### 4. Config — `src/config/define-config.ts` + `defaults.ts`

```ts
// define-config.ts (loop):
// #5: escalate when a single BLOCKING finding's signature recurs across this many
// consecutive reviewed iterations (a treadmill where one finding sticks while the
// set churns — the whole-set stuckThreshold check misses it). Fail-safe (surfaces
// to the human, never suppresses). 0 disables. Must be > stuckThreshold so a total
// stall still escalates faster via stuck-signatures.
maxSignatureRecurrence: z.number().int().nonnegative().default(3),
```
`defaults.ts` (loop): `maxSignatureRecurrence: 3`. (Note: this IS a `loop` field with
`.default()`, which is fine — `loop` fixtures spread `defaultConfig.loop`, unlike the
`phases.review` partial-literal fixtures that forced `.optional()` for #7/#8.)

### 5. Off-ramp guidance — `src/core/report-writer.ts` `renderMd`

In the gate-mode "Required actions" block, when `r.iter >= 2`, append a render-only tip:

```
⤷ Converging tip (iteration N): prefer fixing a finding definitively or rejecting it (reviewer_was_wrong) over adding new code — each new edit spawns a fresh review and can prolong this loop. A finding you reject as a false positive is suppressed if it recurs.
```

(`r.iter` and `r.max_iter` are already on the report; `mode === "gate"` only. Render-only,
no new data flow.)

## Behavior summary

- One blocking finding recurs ≥ `maxSignatureRecurrence` consecutive reviews → escalate
  `signature-recurrence` (block-once, then allow; surfaces the off-ramp). Deferred on a
  quota-degraded panel (#10).
- Whole set stuck → `stuck-signatures` still escalates faster (threshold 2).
- An advisory/INFO finding recurring → no escalation (not in the blocking set).
- A recurring finding the agent REJECTS (reviewer_was_wrong) → `cycleRejected` suppresses
  it on recurrence → it drops out of the blocking set → no escalation (the off-ramp working).
- `maxSignatureRecurrence: 0` → disabled (no per-signature escalation; prior behavior).
- Off-ramp tip shows in pending.md from iteration 2 onward (render-only).

## Testing

Unit (`recurringBlockingSignatures`, pure):
1. a sig in all of the last K rows AND in `blocking` → returned.
2. a sig in the last K rows but NOT in `blocking` (advisory) → excluded.
3. a sig present in only K−1 of the last K rows (a gap/empty row breaks the streak) → excluded.
4. `history.length < threshold` → `[]`; `threshold <= 0` → `[]`.
5. churning set with one persistent blocking sig over K rows → that sig returned.

loop-driver (mirroring the existing stuck-signatures tests): seed `signature_history`
with one blocking sig recurring K times + a matching CRITICAL/WARN pending.json →
`escalateAndDecide` fires reason `signature-recurrence` (block-once, ESCALATION.md
written); below K → no escalation; `maxSignatureRecurrence: 0` → no escalation; an
INFO-only recurrence → no escalation.

report-writer: the off-ramp tip is present at `iter >= 2` (gate mode), absent at `iter 1`
and in one-shot mode.

config: `maxSignatureRecurrence` defaults to 3.

Plus: `bunx tsc --noEmit`, `bun run lint`, `bun test tests/unit --timeout 20000` clean.

## Files touched

- `src/core/signature-recurrence.ts` — new (pure recurrence function).
- `src/core/loop-driver.ts` — the per-signature precondition (after stuck-signatures); import the helper.
- `src/schemas/state.ts` — add `"signature-recurrence"` to `EscalationReason`.
- `src/config/define-config.ts` + `defaults.ts` — `maxSignatureRecurrence` (default 3).
- `src/core/report-writer.ts` — the off-ramp tip in "Required actions".
- `tests/unit/` — new tests for the helper, the loop-driver escalation, the report tip, the config.
