import { z } from "zod";

export const RepEventSchema = z.object({ ts: z.string(), eid: z.string() });

export const ReputationEntrySchema = z.object({
  correct: z.array(RepEventSchema).default([]),
  wrong: z.array(RepEventSchema).default([]),
});

export const ReputationSchema = z.object({
  schema: z.literal("reviewgate.reputation.v1"),
  // keyed by provider id (NOT provider::persona — merged members lack persona)
  reviewers: z.record(z.string(), ReputationEntrySchema).default({}),
});

export type Reputation = z.infer<typeof ReputationSchema>;
export type ReputationEntry = z.infer<typeof ReputationEntrySchema>;

export function emptyReputation(): Reputation {
  return { schema: "reviewgate.reputation.v1", reviewers: {} };
}
