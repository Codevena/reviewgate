# Advisory FP-Fragmentation Surfacing — Design (field-report #4)

**Date:** 2026-06-17
**Field-report item:** #4 — "Persist adjudications across diff changes (a rejected FP must not return as a fresh CRITICAL) / fix the FP-ledger signature fragmentation."
**Status:** approved, pre-implementation.

## Problem & scope

The FP suppression system is already extensive: the per-signature **FP-ledger**
(candidate→active→sticky, auto-demote), the **FP-clusters** view (`clusters.ts`,
groups by `(rule_id_token0, file)` so paraphrased rule_ids cluster and an
active/sticky cluster auto-demotes — `fp_cluster_match`), maintainer **house-rules**
(`house-rules.ts` — the documented durable fix: assert ground truth, suppress at the
source), reputation, and the Brain cross-run quorum.

**The fail-safe wall (why the literal ask is out of scope):** the ledger's
`≥3 rejects + ≥2 distinct providers` promotion floor exists *specifically* to stop
the agent from suppressing a REAL finding by rejecting it once. The literal #4 ask —
auto-suppress a fragmented *single-reject* class — **fails OPEN**: it would let the
agent reject a real CRITICAL once and have it suppressed forever. A stronger
*automatic* suppressor on fewer signals is therefore unsound (the same trap #3 hit).

**The genuine residual gap (in scope):** the *documented* durable fix is a house
rule, but a maintainer running the gate **never learns when a class is fragmenting**
— `isNearActive` is surfaced only via the CLI. So the durable fix is never applied.
This design closes that gap: detect a fragmenting-but-unpromotable FP class at
gate-time and surface an **advisory** banner recommending a house rule. Purely
additive metadata — it can never demote/suppress a finding, so it sidesteps the
fail-open wall entirely (Option B; mirrors the #3/#8 advisory-context pivot).

Out of scope: any automatic suppression on fewer-than-floor signals (unsound); coarser
auto-clustering by category (over-suppression risk — Option A, rejected); relaxing the
≥2-provider floor (loses cross-validation).

## Components

### 1. `src/core/fp-ledger/fragmentation.ts` (new, pure)

```ts
export interface FpFragmentation {
  file: string;
  distinct_signatures: number; // distinct candidate-entry signatures on the file
  total_rejects: number;       // reject events within the window across those entries
  sample_rule_ids: string[];   // a few distinct rule_ids, for the human
}

// Files where a false-positive class is FRAGMENTING but not being suppressed.
// `suppressedFiles` is the set of files where suppression is EFFECTIVELY ACTIVE
// AT `now` (built by the caller from the windowed views — the per-signature
// activeSnapshot AND the active/sticky clusters — NOT from the stored entry.stage,
// which is promote-only and can be stale). The detector does NOT read `entry.stage`;
// it relies entirely on `suppressedFiles` for the "already suppressed" exclusion.
// Pure; sorted by total_rejects desc; the caller caps the count.
export function fragmentingFpClasses(
  entries: FpLedgerEntry[],
  nowIso: string,
  opts: {
    minDistinctSignatures: number;
    minRejects: number;
    windowDays: number;
    suppressedFiles: Set<string>;
  },
): FpFragmentation[];
```

Logic: group entries by `file`, skipping files in `suppressedFiles`. For each
remaining file, consider only entries with **≥1 reject within `windowDays`** of
`nowIso` (so stale signatures with no recent activity neither inflate the
fragmentation breadth nor the reject count — codex). Among those in-window entries:
`distinct_signatures` = count of distinct signatures; `total_rejects` = sum of
in-window reject events. If `distinct_signatures >= minDistinctSignatures` AND
`total_rejects >= minRejects` → emit `{ file, distinct_signatures, total_rejects,
sample_rule_ids }` (sample_rule_ids = up to 4 distinct rule_ids from the in-window
entries, sorted). Return sorted by `total_rejects` desc, tie-broken by `file`.

### 2. Orchestrator wiring — `src/core/orchestrator.ts`

The orchestrator already loads `fpFullSnapshot = await fpStore.snapshot()` (~651), the
windowed per-signature `fpActiveSnapshot = await fpStore.activeSnapshot(now)` (~654, a
`Map<signature, FpLedgerEntry>` of entries EFFECTIVELY active at `now`), and computes
`fpActiveClusters` from `computeFpClusters(...)` (~1621). In the SAME loop that builds
`fpActiveClusters`, also collect the active/sticky clusters' files (from the `FpCluster`
object's `.file`, BEFORE it is reduced to `{key, member_ids}` — do not parse the key).
Then, in gate mode only (`reportMode !== "one-shot"`) and when
`phases.review.fpFragmentationHint` is truthy and `fpFullSnapshot` exists:

```ts
// suppressedFiles = files where suppression is EFFECTIVELY ACTIVE at `now`:
//   (a) per-signature active entries (fpActiveSnapshot — already windowed/demoted), and
//   (b) active/sticky clusters' files (collected from FpCluster.file in the cluster loop).
// Built from the windowed views, never from the stored (promote-only, stale) entry.stage.
const suppressedFiles = new Set<string>();
if (fpActiveSnapshot) for (const e of fpActiveSnapshot.values()) suppressedFiles.add(e.file);
for (const f of activeClusterFiles) suppressedFiles.add(f); // collected in the cluster loop

let fpFragmentation: FpFragmentation[] | undefined;
if (this.input.reportMode !== "one-shot" && this.input.config.phases.review.fpFragmentationHint && fpFullSnapshot) {
  try {
    const frag = fragmentingFpClasses(fpFullSnapshot.entries, now.toISOString(), {
      minDistinctSignatures: FP_FRAG_MIN_SIGNATURES,
      minRejects: FP_FRAG_MIN_REJECTS,
      windowDays: FP_FRAG_WINDOW_DAYS,
      suppressedFiles,
    });
    if (frag.length > 0) fpFragmentation = frag.slice(0, FP_FRAG_MAX_REPORTED);
  } catch (err) {
    console.warn(`[reviewgate] fp-fragmentation hint failed (non-fatal): ${String(err)}`);
  }
}
```

- `fpFragmentation` is a `runIteration` LOCAL (not a constructor `this.input`), unlike
  `largeDiff`/`workspaceUnsettled` which the gate passes in. So thread it to `writeReport`
  as a **new trailing optional parameter** (like `criticInfo`/`panelNote` are params), and
  inside `writeReport` inject `...(fpFragmentation ? { fp_fragmentation: fpFragmentation } : {})`
  into the `PendingReport` object (next to `large_diff`).
- Constants in `fragmentation.ts`: `FP_FRAG_MIN_SIGNATURES = 3`, `FP_FRAG_MIN_REJECTS = 3`,
  `FP_FRAG_WINDOW_DAYS = 60` (matches the cluster active window), `FP_FRAG_MAX_REPORTED = 3`.
- Suppression exclusion uses the WINDOWED views (`fpActiveSnapshot` + the active/sticky
  cluster files), never the stored `entry.stage` (which `store.recompute` only ever raises,
  so it can be stale; `activeSnapshot`/`computeFpClusters` are the read-time demoting views).
- Best-effort: a thrown error → no hint, never blocks the verdict.

### 3. Schema — `src/schemas/pending-report.ts`

```ts
// #4: advisory — files where a false-positive class is fragmenting across many
// FP-ledger entries but not promoting to auto-suppression (fragmented rule_ids /
// single-reviewer ≥2-provider floor). Render-only; recommends a house rule. The
// verdict is unaffected.
fp_fragmentation: z
  .array(
    z.object({
      file: z.string(),
      distinct_signatures: z.number().int().nonnegative(),
      total_rejects: z.number().int().nonnegative(),
      sample_rule_ids: z.array(z.string()),
    }),
  )
  .optional(),
```

### 4. Rendering — `src/core/report-writer.ts` `renderMd`

A banner (alongside the other banners), emitted only when `r.fp_fragmentation` is
present + non-empty. One line per reported file:

```
> ⚠ **Fragmenting false-positive class:** `<file>` has <N> distinct rejected-FP findings (e.g. `<ruleA>`, `<ruleB>`, `<ruleC>`; <M> rejects) that aren't promoting to auto-suppression (fragmented rule_ids / single reviewer). The durable fix is a **house rule** in `phases.review.houseRules` (reviewgate.config.ts) asserting the repo's ground truth — it suppresses the class at the source and invalidates cached verdicts.
```

(Rule_ids are gate-derived ledger fields — known strings, not untrusted reviewer
free-text — so no injection neutralization is needed, consistent with the #8
`reviewer_precision` rendering.)

### 5. Config — `src/config/define-config.ts` + `defaults.ts`

```ts
// define-config.ts (phases.review):
// #4: surface an advisory hint in pending.md when a false-positive class is
// fragmenting across many FP-ledger entries on a file but not promoting to
// auto-suppression — recommending a house rule (the durable fix). Render-only;
// never suppresses a finding. Default on.
fpFragmentationHint: z.boolean().optional(),
```
`defaults.ts` (phases.review): `fpFragmentationHint: true`. Thresholds are module
constants (YAGNI). Requires the FP-ledger to be enabled (else `fpFullSnapshot` is
undefined and the hint is skipped).

## Behavior summary

- A file with ≥3 distinct candidate FP-ledger signatures + ≥3 in-window rejects, no
  active/sticky entry, not cluster-suppressed → advisory banner recommending a house rule.
- A file already suppressed (an entry promoted, OR an active cluster covers it) → no hint.
- Stale rejects (outside the 60-day window) → not counted.
- FP-ledger disabled, toggle off, or one-shot mode → no hint.
- Best-effort: any error → no hint, never blocks the verdict.

## Testing

Unit (`fragmentingFpClasses`, pure; construct `FpLedgerEntry[]` fixtures — the detector
does NOT read `entry.stage`, so fixtures vary signatures/files/reject ts only):
1. a file with 3 distinct signatures each with an in-window reject, not in
   `suppressedFiles` → flagged (distinct_signatures 3, total_rejects ≥ 3, sample_rule_ids).
2. below `minDistinctSignatures` (2 distinct in-window signatures) → not flagged.
3. a file in `suppressedFiles` → excluded entirely.
4. a signature whose only rejects are OUTSIDE `windowDays` → it neither counts toward
   distinct_signatures nor total_rejects (so a file relying on it falls below threshold).
5. multiple flagged files → sorted by `total_rejects` desc.

report-writer: `fp_fragmentation` present → banner rendered (file + rule_ids + house-rule
recommendation); absent → no banner.

config: `fpFragmentationHint` defaults to `true` (via the defaults merge / defineConfig).

orchestrator: a fragmenting fixture in the ledger + toggle on → pending.md shows the
banner; toggle off / suppressed file → no banner. (Mirror the #8 orchestrator-precision test.)

Plus: `bunx tsc --noEmit`, `bun run lint`, `bun test tests/unit --timeout 20000` clean.

## Files touched

- `src/core/fp-ledger/fragmentation.ts` — new (pure detector + constants).
- `src/core/orchestrator.ts` — compute the hint after `fpActiveClusters` (gate-mode, toggle-gated, best-effort); thread to `writeReport`.
- `src/schemas/pending-report.ts` — optional `fp_fragmentation` field.
- `src/core/report-writer.ts` — render the banner.
- `src/config/define-config.ts` + `defaults.ts` — `fpFragmentationHint` toggle.
- `tests/unit/` — new tests for the detector, the banner, the config, the orchestrator passthrough.
