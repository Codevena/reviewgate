// tests/unit/bench-runner.test.ts
// reviewgate bench — per-case runner (spec §12 P1b). Drives the REAL Orchestrator
// one-shot path in a fresh git sandbox with in-process stub reviewers (no real
// CLIs), then scores the aggregated report AND the per-provider raw layer against
// the case labels. Also exercises hydration path-safety and the review-error path.
import { describe, expect, it } from "bun:test";
import { buildBenchConfig, runBenchCase } from "../../src/bench/runner.ts";
import { defaultConfig } from "../../src/config/defaults.ts";
import { ConfigSchema, type ReviewgateConfig } from "../../src/config/define-config.ts";
import type {
  ProviderAdapter,
  ReviewResult,
  ReviewStatus,
} from "../../src/providers/adapter-base.ts";
import type { ProviderId } from "../../src/providers/registry.ts";
import type { BenchCase } from "../../src/schemas/bench-case.ts";
import type { Finding } from "../../src/schemas/finding.ts";

// --- stub reviewer -----------------------------------------------------------
function stubReviewer(
  id: ProviderId,
  findings: Finding[],
  status: ReviewStatus = "ok",
): ProviderAdapter {
  return {
    id,
    async preflight() {
      return { available: true, version: "stub-1", authMode: "oauth", error: null };
    },
    async review(inp) {
      return {
        reviewerId: inp.reviewerId,
        verdict: findings.length ? "FAIL" : "PASS",
        findings,
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0, quotaUsedPct: null },
        durationMs: 1,
        exitCode: status === "ok" ? 0 : 1,
        rawEventsPath: "",
        rawText: "",
        status,
      } satisfies ReviewResult;
    },
  };
}

function sqlInjectionFinding(provider: ProviderId, persona: string): Finding {
  return {
    id: `${provider}-1`,
    signature: "sql-inj",
    severity: "CRITICAL",
    category: "security",
    rule_id: "sql-injection",
    file: "src/db.ts",
    line_start: 3,
    line_end: 3,
    message: "SQL injection via string concatenation",
    details: "the user id is concatenated directly into the query string",
    reviewer: { provider, model: "m", persona },
    confidence: 0.95,
    consensus: "singleton",
  };
}

function hallucinatedFinding(provider: ProviderId, persona: string): Finding {
  return {
    id: `${provider}-h`,
    signature: "halluc",
    severity: "WARN",
    category: "quality",
    rule_id: "naming",
    file: "src/util.ts",
    line_start: 2,
    line_end: 2,
    message: "variable name could be clearer",
    details: "consider renaming for readability",
    reviewer: { provider, model: "m", persona },
    confidence: 0.9,
    consensus: "singleton",
  };
}

// --- corpus fixtures (self-contained new-file diffs — apply to an empty tree) --
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

const seededCase: BenchCase = {
  schema: "reviewgate.bench.case.v1",
  id: "sql-injection-001",
  kind: "seeded-bug",
  language: "ts",
  expected: [{ tag: "sql injection", file: "src/db.ts", line: 3, min_severity: "CRITICAL" }],
  allowed: [],
  strict_region: true,
  source: "hand-written",
};

const cleanCase: BenchCase = {
  schema: "reviewgate.bench.case.v1",
  id: "clean-add-001",
  kind: "clean",
  language: "ts",
  expected: [],
  allowed: [],
  strict_region: true,
  source: "hand-written",
};

function twoReviewerConfig(): ReviewgateConfig {
  return ConfigSchema.parse({
    ...defaultConfig,
    cache: { ...defaultConfig.cache, enabled: false },
    providers: {
      ...defaultConfig.providers,
      "claude-code": { ...defaultConfig.providers["claude-code"], enabled: true },
    },
    phases: {
      ...defaultConfig.phases,
      review: {
        ...defaultConfig.phases.review,
        reviewers: [
          { provider: "codex", persona: "security" },
          { provider: "claude-code", persona: "quality" },
        ],
      },
      critic: null,
      triage: null,
    },
  });
}

