import { z } from 'zod';

const Base = z.object({
  schema: z.literal('reviewgate.decision.v1'),
  finding_id: z.string(),
});

const Accepted = Base.extend({
  verdict: z.literal('accepted'),
  action: z.enum(['fixed', 'addressed-elsewhere', 'deferred-with-followup']),
  files_touched: z.array(z.string()).optional(),
  commit_message_hint: z.string().optional(),
});

const Rejected = Base.extend({
  verdict: z.literal('rejected'),
  reason: z.string().min(20),
  reviewer_was_wrong: z.boolean().optional(),
});

export const DecisionEntrySchema = z.discriminatedUnion('verdict', [Accepted, Rejected]);
export type DecisionEntry = z.infer<typeof DecisionEntrySchema>;
