// tests/unit/bench-run-cli.test.ts
// reviewgate bench run (spec §12 P1c). Loads a labelled corpus, runs each case
// through the runner with in-process stub reviewers, aggregates Wilson-CI metrics
// over the scored cases, pins provenance, enforces the exit-4 quality gate, and
// writes a schema-valid results JSON. No real reviewer CLIs.
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBenchRun } from "../../src/cli/commands/bench.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";
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
  it("scores a healthy seeded+clean corpus, writes a schema-valid result, exit 0", async () => {
    const corpus = newCorpus();
    writeCase(corpus, "sql-injection-001", seededJson, DB_DIFF);
    writeCase(corpus, "clean-add-001", cleanJson, UTIL_DIFF);
    const out = join(corpus, "results.json");

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
    // Per-provider RAW layer present + authoritative at full coverage.
    const codex = result.providers.find((p) => p.provider === "codex");
    expect(codex?.authoritative).toBe(true);
    expect(codex?.coverage.value).toBe(1);
    // Cost records the OAuth quota calls even at $0 billed.
    const cost = result.cost.find((c) => c.provider === "codex");
    expect(cost?.oauth_quota_calls).toBeGreaterThanOrEqual(2);
    expect(cost?.billed_usd).toBe(0);
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

  it("returns a usage error (exit 2) when --providers matches no reviewer", async () => {
    const corpus = newCorpus();
    writeCase(corpus, "sql-injection-001", seededJson, DB_DIFF);
    writeCase(corpus, "clean-add-001", cleanJson, UTIL_DIFF);
    const res = await runBenchRun({
      repoRoot: corpus,
      corpus,
      out: join(corpus, "results.json"),
      providers: ["opencode"],
      adapters: { codex: smartCodexStub() },
    });
    expect(res.exitCode).toBe(2);
  });
});
