// tests/unit/cassette-schema.test.ts
import { describe, expect, it } from "bun:test";
import type { z } from "zod";
import { CassetteEntrySchema, ReviewResultSchema } from "../../src/schemas/cassette.ts";

const reviewResult: z.infer<typeof ReviewResultSchema> = {
  reviewerId: "codex-security",
  verdict: "FAIL",
  findings: [],
  usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
  durationMs: 1,
  exitCode: 0,
  rawEventsPath: "", // MAY be empty — must validate
  status: "ok",
};

describe("cassette schema", () => {
  it("validates a review entry with an empty rawEventsPath", () => {
    const entry = {
      schema: "reviewgate.cassette.entry.v1",
      provider: "codex",
      key: "codex-security",
      method: "review",
      promptSha256: "a".repeat(64),
      result: reviewResult,
    };
    expect(CassetteEntrySchema.parse(entry).result).toEqual(reviewResult);
  });

  it("validates complete + embed entries", () => {
    const c = CassetteEntrySchema.parse({
      schema: "reviewgate.cassette.entry.v1",
      provider: "openrouter",
      key: "openrouter:complete",
      method: "complete",
      promptSha256: "b".repeat(64),
      result: { text: '{"accept":true}' },
    });
    expect((c.result as { text: string }).text).toContain("accept");
    const e = CassetteEntrySchema.parse({
      schema: "reviewgate.cassette.entry.v1",
      provider: "openrouter",
      key: `openrouter:embed:${"c".repeat(64)}`,
      method: "embed",
      promptSha256: "c".repeat(64),
      result: { vector: [0.1, 0.2, 0.3] },
    });
    expect((e.result as { vector: number[] }).vector).toHaveLength(3);
  });

  it("rejects an unknown provider", () => {
    expect(() =>
      CassetteEntrySchema.parse({
        schema: "reviewgate.cassette.entry.v1",
        provider: "nope",
        key: "x",
        method: "review",
        promptSha256: "d".repeat(64),
        result: reviewResult,
      }),
    ).toThrow();
  });

  it("ReviewResultSchema accepts optional rawText/statusDetail", () => {
    expect(
      ReviewResultSchema.parse({ ...reviewResult, rawText: "hi", statusDetail: "x" }).rawText,
    ).toBe("hi");
  });
});
