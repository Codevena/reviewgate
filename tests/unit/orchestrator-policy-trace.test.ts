import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../src/config/defaults.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import {
  EMPTY_POLICY_ABLATIONS,
  resolvePolicyExecutionOptions,
} from "../../src/core/policy/replay.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";
import { PolicyReplayEnvelopeSchema } from "../../src/schemas/policy-replay.ts";
import { initialState } from "../../src/schemas/state.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const DIFF = "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-old\n+new\n";

function reviewResult(
  reviewerId: string,
  status: "ok" | "error",
  rawText: string,
  findings: ReviewResult["findings"] = [],
): ReviewResult {
  return {
    reviewerId,
    verdict: status === "ok" && findings.length === 0 ? "PASS" : status === "ok" ? "FAIL" : "ERROR",
    findings,
    usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
    durationMs: 1,
    exitCode: status === "ok" ? 0 : 1,
    rawEventsPath: "",
    rawText,
    status,
  };
}

async function capturedEnvelope(input: {
  reviewers: Array<{
    provider: "codex" | "gemini";
    persona: "security";
    fallback?: Array<"gemini">;
  }>;
  adapters: Partial<Record<"codex" | "gemini", ProviderAdapter>>;
  critic?: { provider: "codex"; model: string } | null;
  criticMaxAttempts?: number;
}) {
  const repoRoot = mkdtempSync(join(tmpdir(), "rg-policy-call-capture-"));
  writeFileSync(join(repoRoot, "foo.ts"), "new\n");
  mkdirSync(join(repoRoot, ".reviewgate"));
  writeFileSync(
    join(repoRoot, ".reviewgate", "state.json"),
    JSON.stringify(initialState("policy-call-session")),
    { mode: 0o600 },
  );
  const outputRoot = mkdtempSync(join(tmpdir(), "rg-policy-call-output-"));
  const sinkDir = join(outputRoot, "policy-replay");
  mkdirSync(sinkDir, { mode: 0o700 });
  const config = {
    ...defaultConfig,
    phases: {
      ...defaultConfig.phases,
      review: { ...defaultConfig.phases.review, reviewers: input.reviewers },
      critic: input.critic ?? null,
      triage: null,
      fpLedger: null,
      reputation: { ...defaultConfig.phases.reputation, enabled: false },
      implicitOutcomes: null,
    },
  };
  const orchestrator = new Orchestrator({
    repoRoot,
    // biome-ignore lint/suspicious/noExplicitAny: focused test config narrows provider tuples
    config: config as any,
    adapters: input.adapters,
    sandboxMode: "off",
    hostTier: "opus",
    diff: DIFF,
    reasonOnFailEnabled: true,
    policyExecution: { trace: "memory", policyAblations: new Set(), authoritative: false },
    policyReplayCapture: { sinkDir, sourceCommit: "a".repeat(40) },
    providerAvailable: (provider) => input.adapters[provider as "codex" | "gemini"] !== undefined,
    ...(input.criticMaxAttempts === undefined
      ? {}
      : { criticMaxAttempts: input.criticMaxAttempts }),
  });
  await orchestrator.runIteration({ runId: "policy-call-run", iter: 1 });
  const files = readdirSync(sinkDir).filter((name) => name.endsWith(".json"));
  expect(files).toHaveLength(1);
  return PolicyReplayEnvelopeSchema.parse(
    JSON.parse(readFileSync(join(sinkDir, files[0] as string), "utf8")),
  );
}

describe("internal policy execution selection", () => {
  it("keeps legacy direct construction off and defaults the AuditLogger path to persist", () => {
    const direct = resolvePolicyExecutionOptions(undefined, false);
    const production = resolvePolicyExecutionOptions(undefined, true);

    expect(direct).toEqual({
      trace: "off",
      policyAblations: EMPTY_POLICY_ABLATIONS,
      authoritative: false,
    });
    expect(production).toEqual({
      trace: "persist",
      policyAblations: EMPTY_POLICY_ABLATIONS,
      authoritative: false,
    });
    expect(production.policyAblations.size).toBe(0);
  });

  it("preserves explicit internal memory mode and its ablation identity", () => {
    const ablations = new Set(["judgment.confidence"] as const);
    const resolved = resolvePolicyExecutionOptions(
      { trace: "memory", policyAblations: ablations, authoritative: true },
      false,
    );

    expect(resolved.trace).toBe("memory");
    expect(resolved.policyAblations).toBe(ablations);
    expect(resolved.authoritative).toBe(true);
  });
});

