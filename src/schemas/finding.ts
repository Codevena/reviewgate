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
  fp_ledger_match: z
    .object({
      pattern_id: z.string(),
      matched_count: z.number().int().nonnegative(),
      suppressed: z.boolean(),
    })
    .optional(),
  contradicts_memory: z
    .object({
      brain_entry_id: z.string(),
      reason: z.string().max(500),
    })
    .optional(),
});

export type Finding = z.infer<typeof FindingSchema>;
