// src/cache/behavior-hash.ts
//
// Single structured behavior-hash for the review cache key. Both the brain's
// active-entry identity and the FP-ledger's active/sticky identity flow through
// here so a change in either deterministically invalidates a cached PASS/SOFT-PASS
// (a cached pass otherwise short-circuits BEFORE few-shot injection and the
// reactive fp-demote run). Keep the brain-only output byte-identical to the
// pre-B1 `id:status` format so existing cache keys are preserved when the
// FP-ledger is off or empty.

export interface BrainHashEntry {
  id: string;
  status: string;
}
// `id` is intentionally excluded — it only feeds the cosmetic fp_ledger_match
// .pattern_id and must not perturb the cache. Verdict behavior depends solely on
// which signatures are demoted (and at what stage).
export interface FpHashEntry {
  signature: string;
  stage: string;
  id?: string;
}

export function computeBehaviorHash(input: {
  brain: BrainHashEntry[];
  fp: FpHashEntry[];
}): string {
  const brainPart = input.brain
    .map((e) => `${e.id}:${e.status}`)
    .sort()
    .join(",");
  if (input.fp.length === 0) return brainPart;
  const fpPart = input.fp
    .map((e) => `${e.signature}:${e.stage}`)
    .sort()
    .join(",");
  return `${brainPart}|fp:${fpPart}`;
}