describe("policy ablations stay internal", () => {
  it("has no policyAblations mapping in Gate, Config, Setup, config schemas, or env parsing", async () => {
    const guardedFiles = [
      "src/cli/commands/gate.ts",
      "src/cli/commands/config.ts",
      "src/cli/commands/setup.ts",
    ];
    const configFiles = new Bun.Glob("src/config/**/*.ts");
    for await (const path of configFiles.scan({ cwd: REPO_ROOT, onlyFiles: true })) {
      guardedFiles.push(path);
    }

    for (const path of guardedFiles) {
      const source = readFileSync(join(REPO_ROOT, path), "utf8");
      expect(source, path).not.toContain("policyAblations");
    }
  });

  it("lets Gate read only the Rig capture sink, never a pass or ablation control", () => {
    const gate = readFileSync(join(REPO_ROOT, "src/cli/commands/gate.ts"), "utf8");
    const replayEnvReads = [...gate.matchAll(/process\.env\.([A-Z0-9_]*RIG[A-Z0-9_]*)/g)].map(
      (match) => match[1],
    );
    expect(replayEnvReads).toEqual(["REVIEWGATE_RIG_REPLAY_DIR"]);
    expect(gate).not.toMatch(/REVIEWGATE_(?:POLICY_)?ABLATION/);
    expect(gate).not.toMatch(/REVIEWGATE_POLICY_PASS/);
  });
});

describe("policy replay response-call capture", () => {
  it("binds the settled failover response to the actual provider and attempt", async () => {
    const codex: ProviderAdapter = {
      id: "codex",
      async preflight() {
        return { available: true, version: "x", authMode: "oauth", error: null };
      },
      async review(input) {
        return reviewResult(input.reviewerId, "error", "safe primary failure");
      },
    };
    const gemini: ProviderAdapter = {
      id: "gemini",
      async preflight() {
        return { available: true, version: "x", authMode: "oauth", error: null };
      },
      async review(input) {
        return reviewResult(input.reviewerId, "ok", "safe fallback response");
      },
    };
    const envelope = await capturedEnvelope({
      reviewers: [{ provider: "codex", persona: "security", fallback: ["gemini"] }],
      adapters: { codex, gemini },
    });

    expect(envelope.response_calls).toHaveLength(1);
    const responseCall = envelope.response_calls[0];
    if (responseCall === undefined) throw new Error("missing captured fallback response call");
    expect(responseCall).toMatchObject({
      kind: "reviewer",
      provider: "gemini",
      method: "review",
      key: "gemini-security",
      slot: 0,
      attempt: 2,
      occurrence: 0,
      ordinal: 0,
    });
    expect(envelope.raw_response_sha256).toEqual([responseCall.response_sha256]);
  });

  it("binds critic retries to one prompt identity with ordered attempts and occurrences", async () => {
    const finding = {
      id: "critic-1",
      signature: "critic-signature",
      severity: "WARN" as const,
      category: "quality" as const,
      rule_id: "critic-rule",
      file: "foo.ts",
      line_start: 1,
      line_end: 1,
      message: "A concrete issue",
      details: "The changed value is not checked.",
      reviewer: { provider: "codex", model: "test", persona: "security" },
      confidence: 0.9,
      consensus: "singleton" as const,
    };
    let completion = 0;
    const codex: ProviderAdapter = {
      id: "codex",
      async preflight() {
        return { available: true, version: "x", authMode: "oauth", error: null };
      },
      async review(input) {
        return reviewResult(input.reviewerId, "ok", "safe reviewer response", [finding]);
      },
      async complete() {
        completion += 1;
        return completion === 1
          ? "safe invalid critic response"
          : JSON.stringify({
              verdicts: [{ signature: finding.signature, verdict: "keep" }],
            });
      },
    };
    const envelope = await capturedEnvelope({
      reviewers: [{ provider: "codex", persona: "security" }],
      adapters: { codex },
      critic: { provider: "codex", model: "test" },
      criticMaxAttempts: 2,
    });
    const criticCalls = envelope.response_calls.filter((call) => call.kind === "critic");

    expect(criticCalls).toHaveLength(2);
    expect(criticCalls.map((call) => call.attempt)).toEqual([1, 2]);
    expect(criticCalls.map((call) => call.occurrence)).toEqual([0, 1]);
    expect(new Set(criticCalls.map((call) => call.key)).size).toBe(1);
    expect(criticCalls.map((call) => call.slot)).toEqual([0, 0]);
    expect(criticCalls.map((call) => call.ordinal)).toEqual([2, 3]);
  });
});
