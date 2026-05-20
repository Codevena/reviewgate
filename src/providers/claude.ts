// src/providers/claude.ts
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

const DISALLOWED = "Bash,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch,TodoWrite,Task";

export interface ClaudeAdapterOptions {
  binPath?: string;
}

interface ClaudeEnvelope {
  result?: string;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
  total_cost_usd?: number;
}

export class ClaudeAdapter implements ProviderAdapter {
  readonly id = "claude-code" as const;
  private readonly binPath: string;
  constructor(opts: ClaudeAdapterOptions = {}) {
    this.binPath = opts.binPath ?? "claude";
  }

  async preflight(cfg: ProviderConfig): Promise<Preflight> {
    const tmp = mkdtempSync(join(tmpdir(), "rg-cl-pf-"));
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
          error: `claude --version exit=${res.exitCode}`,
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
    // Hook-free temp CWD: the reviewer's own Stop hook can never recurse into
    // Reviewgate. The diff is supplied via the prompt, so the reviewer does not
    // need the real repo tree.
    const run = mkdtempSync(join(tmpdir(), "rg-cl-run-"));
    const outFile = join(run, "out.json");
    const errFile = join(run, "err.log");

    const args = [
      "-p",
      readFileSync(input.promptFile, "utf8"),
      "--model",
      input.cfg.model,
      "--output-format",
      "json",
      "--disallowedTools",
      DISALLOWED,
      "--permission-mode",
      "dontAsk",
      "--no-session-persistence",
    ];
    const env = { ...process.env } as Record<string, string>;
    if (input.cfg.auth === "apikey" && input.cfg.apiKeyEnv) {
      const key = process.env[input.cfg.apiKeyEnv];
      if (key) env.ANTHROPIC_API_KEY = key;
    }
    const res = await spawnSafely({
      command: this.binPath,
      args,
      env,
      cwd: run,
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
    let env: ClaudeEnvelope = {};
    let rawText = "";
    try {
      rawText = readFileSync(outFile, "utf8");
      env = JSON.parse(rawText) as ClaudeEnvelope;
    } catch {
      env = {};
    }
    const text = env.result ?? rawText;
    const out = parseReviewOutput(text);
    const findings = out
      ? mapReviewOutputToFindings(out, { provider: "claude-code", model, persona, workingDir })
      : [];
    return {
      findings,
      usage: {
        inputTokens: env.usage?.input_tokens ?? 0,
        outputTokens: env.usage?.output_tokens ?? 0,
        costUsd: 0,
        quotaUsedPct: null,
      },
    };
  }
}
