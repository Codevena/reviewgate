// src/providers/gemini.ts
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Finding } from "../schemas/finding.ts";
import { spawnSafely } from "../utils/spawn.ts";
import type {
  CompleteOptions,
  Preflight,
  ProviderAdapter,
  ProviderConfig,
  ReviewInput,
  ReviewResult,
  ReviewStatus,
} from "./adapter-base.ts";
import { failureReason, readFileSafe } from "./complete-helpers.ts";
import { isQuotaExhausted } from "./quota-signals.ts";
import { mapReviewOutputToFindings, parseReviewOutput } from "./review-output.ts";

const COMPLETE_TIMEOUT_MS = 20_000;

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
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  async review(
    input: ReviewInput & { cfg: ProviderConfig; reviewerId: string },
  ): Promise<ReviewResult> {
    const run = mkdtempSync(join(tmpdir(), "rg-gem-run-"));
    const outFile = join(run, "out.json");
    const errFile = join(run, "err.log");
    // No --include-directories: the diff is supplied in the prompt, so the
    // reviewer needs no repo tree. Including the workspace makes Gemini enter a
    // file-scanning/agentic loop that can run for minutes.
    const args = [
      "-p",
      readFileSync(input.promptFile, "utf8"),
      "-m",
      input.cfg.model,
      "-o",
      "json",
      "--approval-mode",
      "plan",
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
      // `gemini -o json` buffers the whole response (no streamed stdout), so the
      // default 60s zero-byte idle watchdog would SIGKILL any review that thinks
      // longer than a minute — fatal for the slower gemini-3-pro-preview tier.
      // Tie the idle watchdog to the wall-clock timeout. (See claude.ts/codex.ts.)
      zeroByteWatchdogMs: input.cfg.timeoutMs,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const errText = readFileSafe(errFile);
    const baseStatus: ReviewStatus =
      res.killedByTimeout || res.killedByWatchdog ? "timeout" : res.exitCode === 0 ? "ok" : "error";
    const status: ReviewStatus =
      baseStatus === "error" && isQuotaExhausted(errText + readFileSafe(outFile))
        ? "quota-exhausted"
        : baseStatus;
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
        statusDetail: errText.slice(0, 1000),
      };
    }
    const { findings, usage, rawText } = this.parse(
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
      rawText,
      status: "ok",
    };
  }

  async complete(prompt: string, opts: CompleteOptions): Promise<string> {
    const run = mkdtempSync(join(tmpdir(), "rg-gem-cmpl-"));
    try {
      const outFile = join(run, "out.json");
      const errFile = join(run, "err.log");
      const args = ["-p", prompt, "-m", opts.model, "-o", "json", "--approval-mode", "plan"];
      const env = { ...process.env, GEMINI_CLI_TRUST_WORKSPACE: "true" } as Record<string, string>;
      if (opts.auth === "apikey" && opts.apiKeyEnv) {
        const key = process.env[opts.apiKeyEnv];
        if (key) env.GEMINI_API_KEY = key;
      }
      const res = await spawnSafely({
        command: this.binPath,
        args,
        env,
        cwd: run,
        stdoutFile: outFile,
        stderrFile: errFile,
        timeoutMs: opts.timeoutMs ?? COMPLETE_TIMEOUT_MS,
        // Buffered like review() — neutralise the idle watchdog (see review()).
        zeroByteWatchdogMs: opts.timeoutMs ?? COMPLETE_TIMEOUT_MS,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      if (res.killedByTimeout || res.killedByWatchdog || res.exitCode !== 0) {
        let detail = "";
        try {
          detail = readFileSync(errFile, "utf8").slice(0, 500);
        } catch {
          detail = "";
        }
        throw new Error(`gemini complete ${failureReason(res)}: ${detail}`);
      }
      try {
        const envelope = JSON.parse(readFileSync(outFile, "utf8")) as GeminiEnvelope;
        return envelope.response ?? "";
      } catch {
        return "";
      }
    } finally {
      try {
        rmSync(run, { recursive: true, force: true });
      } catch {
        // best-effort temp cleanup
      }
    }
  }

  private parse(
    outFile: string,
    model: string,
    persona: string,
    workingDir: string,
  ): { findings: Finding[]; usage: ReviewResult["usage"]; rawText: string } {
    let env: GeminiEnvelope = {};
    try {
      env = JSON.parse(readFileSync(outFile, "utf8")) as GeminiEnvelope;
    } catch {
      return {
        findings: [],
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, quotaUsedPct: null },
        rawText: "",
      };
    }
    const rawText = env.response ?? "";
    const out = rawText ? parseReviewOutput(rawText) : null;
    const findings = out
      ? mapReviewOutputToFindings(out, { provider: "gemini", model, persona, workingDir })
      : [];
    let inputTokens = 0;
    let outputTokens = 0;
    for (const m of Object.values(env.stats?.models ?? {})) {
      inputTokens += m.tokens?.prompt ?? 0;
      outputTokens += m.tokens?.candidates ?? 0;
    }
    return {
      findings,
      usage: { inputTokens, outputTokens, costUsd: 0, quotaUsedPct: null },
      rawText,
    };
  }
}
