// src/providers/gemini.ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Finding } from "../schemas/finding.ts";
import { spawnSafely } from "../utils/spawn.ts";
import type {
  Preflight,
  ProviderAdapter,
  ProviderConfig,
  ReviewInput,
  ReviewResult,
  ReviewStatus,
} from "./adapter-base.ts";
import { mapReviewOutputToFindings, parseReviewOutput } from "./review-output.ts";

export interface GeminiAdapterOptions {
  binPath?: string;
}

interface GeminiEnvelope {
  response?: string;
  stats?: {
    models?: Record<string, { tokens?: { prompt?: number; candidates?: number; cached?: number } }>;
  };
}

export class GeminiAdapter implements ProviderAdapter {
  readonly id = "gemini" as const;
  private readonly binPath: string;
  constructor(opts: GeminiAdapterOptions = {}) {
    this.binPath = opts.binPath ?? "gemini";
  }

  async preflight(cfg: ProviderConfig): Promise<Preflight> {
    const tmp = mkdtempSync(join(tmpdir(), "rg-gem-pf-"));
    try {
      const res = await spawnSafely({
        command: this.binPath,
        args: ["--version"],
        stdoutFile: join(tmp, "o"),
        stderrFile: join(tmp, "e"),
        timeoutMs: 5_000,
      });
      if (res.exitCode !== 0)
        return {
          available: false,
          version: null,
          authMode: cfg.auth,
          error: `gemini --version exit=${res.exitCode}`,
        };
      return {
        available: true,
        version: readFileSync(join(tmp, "o"), "utf8").trim(),
        authMode: cfg.auth,
        error: null,
      };
    } catch (err) {
      return { available: false, version: null, authMode: cfg.auth, error: (err as Error).message };
    }
  }

  async review(
    input: ReviewInput & { cfg: ProviderConfig; reviewerId: string },
  ): Promise<ReviewResult> {
    const run = mkdtempSync(join(tmpdir(), "rg-gem-run-"));
    const outFile = join(run, "out.json");
    const errFile = join(run, "err.log");
    const args = [
      "-p",
      readFileSync(input.promptFile, "utf8"),
      "-m",
      input.cfg.model,
      "-o",
      "json",
      "--approval-mode",
      "plan",
      "--include-directories",
      input.workingDir,
    ];
    const env = { ...process.env, GEMINI_CLI_TRUST_WORKSPACE: "true" } as Record<string, string>;
    if (input.cfg.auth === "apikey" && input.cfg.apiKeyEnv) {
      const key = process.env[input.cfg.apiKeyEnv];
      if (key) env.GEMINI_API_KEY = key;
    }
    const res = await spawnSafely({
      command: this.binPath,
      args,
      env,
      cwd: input.workingDir,
      stdoutFile: outFile,
      stderrFile: errFile,
      timeoutMs: input.cfg.timeoutMs,
    });
    const status: ReviewStatus =
      res.killedByTimeout || res.killedByWatchdog ? "timeout" : res.exitCode === 0 ? "ok" : "error";
    if (status !== "ok") {
      return {
        reviewerId: input.reviewerId,
        verdict: "ERROR",
        findings: [],
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, quotaUsedPct: null },
        durationMs: res.durationMs,
        exitCode: res.exitCode,
        rawEventsPath: outFile,
        status,
        statusDetail: readFileSync(errFile, "utf8").slice(0, 1000),
      };
    }
    const { findings, usage } = this.parse(
      outFile,
      input.cfg.model,
      input.persona,
      input.workingDir,
    );
    return {
      reviewerId: input.reviewerId,
      verdict: findings.some((f) => f.severity === "CRITICAL" || f.severity === "WARN")
        ? "FAIL"
        : "PASS",
      findings,
      usage,
      durationMs: res.durationMs,
      exitCode: 0,
      rawEventsPath: outFile,
      status: "ok",
    };
  }

  private parse(
    outFile: string,
    model: string,
    persona: string,
    workingDir: string,
  ): { findings: Finding[]; usage: ReviewResult["usage"] } {
    let env: GeminiEnvelope = {};
    try {
      env = JSON.parse(readFileSync(outFile, "utf8")) as GeminiEnvelope;
    } catch {
      return {
        findings: [],
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, quotaUsedPct: null },
      };
    }
    const out = env.response ? parseReviewOutput(env.response) : null;
    const findings = out
      ? mapReviewOutputToFindings(out, { provider: "gemini", model, persona, workingDir })
      : [];
    let inputTokens = 0;
    let outputTokens = 0;
    for (const m of Object.values(env.stats?.models ?? {})) {
      inputTokens += m.tokens?.prompt ?? 0;
      outputTokens += m.tokens?.candidates ?? 0;
    }
    return { findings, usage: { inputTokens, outputTokens, costUsd: 0, quotaUsedPct: null } };
  }
}
