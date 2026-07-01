import { describe, expect, it } from "bun:test";
import { BenchResultSchema } from "../../src/schemas/bench-result.ts";

const validResult = {
  schema: "reviewgate.bench.result.v1",
  provenance: {
    reviewgate_version: "0.1.0-alpha.4",
    corpus_commit: "abc1234",
    corpus_dirty: false,
    providers: [{ id: "codex", cli_version: "1.2.3", model: "unknown" }],
    config_hash: "deadbeef",
    window: 5,
    repeat: 1,
    include_advisory: false,
    temperature: null,
    stores: "per-case-fresh",
    cache: "cold",
    host_os: "darwin-arm64",
    timestamp: "2026-07-01T00:00:00Z",
    case_count: { seeded: 1, clean: 1 },
  },
  cases: [
    {
      id: "sql-injection-001",
      kind: "seeded-bug",
      status: "scored",
      content_hash: "hash1",
      counts: { tp: 1, fp: 0, fn: 0, neutral: 0 },
      latency_ms: 1200,
      error: null,
    },
  ],
  cost: [
    {
      provider: "codex",
      calls: 2,
      cache_hits: 0,
      tokens_in: 100,
      tokens_out: 50,
      billed_usd: 0,
      oauth_quota_calls: 2,
    },
  ],
  aggregate: {
    precision: { num: 1, den: 1, value: 1, ci_lo: 0.21, ci_hi: 1 },
    recall: { num: 1, den: 1, value: 1, ci_lo: 0.21, ci_hi: 1 },
    clean_fp_rate: { num: 0, den: 1, value: 0, ci_lo: 0, ci_hi: 0.79 },
  },
};

describe("BenchResultSchema", () => {
  it("parses a valid result", () => {
    const r = BenchResultSchema.safeParse(validResult);
    if (!r.success) console.error(r.error);
    expect(r.success).toBe(true);
  });

  it("rejects an unknown schema tag", () => {
    const r = BenchResultSchema.safeParse({ ...validResult, schema: "reviewgate.bench.result.v2" });
    expect(r.success).toBe(false);
  });

  it("rejects an invalid per-case status", () => {
    const bad = {
      ...validResult,
      cases: [{ ...validResult.cases[0], status: "bogus" }],
    };
    expect(BenchResultSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a metric whose numerator exceeds its denominator", () => {
    const r = BenchResultSchema.safeParse({
      ...validResult,
      aggregate: {
        ...validResult.aggregate,
        precision: { num: 5, den: 1, value: 1, ci_lo: 1, ci_hi: 1 },
      },
    });
    expect(r.success).toBe(false);
  });

  it("rejects a zero-denominator metric with a non-null value", () => {
    const r = BenchResultSchema.safeParse({
      ...validResult,
      aggregate: {
        ...validResult.aggregate,
        recall: { num: 0, den: 0, value: 0, ci_lo: 0, ci_hi: 0 },
      },
    });
    expect(r.success).toBe(false);
  });

  it("rejects a positive-denominator metric with a null value", () => {
    const r = BenchResultSchema.safeParse({
      ...validResult,
      aggregate: {
        ...validResult.aggregate,
        precision: { num: 1, den: 1, value: null, ci_lo: null, ci_hi: null },
      },
    });
    expect(r.success).toBe(false);
  });

  it("rejects a metric whose value disagrees with num/den", () => {
    const r = BenchResultSchema.safeParse({
      ...validResult,
      aggregate: {
        ...validResult.aggregate,
        precision: { num: 1, den: 2, value: 0.9, ci_lo: 0, ci_hi: 1 },
      },
    });
    expect(r.success).toBe(false);
  });

  it("allows a metric with a null value when its denominator is zero", () => {
    const r = BenchResultSchema.safeParse({
      ...validResult,
      aggregate: {
        ...validResult.aggregate,
        recall: { num: 0, den: 0, value: null, ci_lo: null, ci_hi: null },
      },
    });
    expect(r.success).toBe(true);
  });

  it("allows a benchmark-invalid case with a null latency and an error", () => {
    const r = BenchResultSchema.safeParse({
      ...validResult,
      cases: [
        {
          id: "broken",
          kind: "seeded-bug",
          status: "review-error",
          content_hash: "h",
          counts: { tp: 0, fp: 0, fn: 0, neutral: 0 },
          latency_ms: null,
          error: "provider timeout",
        },
      ],
    });
    expect(r.success).toBe(true);
  });
});
