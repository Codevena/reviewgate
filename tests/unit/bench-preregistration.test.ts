import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildBenchConfig } from "../../src/bench/runner.ts";
import {
  type BenchMatrixInput,
  validateMatrixPreregistration,
} from "../../src/cli/commands/bench.ts";
import type { ProviderAdapter } from "../../src/providers/adapter-base.ts";
import { BenchPreregistrationSchema } from "../../src/schemas/bench-preregistration.ts";

const REPO = join(import.meta.dir, "../..");
const PREREGISTRATION_PATH = "bench/preregistrations/alpha12-v2.json";
const ATTEMPT_02_PREREGISTRATION_PATH = "bench/preregistrations/alpha12-v2-attempt-02.json";
const ATTEMPT_03_PREREGISTRATION_PATH = "bench/preregistrations/alpha12-v2-attempt-03.json";
const ATTEMPT_04_PREREGISTRATION_PATH = "bench/preregistrations/alpha12-v2-attempt-04.json";

function matrixInput(): BenchMatrixInput {
  return {
    repoRoot: REPO,
    corpus: "bench/cases",
    out: "bench/results/alpha12-v2/attempt-01/matrix.json",
    providers: ["codex", "claude-code"],
    ablate: ["critic"],
    criticProvider: "openrouter",
    criticModel: "deepseek/deepseek-v4-flash",
    criticOpenrouterProvider: { only: ["alibaba"], allowFallbacks: false },
    repeat: 3,
    minClean: 16,
    minSeeded: 14,
    maxFailedFrac: 0,
    maxProviderCalls: 270,
    maxOutputTokens: 2048,
    authoritative: true,
    preregistration: PREREGISTRATION_PATH,
  };
}

function benchConfig(input: BenchMatrixInput) {
  return buildBenchConfig({
    ...(input.providers ? { providers: input.providers } : {}),
    suppressors: input.criticProvider ? { critic: input.criticProvider } : {},
    ...(input.criticModel ? { criticModel: input.criticModel } : {}),
    ...(input.criticOpenrouterProvider
      ? { criticOpenrouterProvider: input.criticOpenrouterProvider }
      : {}),
    ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
  });
}

function preregistration(): unknown {
  return JSON.parse(readFileSync(join(REPO, PREREGISTRATION_PATH), "utf8"));
}

function attempt02Input(): BenchMatrixInput {
  return {
    ...matrixInput(),
    out: "bench/results/alpha12-v2/attempt-02/matrix.json",
    criticMaxAttempts: 2,
    maxProviderCalls: 360,
    preregistration: ATTEMPT_02_PREREGISTRATION_PATH,
  };
}

function attempt02Preregistration(): unknown {
  return JSON.parse(readFileSync(join(REPO, ATTEMPT_02_PREREGISTRATION_PATH), "utf8"));
}

function attempt03Input(): BenchMatrixInput {
  return {
    ...attempt02Input(),
    out: "bench/results/alpha12-v2/attempt-03/matrix.json",
    preregistration: ATTEMPT_03_PREREGISTRATION_PATH,
  };
}

function attempt03Preregistration(): unknown {
  return JSON.parse(readFileSync(join(REPO, ATTEMPT_03_PREREGISTRATION_PATH), "utf8"));
}

function attempt04Input(): BenchMatrixInput {
  return {
    ...attempt03Input(),
    out: "bench/results/alpha12-v2/attempt-04/matrix.json",
    preregistration: ATTEMPT_04_PREREGISTRATION_PATH,
  };
}

function attempt04Preregistration(): unknown {
  return JSON.parse(readFileSync(join(REPO, ATTEMPT_04_PREREGISTRATION_PATH), "utf8"));
}

