// tests/unit/bench-report-cli.test.ts — `reviewgate bench report <file>` (spec §6).
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeMetric } from "../../src/bench/metrics.ts";
import { runBenchReport } from "../../src/cli/commands/bench.ts";
import type { BenchResult } from "../../src/schemas/bench-result.ts";

function validResult(): BenchResult {
  return {
    schema: "reviewgate.bench.result.v1",
    provenance: {
      reviewgate_version: "0.1.0-alpha.9",
      corpus_commit: "abc1234",
      corpus_dirty: false,
      providers: [{ id: "codex", cli_version: "1", model: "gpt-5.5", persona: "security" }],
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
        id: "c1",
        kind: "seeded-bug",
        status: "scored",
        content_hash: "h",
        counts: { tp: 1, fp: 0, fn: 0, neutral: 0 },
        panel_ok: 1,
        panel_configured: 1,
        file_context: "full",
        latency_ms: 100,
        error: null,
      },
      {
        id: "c2",
        kind: "clean",
        status: "scored",
        content_hash: "h",
        counts: { tp: 0, fp: 0, fn: 0, neutral: 0 },
        panel_ok: 1,
        panel_configured: 1,
        file_context: "full",
        latency_ms: 100,
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
    cost: [],
    aggregate: {
      precision: makeMetric(1, 1),
      recall: makeMetric(1, 1),
      clean_fp_rate: makeMetric(0, 1),
    },
  };
}

function writeResult(r: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-bench-report-"));
  const f = join(dir, "results.json");
  writeFileSync(f, JSON.stringify(r));
  return f;
}

describe("runBenchReport", () => {
  it("renders the terminal table (exit 0)", async () => {
    const f = writeResult(validResult());
    const res = await runBenchReport({ repoRoot: "/", file: f });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Clean FP-rate");
    expect(res.stdout).toContain("Reviewgate bench report");
  });

  it("--markdown emits only the markdown block", async () => {
    const f = writeResult(validResult());
    const res = await runBenchReport({ repoRoot: "/", file: f, markdown: true });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("| Metric |");
    expect(res.stdout).not.toContain("Reviewgate bench report"); // no terminal header
  });

  it("exits 2 when the file is missing", async () => {
    const res = await runBenchReport({ repoRoot: "/", file: "/nope/does-not-exist.json" });
    expect(res.exitCode).toBe(2);
  });

  it("exits 2 when the file is not valid JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-bench-report-badjson-"));
    const f = join(dir, "results.json");
    writeFileSync(f, "{not json");
    const res = await runBenchReport({ repoRoot: "/", file: f });
    expect(res.exitCode).toBe(2);
  });

  it("exits 2 when the JSON is not a valid bench result", async () => {
    const f = writeResult({ schema: "wrong" });
    const res = await runBenchReport({ repoRoot: "/", file: f });
    expect(res.exitCode).toBe(2);
  });
});
