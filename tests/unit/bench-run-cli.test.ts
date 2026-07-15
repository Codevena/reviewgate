// tests/unit/bench-run-cli.test.ts
// reviewgate bench run (spec §12 P1c). Loads a labelled corpus, runs each case
// through the runner with in-process stub reviewers, aggregates Wilson-CI metrics
// over the scored cases, pins provenance, enforces the exit-4 quality gate, and
// writes a schema-valid results JSON. No real reviewer CLIs.
import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBenchRun } from "../../src/cli/commands/bench.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";
import type { ProviderId } from "../../src/providers/registry.ts";
import { BenchResultSchema } from "../../src/schemas/bench-result.ts";
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
    details: "the user id is concatenated directly into the query string",
    reviewer: { provider: "codex", model: "m", persona: "security" },
    confidence: 0.95,
    consensus: "singleton",
  };
}

// Content-aware stub: fires the seeded finding only on the db.ts case, clean on util.ts.
function smartStub(id: ProviderAdapter["id"]): ProviderAdapter {
  return {
    id,
    async preflight() {
      return { available: true, version: "stub-1", authMode: "oauth", error: null };
    },
    async review(inp) {
      const diff = readFileSync(inp.diffPath, "utf8");
      const findings = diff.includes("db.ts") ? [sqlFinding()] : [];
      return {
        reviewerId: inp.reviewerId,
        verdict: findings.length ? "FAIL" : "PASS",
        findings,
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0, quotaUsedPct: null },
        durationMs: 1,
        exitCode: 0,
        rawEventsPath: "",
        rawText: "",
        status: "ok",
      } satisfies ReviewResult;
    },
  };
}

const smartCodexStub = () => smartStub("codex");

// A quota-exhausted reviewer: forces the orchestrator's failover to the next
// provider in the chain (the only status that triggers failover).
function quotaStub(id: ProviderAdapter["id"]): ProviderAdapter {
  return {
    id,
    async preflight() {
      return { available: true, version: "stub-1", authMode: "oauth", error: null };
    },
    async review(inp) {
      return {
        reviewerId: inp.reviewerId,
        verdict: "ERROR",
        findings: [],
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, quotaUsedPct: 100 },
        durationMs: 1,
        exitCode: 1,
        rawEventsPath: "",
        rawText: "",
        status: "quota-exhausted",
      } satisfies ReviewResult;
    },
  };
}

function writeCase(corpus: string, id: string, caseJson: unknown, diff: string) {
  const dir = join(corpus, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "case.json"), JSON.stringify(caseJson, null, 2));
  writeFileSync(join(dir, "diff.patch"), diff);
}

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

function newCorpus(): string {
  return mkdtempSync(join(tmpdir(), "rg-bench-corpus-"));
}

