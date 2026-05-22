// tests/unit/run-summary-schema.test.ts
import { describe, expect, it } from "bun:test";
import { RunSummarySchema } from "../../src/schemas/audit-event.ts";

const valid = {
  verdict: "FAIL",
  source: "panel",
  counts: { critical: 1, warn: 0, info: 2 },
  cost_usd: 0.01,
  duration_ms: 1234,
  demoted: 1,
  signatures: ["sigA", "sigB"],
  providers: [
    {
      provider: "codex",
      personas: ["security"],
      runs: 1,
      errors: 0,
      findings: 2,
      demoted: 1,
      cost_usd: 0.01,
      duration_ms: 1200,
    },
  ],
};

describe("RunSummarySchema", () => {
  it("validates a complete run summary", () => {
    expect(RunSummarySchema.parse(valid).providers[0]?.provider).toBe("codex");
  });
  it("accepts an empty (skipped/cache) summary", () => {
    expect(
      RunSummarySchema.parse({
        verdict: "PASS",
        source: "cache",
        counts: { critical: 0, warn: 0, info: 0 },
        cost_usd: 0,
        duration_ms: 5,
        demoted: 0,
        signatures: [],
        providers: [],
      }).providers,
    ).toEqual([]);
  });
  it("rejects an unknown source / provider", () => {
    expect(() => RunSummarySchema.parse({ ...valid, source: "nope" })).toThrow();
    expect(() =>
      RunSummarySchema.parse({ ...valid, providers: [{ ...valid.providers[0], provider: "x" }] }),
    ).toThrow();
  });
});
