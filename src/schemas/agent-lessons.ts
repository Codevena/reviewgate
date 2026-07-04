import { z } from "zod";
import { FindingCategory } from "./finding.ts";

export const LessonOccurrenceSchema = z.object({
  run_id: z.string(),
  session_id: z.string(),
  signature: z.string(),
  file: z.string(),
  ts: z.string(),
});
export type LessonOccurrence = z.infer<typeof LessonOccurrenceSchema>;

export const LessonEntrySchema = z.object({
  id: z.string(), // "AL-NNN"
  key: z.string(), // sha256(category + "|" + normalizeRuleId(rule_id))
  category: FindingCategory,
  rule_id: z.string(),
  // The RAW rule_id as the reviewer wrote it (most-recent-wins) — for human-readable display.
  // `rule_id` above stays the NORMALIZED bucket token (it must match `key`). Optional for
  // back-compat: entries written before this field fall back to `rule_id` at render time.
  display_rule_id: z.string().optional(),
  occurrences: z.array(LessonOccurrenceSchema),
  exemplar_message: z.string(),
  first_seen_at: z.string(),
  last_seen_at: z.string(),
});
export type LessonEntry = z.infer<typeof LessonEntrySchema>;

export const AgentLessonsIndexSchema = z.object({
  schema: z.literal("reviewgate.agentlessons.v1"),
  entries: z.array(LessonEntrySchema),
  // Monotonic high-water for AL-NNN allocation (never reuse a pruned id). Optional
  // for back-compat with a store written before `seq` existed.
  seq: z.number().int().nonnegative().optional(),
});
export type AgentLessonsIndex = z.infer<typeof AgentLessonsIndexSchema>;
