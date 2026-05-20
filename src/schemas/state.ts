// src/schemas/state.ts
import { z } from "zod";

export const EscalationReason = z.enum([
  "max-iterations",
  "cost-cap",
  "stuck-signatures",
  "reject-rate-high",
  "decisions-unaddressed",
]);
export type EscalationReason = z.infer<typeof EscalationReason>;

export const ReviewgateStateSchema = z.object({
  schema: z.literal("reviewgate.state.v1"),
  session_id: z.string(),
  iteration: z.number().int().nonnegative(),
  cost_usd_so_far: z.number().nonnegative(),
  tokens_so_far: z.object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
  }),
  signature_history: z.array(z.array(z.string())),
  decision_history: z.array(
    z.object({
      iter: z.number().int().nonnegative(),
      accepted: z.array(z.string()),
      rejected: z.array(z.string()),
    }),
  ),
  last_diff_hash: z.string().nullable(),
  last_stop_ts: z.string().nullable(),
  last_pass_diff_hash: z.string().nullable(),
  // HEAD sha at the last review. Used to detect a commit (HEAD moved) between
  // stops, which re-arms the gate for the next batch of uncommitted changes.
  last_reviewed_head_sha: z.string().nullable().default(null),
  started_at: z.string(),
  escalated: z.boolean(),
  escalation_reason: EscalationReason.nullable(),
  // Whether the current escalation has already been surfaced to the agent via a
  // one-time block. Prevents the escalation block from looping; cleared on re-arm.
  escalation_announced: z.boolean().default(false),
  recovered_from: z.enum(["crash", "corruption"]).optional(),
});

export type ReviewgateState = z.infer<typeof ReviewgateStateSchema>;

export function initialState(sessionId: string): ReviewgateState {
  return {
    schema: "reviewgate.state.v1",
    session_id: sessionId,
    iteration: 0,
    cost_usd_so_far: 0,
    tokens_so_far: { input: 0, output: 0 },
    signature_history: [],
    decision_history: [],
    last_diff_hash: null,
    last_stop_ts: null,
    last_pass_diff_hash: null,
    last_reviewed_head_sha: null,
    started_at: new Date().toISOString(),
    escalated: false,
    escalation_reason: null,
    escalation_announced: false,
  };
}
