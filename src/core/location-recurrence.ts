// src/core/location-recurrence.ts
// Non-convergence remediation (field report 2026-06-17): every cross-iteration guard is
// SIGNATURE-keyed, so a reviewer re-litigating the SAME file:line each round with a DIFFERENT
// rule_id/signature ('remove the ?.' → 'add the ?. back' → 'normalize trailing slash' →
// 'regex-scope') defeats stuck-signatures, signature-recurrence (#5), cycleRejected and
// claimedFixed, AND fools the convergence accounting (fresh signatures read as progress). This is
// the LOCATION-keyed sibling of signature-recurrence: a file:line REGION re-raised as a blocking
// finding across N consecutive reviewed iterations escalates (surface to the human, block-once,
// NEVER suppress a finding) — the structural fix the field report calls the "missing building
// block". Pure; mirrors signature-recurrence.ts exactly, swapping signature → region key.

// Bucket tolerance so a few-line drift across edits (the reviewer cites line 72 one round, 70 the
// next as the agent edits above it) still maps to the same logical region. bucketSize 10 mirrors
// the line bucketing computeSignature uses. A region is `<repo-path>:<bucketStart>`.
const REGION_BUCKET = 10;

/** Stable region key for a finding's location, bucketed for drift tolerance. */
export function locationKey(file: string, lineStart: number): string {
  const start = Number.isFinite(lineStart) ? Math.max(1, Math.trunc(lineStart)) : 1;
  const bucket = Math.floor((start - 1) / REGION_BUCKET) * REGION_BUCKET;
  return `${file}:${bucket}`;
}

// Region keys in `blocking` present in EVERY one of the last `threshold` rows of `history`.
// Returns [] if threshold < 1 or history has fewer than `threshold` rows. An empty/ERROR row
// (lacking the region) breaks its streak. Sorted + unique. Identical shape to
// recurringBlockingSignatures so the loop-driver wiring mirrors signature-recurrence 1:1.
export function recurringBlockingLocations(
  history: string[][],
  blocking: Set<string>,
  threshold: number,
): string[] {
  if (threshold < 1 || history.length < threshold) return [];
  const window = history.slice(-threshold).map((row) => new Set(row));
  const out: string[] = [];
  for (const region of blocking) {
    if (window.every((row) => row.has(region))) out.push(region);
  }
  return out.sort();
}
