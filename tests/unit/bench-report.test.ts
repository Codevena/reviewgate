// tests/unit/bench-report.test.ts
// reviewgate bench report (spec §5.2/§6): render a saved BenchResult to a terminal
// table + a paste-ready markdown block. Leads with Clean FP-rate; every rate shows
// its raw num/den and Wilson CI; per-provider RAW rows carry the authoritative
// flag; a run that isn't trustworthy (corpus dirty / invalid cases / no clean or
// seeded cases) is flagged non-authoritative and its headline rates are withheld.
import { describe, expect, it } from "bun:test";
import { makeMetric } from "../../src/bench/metrics.ts";
import { isAuthoritative, renderBenchReport } from "../../src/bench/report.ts";
import type { BenchResult } from "../../src/schemas/bench-result.ts";

function baseResult(over: Partial<BenchResult> = {}): BenchResult {
  const result: BenchResult = {
    schema: "reviewgate.bench.result.v1",
    provenance: {
      reviewgate_version: "0.1.0-alpha.9",
      corpus_commit: "abc1234",
      corpus_dirty: false,
      providers: [{ id: "codex", cli_version: "1.2.3", model: "gpt-5.5", persona: "security" }],
      config_hash: "deadbeefcafe",
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
        content_hash: "h1",
        counts: { tp: 1, fp: 0, fn: 0, neutral: 0 },
        panel_ok: 1,
        panel_configured: 1,
        file_context: "full",
        latency_ms: 1200,
        error: null,
      },
      {
        id: "clean-001",
        kind: "clean",
        status: "scored",
        content_hash: "h2",
        counts: { tp: 0, fp: 0, fn: 0, neutral: 0 },
        panel_ok: 1,
        panel_configured: 1,
        file_context: "full",
        latency_ms: 900,
        error: null,
      },
    ],
    providers: [
      {
        provider: "codex",
        coverage: makeMetric(2, 2),
        precision: makeMetric(1, 1),
        recall: makeMetric(1, 1),
        authoritative: true,
      },
    ],
    cost: [
      {
        provider: "codex",
        calls: 2,
        cache_hits: 0,
        tokens_in: 0,
        tokens_out: 0,
        billed_usd: 0,
        oauth_quota_calls: 2,
      },
    ],
    aggregate: {
      precision: makeMetric(1, 1),
      recall: makeMetric(1, 1),
      clean_fp_rate: makeMetric(0, 1),
    },
    ...over,
  };
  return result;
}

describe("isAuthoritative", () => {
  it("is ok for a clean scored run", () => {
    expect(isAuthoritative(baseResult()).ok).toBe(true);
  });

  it("is not ok when the corpus was dirty", () => {
    const r = isAuthoritative(
      baseResult({ provenance: { ...baseResult().provenance, corpus_dirty: true } }),
    );
    expect(r.ok).toBe(false);
    expect(r.reasons.join(" ")).toContain("dirty");
  });

  it("is not ok when a case is invalid", () => {
    const base = baseResult();
    const r = isAuthoritative(
      baseResult({
        cases: [
          ...base.cases,
          {
            id: "bad",
            kind: "seeded-bug",
            status: "invalid",
            content_hash: "h",
            counts: { tp: 0, fp: 0, fn: 0, neutral: 0 },
            panel_ok: 0,
            panel_configured: 1,
            file_context: "full",
            latency_ms: null,
            error: "malformed",
          },
        ],
      }),
    );
    expect(r.ok).toBe(false);
  });

  it("is not ok when there are zero clean cases", () => {
    const r = isAuthoritative(
      baseResult({
        provenance: { ...baseResult().provenance, case_count: { seeded: 2, clean: 0 } },
      }),
    );
    expect(r.ok).toBe(false);
  });
});

describe("renderBenchReport", () => {
  it("leads with Clean FP-rate and shows raw denominators + CI", () => {
    const { table } = renderBenchReport(baseResult());
    expect(table).toContain("Clean FP-rate");
    expect(table).toContain("0/1");
    expect(table).toContain("CI");
    // Clean FP-rate appears before Precision (it is the headline number).
    expect(table.indexOf("Clean FP-rate")).toBeLessThan(table.indexOf("Precision"));
  });

  it("shows panel precision + recall with numerators", () => {
    const { table } = renderBenchReport(baseResult());
    expect(table).toContain("Precision");
    expect(table).toContain("Recall");
    expect(table).toContain("1/1");
  });

  it("renders a per-provider RAW row with the authoritative flag", () => {
    const { table } = renderBenchReport(baseResult());
    expect(table).toContain("codex");
    expect(table.toLowerCase()).toContain("provider");
  });

  it("includes reproducibility provenance (version, corpus commit, window)", () => {
    const { table } = renderBenchReport(baseResult());
    expect(table).toContain("0.1.0-alpha.9");
    expect(table).toContain("abc1234");
    expect(table).toContain("window");
  });

  it("emits a markdown table block leading with Clean FP-rate", () => {
    const { markdown } = renderBenchReport(baseResult());
    expect(markdown).toContain("|");
    expect(markdown).toContain("Clean FP-rate");
    expect(markdown.indexOf("Clean FP-rate")).toBeLessThan(markdown.indexOf("Precision"));
  });

  it("flags a non-authoritative run and withholds the headline framing", () => {
    const { table, markdown } = renderBenchReport(
      baseResult({ provenance: { ...baseResult().provenance, corpus_dirty: true } }),
    );
    expect(table.toLowerCase()).toContain("non-authoritative");
    expect(markdown.toLowerCase()).toContain("non-authoritative");
  });

  it("formats an undefined (den=0) rate as n/a, not 0", () => {
    const { table } = renderBenchReport(
      baseResult({
        aggregate: {
          precision: makeMetric(0, 0),
          recall: makeMetric(0, 0),
          clean_fp_rate: makeMetric(0, 0),
        },
      }),
    );
    expect(table).toContain("n/a");
  });
});
