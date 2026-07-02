// tests/unit/bench-matrix.test.ts — `reviewgate bench matrix` (spec §8 ablation).
// Runs the corpus as a baseline (full suppression) + once per ablated layer, and
// reports the per-layer Δ. Uses the deterministic confidence-floor suppressor (no
// LLM critic needed): a low-confidence FP on the clean case is demoted at the
// baseline floor and survives when the floor is ablated → a real Δ.
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBenchMatrix } from "../../src/cli/commands/bench.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";
import { BenchMatrixSchema } from "../../src/schemas/bench-result.ts";
import type { Finding } from "../../src/schemas/finding.ts";

const DB_DIFF = [
  "diff --git a/src/db.ts b/src/db.ts",
  "new file mode 100644",
  "index 0000000..1111111",
  "--- /dev/null",
  "+++ b/src/db.ts",
  "@@ -0,0 +1,5 @@",
  "+export function q(id) {",
  "+  // build query",
  '+  return db.query("SELECT * FROM t WHERE id=" + id);',
  "+}",
  "+export const y = 1;",
  "",
].join("\n");

const UTIL_DIFF = [
  "diff --git a/src/util.ts b/src/util.ts",
  "new file mode 100644",
  "index 0000000..2222222",
  "--- /dev/null",
  "+++ b/src/util.ts",
  "@@ -0,0 +1,3 @@",
  "+export function add(a, b) {",
  "+  return a + b;",
  "+}",
  "",
].join("\n");

const seededJson = {
  schema: "reviewgate.bench.case.v1",
  id: "sql-injection-001",
  kind: "seeded-bug",
  language: "ts",
  expected: [{ tag: "sql injection", file: "src/db.ts", line: 3, min_severity: "CRITICAL" }],
  allowed: [],
  strict_region: true,
  source: "hand-written",
};
const cleanJson = {
  schema: "reviewgate.bench.case.v1",
  id: "clean-add-001",
  kind: "clean",
  language: "ts",
  expected: [],
  allowed: [],
  strict_region: true,
  source: "hand-written",
};

function sqlFinding(): Finding {
  return {
    id: "codex-1",
    signature: "sql-inj",
    severity: "CRITICAL",
    category: "security",
    rule_id: "sql-injection",
    file: "src/db.ts",
    line_start: 3,
    line_end: 3,
    message: "SQL injection via string concatenation",
    details: "user id concatenated into the query",
    reviewer: { provider: "codex", model: "m", persona: "security" },
    confidence: 0.95,
    consensus: "singleton",
  };
}

// A low-confidence quality nit on the clean case — below the default 0.6 floor.
function lowConfFp(): Finding {
  return {
    id: "codex-fp",
    signature: "nit",
    severity: "WARN",
    category: "quality",
    rule_id: "naming",
    file: "src/util.ts",
    line_start: 2,
    line_end: 2,
    message: "variable name could be clearer",
    details: "consider renaming",
    reviewer: { provider: "codex", model: "m", persona: "security" },
    confidence: 0.3,
    consensus: "singleton",
  };
}

function stub(): ProviderAdapter {
  return {
    id: "codex",
    async preflight() {
      return { available: true, version: "stub-1", authMode: "oauth", error: null };
    },
    async review(inp) {
      const diff = readFileSync(inp.diffPath, "utf8");
      const findings = diff.includes("db.ts") ? [sqlFinding()] : [lowConfFp()];
      return {
        reviewerId: inp.reviewerId,
        verdict: findings.length ? "FAIL" : "PASS",
        findings,
        usage: { inputTokens: 5, outputTokens: 5, costUsd: 0, quotaUsedPct: null },
        durationMs: 1,
        exitCode: 0,
        rawEventsPath: "",
        rawText: "",
        status: "ok",
      } satisfies ReviewResult;
    },
  };
}

function newCorpus(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-bench-matrix-corpus-"));
  for (const [id, cj, diff] of [
    ["sql-injection-001", seededJson, DB_DIFF],
    ["clean-add-001", cleanJson, UTIL_DIFF],
  ] as const) {
    const cd = join(dir, id);
    mkdirSync(cd, { recursive: true });
    writeFileSync(join(cd, "case.json"), JSON.stringify(cj));
    writeFileSync(join(cd, "diff.patch"), diff);
  }
  return dir;
}

describe("runBenchMatrix", () => {
  it("reports the confidence-floor ablation Δ (baseline demotes a low-conf FP; ablated keeps it)", async () => {
    const corpus = newCorpus();
    const out = join(corpus, "matrix.json");
    const res = await runBenchMatrix({
      repoRoot: corpus,
      corpus,
      out,
      ablate: ["confidence-floor"],
      adapters: { codex: stub() },
      now: () => new Date("2026-07-01T00:00:00Z"),
    });
    expect(res.exitCode).toBe(0);
    const m = BenchMatrixSchema.parse(JSON.parse(readFileSync(out, "utf8")));
    expect(m.variants).toHaveLength(2);
    const baseline = m.variants[0];
    const ablated = m.variants.find((v) => v.ablation === "confidence-floor");
    expect(baseline?.ablation).toBe("");
    expect(baseline?.delta).toBeNull();
    // baseline: floor demotes the low-conf FP → clean-FP 0, precision 1.
    expect(baseline?.clean_fp_rate.value).toBe(0);
    expect(baseline?.precision.value).toBe(1);
    // ablated: floor off → FP survives → clean-FP 1, precision 0.5.
    expect(ablated?.clean_fp_rate.value).toBe(1);
    expect(ablated?.precision.value).toBeCloseTo(0.5, 10);
    // Δ = baseline − ablated.
    expect(ablated?.class).toBe("A");
    expect(ablated?.delta?.precision).toBeCloseTo(0.5, 10);
    expect(ablated?.delta?.clean_fp_rate).toBeCloseTo(-1, 10);
    // The Δ table renders.
    expect(res.stdout).toContain("ablation");
    expect(res.stdout.toLowerCase()).toContain("baseline");
  });

  it("exits 2 with no --ablate layers", async () => {
    const corpus = newCorpus();
    const res = await runBenchMatrix({
      repoRoot: corpus,
      corpus,
      out: join(corpus, "m.json"),
      ablate: [],
      adapters: { codex: stub() },
    });
    expect(res.exitCode).toBe(2);
  });

  it("exits 2 on an unknown ablation layer", async () => {
    const corpus = newCorpus();
    const res = await runBenchMatrix({
      repoRoot: corpus,
      corpus,
      out: join(corpus, "m.json"),
      ablate: ["bogus-layer"],
      adapters: { codex: stub() },
    });
    expect(res.exitCode).toBe(2);
  });
});
