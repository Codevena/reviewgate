import { afterAll, describe, expect, it, setSystemTime } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLogger } from "../../src/audit/logger.ts";
import { defaultConfig } from "../../src/config/defaults.ts";
import type { ReviewgateConfig } from "../../src/config/define-config.ts";
import {
  type IterationResult,
  Orchestrator,
  type OrchestratorInput,
} from "../../src/core/orchestrator.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";
import type { Finding } from "../../src/schemas/finding.ts";

const DIFF = [
  "diff --git a/a.ts b/a.ts",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1 +1 @@",
  "-export const value = 0;",
  "+export const value = 1;",
  "",
].join("\n");

const RAW_BY_PROVIDER = {
  codex: '{"verdict":"FAIL","findings":[{"source":"codex"}]}',
  "claude-code": '{"verdict":"FAIL","findings":[{"source":"claude-code"}]}',
} as const;

type TraceMode = NonNullable<OrchestratorInput["policyExecution"]>["trace"];
type PolicyAwareInput = OrchestratorInput;
type PolicyAwareResult = IterationResult;

function sha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function finding(provider: "codex" | "claude-code"): Finding {
  return {
    id: "F-001",
    signature: "same-finding",
    severity: "INFO",
    category: "quality",
    rule_id: "same-rule",
    file: "a.ts",
    line_start: 1,
    line_end: 1,
    message: "The changed value needs review",
    details: "The same deterministic observation from both configured reviewer slots.",
    reviewer: { provider, model: "fixture-model", persona: "quality" },
    confidence: 0.9,
    consensus: "singleton",
  };
}

function adapter(provider: "codex" | "claude-code", calls: string[]): ProviderAdapter {
  return {
    id: provider,
    async preflight() {
      return { available: true, version: "fixture", authMode: "oauth", error: null };
    },
    async review(input) {
      calls.push(provider);
      return {
        reviewerId: input.reviewerId,
        verdict: "FAIL",
        findings: [finding(provider)],
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
        durationMs: 1,
        exitCode: 0,
        rawEventsPath: "",
        rawText: RAW_BY_PROVIDER[provider],
        status: "ok",
      } satisfies ReviewResult;
    },
  };
}

function stripPolicyTelemetry(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripPolicyTelemetry);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (
      key === "policy_effects" ||
      key === "policy_summary" ||
      key === "policy_trace_status" ||
      key === "policy_trace_ref" ||
      key === "policy_trace_sha256"
    ) {
      continue;
    }
    out[key] = stripPolicyTelemetry(child);
  }
  return out;
}

async function run(
  mode?: TraceMode,
  withAudit = false,
  reviewOverrides: Partial<ReviewgateConfig["phases"]["review"]> = {},
  reportMode: OrchestratorInput["reportMode"] = "gate",
  grounding: ReviewgateConfig["phases"]["grounding"] = null,
): Promise<{
  repo: string;
  calls: string[];
  result: PolicyAwareResult;
  report: unknown;
  markdown: Buffer;
  reviewCache: Record<string, string>;
}> {
  const repo = mkdtempSync(join(tmpdir(), `rg-policy-${mode ?? "default"}-`));
  writeFileSync(join(repo, "a.ts"), "export const value = 1;\n");
  const calls: string[] = [];
  const config: ReviewgateConfig = {
    ...defaultConfig,
    cache: { enabled: true, reviewTtlDays: 7 },
    providers: {
      ...defaultConfig.providers,
      "claude-code": { ...defaultConfig.providers["claude-code"], enabled: true },
    },
    phases: {
      ...defaultConfig.phases,
      review: {
        ...defaultConfig.phases.review,
        ...reviewOverrides,
        reviewers: [
          { provider: "codex" as const, persona: "quality" },
          { provider: "claude-code" as const, persona: "quality" },
        ],
        providerPrecisionContext: false,
      },
      brain: null,
      critic: null,
      fpLedger: null,
      grounding,
      implicitOutcomes: null,
      lore: null,
      triage: null,
    },
  };
  const baseInput: OrchestratorInput = {
    repoRoot: repo,
    config,
    ...(withAudit ? { audit: new AuditLogger(join(repo, ".reviewgate", "audit")) } : {}),
    adapters: {
      codex: adapter("codex", calls),
      "claude-code": adapter("claude-code", calls),
    },
    sandboxMode: "off",
    hostTier: "opus",
    agentHost: "codex",
    diff: DIFF,
    gitInfo: { sha: "a".repeat(40), branch: "fixture", dirtyFiles: ["a.ts"] },
    reasonOnFailEnabled: true,
    disableLastResortFailover: true,
    reportMode,
  };
  const input: OrchestratorInput | PolicyAwareInput =
    mode === undefined
      ? baseInput
      : {
          ...baseInput,
          policyExecution: {
            trace: mode,
            policyAblations: new Set(),
            authoritative: false,
          },
        };
  const result = (await new Orchestrator(input).runIteration({
    runId: "RUN-POLICY-EQUIVALENCE",
    iter: 1,
  })) as PolicyAwareResult;
  const reviewCacheDir = join(repo, ".reviewgate", "cache", "reviews");
  const reviewCache = Object.fromEntries(
    readdirSync(reviewCacheDir)
      .sort()
      .map((name) => [name, readFileSync(join(reviewCacheDir, name), "utf8")]),
  );
  return {
    repo,
    calls,
    result,
    report: JSON.parse(
      readFileSync(
        join(repo, ".reviewgate", reportMode === "one-shot" ? "plan-review.json" : "pending.json"),
        "utf8",
      ),
    ),
    markdown: readFileSync(
      join(repo, ".reviewgate", reportMode === "one-shot" ? "plan-review.md" : "pending.md"),
    ),
    reviewCache,
  };
}

