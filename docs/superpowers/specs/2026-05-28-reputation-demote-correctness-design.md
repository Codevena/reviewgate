# Spec — Reputation-demote for lone unreliable correctness CRITICALs

**Date:** 2026-05-28
**Status:** Approved (design), pending implementation plan
**Author:** brainstormed with Markus

## Problem / Motivation

A single-reviewer panel that keeps hallucinating CRITICAL findings (the shoal
opencode case, [[project_shoal_dogfood_audit]] / [[project_reviewer_fp_runaway_loop]])
imposes a permanent verification tax: every run the agent must build a runtime
trace and reject the false positive. The self-learning machinery records the
signal (`reputation/learn.ts` logs `reviewer_was_wrong`), but the **reputation
demote cannot act on it for correctness/security CRITICALs** — `aggregator.ts`'s
`repScoped` pass exempts `touchesSecurityOrCorrectness` entirely (line ~377). So a
reviewer can be chronically wrong in the *correctness* lane forever and never get
reined in.

The pushed **F3 Phase 2** (derived FP-cluster demote) is the multi-provider
backstop — but a cluster only goes *active* once a **second** provider rejects the
same pattern. For a **single-reviewer** panel, no cluster ever activates, so the
gap stays open. This spec is the **single-reviewer complement**: a reputation-keyed
demote that works for a lone reviewer.

## Decisions (locked during brainstorming)

1. **Scope: `correctness` only.** `security` CRITICALs are NEVER softened — they
   remain a hard veto. We split the blanket `touchesSecurityOrCorrectness`
   exemption in `repScoped` into "security always-exempt" + "correctness
   demotable".
2. **Demote semantic: CRITICAL→WARN, capped at WARN.** One step only. A correctness
   finding is never pushed below WARN by this mechanism (stays blocking — always
   requires a decision, never silenced). The demoted finding loses its hard
   CRITICAL veto but still FAILs the gate as a WARN.
3. **Threshold: reuse the existing `repUnreliable` set** (same `minSamples` +
   `trustFloor`). No second threshold.
4. **Default ON**, behind a config flag so it can be disabled.
5. **Corroboration still protects:** unanimous/majority findings are never
   reputation-demoted (unchanged).

## Background — current `repScoped` (aggregator.ts ~371-394)

```
const repScoped = repUnreliable?.size
  ? confScoped.map((f) => {
      if (f.severity === "INFO") return f;
      if (f.consensus === "unanimous" || f.consensus === "majority") return f;
      if (touchesSecurityOrCorrectness(f)) return f;          // <-- blanket exempt
      const keys = f.confirmed_by?.length ? f.confirmed_by : [`${f.reviewer.provider}:${f.reviewer.persona}`];
      if (!keys.every((k) => repUnreliable.has(k))) return f;
      const next = DEMOTE[f.severity];                        // one step
      ...
    })
  : confScoped;
```

Verdict ordering (verified): the pipeline is critic → scoped (diff) → fpScoped →
fpClusterScoped → confScoped → **repScoped (last)** → verdict loop (~402+). So a
demote in `repScoped` is reflected in the verdict. The critic block (line ~257),
the confidence-demote exemption (line ~353), and the verdict hard-FAIL (line ~405)
all run on the *result* of the relevant stage and keep using
`touchesSecurityOrCorrectness` unchanged.

## Design

### 1. Helper split (`aggregator.ts`)

Add two focused predicates alongside the existing one (which stays for the other
call sites):

```ts
// representative OR any merged member category == "security"
function touchesSecurity(f: Finding): boolean {
  const cats = [f.category, ...(f.members?.map((m) => m.category) ?? [])];
  return cats.some((c) => c === "security");
}
// representative OR any merged member category == "correctness"
function touchesCorrectness(f: Finding): boolean {
  const cats = [f.category, ...(f.members?.map((m) => m.category) ?? [])];
  return cats.some((c) => c === "correctness");
}
```

`touchesSecurityOrCorrectness` is left untouched and continues to guard the critic
block (:257), the confidence-demote exemption (:353), and the verdict hard-FAIL
(:405). Only `repScoped` changes.

### 2. Carve-in in `repScoped`

Gated by the new flag `input.demoteCorrectness` (wired from config, default true).
Skip-check order per finding:

