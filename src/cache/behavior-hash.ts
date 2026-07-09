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
// M6: the injected docs corpus identity. `libraryId` is intentionally NOT part
// of the digest — `responseHash` already captures the fetched content and
// `name@version` captures which lib/version was injected. A docs change (new
// version, re-indexed content) flips `responseHash` → cache invalidation.
export interface DocsHashEntry {
  name: string;
  version: string | null;
  responseHash: string;
}

export function computeBehaviorHash(input: {
  brain: BrainHashEntry[];
  fp: FpHashEntry[];
  docs?: DocsHashEntry[] | undefined;
  // Slice 2: sha256 hex of injected referenced-file content (doc reviews) — invalidates the cache when that source changes.
  refs?: string | undefined;
  // §3.1: per-persona reaffirmation DELTA from the built-in map (entries sourced
  // from a persona file / config override), as `<id>:<sha256(text)>`. Empty when
  // no override → segment omitted → byte-identical to the legacy hash.
  personas?: string[] | undefined;
  // S1: sha256 hex of the rendered prior-iteration adjudications injected into the
  // reviewer prompt — invalidates the cache when that cross-iteration context changes.
  // Empty/absent → segment omitted (continuity rule).
  adjudications?: string | undefined;
  // N5: sha256 hex of the injected imported-collaborator corpus (unchanged first-party
  // files shown for premise verification). A collaborator's content is NOT in the diff
  // hash, so a change to it must invalidate the cached verdict. Empty/absent → omitted.
  collaborators?: string | undefined;
  // N7: sha256 hex of the rendered UI/CSS facts block. Derived from the changed files'
  // content (covered by the diff hash) BUT also from the resolver tables, so fold it in
  // for determinism/invalidation. Empty/absent → omitted (continuity rule).
  ui?: string | undefined;
  // Lore v1 (2026-07-09): sha256 hex of the rendered lore injection block (the
  // trusted "Project lore" text). Not covered by the diff hash (lore lives under
  // .reviewgate/, which is excluded from the reviewed diff) — fold it in so an
  // entry edit invalidates a cached verdict. Empty/absent → omitted (continuity rule).
  lore?: string | undefined;
}): string {
  const brainPart = input.brain
    .map((e) => `${e.id}:${e.status}`)
    .sort()
    .join(",");
  // Append fp / docs segments ONLY when non-empty, so the brain-only output stays
  // byte-identical to the legacy format and existing cache keys are preserved when
  // those phases are off or empty (same continuity rule across all segments).
  let out = brainPart;
  if (input.fp.length > 0) {
    const fpPart = input.fp
      .map((e) => `${e.signature}:${e.stage}`)
      .sort()
      .join(",");
    out += `|fp:${fpPart}`;
  }
  if (input.docs && input.docs.length > 0) {
    const docsPart = input.docs
      .map((e) => `${e.name}@${e.version ?? ""}:${e.responseHash}`)
      .sort()
      .join(",");
    out += `|docs:${docsPart}`;
  }
  if (input.refs) {
    out += `|refs:${input.refs}`;
  }
  if (input.personas && input.personas.length > 0) {
    out += `|personas:${[...input.personas].sort().join(",")}`;
  }
  if (input.adjudications) {
    out += `|adj:${input.adjudications}`;
  }
  if (input.collaborators) {
    out += `|collab:${input.collaborators}`;
  }
  if (input.ui) {
    out += `|ui:${input.ui}`;
  }
  if (input.lore) {
    out += `|lore:${input.lore}`;
  }
  return out;
}
