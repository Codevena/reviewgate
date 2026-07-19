// tests/unit/bench-matrix.test.ts — `reviewgate bench matrix` (spec §8 ablation).
// Runs the corpus as a baseline (full suppression) + once per ablated layer, and
// reports the per-layer Δ. Uses the deterministic confidence-floor suppressor (no
// LLM critic needed): a low-confidence FP on the clean case is demoted at the
// baseline floor and survives when the floor is ablated → a real Δ.
import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBenchMatrix } from "../../src/cli/commands/bench.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";
import { BenchMatrixSchema, BenchResultSchema } from "../../src/schemas/bench-result.ts";
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

function initGitRepo(dir: string): void {
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "bench-test@example.test"], {
    cwd: dir,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.name", "Bench Test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "ignore" });
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

  it("captures reviewer responses once and replays those exact samples for critic ablation", async () => {
    const corpus = newCorpus();
    const artifactDir = join(corpus, "attempt-01");
    const out = join(artifactDir, "matrix.json");
    let reviewCalls = 0;
    let criticCalls = 0;
    const reviewer = stub();
    const countedReviewer: ProviderAdapter = {
      ...reviewer,
      async review(input) {
        reviewCalls++;
        return reviewer.review(input);
      },
    };
    const critic: ProviderAdapter = {
      id: "openrouter",
      async preflight() {
        return { available: true, version: "stub-1", authMode: "openrouter", error: null };
      },
      async review() {
        throw new Error("critic must use complete()");
      },
      async complete() {
        criticCalls++;
        return JSON.stringify({
          verdicts: [
            { signature: "sql-inj", verdict: "keep" },
            { signature: "nit", verdict: "likely_fp" },
          ],
        });
      },
    };

    const res = await runBenchMatrix({
      repoRoot: corpus,
      corpus,
      out,
      ablate: ["critic"],
      criticProvider: "openrouter",
      criticModel: "deepseek/deepseek-v4-flash",
      criticOpenrouterProvider: { only: ["alibaba"] },
      maxOutputTokens: 128,
      maxProviderCalls: 10,
      adapters: { codex: countedReviewer, openrouter: critic },
      now: () => new Date("2026-07-01T00:00:00Z"),
    });

    expect(res.exitCode).toBe(0);
    expect(reviewCalls).toBe(2); // baseline only; the variant is deterministic replay
    expect(criticCalls).toBe(2);
    expect(existsSync(join(artifactDir, "baseline.result.json"))).toBe(true);
    expect(existsSync(join(artifactDir, "no-critic.result.json"))).toBe(true);
    const manifest = JSON.parse(
      readFileSync(join(artifactDir, "reviewer-responses.sha256.json"), "utf8"),
    ) as { entries: Array<{ request_sha256: string; response_sha256: string }> };
    expect(manifest.entries).toHaveLength(2);
    expect(manifest.entries.every((e) => e.request_sha256.length === 64)).toBe(true);
    expect(manifest.entries.every((e) => e.response_sha256.length === 64)).toBe(true);
    const matrix = BenchMatrixSchema.parse(JSON.parse(readFileSync(out, "utf8")));
    expect(matrix.artifacts?.baseline.path).toBe("baseline.result.json");
    expect(matrix.artifacts?.variants[0]?.path).toBe("no-critic.result.json");
    expect(matrix.artifacts?.reviewer_responses.path).toBe("reviewer-responses.sha256.json");
  });

  it("replays reviewer retry attempts in the same order as the captured baseline", async () => {
    const corpus = newCorpus();
    const artifactDir = join(corpus, "attempt-retry");
    const out = join(artifactDir, "matrix.json");
    let reviewCalls = 0;
    const reviewer = stub();
    const flaky: ProviderAdapter = {
      ...reviewer,
      async review(input) {
        reviewCalls++;
        if (reviewCalls === 1) {
          return {
            reviewerId: input.reviewerId,
            verdict: "ERROR",
            findings: [],
            usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, quotaUsedPct: null },
            durationMs: 1,
            exitCode: 1,
            rawEventsPath: "",
            rawText: "",
            status: "error",
            statusDetail: "transient malformed output",
          } satisfies ReviewResult;
        }
        return reviewer.review(input);
      },
    };

    const res = await runBenchMatrix({
      repoRoot: corpus,
      corpus,
      out,
      ablate: ["confidence-floor"],
      adapters: { codex: flaky },
      maxProviderCalls: 3,
      reviewerMaxAttempts: 2,
      now: () => new Date("2026-07-01T00:00:00Z"),
    });

    expect(res.exitCode).toBe(0);
    expect(reviewCalls).toBe(3);
    const baseline = BenchResultSchema.parse(
      JSON.parse(readFileSync(join(artifactDir, "baseline.result.json"), "utf8")),
    );
    const variant = BenchResultSchema.parse(
      JSON.parse(readFileSync(join(artifactDir, "no-confidence-floor.result.json"), "utf8")),
    );
    expect(baseline.providers[0]?.coverage.value).toBe(1);
    expect(variant.providers[0]?.coverage.value).toBe(1);
    expect(baseline.provenance.integrity?.provider_calls_used).toBe(3);
    expect(baseline.provenance.integrity?.reviewer_max_attempts).toBe(2);
    const manifest = JSON.parse(
      readFileSync(join(artifactDir, "reviewer-responses.sha256.json"), "utf8"),
    ) as { entries: unknown[] };
    expect(manifest.entries).toHaveLength(3);
  });

  it("fails closed when a replay variant records a different source commit than the baseline", async () => {
    const corpus = newCorpus();
    initGitRepo(corpus);
    const artifactDir = join(corpus, "provenance-mismatch");
    let criticCalls = 0;
    const critic: ProviderAdapter = {
      id: "openrouter",
      async preflight() {
        return { available: true, version: "stub-1", authMode: "openrouter", error: null };
      },
      async review() {
        throw new Error("critic must use complete()");
      },
      async complete() {
        criticCalls++;
        if (criticCalls === 2) {
          writeFileSync(join(corpus, "after-baseline.txt"), "new committed state\n");
          execFileSync("git", ["add", "after-baseline.txt"], { cwd: corpus, stdio: "ignore" });
          execFileSync("git", ["commit", "-m", "advance during matrix"], {
            cwd: corpus,
            stdio: "ignore",
          });
        }
        return JSON.stringify({
          verdicts: [
            { signature: "sql-inj", verdict: "keep" },
            { signature: "nit", verdict: "likely_fp" },
          ],
        });
      },
    };

    const res = await runBenchMatrix({
      repoRoot: corpus,
      corpus,
      out: join(artifactDir, "matrix.json"),
      ablate: ["critic"],
      criticProvider: "openrouter",
      criticModel: "deepseek/deepseek-v4-flash",
      maxOutputTokens: 128,
      maxProviderCalls: 10,
      adapters: { codex: stub(), openrouter: critic },
      now: () => new Date("2026-07-01T00:00:00Z"),
    });

    expect(res.exitCode).toBe(4);
    expect(res.stderr).toContain("variant corpus commit differs from baseline");
    expect(res.stderr).toContain("variant source commit differs from baseline");
    expect(existsSync(join(artifactDir, "baseline.result.json"))).toBe(true);
    expect(existsSync(join(artifactDir, "no-critic.result.json"))).toBe(true);
    expect(existsSync(join(artifactDir, "matrix.json"))).toBe(false);
  });

  it("preserves method binding through budget, capture and replay wrappers", async () => {
    const corpus = newCorpus();
    class StatefulCodex implements ProviderAdapter {
      readonly id = "codex" as const;
      private readonly marker = "bound";
      reviewCalls = 0;
      completeCalls = 0;

      private assertBound(): void {
        if (this.marker !== "bound") throw new Error("adapter method lost its receiver");
      }

      async preflight() {
        this.assertBound();
        return { available: true, version: "stub-1", authMode: "oauth" as const, error: null };
      }

      async review(input: Parameters<ProviderAdapter["review"]>[0]) {
        this.assertBound();
        this.reviewCalls++;
        const diff = readFileSync(input.diffPath, "utf8");
        const findings = diff.includes("db.ts") ? [sqlFinding()] : [lowConfFp()];
        return {
          reviewerId: input.reviewerId,
          verdict: findings.length ? ("FAIL" as const) : ("PASS" as const),
          findings,
          usage: { inputTokens: 5, outputTokens: 5, costUsd: 0, quotaUsedPct: null },
          durationMs: 1,
          exitCode: 0,
          rawEventsPath: "",
          rawText: "",
          status: "ok" as const,
        };
      }

      async complete() {
        this.assertBound();
        this.completeCalls++;
        return JSON.stringify({
          verdicts: [
            { signature: "sql-inj", verdict: "keep" },
            { signature: "nit", verdict: "keep" },
          ],
        });
      }
    }
    const adapter = new StatefulCodex();
    const res = await runBenchMatrix({
      repoRoot: corpus,
      corpus,
      out: join(corpus, "bound", "matrix.json"),
      ablate: ["confidence-floor"],
      criticProvider: "codex",
      maxProviderCalls: 10,
      adapters: { codex: adapter },
      now: () => new Date("2026-07-01T00:00:00Z"),
    });

    expect(res.exitCode).toBe(0);
    expect(adapter.reviewCalls).toBe(2);
    expect(adapter.completeCalls).toBe(4);
  });

  it("counts live critic completions in reviewer-replay variants against the hard call ceiling", async () => {
    const corpus = newCorpus();
    let reviewCalls = 0;
    let criticCalls = 0;
    const reviewer = stub();
    const countedReviewer: ProviderAdapter = {
      ...reviewer,
      async review(input) {
        reviewCalls++;
        return reviewer.review(input);
      },
    };
    const critic: ProviderAdapter = {
      id: "openrouter",
      async preflight() {
        return { available: true, version: "stub-1", authMode: "openrouter", error: null };
      },
      async review() {
        throw new Error("critic must use complete()");
      },
      async complete() {
        criticCalls++;
        return JSON.stringify({
          verdicts: [
            { signature: "sql-inj", verdict: "keep" },
            { signature: "nit", verdict: "keep" },
          ],
        });
      },
    };

    const res = await runBenchMatrix({
      repoRoot: corpus,
      corpus,
      out: join(corpus, "matrix-budget", "matrix.json"),
      ablate: ["confidence-floor"],
      criticProvider: "openrouter",
      criticModel: "deepseek/deepseek-v4-flash",
      criticOpenrouterProvider: { only: ["alibaba"] },
      maxOutputTokens: 128,
      // baseline = 2 reviewer + 2 critic calls; the replay variant has two more
      // live critic calls. The second one must be refused, never hidden as replay.
      maxProviderCalls: 5,
      adapters: { codex: countedReviewer, openrouter: critic },
      now: () => new Date("2026-07-01T00:00:00Z"),
    });

    expect(res.exitCode).toBe(4);
    expect(res.stderr).toContain("provider-call ceiling exhausted");
    expect(reviewCalls).toBe(2);
    expect(criticCalls).toBe(3);
  });

  it("captures declared fallback reviewers and replays them without untracked live calls", async () => {
    const corpus = newCorpus();
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const successful = stub();
    const quotaPrimary: ProviderAdapter = {
      id: "codex",
      async preflight() {
        return { available: true, version: "stub-1", authMode: "oauth", error: null };
      },
      async review(input) {
        primaryCalls++;
        return {
          reviewerId: input.reviewerId,
          verdict: "ERROR",
          findings: [],
          usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, quotaUsedPct: null },
          durationMs: 1,
          exitCode: 1,
          rawEventsPath: "",
          rawText: "",
          status: "quota-exhausted",
        };
      },
    };
    const fallback: ProviderAdapter = {
      ...successful,
      id: "gemini",
      async review(input) {
        fallbackCalls++;
        return successful.review(input);
      },
    };

    const artifactDir = join(corpus, "fallback-replay");
    const res = await runBenchMatrix({
      repoRoot: corpus,
      corpus,
      out: join(artifactDir, "matrix.json"),
      ablate: ["confidence-floor"],
      // Omit providers: the default codex slot declares gemini as its first fallback.
      maxProviderCalls: 4,
      adapters: { codex: quotaPrimary, gemini: fallback },
      providerAvailable: () => true,
      now: () => new Date("2026-07-01T00:00:00Z"),
    });

    expect(res.exitCode).toBe(0);
    expect(primaryCalls).toBe(2);
    expect(fallbackCalls).toBe(2);
    const manifest = JSON.parse(
      readFileSync(join(artifactDir, "reviewer-responses.sha256.json"), "utf8"),
    ) as { entries: Array<{ provider: string }> };
    expect(manifest.entries.filter((entry) => entry.provider === "codex")).toHaveLength(2);
    expect(manifest.entries.filter((entry) => entry.provider === "gemini")).toHaveLength(2);
  });

  it("classifies scope-to-diff as a deterministic post-review ablation", async () => {
    const corpus = newCorpus();
    const out = join(corpus, "scope-matrix", "matrix.json");
    const res = await runBenchMatrix({
      repoRoot: corpus,
      corpus,
      out,
      ablate: ["scope-to-diff"],
      adapters: { codex: stub() },
      now: () => new Date("2026-07-01T00:00:00Z"),
    });

    expect(res.exitCode).toBe(0);
    const matrix = BenchMatrixSchema.parse(JSON.parse(readFileSync(out, "utf8")));
    expect(matrix.variants.find((variant) => variant.ablation === "scope-to-diff")?.class).toBe(
      "A",
    );
  });
});
