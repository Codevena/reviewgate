import { describe, expect, it } from "bun:test";
import { BenchResultSchema } from "../../src/schemas/bench-result.ts";

const validResult = {
  schema: "reviewgate.bench.result.v1",
  provenance: {
    reviewgate_version: "0.1.0-alpha.4",
    corpus_commit: "abc1234",
    corpus_dirty: false,
    providers: [{ id: "codex", cli_version: "1.2.3", model: "unknown", persona: "security" }],
    config_hash: "deadbeef",
    window: 5,
    repeat: 1,
    include_advisory: false,
    temperature: null,
    stores: "per-case-fresh",
    cache: "cold",
    file_context: "full",
    phases: {
      critic: false,
      reputation: true,
      fp_ledger: false,
      confidence_floor: 0.6,
      scope_to_diff: true,
      ablations: [],
    },
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
      panel_ok: 1,
      panel_configured: 1,
      file_context: "full",
      latency_ms: 1200,
      error: null,
    },
  ],
  providers: [
    {
      provider: "codex",
      coverage: { num: 1, den: 1, value: 1, ci_lo: 0.21, ci_hi: 1 },
      precision: { num: 1, den: 1, value: 1, ci_lo: 0.21, ci_hi: 1 },
      recall: { num: 1, den: 1, value: 1, ci_lo: 0.21, ci_hi: 1 },
      authoritative: true,
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

  it("accepts Alpha.12 integrity, critic coverage and honest unknown costs additively", () => {
    const r = BenchResultSchema.safeParse({
      ...validResult,
      provenance: {
        ...validResult.provenance,
        case_run_count: { seeded: 3, clean: 3, total: 6 },
        critic: {
          provider: "openrouter",
          model: "deepseek/deepseek-v4-flash",
          openrouter_provider: { only: ["alibaba"] },
          max_attempts: 2,
        },
        integrity: {
          source_commit: "a".repeat(40),
          repository_dirty: false,
          runner_sha256: "b".repeat(64),
          runner_kind: "compiled",
          preregistration_sha256: "c".repeat(64),
          authoritative_requested: true,
          max_provider_calls: 100,
          provider_calls_used: 9,
          max_output_tokens: 256,
        },
      },
      cases: [
        {
          ...validResult.cases[0],
          critic: {
            provider: "openrouter",
            eligible: true,
            status: "ran",
            verdicts: 1,
            demoted: 0,
          },
        },
      ],
      critic: {
        provider: "openrouter",
        eligible: 1,
        ran: 1,
        coverage: { num: 1, den: 1, value: 1, ci_lo: 0.21, ci_hi: 1 },
        authoritative: true,
      },
      cost: validResult.cost.map((c) => ({
        ...c,
        tokens_in: null,
        tokens_out: null,
        billed_usd: null,
      })),
    });
    if (!r.success) console.error(r.error);
    expect(r.success).toBe(true);
  });

  it("accepts an optional stamped verdict", () => {
    const r = BenchResultSchema.safeParse({
      ...validResult,
      verdict: {
        authoritative: false,
        gate_exit_code: 4,
        reasons: ["reviewer codex coverage 0/1 (100% required)"],
      },
    });
    if (!r.success) console.error(r.error);
    expect(r.success).toBe(true);
  });

  it("rejects a verdict with an unknown key (strict)", () => {
    const r = BenchResultSchema.safeParse({
      ...validResult,
      verdict: { authoritative: true, gate_exit_code: 0, reasons: [], extra: 1 },
    });
    expect(r.success).toBe(false);
  });

  it("rejects a verdict whose authoritative flag contradicts gate_exit_code", () => {
    const r = BenchResultSchema.safeParse({
      ...validResult,
      verdict: { authoritative: true, gate_exit_code: 4, reasons: ["x"] },
    });
    expect(r.success).toBe(false);
  });

  it("rejects a verdict with an out-of-domain gate_exit_code", () => {
    const r = BenchResultSchema.safeParse({
      ...validResult,
      verdict: { authoritative: false, gate_exit_code: 2, reasons: ["x"] },
    });
    expect(r.success).toBe(false);
  });

  it("rejects a non-authoritative verdict with no stated reasons", () => {
    const r = BenchResultSchema.safeParse({
      ...validResult,
      verdict: { authoritative: false, gate_exit_code: 4, reasons: [] },
    });
    expect(r.success).toBe(false);
  });

  it("rejects an authoritative verdict that carries reasons", () => {
    const r = BenchResultSchema.safeParse({
      ...validResult,
      verdict: { authoritative: true, gate_exit_code: 0, reasons: ["stray"] },
    });
    expect(r.success).toBe(false);
  });

  it("rejects a verdict reason containing a C0 ESC (ANSI/VT100) sequence", () => {
    const r = BenchResultSchema.safeParse({
      ...validResult,
      verdict: { authoritative: false, gate_exit_code: 4, reasons: ["\u001b[2Jcleared"] },
    });
    expect(r.success).toBe(false);
  });

  it("rejects a verdict reason containing an 8-bit C1 CSI (U+009B) sequence", () => {
    const r = BenchResultSchema.safeParse({
      ...validResult,
      verdict: { authoritative: false, gate_exit_code: 4, reasons: ["\u009b2Jcleared"] },
    });
    expect(r.success).toBe(false);
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
          panel_ok: 0,
          panel_configured: 1,
          file_context: "full",
          latency_ms: null,
          error: "provider timeout",
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  // --- P1 additive amendments (spec §12) ---

  it("requires provenance.file_context and rejects an unknown value", () => {
    const { file_context: _drop, ...prov } = validResult.provenance;
    expect(BenchResultSchema.safeParse({ ...validResult, provenance: prov }).success).toBe(false);
    expect(
      BenchResultSchema.safeParse({
        ...validResult,
        provenance: { ...validResult.provenance, file_context: "sideways" },
      }).success,
    ).toBe(false);
  });

  it("requires a persona on every provenance roster entry", () => {
    const r = BenchResultSchema.safeParse({
      ...validResult,
      provenance: {
        ...validResult.provenance,
        providers: [{ id: "codex", cli_version: "1", model: "unknown" }],
      },
    });
    expect(r.success).toBe(false);
  });

  it("requires the provenance.phases config snapshot", () => {
    const { phases: _drop, ...prov } = validResult.provenance;
    expect(BenchResultSchema.safeParse({ ...validResult, provenance: prov }).success).toBe(false);
  });

  it("allows a null confidence_floor in the phases snapshot (floor disabled)", () => {
    const r = BenchResultSchema.safeParse({
      ...validResult,
      provenance: {
        ...validResult.provenance,
        phases: { ...validResult.provenance.phases, confidence_floor: null },
      },
    });
    expect(r.success).toBe(true);
  });

  it("records ablation names in the phases snapshot", () => {
    const r = BenchResultSchema.safeParse({
      ...validResult,
      provenance: {
        ...validResult.provenance,
        phases: { ...validResult.provenance.phases, critic: false, ablations: ["no-critic"] },
      },
    });
    expect(r.success).toBe(true);
  });

  it("requires per-case panel_ok / panel_configured / file_context", () => {
    const bareCase = {
      id: "x",
      kind: "seeded-bug",
      status: "scored",
      content_hash: "h",
      counts: { tp: 0, fp: 0, fn: 0, neutral: 0 },
      latency_ms: 1,
      error: null,
    };
    expect(BenchResultSchema.safeParse({ ...validResult, cases: [bareCase] }).success).toBe(false);
  });

  it("requires the top-level per-provider results section", () => {
    const { providers: _drop, ...rest } = validResult;
    expect(BenchResultSchema.safeParse(rest).success).toBe(false);
  });

  it("validates the per-provider metric blocks", () => {
    const r = BenchResultSchema.safeParse({
      ...validResult,
      providers: [
        {
          provider: "codex",
          coverage: { num: 1, den: 1, value: 1, ci_lo: 0.21, ci_hi: 1 },
          // precision value disagrees with num/den → MetricSchema rejects it.
          precision: { num: 1, den: 2, value: 0.9, ci_lo: 0, ci_hi: 1 },
          recall: { num: 1, den: 1, value: 1, ci_lo: 0.21, ci_hi: 1 },
          authoritative: true,
        },
      ],
    });
    expect(r.success).toBe(false);
  });

  it("rejects an authoritative provider with an undefined (den=0) coverage", () => {
    const r = BenchResultSchema.safeParse({
      ...validResult,
      providers: [
        {
          provider: "codex",
          coverage: { num: 0, den: 0, value: null, ci_lo: null, ci_hi: null },
          precision: { num: 0, den: 0, value: null, ci_lo: null, ci_hi: null },
          recall: { num: 0, den: 0, value: null, ci_lo: null, ci_hi: null },
          authoritative: true,
        },
      ],
    });
    expect(r.success).toBe(false);
  });

  it("allows a non-authoritative provider with undefined coverage", () => {
    const r = BenchResultSchema.safeParse({
      ...validResult,
      providers: [
        {
          provider: "gemini",
          coverage: { num: 0, den: 0, value: null, ci_lo: null, ci_hi: null },
          precision: { num: 0, den: 0, value: null, ci_lo: null, ci_hi: null },
          recall: { num: 0, den: 0, value: null, ci_lo: null, ci_hi: null },
          authoritative: false,
        },
      ],
    });
    expect(r.success).toBe(true);
  });
});

describe("BenchResultSchema — P5 repeat/stability", () => {
  it("accepts a result with a stability block and per-case repeat index", () => {
    const r = BenchResultSchema.safeParse({
      ...validResult,
      cases: [{ ...validResult.cases[0], repeat: 2 }],
      stability: {
        repeats: 3,
        precision: { mean: 0.5, stddev: 0.2, min: 0.3, max: 0.7, samples: 3 },
        recall: { mean: 0.8, stddev: 0.1, min: 0.7, max: 0.9, samples: 3 },
        clean_fp_rate: { mean: 0.25, stddev: 0.35, min: 0, max: 0.75, samples: 3 },
      },
    });
    if (!r.success) console.error(r.error);
    expect(r.success).toBe(true);
  });

  it("accepts an all-null (zero-sample) spread stat", () => {
    const r = BenchResultSchema.safeParse({
      ...validResult,
      stability: {
        repeats: 2,
        precision: { mean: null, stddev: null, min: null, max: null, samples: 0 },
        recall: { mean: null, stddev: null, min: null, max: null, samples: 0 },
        clean_fp_rate: { mean: 0, stddev: 0, min: 0, max: 0, samples: 2 },
      },
    });
    expect(r.success).toBe(true);
  });

  it("still parses a result with no stability (single run)", () => {
    expect(BenchResultSchema.safeParse(validResult).success).toBe(true);
  });

  it("rejects a stability stat with a negative stddev", () => {
    const r = BenchResultSchema.safeParse({
      ...validResult,
      stability: {
        repeats: 2,
        precision: { mean: 0.5, stddev: -0.1, min: 0.4, max: 0.6, samples: 2 },
        recall: { mean: 0.5, stddev: 0, min: 0.5, max: 0.5, samples: 2 },
        clean_fp_rate: { mean: 0, stddev: 0, min: 0, max: 0, samples: 2 },
      },
    });
    expect(r.success).toBe(false);
  });
});