describe("runBenchRun", () => {
  it("canonicalizes macOS /var aliases when checking a clean committed corpus", async () => {
    const corpus = newCorpus();
    writeCase(corpus, "sql-injection-001", seededJson, DB_DIFF);
    writeCase(corpus, "clean-add-001", cleanJson, UTIL_DIFF);
    execFileSync("git", ["init", "-q"], { cwd: corpus });
    execFileSync("git", ["config", "user.email", "bench@example.invalid"], { cwd: corpus });
    execFileSync("git", ["config", "user.name", "Bench Test"], { cwd: corpus });
    execFileSync("git", ["add", "."], { cwd: corpus });
    execFileSync("git", ["commit", "-qm", "freeze corpus"], { cwd: corpus });

    const out = join(corpus, "attempt", "results.json");
    const res = await runBenchRun({
      repoRoot: corpus,
      corpus,
      out,
      adapters: { codex: smartCodexStub() },
    });

    expect(res.exitCode).toBe(0);
    const result = BenchResultSchema.parse(JSON.parse(readFileSync(out, "utf8")));
    expect(result.provenance.corpus_dirty).toBe(false);
    expect(result.provenance.integrity?.repository_dirty).toBe(false);
  });

  it("rejects direct authoritative runs because only matrix validates the frozen protocol", async () => {
    const corpus = newCorpus();
    writeCase(corpus, "sql-injection-001", seededJson, DB_DIFF);
    writeCase(corpus, "clean-add-001", cleanJson, UTIL_DIFF);
    let calls = 0;
    const reviewer = smartCodexStub();
    const counted: ProviderAdapter = {
      ...reviewer,
      async review(input) {
        calls++;
        return reviewer.review(input);
      },
    };
    const res = await runBenchRun({
      repoRoot: corpus,
      corpus,
      out: join(corpus, "results.json"),
      adapters: { codex: counted },
      authoritative: true,
      preregistration: "sql-injection-001/case.json",
      maxProviderCalls: 10,
      maxOutputTokens: 128,
      runnerInfo: { kind: "compiled", sha256: "a".repeat(64) },
    });
    expect(res.exitCode).toBe(4);
    expect(res.stderr).toContain("authoritative protocol is matrix-only");
    expect(calls).toBe(0);
  });

  it("fails authoritative provenance before making a provider call", async () => {
    const corpus = newCorpus();
    writeCase(corpus, "sql-injection-001", seededJson, DB_DIFF);
    writeCase(corpus, "clean-add-001", cleanJson, UTIL_DIFF);
    let calls = 0;
    const reviewer = smartCodexStub();
    const counted: ProviderAdapter = {
      ...reviewer,
      async review(input) {
        calls++;
        return reviewer.review(input);
      },
    };
    const out = join(corpus, "results.json");
    const res = await runBenchRun({
      repoRoot: corpus,
      corpus,
      out,
      adapters: { codex: counted },
      authoritative: true,
      maxProviderCalls: 10,
      maxOutputTokens: 128,
      runnerInfo: { kind: "compiled", sha256: "a".repeat(64) },
    });
    expect(res.exitCode).toBe(4);
    expect(res.stderr).toContain("before provider calls");
    expect(calls).toBe(0);
  });

  it("stops external calls at the hard provider-call ceiling and preserves the invalid result", async () => {
    const corpus = newCorpus();
    writeCase(corpus, "sql-injection-001", seededJson, DB_DIFF);
    writeCase(corpus, "clean-add-001", cleanJson, UTIL_DIFF);
    let calls = 0;
    const reviewer = smartCodexStub();
    const counted: ProviderAdapter = {
      ...reviewer,
      async review(input) {
        calls++;
        return reviewer.review(input);
      },
    };
    const out = join(corpus, "results.json");
    const res = await runBenchRun({
      repoRoot: corpus,
      corpus,
      out,
      adapters: { codex: counted },
      maxProviderCalls: 1,
    });
    expect(res.exitCode).toBe(4);
    expect(calls).toBe(1);
    const result = BenchResultSchema.parse(JSON.parse(readFileSync(out, "utf8")));
    expect(result.provenance.integrity?.provider_calls_used).toBe(1);
    expect(result.cost.find((c) => c.provider === "codex")?.calls).toBe(1);
  });

  it("marks benchmark reviews no-retry so one budget unit is one physical call", async () => {
    const corpus = newCorpus();
    writeCase(corpus, "sql-injection-001", seededJson, DB_DIFF);
    writeCase(corpus, "clean-add-001", cleanJson, UTIL_DIFF);
    const flags: Array<boolean | undefined> = [];
    const reviewer = smartCodexStub();
    const inspecting: ProviderAdapter = {
      ...reviewer,
      async review(input) {
        flags.push(input.disableRetries);
        return reviewer.review(input);
      },
    };
    const res = await runBenchRun({
      repoRoot: corpus,
      corpus,
      out: join(corpus, "no-retry", "results.json"),
      maxProviderCalls: 2,
      adapters: { codex: inspecting },
    });

    expect(res.exitCode).toBe(0);
    expect(flags).toEqual([true, true]);
  });

  it("preserves a stateful critic receiver through the direct run budget wrapper", async () => {
    const corpus = newCorpus();
    writeCase(corpus, "sql-injection-001", seededJson, DB_DIFF);
    writeCase(corpus, "clean-add-001", cleanJson, UTIL_DIFF);
    class StatefulCritic implements ProviderAdapter {
      readonly id = "openrouter" as const;
      private readonly marker = "bound";
      completeCalls = 0;

      private assertBound(): void {
        if (this.marker !== "bound") throw new Error("critic method lost its receiver");
      }

      async preflight() {
        this.assertBound();
        return { available: true, version: "stub-1", authMode: "openrouter" as const, error: null };
      }

      async review(): Promise<ReviewResult> {
        throw new Error("critic must use complete()");
      }

      async complete() {
        this.assertBound();
        this.completeCalls++;
        return JSON.stringify({ verdicts: [{ signature: "sql-inj", verdict: "keep" }] });
      }
    }
    const critic = new StatefulCritic();
    const out = join(corpus, "bound-critic", "results.json");
    const res = await runBenchRun({
      repoRoot: corpus,
      corpus,
      out,
      suppressors: { critic: "openrouter" },
      criticModel: "deepseek/deepseek-v4-flash",
      maxProviderCalls: 10,
      adapters: { codex: smartCodexStub(), openrouter: critic },
    });

    expect(res.exitCode).toBe(0);
    expect(critic.completeCalls).toBe(1);
  });

  it("scores a healthy seeded+clean corpus, writes a schema-valid result, exit 0", async () => {
    const corpus = newCorpus();
    writeCase(corpus, "sql-injection-001", seededJson, DB_DIFF);
    writeCase(corpus, "clean-add-001", cleanJson, UTIL_DIFF);
    const out = join(corpus, "attempt-01", "results.json");

    const res = await runBenchRun({
      repoRoot: corpus,
      corpus,
      out,
      window: 5,
      includeAdvisory: false,
      adapters: { codex: smartCodexStub() },
      now: () => new Date("2026-07-01T00:00:00Z"),
    });

    expect(res.exitCode).toBe(0);
    const parsed = BenchResultSchema.safeParse(JSON.parse(readFileSync(out, "utf8")));
    if (!parsed.success) console.error(parsed.error);
    expect(parsed.success).toBe(true);
    const result = parsed.data;
    if (!result) throw new Error("no result");

    expect(result.cases).toHaveLength(2);
    expect(result.cases.every((c) => c.status === "scored")).toBe(true);
    // Panel caught the plant, no false positive on the clean case.
    expect(result.aggregate.precision.value).toBe(1);
    expect(result.aggregate.recall.value).toBe(1);
    expect(result.aggregate.clean_fp_rate.value).toBe(0);
    // Provenance pins the roster + result-affecting config.
    expect(result.provenance.providers[0]?.id).toBe("codex");
    expect(result.provenance.providers[0]?.persona).toBe("security");
    expect(result.provenance.providers[0]?.cli_version).toBe("stub-1");
    expect(result.provenance.file_context).toBe("full");
    expect(result.provenance.cache).toBe("cold");
    expect(result.provenance.config_hash.length).toBeGreaterThan(0);
    expect(result.provenance.case_count).toEqual({ seeded: 1, clean: 1 });
    expect(result.provenance.case_run_count).toEqual({ seeded: 1, clean: 1, total: 2 });
    // Per-provider RAW layer present + authoritative at full coverage.
    const codex = result.providers.find((p) => p.provider === "codex");
    expect(codex?.authoritative).toBe(true);
    expect(codex?.coverage.value).toBe(1);
    // Cost records the OAuth quota calls even at $0 billed.
    const cost = result.cost.find((c) => c.provider === "codex");
    expect(cost?.oauth_quota_calls).toBeGreaterThanOrEqual(2);
    expect(cost?.tokens_in).toBeNull();
    expect(cost?.tokens_out).toBeNull();
    expect(cost?.billed_usd).toBeNull();
  });

  it("fails the quality gate (exit 4) when a case.json is malformed", async () => {
    const corpus = newCorpus();
    writeCase(corpus, "sql-injection-001", seededJson, DB_DIFF);
    writeCase(corpus, "clean-add-001", cleanJson, UTIL_DIFF);
    writeCase(corpus, "broken-001", { schema: "wrong.tag" }, DB_DIFF);
    const out = join(corpus, "results.json");

    const res = await runBenchRun({
      repoRoot: corpus,
      corpus,
      out,
      adapters: { codex: smartCodexStub() },
      now: () => new Date("2026-07-01T00:00:00Z"),
    });

    expect(res.exitCode).toBe(4);
    const result = BenchResultSchema.parse(JSON.parse(readFileSync(out, "utf8")));
    const broken = result.cases.find((c) => c.id === "broken-001");
    expect(broken?.status).toBe("invalid");
  });

  it("fails the quality gate (exit 4) when the corpus has zero clean cases", async () => {
    const corpus = newCorpus();
    writeCase(corpus, "sql-injection-001", seededJson, DB_DIFF);
    const out = join(corpus, "results.json");
    const res = await runBenchRun({
      repoRoot: corpus,
      corpus,
      out,
      adapters: { codex: smartCodexStub() },
      now: () => new Date("2026-07-01T00:00:00Z"),
    });
    expect(res.exitCode).toBe(4);
  });

  it("attributes the RAW per-provider layer to the reviewer that actually ran on failover", async () => {
    // Default roster = codex with a [gemini, claude-code] failover chain. codex is
    // quota-capped, so the orchestrator fails over to gemini — whose real metrics
    // must appear in the per-provider results, not be dropped for the configured slot.
    const corpus = newCorpus();
    writeCase(corpus, "sql-injection-001", seededJson, DB_DIFF);
    writeCase(corpus, "clean-add-001", cleanJson, UTIL_DIFF);
    const out = join(corpus, "results.json");
    const res = await runBenchRun({
      repoRoot: corpus,
      corpus,
      out,
      adapters: { codex: quotaStub("codex"), gemini: smartStub("gemini") },
      // Force the failover target available so the test is hermetic (does not depend
      // on whether the gemini/agy CLI is installed on the runner — it is not in CI).
      providerAvailable: () => true,
      now: () => new Date("2026-07-01T00:00:00Z"),
    });
    expect(res.exitCode).toBe(0);
    const result = BenchResultSchema.parse(JSON.parse(readFileSync(out, "utf8")));
    const gemini = result.providers.find((p) => p.provider === "gemini");
    expect(gemini).toBeDefined();
    expect(gemini?.coverage.value).toBe(1);
    expect(gemini?.authoritative).toBe(true);
    // The plant was still caught (by the failover reviewer).
    expect(result.aggregate.recall.value).toBe(1);
  });

  it("runs --repeat K and reports per-metric mean ± spread (run-to-run stability)", async () => {
    const corpus = newCorpus();
    writeCase(corpus, "sql-injection-001", seededJson, DB_DIFF);
    writeCase(corpus, "clean-add-001", cleanJson, UTIL_DIFF);
    const out = join(corpus, "results.json");

    // Content-aware + repeat-varying: the seeded bug is always caught; the clean
    // case draws a false positive ONLY on its 2nd review (repeat 2), so clean-FP
    // varies [0, 1, 0] across 3 repeats → non-zero spread.
    let cleanCalls = 0;
    const varyingStub: ProviderAdapter = {
      id: "codex",
      async preflight() {
        return { available: true, version: "stub-1", authMode: "oauth", error: null };
      },
      async review(inp) {
        const diff = readFileSync(inp.diffPath, "utf8");
        let findings: Finding[] = [];
        if (diff.includes("db.ts")) {
          findings = [sqlFinding()];
        } else {
          cleanCalls++;
          if (cleanCalls === 2) {
            findings = [
              {
                id: "codex-fp",
                signature: "fp",
                severity: "WARN",
                category: "quality",
                rule_id: "naming",
                file: "src/util.ts",
                line_start: 2,
                line_end: 2,
                message: "variable name could be clearer",
                details: "consider renaming for readability",
                reviewer: { provider: "codex", model: "m", persona: "security" },
                confidence: 0.9,
                consensus: "singleton",
              },
            ];
          }
        }
        return {
          reviewerId: inp.reviewerId,
          verdict: findings.length ? "FAIL" : "PASS",
          findings,
          usage: { inputTokens: 10, outputTokens: 5, costUsd: 0, quotaUsedPct: null },
          durationMs: 1,
          exitCode: 0,
          rawEventsPath: "",
          rawText: "",
          status: "ok",
        } satisfies ReviewResult;
      },
    };

    const res = await runBenchRun({
      repoRoot: corpus,
      corpus,
      out,
      repeat: 3,
      adapters: { codex: varyingStub },
      now: () => new Date("2026-07-01T00:00:00Z"),
    });

    expect(res.exitCode).toBe(0);
    const r = BenchResultSchema.parse(JSON.parse(readFileSync(out, "utf8")));
    expect(r.provenance.repeat).toBe(3);
    expect(r.cases).toHaveLength(6); // 2 cases × 3 repeats
    // Pooled aggregate over the 6 case-runs: 3 TP, 1 FP, 0 FN.
    expect(r.aggregate.recall.value).toBe(1);
    expect(r.aggregate.precision.value).toBeCloseTo(0.75, 10);
    // Stability surfaces the run-to-run variance the pooled number hides.
    expect(r.stability).not.toBeNull();
    expect(r.stability?.repeats).toBe(3);
    expect(r.stability?.clean_fp_rate.mean).toBeCloseTo(1 / 3, 6);
    expect(r.stability?.clean_fp_rate.min).toBe(0);
    expect(r.stability?.clean_fp_rate.max).toBe(1);
    expect(r.stability?.recall.stddev).toBeCloseTo(0, 10); // recall 1 every repeat
    expect(r.stability?.precision.min).toBeCloseTo(0.5, 10);
  });

  it("returns a usage error (exit 2) when the corpus directory is missing", async () => {
    const corpus = newCorpus();
    const res = await runBenchRun({
      repoRoot: corpus,
      corpus: join(corpus, "does-not-exist"),
      out: join(corpus, "results.json"),
      adapters: { codex: smartCodexStub() },
    });
    expect(res.exitCode).toBe(2);
  });

  it("returns a usage error (exit 2) for an unknown provider", async () => {
    const corpus = newCorpus();
    writeCase(corpus, "sql-injection-001", seededJson, DB_DIFF);
    writeCase(corpus, "clean-add-001", cleanJson, UTIL_DIFF);
    const res = await runBenchRun({
      repoRoot: corpus,
      corpus,
      out: join(corpus, "results.json"),
      providers: ["bogus" as ProviderId],
      adapters: { codex: smartCodexStub() },
    });
    expect(res.exitCode).toBe(2);
  });

  it("builds a multi-reviewer PANEL from --providers and scores each provider (RAW layer)", async () => {
    const corpus = newCorpus();
    writeCase(corpus, "sql-injection-001", seededJson, DB_DIFF);
    writeCase(corpus, "clean-add-001", cleanJson, UTIL_DIFF);
    const out = join(corpus, "results.json");
    const res = await runBenchRun({
      repoRoot: corpus,
      corpus,
      out,
      providers: ["codex", "claude-code"],
      adapters: { codex: smartStub("codex"), "claude-code": smartStub("claude-code") },
      now: () => new Date("2026-07-01T00:00:00Z"),
    });
    expect(res.exitCode).toBe(0);
    const r = BenchResultSchema.parse(JSON.parse(readFileSync(out, "utf8")));
    // Provenance pins a 2-reviewer roster; per-provider RAW rows cover both.
    expect(r.provenance.providers.map((p) => p.id).sort()).toEqual(["claude-code", "codex"]);
    for (const id of ["codex", "claude-code"]) {
      const p = r.providers.find((x) => x.provider === id);
      expect(p?.recall.value).toBe(1); // each provider caught the seeded bug
    }
    // The panel corroborated → the plant is caught, no false positive on the clean case.
    expect(r.aggregate.recall.value).toBe(1);
    expect(r.aggregate.clean_fp_rate.value).toBe(0);
  });
});
