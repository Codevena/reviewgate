import { z } from "zod";

export const Severity = z.enum(["CRITICAL", "WARN", "INFO"]);
export type Severity = z.infer<typeof Severity>;

export const FindingCategory = z.enum([
  "security",
  "correctness",
  "quality",
  "architecture",
  "performance",
  "testing",
  "docs",
]);
export type FindingCategory = z.infer<typeof FindingCategory>;

export const Consensus = z.enum(["unanimous", "majority", "minority", "singleton"]);
export type Consensus = z.infer<typeof Consensus>;

export const FindingSchema = z.object({
  id: z.string(),
  signature: z.string(),
  severity: Severity,
  category: FindingCategory,
  rule_id: z.string(),
  file: z.string(),
  line_start: z.number().int().positive(),
  line_end: z.number().int().positive(),
  diff_hunk: z.string().optional(),
  message: z.string().max(200),
  details: z.string().max(2000),
  suggested_fix: z.string().optional(),
  reviewer: z.object({
    provider: z.string(),
    model: z.string(),
    persona: z.string(),
  }),
  confidence: z.number().min(0).max(1),
  confirmed_by: z.array(z.string()).optional(),
  consensus: Consensus,
  critic_verdict: z.enum(["keep", "likely_fp"]).optional(),
  critic_reason: z.string().optional(),
  // M5 Part A: set true when the aggregator demoted this finding to INFO because
  // its range falls outside the changed hunks (advisory, non-blocking).
  scope_demoted: z.boolean().optional(),
  // Phase 4 #7: set true when the aggregator demoted this finding to INFO because
  // its reviewer-reported confidence fell below the configured floor AND it wasn't
  // corroborated by other reviewers (advisory, non-blocking).
  low_confidence: z.boolean().optional(),
  // Reviewer-reputation demote: set true when the aggregator demoted this finding
  // one severity step because its sole (un-corroborated) reviewer (provider:persona) is currently
  // below the reputation trust floor. Advisory-leaning; never security/correctness.
  reputation_demoted: z.boolean().optional(),
  // M5 Part B0: per-member provenance of a merged cluster. The aggregator clusters
  // findings (possibly different rule_id/category/signature) under one
  // representative; this records each member's own signature + trusted base
  // provider so the FP-ledger can attribute cross-provider quorum PER signature
  // (not to the representative's signature that some providers never emitted).
  members: z
    .array(
      z.object({
        signature: z.string(),
        provider: z.string(),
        rule_id: z.string(),
        category: FindingCategory,
        // Per-member reviewer confidence — so the confidence-demote uses the
        // cluster MAX (a co-located high-confidence member isn't masked by a
        // low-confidence representative). Optional for backward-compat.
        confidence: z.number().min(0).max(1).optional(),
      }),
    )
    .optional(),
  fp_ledger_match: z
    .object({
      pattern_id: z.string(),
      matched_count: z.number().int().nonnegative(),
      suppressed: z.boolean(),
    })
    .optional(),
  // F3 Phase 2 — match against a DERIVED FP cluster (computeFpClusters) that
  // reached active/sticky stage. Different from fp_ledger_match: that tag fires
  // when a finding's exact signature matches a single ledger entry; this fires
  // when the finding's (rule_id_token0 × file) groups it with ≥3 rejects from
  // ≥2 distinct providers across MULTIPLE ledger entries — catching multi-
  // rule_id hallucination bursts (e.g. prisma-{attribute-corruption, corrupted-
  // attribute, invalid-attribute}) that per-signature granularity misses.
  fp_cluster_match: z
    .object({
      cluster_key: z.string(), // "<rule_id_token0>@<file>"
      member_ids: z.array(z.string()), // FP-ledger entry ids in the cluster
      suppressed: z.boolean(),
    })
    .optional(),
  // §4.3 Fix-Verification: set by the aggregator when this finding's signature was
  // marked accepted/action:"fixed" in an earlier iteration of the current cycle and
  // has RECURRED. The finding is PINNED (critic/confidence/reputation demote passes
  // skip it) so an ineffective "fix" stays blocking. `iter` = earliest iteration the
  // fix was claimed. Rendered as a blocking-section badge by report-writer.
  claimed_fixed_recurred: z.object({ iter: z.number().int().positive() }).optional(),
  contradicts_memory: z
    .object({
      brain_entry_id: z.string(),
      reason: z.string().max(500),
    })
    .optional(),
});

export type Finding = z.infer<typeof FindingSchema>;
