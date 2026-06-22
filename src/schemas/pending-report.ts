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
  // S2 (field report 2026-06-23): true iff the reviewed diff contains at least one file this
  // session is responsible for (the attributable ∩ diff set is non-empty). The load-bearing
  // whole-diff guard for the out-of-session honest handoff: the agent may disown the change-set
  // ONLY when this is false (the session produced zero uncommitted work in the diff). ABSENT is
  // read as TRUE by the decisions-gate (fail-closed: disown unavailable) — note the INVERTED
  // polarity vs the per-finding flags. Omitted on single-agent / scoping-off / non-main writeReport
  // paths (cache-hit/ERROR/early-PASS), all of which correctly disable disown.
  whole_diff_attributable: z.boolean().optional(),
  // Slice C: a human/agent-visible note when the reviewer panel was degraded this
  // cycle (reviewers quarantined, or all-quarantined → full panel ran anyway).
  panel_note: z.string().optional(),
  // Slice 3 (field report #6): counts for the large-diff warning banner. Present only when
  // the reviewed diff exceeded loop.diffWarnBytes/diffWarnFiles. Render-only; mirrors panel_note.
  large_diff: z
    .object({ files: z.number().int().nonnegative(), bytes: z.number().int().nonnegative() })
    .optional(),
  // #7: set when the working tree was still being written when the panel ran (the
  // settle-check hit its cap without the tree going quiet). Render-only / advisory —
  // the verdict is unaffected; warns the agent the review may reflect a half-finished state.
  workspace_unsettled: z
    .object({
      last_write_ms_ago: z.number().int().nonnegative(),
      waited_ms: z.number().int().nonnegative(),
    })
    .optional(),
  // P11: set when this is a PURE docs-only review (triage riskClass "docs" — every changed
  // file is prose/markdown). Render-only — drives a "spec/docs review" framing banner so the
  // agent reads a prose finding as a prose review (e.g. verify a framework attribution) rather
  // than code-review CRITICAL weight. The verdict/severity are unaffected.
  docs_review: z.boolean().optional(),
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
