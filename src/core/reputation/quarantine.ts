// src/core/reputation/quarantine.ts
export interface QuarantineResult<R> {
  /** Reviewers to actually run this cycle. */
  active: R[];
  /** Reviewer keys (provider:persona) skipped because they are quarantined. */
  dropped: string[];
  /** True when filtering would empty the panel → the FULL panel ran anyway (quarantine yields). */
  usedFullFallback: boolean;
}

// Filter quarantined reviewer slots out of the panel. If that would leave zero
// reviewers, return the full list with usedFullFallback=true — quarantine must
// never produce an empty (un-reviewed) panel. Pure: no I/O, fully unit-testable.
export function selectActiveReviewers<R>(
  activeReviewers: R[],
  quarantined: Set<string>,
  keyOf: (r: R) => string,
): QuarantineResult<R> {
  if (quarantined.size === 0)
    return { active: activeReviewers, dropped: [], usedFullFallback: false };
  const active = activeReviewers.filter((r) => !quarantined.has(keyOf(r)));
  if (active.length === 0) return { active: activeReviewers, dropped: [], usedFullFallback: true };
  const dropped = activeReviewers.filter((r) => quarantined.has(keyOf(r))).map(keyOf);
  return { active, dropped, usedFullFallback: false };
}