describe("Alpha.12 benchmark preregistration", () => {
  it("parses and exactly matches the frozen authoritative matrix protocol", () => {
    const input = matrixInput();
    const frozen = BenchPreregistrationSchema.parse(preregistration());

    expect(validateMatrixPreregistration(input, benchConfig(input), frozen, input.corpus)).toEqual(
      [],
    );
  });

  it("matches Attempt 02's explicit critic-attempt limit without changing Attempt 01", () => {
    const input = attempt02Input();
    const frozen = BenchPreregistrationSchema.parse(attempt02Preregistration());

    expect(validateMatrixPreregistration(input, benchConfig(input), frozen, input.corpus)).toEqual(
      [],
    );
    expect(
      validateMatrixPreregistration(
        matrixInput(),
        benchConfig(matrixInput()),
        preregistration(),
        "bench/cases",
      ),
    ).toEqual([]);
  });

  it("matches Attempt 03's unchanged protocol after the prompt-determinism fix", () => {
    const input = attempt03Input();
    const frozen = BenchPreregistrationSchema.parse(attempt03Preregistration());

    expect(validateMatrixPreregistration(input, benchConfig(input), frozen, input.corpus)).toEqual(
      [],
    );
  });

  it("matches Attempt 04's unchanged protocol after the compact critic-output fix", () => {
    const input = attempt04Input();
    const frozen = BenchPreregistrationSchema.parse(attempt04Preregistration());

    expect(validateMatrixPreregistration(input, benchConfig(input), frozen, input.corpus)).toEqual(
      [],
    );
  });

  it("rejects critic-attempt drift before the provider boundary", () => {
    const input = attempt02Input();
    const frozen = BenchPreregistrationSchema.parse(attempt02Preregistration());
    const reasons = validateMatrixPreregistration(
      { ...input, criticMaxAttempts: 3 },
      benchConfig(input),
      frozen,
      input.corpus,
    );

    expect(reasons).toContain("command differs from preregistration");
    expect(reasons).toContain("critic-attempt limit differs");
  });

  it("rejects result-affecting command, corpus, roster, and budget drift", () => {
    const input = matrixInput();
    const frozen = BenchPreregistrationSchema.parse(preregistration());
    const changed = structuredClone(frozen);
    changed.command[changed.command.indexOf("270")] = "999";
    changed.corpus.content_sha256["clean-sum-ts"] = "0".repeat(64);
    const firstReviewer = changed.roster.reviewers[0];
    if (!firstReviewer) throw new Error("frozen roster has no first reviewer");
    firstReviewer.model = "different-model";
    changed.hard_gates.maximum_provider_calls = 271;

    const reasons = validateMatrixPreregistration(
      { ...input, maxProviderCalls: 271 },
      benchConfig(input),
      changed,
      input.corpus,
    );

    expect(reasons).toContain("corpus content hashes differ");
    expect(reasons).toContain("reviewer roster/model/persona differs");
    expect(reasons).toContain("command differs from preregistration");
  });

  it("blocks an authoritative protocol mismatch before any provider call", async () => {
    let calls = 0;
    const adapter = (id: "codex" | "claude-code" | "openrouter"): ProviderAdapter => ({
      id,
      async preflight() {
        return { available: true, version: "stub", authMode: "oauth", error: null };
      },
      async review(input) {
        calls++;
        return {
          reviewerId: input.reviewerId,
          verdict: "PASS",
          findings: [],
          usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, quotaUsedPct: null },
          durationMs: 0,
          exitCode: 0,
          rawEventsPath: "",
          status: "ok",
        };
      },
      async complete() {
        calls++;
        return '{"verdicts":[]}';
      },
    });
    const input = {
      ...matrixInput(),
      out: "bench/results/alpha12-v2/test-mismatch/matrix.json",
      maxProviderCalls: 271,
    };

    const result = await import("../../src/cli/commands/bench.ts").then(({ runBenchMatrix }) =>
      runBenchMatrix({
        ...input,
        adapters: {
          codex: adapter("codex"),
          "claude-code": adapter("claude-code"),
          openrouter: adapter("openrouter"),
        },
      }),
    );

    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("benchmark-invalid before provider calls");
    expect(result.stderr).toContain("preregistration mismatch");
    expect(calls).toBe(0);
  });
});