describe("runBenchCase", () => {
  it("pins critic model/route/cap without overwriting the provider's reviewer model", () => {
    const config = buildBenchConfig({
      suppressors: { critic: "openrouter" },
      criticModel: "benchmark/critic-only-model",
      criticOpenrouterProvider: { only: ["alibaba"], allowFallbacks: false },
      maxOutputTokens: 256,
    });
    expect(config.phases.critic?.model).toBe("benchmark/critic-only-model");
    expect(config.providers.openrouter?.model).toBe(defaultConfig.providers.openrouter.model);
    expect(config.providers.openrouter?.openrouterProvider).toEqual({
      only: ["alibaba"],
      allowFallbacks: false,
    });
    expect(config.providers.openrouter?.maxTokens).toBe(256);
  });

  it("keeps a same-provider reviewer model independent from the critic override", () => {
    const config = buildBenchConfig({
      providers: ["codex"],
      suppressors: { critic: "codex" },
      criticModel: "critic-only-model",
    });
    expect(config.phases.critic?.model).toBe("critic-only-model");
    expect(config.providers.codex?.model).toBe(defaultConfig.providers.codex.model);
  });

  it("surfaces an eligible critic's persisted run status per case", async () => {
    const config = buildBenchConfig({
      suppressors: { critic: "openrouter" },
      criticModel: "deepseek/deepseek-v4-flash",
      criticOpenrouterProvider: { only: ["alibaba"] },
      maxOutputTokens: 128,
    });
    const receivedOptions: Array<Parameters<NonNullable<ProviderAdapter["complete"]>>[1]> = [];
    const critic: ProviderAdapter = {
      id: "openrouter",
      async preflight() {
        return { available: true, version: "stub-1", authMode: "openrouter", error: null };
      },
      async review() {
        throw new Error("critic must not use review()");
      },
      async complete(_prompt, options) {
        receivedOptions.push(options);
        return JSON.stringify({
          verdicts: [{ signature: "sql-inj", verdict: "keep", reason: "real bug" }],
        });
      },
    };
    const out = await runBenchCase({
      benchCase: seededCase,
      diffPatch: DB_DIFF,
      config,
      window: 5,
      includeAdvisory: false,
      adapters: {
        codex: stubReviewer("codex", [sqlInjectionFinding("codex", "security")]),
        openrouter: critic,
      },
    });
    expect(out.critic).toEqual({
      provider: "openrouter",
      eligible: true,
      status: "ran",
      verdicts: 1,
      demoted: 0,
    });
    expect(receivedOptions[0]?.model).toBe("deepseek/deepseek-v4-flash");
    expect(receivedOptions[0]?.openrouterProvider).toEqual({ only: ["alibaba"] });
    expect(receivedOptions[0]?.maxTokens).toBe(128);
  });

  it("scores a caught seeded bug as a TP on both the panel and every provider", async () => {
    const config = twoReviewerConfig();
    const out = await runBenchCase({
      benchCase: seededCase,
      diffPatch: DB_DIFF,
      config,
      window: 5,
      includeAdvisory: false,
      adapters: {
        codex: stubReviewer("codex", [sqlInjectionFinding("codex", "security")]),
        "claude-code": stubReviewer("claude-code", [sqlInjectionFinding("claude-code", "quality")]),
      },
    });

    expect(out.status).toBe("scored");
    expect(out.counts.tp).toBe(1);
    expect(out.counts.fn).toBe(0);
    expect(out.counts.fp).toBe(0);
    expect(out.panelConfigured).toBe(2);
    expect(out.panelOk).toBe(2);
    // Per-provider RAW layer: each reviewer independently caught it.
    expect(out.perProvider).toHaveLength(2);
    for (const pp of out.perProvider) {
      expect(pp.status).toBe("ok");
      expect(pp.match?.tp).toBe(1);
      expect(pp.match?.fn).toBe(0);
    }
  });

  it("records a missed seeded bug as an FN (no reviewer fired)", async () => {
    const config = twoReviewerConfig();
    const out = await runBenchCase({
      benchCase: seededCase,
      diffPatch: DB_DIFF,
      config,
      window: 5,
      includeAdvisory: false,
      adapters: {
        codex: stubReviewer("codex", []),
        "claude-code": stubReviewer("claude-code", []),
      },
    });
    expect(out.status).toBe("scored");
    expect(out.counts.tp).toBe(0);
    expect(out.counts.fn).toBe(1);
  });

  it("scores a clean case with no findings as zero FP", async () => {
    const config = twoReviewerConfig();
    const out = await runBenchCase({
      benchCase: cleanCase,
      diffPatch: UTIL_DIFF,
      config,
      window: 5,
      includeAdvisory: false,
      adapters: {
        codex: stubReviewer("codex", []),
        "claude-code": stubReviewer("claude-code", []),
      },
    });
    expect(out.status).toBe("scored");
    expect(out.counts.fp).toBe(0);
    expect(out.counts.tp).toBe(0);
    expect(out.counts.fn).toBe(0);
  });

  it("scores an in-region hallucination on a clean case as an FP", async () => {
    const config = twoReviewerConfig();
    const out = await runBenchCase({
      benchCase: cleanCase,
      diffPatch: UTIL_DIFF,
      config,
      window: 5,
      includeAdvisory: false,
      adapters: {
        codex: stubReviewer("codex", [hallucinatedFinding("codex", "security")]),
        "claude-code": stubReviewer("claude-code", [hallucinatedFinding("claude-code", "quality")]),
      },
    });
    expect(out.status).toBe("scored");
    expect(out.counts.fp).toBeGreaterThanOrEqual(1);
  });

  it("marks a case whose diff targets a reserved dir as invalid (never runs a reviewer)", async () => {
    const config = twoReviewerConfig();
    const evilDiff = [
      "diff --git a/.git/hooks/pre-commit b/.git/hooks/pre-commit",
      "new file mode 100755",
      "--- /dev/null",
      "+++ b/.git/hooks/pre-commit",
      "@@ -0,0 +1,1 @@",
      "+echo pwned",
      "",
    ].join("\n");
    const out = await runBenchCase({
      benchCase: { ...seededCase, id: "evil-001" },
      diffPatch: evilDiff,
      config,
      window: 5,
      includeAdvisory: false,
      adapters: { codex: stubReviewer("codex", []) },
    });
    expect(out.status).toBe("invalid");
    expect(out.error).toBeTruthy();
  });

  it("marks a non-applyable diff as invalid", async () => {
    const config = twoReviewerConfig();
    // A modification hunk against a file that does not exist in the empty tree.
    const badDiff = [
      "diff --git a/src/missing.ts b/src/missing.ts",
      "--- a/src/missing.ts",
      "+++ b/src/missing.ts",
      "@@ -1,2 +1,2 @@",
      " unchanged",
      "-old",
      "+new",
      "",
    ].join("\n");
    const out = await runBenchCase({
      benchCase: { ...cleanCase, id: "nonapply-001" },
      diffPatch: badDiff,
      config,
      window: 5,
      includeAdvisory: false,
      adapters: { codex: stubReviewer("codex", []) },
    });
    expect(out.status).toBe("invalid");
  });

  it("classifies a total reviewer failure as review-error, not scored", async () => {
    const config = twoReviewerConfig();
    const out = await runBenchCase({
      benchCase: cleanCase,
      diffPatch: UTIL_DIFF,
      config,
      window: 5,
      includeAdvisory: false,
      adapters: {
        codex: stubReviewer("codex", [], "error"),
        "claude-code": stubReviewer("claude-code", [], "error"),
      },
    });
    expect(out.status).toBe("review-error");
    expect(out.aggregatedMatch).toBeNull();
    expect(out.panelOk).toBe(0);
  });
});

