# Spec — Reputation-demote lone unreliable correctness CRITICALs to advisory

**Date:** 2026-05-28
**Status:** Approved (design, v2), pending implementation plan
**Author:** brainstormed with Markus

> **v2 note:** v1 proposed CRITICAL→WARN "stays blocking". An agy spec-review
> (verified against the code) showed that premise is false for the target case: a
> lone reviewer's WARN has `singleton` consensus, so `warnFail` is never set
> (aggregator.ts:421-425) → verdict `SOFT-PASS` → under the default
> `softPassPolicy:"allow"` (defaults.ts:123, loop-driver.ts:561-562) it is
> **non-blocking**. There is no "blocking-but-softer" tier for a lone reviewer.
> Decision was re-made: **demote to INFO (advisory), honestly non-blocking** — the
> real relief.

## Problem / Motivation

A single-reviewer panel that keeps hallucinating CRITICAL findings (the shoal
opencode case, [[project_shoal_dogfood_audit]] / [[project_reviewer_fp_runaway_loop]])
imposes a permanent verification tax: every run the agent must build a runtime
trace and reject the false positive with evidence. The self-learning machinery
records the signal (`reputation/learn.ts` logs `reviewer_was_wrong`), but the
**reputation demote cannot act on it for correctness/security CRITICALs** —
`aggregator.ts`'s `repScoped` pass exempts `touchesSecurityOrCorrectness` entirely
(line ~377). So a reviewer can be chronically wrong in the *correctness* lane
forever and never get reined in.

The pushed **F3 Phase 2** (derived FP-cluster demote) is the multi-provider
backstop — but a cluster only goes *active* once a **second** provider rejects the
same pattern. For a **single-reviewer** panel, no cluster ever activates, so the
gap stays open. This spec is the **single-reviewer complement**: a reputation-keyed
demote that relieves the tax for a lone reviewer.

## Decisions (locked during brainstorming)

1. **Scope: `correctness` only.** `security` CRITICALs are NEVER softened. We split
   the blanket `touchesSecurityOrCorrectness` exemption in `repScoped` into
   "security always-exempt" + "correctness demotable".
2. **Demote target: INFO (advisory), unconditionally non-blocking.** Not WARN. A
   lone reviewer's WARN is only non-blocking under `softPassPolicy:"allow"`; INFO is
   non-blocking under every policy (verdict counts INFO separately; an INFO-only
   panel → `PASS`). INFO stays **visible** in `pending.md`'s advisory section
   (tagged), but requires **no decision** — the agent just ends its turn instead of
   rejecting the same hallucination with evidence every run. This mirrors the
   established **FP-ledger demote**, whose advisory target is also INFO.
3. **Threshold: reuse the existing `repUnreliable` set** (same `minSamples` +
   `trustFloor`). No second threshold.
4. **Default ON**, behind `reputation.demoteCorrectness` so it can be disabled.
5. **Corroboration still protects:** `unanimous`/`majority` findings are never
   reputation-demoted (unchanged).

**Accepted risk:** a genuine correctness bug from a chronically-wrong, uncorroborated
lone reviewer becomes advisory (visible, non-blocking) rather than a hard veto. This
is the deliberate trade — bounded by the gating (repUnreliable + uncorroborated +
correctness-only, never security).

## Background — current `repScoped` + verdict (aggregator.ts)

`repScoped` (~371-394) currently demotes one step but **skips
`touchesSecurityOrCorrectness` wholesale**:

```
if (f.severity === "INFO") return f;
if (f.consensus === "unanimous" || f.consensus === "majority") return f;
if (touchesSecurityOrCorrectness(f)) return f;          // <-- blanket exempt (to split)
const keys = f.confirmed_by?.length ? f.confirmed_by : [`${f.reviewer.provider}:${f.reviewer.persona}`];
if (!keys.every((k) => repUnreliable.has(k))) return f;
const next = DEMOTE[f.severity]; ...
```

Verdict loop (~397-434, runs on `repScoped` which is the LAST transform):

```
for (const f of repScoped) {
  if (f.severity === "CRITICAL") {
    if (touchesSecurityOrCorrectness(f)) fail = true;                 // hard veto
    else if (consensus unanimous/majority) fail = true;
    else if (reviewersTotal <= 1) fail = true;                        // singleton CRITICAL (PR#22)
  } else if (f.severity === "WARN") {
    if (consensus unanimous/majority) warnFail = true;                // lone WARN does NOT set this
  } else info++;
}
verdict = (fail || warnFail) ? "FAIL" : warn > 0 ? "SOFT-PASS" : "PASS";
```

This is why INFO is the robust advisory target: a demoted lone correctness finding
at INFO contributes only to `info++`, so an otherwise-clean panel → `PASS` (gate
opens, no decision), independent of `softPassPolicy`.

## Design

### 1. Helper split (`aggregator.ts`)

Add two focused predicates; leave `touchesSecurityOrCorrectness` untouched for its
other call sites (critic block ~257, confidence-demote exemption ~353, verdict
hard-FAIL ~405):

