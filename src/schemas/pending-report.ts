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
  // Slice C: a human/agent-visible note when the reviewer panel was degraded this
  // cycle (reviewers quarantined, or all-quarantined → full panel ran anyway).
  panel_note: z.string().optional(),
  // Slice 3 (field report #6): counts for the large-diff warning banner. Present only when
  // the reviewed diff exceeded loop.diffWarnBytes/diffWarnFiles. Render-only; mirrors panel_note.
  large_diff: z
    .object({ files: z.number().int().nonnegative(), bytes: z.number().int().nonnegative() })
    .optional(),
  // Critic-phase observability (absent when no critic is configured). Lets a
  // configured-but-silent critic be diagnosed from pending.json:
  //  status "ran"          — produced parseable verdicts (`verdicts` of them)
  //  status "empty"        — ran but returned nothing parseable
  //  status "error"        — the critic adapter failed
  //  status "misconfigured"— provider/config missing
  //  demoted               — findings the critic actually downgraded this run
  critic: z
    .object({
      provider: z.string(),
      status: z.enum(["ran", "error", "empty", "misconfigured"]),
      verdicts: z.number().int().nonnegative(),
      demoted: z.number().int().nonnegative(),
    })
    .optional(),
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
