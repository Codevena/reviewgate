import { z } from "zod";

export const BrainEntryType = z.enum([
  "convention",
  "anti-pattern",
  "external-knowledge",
  "disagreement",
  "research-cache",
]);
// Single source of truth (derived from the enum) for valid brain-entry types —
// the curator's proposal normalization imports this instead of re-listing the
// literals, so adding a type to the enum can't silently diverge.
export const VALID_BRAIN_ENTRY_TYPES: ReadonlySet<string> = new Set(BrainEntryType.options);

export const BrainEntryStatus = z.enum(["candidate", "active", "stale", "archived"]);
export type BrainEntryStatus = z.infer<typeof BrainEntryStatus>;

export const EvidenceKind = z.enum([
  "reviewer-finding",
  "web-fetch",
  "deterministic",
  "reviewer-observation",
]);
// Single source of truth for valid evidence kinds — consumers (curator
// normalization, orchestrator proposal collection) import this Set instead of
// re-listing the literals, so adding a kind to the enum can't silently diverge.
export const VALID_EVIDENCE_KINDS: ReadonlySet<string> = new Set(EvidenceKind.options);

export const EvidenceItemSchema = z
  .object({
    kind: EvidenceKind,
    source_url: z.string().url().optional(),
    body_sha256: z.string().length(64).optional(),
    fetched_at: z.string().optional(),
    run_id: z.string().optional(),
    reviewer_id: z.string().optional(),
    from_diff: z
      .object({ file: z.string(), line_start: z.number().int(), line_end: z.number().int() })
      .optional(),
    snippet: z.string().max(200).optional(),
  })
  .superRefine((e, ctx) => {
    if (e.kind === "web-fetch" && (!e.source_url || !e.body_sha256 || !e.fetched_at)) {
      ctx.addIssue({
        code: "custom",
        message: "web-fetch evidence needs source_url+body_sha256+fetched_at",
      });
    }
    if (
      (e.kind === "reviewer-finding" || e.kind === "reviewer-observation") &&
      (!e.run_id || !e.reviewer_id)
    ) {
      ctx.addIssue({ code: "custom", message: "reviewer evidence needs run_id+reviewer_id" });
    }
  });
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;

export const MemoryProposalSchema = z.object({
  type: BrainEntryType,
  scope: z.string(),
  title: z.string().max(80),
  body: z.string().max(500),
  evidence: z.array(EvidenceItemSchema).min(1),
  confidence: z.number().min(0).max(1),
  tags: z.array(z.string()),
});
export type MemoryProposal = z.infer<typeof MemoryProposalSchema>;

export const BrainEntrySchema = z.object({
  id: z.string(),
  type: BrainEntryType,
  scope: z.string(),
  title: z.string().max(80),
  body: z.string().max(500),
  tags: z.array(z.string()),
  file_globs: z.array(z.string()),
  status: BrainEntryStatus.default("candidate"),
  referenced_count: z.number().int().nonnegative().default(1),
  referencing_reviewers: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
  embedding: z.array(z.number()).nullable().default(null),
  // The embedding model that produced `embedding`. Optional/back-compatible:
  // entries written before this field (or with no embedding) load fine without
  // it. Cosine similarity is only meaningful WITHIN one model's vector space, so
  // dedup compares embeddings only when their `embedding_model` matches.
  embedding_model: z.string().optional(),
  evidence: z.array(EvidenceItemSchema),
  provenance: z.enum(["diff-derived"]).optional(),
  created_at: z.string(),
  last_referenced_at: z.string().optional(),
  source_run_id: z.string(),
  linked_fp_id: z.string().optional(), // Phase B3: paired FP-ledger entry
});
export type BrainEntry = z.infer<typeof BrainEntrySchema>;

export const BrainCandidateSchema = z.object({
  id: z.string(),
  title: z.string().max(80),
  body: z.string().max(500),
  scope: z.string(),
  type: BrainEntryType,
  embedding: z.array(z.number()).min(1),
  embedding_model: z.string().min(1),
  provider: z.string().min(1),
  confidence: z.number().min(0).max(1),
  source_run_id: z.string(),
  created_at: z.string().datetime(),
  evidence_kinds: z.array(EvidenceKind).default([]),
});
export type BrainCandidate = z.infer<typeof BrainCandidateSchema>;

export const CuratorDecisionSchema = z
  .object({
    schema: z.literal("reviewgate.curator.v1"),
    run_id: z.string(),
    proposal_title: z.string(),
    decision: z.enum(["promoted", "rejected", "queued", "merged-duplicate"]),
    rule_failed: z.string().optional(),
    // Sub-reason for rule_failed:"schema" (e.g. "title", "evidence", "merged:evidence")
    // — diagnostic only, so a recurring schema reject is identifiable from the log.
    schema_detail: z.string().optional(),
    entry_id: z.string().optional(),
    provider: z.string(),
    ts: z.string(),
  })
  .superRefine((d, ctx) => {
    // A promoted proposal MUST reference the brain entry it created.
    if (d.decision === "promoted" && (!d.entry_id || d.entry_id.length === 0)) {
      ctx.addIssue({
        code: "custom",
        path: ["entry_id"],
        message: "a 'promoted' curator decision requires entry_id",
      });
    }
  });
export type CuratorDecision = z.infer<typeof CuratorDecisionSchema>;