```ts
function touchesSecurity(f: Finding): boolean {
  const cats = [f.category, ...(f.members?.map((m) => m.category) ?? [])];
  return cats.some((c) => c === "security");
}
function touchesCorrectness(f: Finding): boolean {
  const cats = [f.category, ...(f.members?.map((m) => m.category) ?? [])];
  return cats.some((c) => c === "correctness");
}
```

### 2. Carve-in in `repScoped`

Gated by `input.demoteCorrectness` (default true). Per-finding skip order:

1. `INFO` → skip (already advisory).
2. `unanimous`/`majority` → skip (corroboration protects).
3. **`touchesSecurity(f)` → skip** (security never softened — replaces the security
   half of the old blanket exempt).
4. `keys` not all in `repUnreliable` → skip.
5. **Correctness branch:** if `touchesCorrectness(f)` && `demoteCorrectness` → set
   `severity = "INFO"`, tag `reputation_demoted: true`, append a note to `details`
   ("dampened to advisory — correctness finding from an unreliable lone reviewer").
   This applies to a correctness CRITICAL **or** WARN (both → INFO advisory).
6. **Else (pure quality/style, neither security nor correctness):** unchanged —
   existing one-step `DEMOTE[f.severity]` (CRITICAL→WARN, WARN→INFO).

No WARN-cap special case (v1's subtlety is gone — correctness goes straight to the
INFO advisory tier).

### 3. Config (`define-config.ts` + `defaults.ts`)

`define-config.ts` reputation block (~108): add
`demoteCorrectness: z.boolean().default(true)`.
`defaults.ts` reputation defaults (~103): add explicit `demoteCorrectness: true`
(so the effective default is visible, not only schema-implied). The full config is
hashed into the review cache key, so flipping it invalidates the cache.

### 4. Wiring (`orchestrator.ts` ~1007-1023)

`repUnreliable` is already computed and threaded into `aggregate({...})`. Read the
flag from the effective reputation config (`repCfg?.demoteCorrectness ?? true`) and
pass it as `demoteCorrectness` on `AggregateInput` (extend the type at
aggregator.ts ~10-44, mirroring `repUnreliable`/`confidenceFloor`).

### 5. Interactions (verified)

- **F3 Phase 2 FP-cluster demote** (runs earlier, → INFO): if already INFO,
  `repScoped` step 1 skips it. Idempotent, no conflict; both may tag the finding.
- **Confidence-demote** (:353, exempts CRITICAL security/correctness): unchanged;
  runs before `repScoped`. The correctness CRITICAL is exempt there, then `repScoped`
  takes it to INFO. No double-handling issue (INFO is terminal).
- **Singleton-CRITICAL hard-FAIL** (PR#22): only fires for `severity === "CRITICAL"`;
  after `repScoped` the finding is INFO, so it does not fire. Intended.
- **Verdict:** lone correctness CRITICAL→INFO, otherwise-clean panel → `PASS`
  (non-blocking, no decision required). A mis-categorized **security** member keeps
  the finding exempt via `touchesSecurity` (representative + members).

## Non-goals / YAGNI

- No softening of `security` findings, ever.
- No second/stricter threshold — reuse `repUnreliable`.
- No change to how reputation is *learned* (`reputation/learn.ts` already records
  `reviewer_was_wrong` regardless of category).
- No change to `softPassPolicy` or the loop-driver (INFO sidesteps all of it).

## Risks & mitigations

- **A real correctness bug from a lone unreliable reviewer becomes advisory.**
  Accepted (decision #2). Bounded: requires the reviewer to be `repUnreliable`
  (≥minSamples, trust<floor), the finding uncorroborated, and `correctness` not
  `security`. The finding stays visible in `pending.md` (advisory), just non-blocking.
- **Security finding mis-categorized as `correctness` at the source.** Mitigation:
  `touchesSecurity` checks the representative AND every merged member category, so a
  security concern clustered under a correctness finding is still exempt. Residual:
  a reviewer that labels a pure-security issue as `correctness` with no security
  member could be demoted — accepted residual, documented here, and only for a
  chronically-unreliable lone reviewer.

## Acceptance criteria

1. Lone + `repUnreliable` + uncorroborated **correctness** CRITICAL → demoted to INFO,
   tagged `reputation_demoted`; an otherwise-clean panel → verdict `PASS`
   (non-blocking, no decision required) — regardless of `softPassPolicy`.
2. **security** CRITICAL in the same conditions → stays CRITICAL → hard FAIL
   (regression-guarded test).
3. A finding whose representative is `correctness` but has a `security` member →
   stays CRITICAL (exempt via `touchesSecurity`).
4. `majority`/`unanimous` correctness CRITICAL → stays CRITICAL.
5. `demoteCorrectness: false` → no correctness demote (today's behavior, correctness
   CRITICAL still hard-FAILs).
6. Pure quality CRITICAL→WARN and WARN→INFO cascade unchanged.
7. `bunx tsc --noEmit`, `bun run lint`, full `bun test` clean.
