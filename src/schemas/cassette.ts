// src/schemas/cassette.ts
import { z } from "zod";
import { FindingSchema } from "./finding.ts";

// Mirror of providers/registry.ts ProviderId (kept local to avoid a zod import there).
export const ProviderIdSchema = z.enum([
  "codex",
  "gemini",
  "claude-code",
  "openrouter",
  "opencode",
]);

const ReviewStatusSchema = z.enum(["ok", "error", "abstain", "timeout", "quota-exhausted"]);

// zod mirror of ReviewResult (src/providers/adapter-base.ts). rawEventsPath MAY be ""
// (several adapters return empty) → plain z.string(), never non-empty.
export const ReviewResultSchema = z.object({
  reviewerId: z.string(),
  verdict: z.enum(["PASS", "FAIL", "ERROR"]),
  findings: z.array(FindingSchema),
  usage: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    cachedInputTokens: z.number().optional(),
    reasoningTokens: z.number().optional(),
    costUsd: z.number(),
    quotaUsedPct: z.number().nullable(),
  }),
  durationMs: z.number(),
  exitCode: z.number(),
  rawEventsPath: z.string(),
  rawText: z.string().optional(),
  status: ReviewStatusSchema,
  statusDetail: z.string().optional(),
});

export const CassetteEntrySchema = z.object({
  schema: z.literal("reviewgate.cassette.entry.v1"),
  provider: ProviderIdSchema, // ReplayAdapter filters on THIS, not on parsing the key
  key: z.string(),
  method: z.enum(["review", "complete", "embed"]),
  promptSha256: z.string(),
  result: z.union([
    ReviewResultSchema,
    z.object({ text: z.string() }),
    z.object({ vector: z.array(z.number()) }),
  ]),
});

export type CassetteEntry = z.infer<typeof CassetteEntrySchema>;