describe("policy trace lifecycle equivalence", () => {
  setSystemTime(new Date("2026-08-10T12:00:00.000Z"));
  afterAll(() => setSystemTime());

  it("keeps findings, Markdown, and cache identity byte-neutral while hashing reviewer slots in order", async () => {
    const traced = await run("memory");
    const legacy = await run("off");

    expect(traced.calls).toEqual(["codex", "claude-code"]);
    expect(legacy.calls).toEqual(traced.calls);
    expect(traced.result.policyTrace?.raw_response_sha256).toEqual([
      sha256(RAW_BY_PROVIDER.codex),
      sha256(RAW_BY_PROVIDER["claude-code"]),
    ]);
    expect(traced.result.verdict).toBe(legacy.result.verdict);
    expect(traced.result.summary.counts).toEqual(legacy.result.summary.counts);
    expect(traced.result.signaturesThisIter).toEqual(legacy.result.signaturesThisIter);
    expect(stripPolicyTelemetry(traced.report)).toEqual(stripPolicyTelemetry(legacy.report));
    expect(traced.markdown.equals(legacy.markdown)).toBe(true);
    expect(traced.reviewCache).toEqual(legacy.reviewCache);
  });

  it("owns the full memory trace only in IterationResult and does not invent persistence metadata", async () => {
    const traced = await run("memory");
    const legacy = await run("off");
    const tracedReport = traced.report as Record<string, unknown>;

    expect(traced.result.policyTrace).toBeDefined();
    expect(traced.result.policySummary).toBeUndefined();
    expect(tracedReport.policy_summary).toBeUndefined();
    expect(traced.result.summary.policy_trace_ref).toBeUndefined();
    expect(traced.result.summary.policy_trace_sha256).toBeUndefined();
    expect(legacy.result.policyTrace).toBeUndefined();
    expect(legacy.result.policySummary).toBeUndefined();
  });

  it("keeps one-shot output free of an unbound policy summary and artifact reference", async () => {
    const traced = await run("memory", false, {}, "one-shot");
    const report = traced.report as Record<string, unknown>;

    expect(traced.result.policyTrace).toBeDefined();
    expect(report.policy_summary).toBeUndefined();
    expect(traced.result.summary.policy_trace_ref).toBeUndefined();
    expect(traced.result.summary.policy_trace_sha256).toBeUndefined();
  });

  it("defaults the ordinary AuditLogger path to persist mode with an empty internal ablation set", async () => {
    const production = await run(undefined, true);

    expect(production.result.policyTrace).toBeDefined();
    expect(production.result.policyTrace?.ablated).toEqual([]);
    expect(production.result.policySummary).toBeUndefined();
  });

  it("orders reviewer, grounding, and critic response hashes by logical call order", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-policy-response-order-"));
    writeFileSync(join(repo, "a.ts"), "export const value = 1;\n");
    const reviewerRaw = '{"verdict":"FAIL","findings":[{"source":"reviewer"}]}';
    const groundingRaw = '{"verdicts":[{"signature":"ordered-signature","grounded":true}]}';
    const criticRaw = ["not critic json", '{"verdicts":[]}'];
    const critical: Finding = {
      ...finding("codex"),
      signature: "ordered-signature",
      severity: "CRITICAL",
      message: "The changed `value` needs review",
    };
    const completionAdapter = (
      id: "gemini" | "opencode",
      response: string | readonly string[],
    ): ProviderAdapter => {
      let calls = 0;
      return {
        id,
        async preflight() {
          return { available: true, version: "fixture", authMode: "oauth", error: null };
        },
        async review(input) {
          return {
            reviewerId: input.reviewerId,
            verdict: "PASS",
            findings: [],
            usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, quotaUsedPct: null },
            durationMs: 1,
            exitCode: 0,
            rawEventsPath: "",
            rawText: "",
            status: "ok",
          } satisfies ReviewResult;
        },
        async complete() {
          if (typeof response === "string") return response;
          const value = response[calls] ?? "";
          calls += 1;
          return value;
        },
      };
    };
    const reviewer: ProviderAdapter = {
      id: "codex",
      async preflight() {
        return { available: true, version: "fixture", authMode: "oauth", error: null };
      },
      async review(input) {
        return {
          reviewerId: input.reviewerId,
          verdict: "FAIL",
          findings: [critical],
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
          durationMs: 1,
          exitCode: 0,
          rawEventsPath: "",
          rawText: reviewerRaw,
          status: "ok",
        } satisfies ReviewResult;
      },
    };
    const config: ReviewgateConfig = {
      ...defaultConfig,
      cache: { enabled: false, reviewTtlDays: 7 },
      providers: {
        ...defaultConfig.providers,
        gemini: { ...defaultConfig.providers.gemini, enabled: true },
        opencode: { ...defaultConfig.providers.opencode, enabled: true },
      },
      phases: {
        ...defaultConfig.phases,
        review: {
          ...defaultConfig.phases.review,
          reviewers: [{ provider: "codex" as const, persona: "quality" }],
          providerPrecisionContext: false,
        },
        brain: null,
        critic: { provider: "opencode" as const, persona: "fp-filter" },
        fpLedger: null,
        grounding: { provider: "gemini" as const },
        implicitOutcomes: null,
        lore: null,
        triage: null,
      },
    };
    const input: PolicyAwareInput = {
      repoRoot: repo,
      config,
      adapters: {
        codex: reviewer,
        gemini: completionAdapter("gemini", groundingRaw),
        opencode: completionAdapter("opencode", criticRaw),
      },
      sandboxMode: "off",
      hostTier: "opus",
      agentHost: "codex",
      diff: DIFF,
      reasonOnFailEnabled: true,
      disableLastResortFailover: true,
      criticMaxAttempts: 2,
      policyExecution: {
        trace: "memory",
        policyAblations: new Set(),
        authoritative: true,
      },
    };

    const result = (await new Orchestrator(input).runIteration({
      runId: "RUN-RESPONSE-ORDER",
      iter: 1,
    })) as PolicyAwareResult;

    expect(result.policyTrace?.raw_response_sha256).toEqual([
      sha256(reviewerRaw),
      sha256(groundingRaw),
      ...criticRaw.map(sha256),
    ]);
    expect(
      result.policyTrace?.passes.find((pass) => pass.pass_id === "judgment.critic")?.status,
    ).toBe("ran");
  });

  it("marks configured-inactive pre-aggregation passes not-run without evaluations", async () => {
    const traced = await run("memory", false, {
      selfRefutationFilter: false,
      hypotheticalSeverityGuard: false,
    });
    const status = new Map(
      traced.result.policyTrace?.passes.map((pass) => [
        pass.pass_id,
        [pass.status, "reason_code" in pass ? pass.reason_code : undefined],
      ]),
    );

    expect(status.get("evidence.self-refutation")).toEqual(["not-run", "configured-off"]);
    expect(status.get("judgment.hypothetical")).toEqual(["not-run", "configured-off"]);
    expect(status.get("judgment.grounding-llm")).toEqual(["not-run", "configured-off"]);
    expect(status.get("judgment.critic")).toEqual(["not-run", "configured-off"]);
    expect(status.get("scope.delta")).toEqual(["not-run", "stage-precondition-miss"]);
    expect(status.get("scope.session")).toEqual(["not-run", "stage-precondition-miss"]);
  });

  it("distinguishes configured-off scopes from stage-precondition misses", async () => {
    const configuredOff = await run("memory", false, {
      scopeToDiff: false,
      deltaReview: false,
      scopeToSession: false,
    });
    const noCritical = await run("memory", false, {}, "gate", { provider: "gemini" });
    const configuredOffStatus = new Map(
      configuredOff.result.policyTrace?.passes.map((pass) => [
        pass.pass_id,
        [pass.status, "reason_code" in pass ? pass.reason_code : undefined],
      ]),
    );
    const grounding = noCritical.result.policyTrace?.passes.find(
      (pass) => pass.pass_id === "judgment.grounding-llm",
    );

    expect(configuredOffStatus.get("scope.diff")).toEqual(["not-run", "configured-off"]);
    expect(configuredOffStatus.get("scope.delta")).toEqual(["not-run", "configured-off"]);
    expect(configuredOffStatus.get("scope.session")).toEqual(["not-run", "configured-off"]);
    expect(grounding).toEqual({
      pass_id: "judgment.grounding-llm",
      status: "not-run",
      reason_code: "stage-precondition-miss",
    });
  });

  it("preserves the exact production demotion when recorder validation fails", async () => {
    const execute = async (mode: "off" | "memory") => {
      const repo = mkdtempSync(join(tmpdir(), `rg-policy-recorder-error-${mode}-`));
      writeFileSync(join(repo, "a.ts"), "export const value = 1;\n");
      const lowConfidence = {
        ...finding("codex"),
        signature: "",
        severity: "WARN" as const,
        confidence: 0.1,
      };
      const config: ReviewgateConfig = {
        ...defaultConfig,
        cache: { enabled: false, reviewTtlDays: 7 },
        phases: {
          ...defaultConfig.phases,
          review: {
            ...defaultConfig.phases.review,
            reviewers: [{ provider: "codex" as const, persona: "quality" }],
            providerPrecisionContext: false,
          },
          brain: null,
          critic: null,
          fpLedger: null,
          grounding: null,
          implicitOutcomes: null,
          lore: null,
          triage: null,
        },
      };
      const reviewer: ProviderAdapter = {
        id: "codex",
        async preflight() {
          return { available: true, version: "fixture", authMode: "oauth", error: null };
        },
        async review(input) {
          return {
            reviewerId: input.reviewerId,
            verdict: "FAIL",
            findings: [lowConfidence],
            usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
            durationMs: 1,
            exitCode: 0,
            rawEventsPath: "",
            rawText: '{"verdict":"FAIL","findings":[]}',
            status: "ok",
          } satisfies ReviewResult;
        },
      };
      const input: PolicyAwareInput = {
        repoRoot: repo,
        config,
        adapters: { codex: reviewer },
        sandboxMode: "off",
        hostTier: "opus",
        agentHost: "codex",
        diff: DIFF,
        reasonOnFailEnabled: true,
        disableLastResortFailover: true,
        policyExecution: {
          trace: mode,
          policyAblations: new Set(),
          authoritative: false,
        },
      };
      const result = (await new Orchestrator(input).runIteration({
        runId: "RUN-RECORDER-ERROR",
        iter: 1,
      })) as PolicyAwareResult;
      return {
        result,
        report: JSON.parse(readFileSync(join(repo, ".reviewgate", "pending.json"), "utf8")) as {
          findings: Finding[];
        },
      };
    };

    const traced = await execute("memory");
    const legacy = await execute("off");

    expect(traced.result.policyTrace).toBeUndefined();
    expect(traced.report.findings[0]?.severity).toBe("INFO");
    expect(traced.report.findings[0]?.low_confidence).toBe(true);
    expect(stripPolicyTelemetry(traced.report)).toEqual(stripPolicyTelemetry(legacy.report));
  });
});
