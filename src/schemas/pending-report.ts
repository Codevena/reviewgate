import { z } from "zod";
import { FindingSchema } from "./finding.ts";

export const ReviewerStatus = z.enum(["ok", "error", "abstain", "timeout", "quota-exhausted"]);
export type ReviewerStatus = z.infer<typeof ReviewerStatus>;

// pending.json is NOT written on ESCALATE — ESCALATION.md is authoritative there.
// See spec §5.5 schemas section.
export const Verdict = z.enum(["PASS", "SOFT-PASS", "FAIL"]);
export type Verdict = z.infer<typeof Verdict>;

export const PendingReportSchema = z.object({
  schema: z.literal("reviewgate.pending.v1"),
  run_id: z.string(),
  iter: z.number().int().nonnegative(),
  max_iter: z.number().int().positive(),
  verdict: Verdict,
  counts: z.object({
    critical: z.number().int().nonnegative(),
    warn: z.number().int().nonnegative(),
    info: z.number().int().nonnegative(),
  }),
  reviewers: z.array(
    z.object({
      id: z.string(),
      provider: z.string(),
      model: z.string(),
      persona: z.string(),
      status: ReviewerStatus,
      cost_usd: z.number().nonnegative(),
      duration_ms: z.number().nonnegative(),
      status_detail: z.string().optional(),
    }),
  ),
  findings: z.array(FindingSchema),
  cost_usd_total: z.number().nonnegative(),
  duration_ms_total: z.number().nonnegative(),
  generated_at: z.string(),
  git: z.object({
    sha: z.string(),
    branch: z.string(),
    dirty_files: z.array(z.string()),
  }),
});

export type PendingReport = z.infer<typeof PendingReportSchema>;
