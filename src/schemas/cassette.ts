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
  "ollama",
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

export const CassetteEntrySchema = z
  .object({
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
  })
  // The `result` shape MUST match `method`, else a malformed line (e.g.
  // method:"embed" with a {text} result) would validate and ReplayAdapter would
  // cast it to the wrong shape and return undefined. Enforce the correspondence so
  // loadCassette skips such lines instead.
  .superRefine((e, ctx) => {
    const r = e.result as Record<string, unknown>;
    const matches =
      (e.method === "review" && "findings" in r) ||
      (e.method === "complete" && "text" in r) ||
      (e.method === "embed" && "vector" in r);
    if (!matches) {
      ctx.addIssue({ code: "custom", message: `result shape does not match method "${e.method}"` });
    }
  });

export type CassetteEntry = z.infer<typeof CassetteEntrySchema>;