1. `INFO` → skip (unchanged).
2. `unanimous`/`majority` → skip (unchanged).
3. **`touchesSecurity(f)` → skip** (security never softened — replaces the security
   half of the old blanket exempt).
4. **If `touchesCorrectness(f)`:** only proceed when `demoteCorrectness === true`;
   otherwise skip (preserves today's behavior when the flag is off).
5. keys not all in `repUnreliable` → skip (unchanged).
6. Demote **one step, capped at WARN for correctness:**
   - `CRITICAL` → `WARN` (tagged `reputation_demoted: true` + a note in `details`
     that this is a dampened correctness CRITICAL from an unreliable lone reviewer).
   - A `WARN` that `touchesCorrectness` → **leave as WARN** (do NOT demote to INFO —
     stays blocking). For pure quality/style findings (neither security nor
     correctness), the existing one-step `DEMOTE[f.severity]` behavior is unchanged
     (a quality `WARN` may still go to `INFO`).

The cap is the one subtlety vs. the existing code: today `DEMOTE[WARN] = INFO`. For a
correctness `WARN` we must NOT apply that, or the finding would go non-blocking,
violating decision #2. Quality findings keep the old cascade.

### 3. Config (`define-config.ts` / `defaults.ts`)

Add to the existing reputation config block:

```ts
reputation: {
  // ...existing fields...
  demoteCorrectness: z.boolean().default(true),
}
```

Default `true`. The full config is already hashed into the review cache key, so
flipping it invalidates the cache (no stale demote).

### 4. Wiring (`orchestrator.ts`)

The orchestrator already computes `repUnreliable` and passes it to the aggregator.
Pass the new flag through to `aggregate(...)` as `demoteCorrectness` from the
effective reputation config (mirroring how `repUnreliable` / `confidenceFloor` are
threaded today).

### 5. Interactions (verified)

- **F3 Phase 2 FP-cluster demote** (runs earlier, demotes to INFO): if a finding is
  already INFO, `repScoped` skips it (step 1). No double-demote; idempotent.
- **Confidence-demote** (:353, runs earlier, exempts CRITICAL security/correctness):
  unchanged. Within one pass it does not touch the correctness CRITICAL; `repScoped`
  (later) does. Cross-iteration, a correctness `WARN` may become eligible for other
  signals — acceptable, slow, multi-signal; not this spec's immediate effect.
- **Singleton-CRITICAL hard-FAIL** (PR#22, [[reference_critical_single_reviewer]]):
  after `repScoped` the finding is `WARN`, so the CRITICAL-keyed hard-FAIL does not
  fire; the gate still FAILs via `warnFail`. Hard veto removed, visibility kept.

## Non-goals / YAGNI

- No softening of `security` findings, ever.
- No second/stricter threshold — reuse `repUnreliable`.
- No demote below WARN for correctness via this mechanism (no silencing).
- No change to how reputation is *learned* (`reputation/learn.ts` already records
  `reviewer_was_wrong` regardless of category — that half already works).

## Risks & mitigations

- **A real correctness bug from a lone unreliable reviewer gets downgraded to WARN.**
  Mitigation: WARN still blocks the gate and requires an explicit decision — the
  finding is never hidden; only its hard-veto status is removed. The reviewer must
  be chronically wrong (`repUnreliable`) and uncorroborated for this to fire.
- **Mis-categorized security finding tagged `correctness`.** Mitigation:
  `touchesSecurity` checks representative AND every merged member category, so a
  security concern clustered under a correctness representative is still caught and
  exempted.

## Acceptance criteria

1. Lone + `repUnreliable` + uncorroborated **correctness** CRITICAL → demoted to WARN,
   tagged `reputation_demoted`, and still FAILs the gate (blocking).
2. **security** CRITICAL in the same conditions → stays CRITICAL (hard veto) —
   regression-guarded by a test.
3. Correctness WARN under the same conditions → stays WARN (never INFO).
4. `majority`/`unanimous` correctness CRITICAL → stays CRITICAL.
5. `demoteCorrectness: false` → no correctness demote (today's behavior).
6. Pure quality CRITICAL→WARN and WARN→INFO cascade unchanged.
7. `bunx tsc --noEmit`, `bun run lint`, full `bun test` clean.