describe("buildBenchConfig panel roster", () => {
  it("defaults to a single codex reviewer with cache disabled", () => {
    const c = buildBenchConfig();
    expect(c.phases.review.reviewers).toHaveLength(1);
    expect(c.phases.review.reviewers[0]?.provider).toBe("codex");
    expect(c.cache.enabled).toBe(false);
  });

  it("builds a multi-reviewer panel from providers and enables each provider", () => {
    const c = buildBenchConfig({ providers: ["codex", "gemini", "claude-code"] });
    expect(c.phases.review.reviewers.map((r) => r.provider)).toEqual([
      "codex",
      "gemini",
      "claude-code",
    ]);
    expect(c.providers.codex?.enabled).toBe(true);
    expect(c.providers.gemini?.enabled).toBe(true);
    expect(c.providers["claude-code"]?.enabled).toBe(true);
    // Same persona (isolates the "more providers" effect), no failover chain.
    expect(c.phases.review.reviewers.every((r) => r.persona === "security")).toBe(true);
    expect(c.phases.review.reviewers.every((r) => !r.fallback)).toBe(true);
  });
});

describe("buildBenchConfig suppressor toggles", () => {
  it("enables the critic with the given provider (default off)", () => {
    expect(buildBenchConfig().phases.critic).toBeNull();
    const c = buildBenchConfig({ suppressors: { critic: "openrouter" } });
    expect(c.phases.critic).not.toBeNull();
    expect(c.phases.critic?.provider).toBe("openrouter");
  });

  it("disables the critic when critic:null", () => {
    const c = buildBenchConfig({ suppressors: { critic: null } });
    expect(c.phases.critic).toBeNull();
  });

  it("applies confidenceFloor / scopeToDiff / reputation overrides", () => {
    const c = buildBenchConfig({
      suppressors: { confidenceFloor: 0, scopeToDiff: false, reputation: false },
    });
    expect(c.phases.review.confidenceFloor).toBe(0);
    expect(c.phases.review.scopeToDiff).toBe(false);
    expect(c.phases.reputation.enabled).toBe(false);
  });
});
