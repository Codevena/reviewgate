// src/providers/opencode.ts
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

export interface OpenCodeAdapterOptions {
  binPath?: string;
}

export class OpenCodeAdapter implements ProviderAdapter {
  readonly id = "opencode" as const;
  private readonly binPath: string;

  constructor(opts: OpenCodeAdapterOptions = {}) {
    this.binPath = opts.binPath ?? "opencode";
  }

  async preflight(cfg: ProviderConfig): Promise<Preflight> {
    const tmp = mkdtempSync(join(tmpdir(), "rg-oc-pf-"));
    try {
      const res = await spawnSafely({
        command: this.binPath,
        args: ["--version"],
        stdoutFile: join(tmp, "o"),
        stderrFile: join(tmp, "e"),
        timeoutMs: 5_000,
      });
      if (res.exitCode !== 0) {
        return {
          available: false,
          version: null,
          authMode: cfg.auth,
          error: `opencode --version exit=${res.exitCode}`,
        };
      }
      return {
        available: true,
        version: readFileSync(join(tmp, "o"), "utf8").trim(),
        authMode: cfg.auth,
        error: null,
      };
    } catch (err) {
      return {
        available: false,
        version: null,
        authMode: cfg.auth,
        error: (err as Error).message,
      };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  async review(
    input: ReviewInput & { cfg: ProviderConfig; reviewerId: string },
  ): Promise<ReviewResult> {
    const run = mkdtempSync(join(tmpdir(), "rg-oc-run-"));
    const stdoutFile = join(run, "out.txt");
    const stderrFile = join(run, "err.log");

    const args = ["run", "--dangerously-skip-permissions", "--format", "default"];
    // Only force a model with -m for a REAL provider/model id. The sentinel
    // "default" (or empty) means "use opencode's own configured default model"
    // — which is how opencode is meant to be driven here (e.g. a MiniMax Token
    // Plan default). Forcing -m opencode/minimax-m2.7 would instead hit the
    // hosted, payment-gated model. (See CLAUDE.md: "do not pass -m".)
    if (input.cfg.model && input.cfg.model !== "default") {
      args.push("-m", input.cfg.model);
    }
    // The prompt text is the trailing positional message argument.
    const promptText = readFileSync(input.promptFile, "utf8");
    args.push(promptText);

    const res = await spawnSafely({
      command: this.binPath,
      args,
      env: { ...process.env } as Record<string, string>,
      cwd: input.workingDir,
      stdoutFile,
      stderrFile,
      timeoutMs: input.cfg.timeoutMs,
      // opencode is the heavy fallback for long codex reviews; don't let the 60s
      // idle watchdog cut it short — bound it by the wall-clock timeout instead.
      zeroByteWatchdogMs: input.cfg.timeoutMs,
      ...(input.signal ? { signal: input.signal } : {}),
    });

    const errText = readFileSafe(stderrFile);
    const baseStatus: ReviewStatus =
      res.killedByTimeout || res.killedByWatchdog ? "timeout" : res.exitCode === 0 ? "ok" : "error";
    const status: ReviewStatus =
      baseStatus === "error" && isQuotaExhausted(errText + readFileSafe(stdoutFile))
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
        rawEventsPath: stdoutFile,
        status,
        statusDetail: errText.slice(0, 1000),
      };
    }

    const stdout = readFileSync(stdoutFile, "utf8");
    const out = parseReviewOutput(stdout);
    const findings = out
      ? mapReviewOutputToFindings(out, {
          provider: "opencode",
          model: input.cfg.model,
          persona: input.persona,
          workingDir: input.workingDir,
        })
      : [];

    return {
      reviewerId: input.reviewerId,
      verdict: findings.some((f) => f.severity === "CRITICAL" || f.severity === "WARN")
        ? "FAIL"
        : "PASS",
      findings,
      // opencode provides no token stats — use zero cost like gemini
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, quotaUsedPct: null },
      durationMs: res.durationMs,
      exitCode: 0,
      rawEventsPath: stdoutFile,
      rawText: stdout,
      status: "ok",
    };
  }

  async complete(prompt: string, opts: CompleteOptions): Promise<string> {
    // No apikey remap (unlike claude/gemini/codex): opencode authenticates via
    // its own configured credential store, exactly as review() does — so
    // opts.auth/opts.apiKeyEnv are intentionally unused here.
    const run = mkdtempSync(join(tmpdir(), "rg-oc-cmpl-"));
    try {
      const stdoutFile = join(run, "out.txt");
      const stderrFile = join(run, "err.log");
      const args = ["run", "--dangerously-skip-permissions", "--format", "default"];
      if (opts.model && opts.model !== "default") args.push("-m", opts.model);
      args.push(prompt);
      const res = await spawnSafely({
        command: this.binPath,
        args,
        env: { ...process.env } as Record<string, string>,
        cwd: run,
        stdoutFile,
        stderrFile,
        timeoutMs: opts.timeoutMs ?? COMPLETE_TIMEOUT_MS,
        // Bound the idle watchdog by the wall-clock timeout (see review()).
        zeroByteWatchdogMs: opts.timeoutMs ?? COMPLETE_TIMEOUT_MS,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      if (res.killedByTimeout || res.killedByWatchdog || res.exitCode !== 0) {
        let detail = "";
        try {
          detail = readFileSync(stderrFile, "utf8").slice(0, 500);
        } catch {
          detail = "";
        }
        throw new Error(`opencode complete ${failureReason(res)}: ${detail}`);
      }
      try {
        return readFileSync(stdoutFile, "utf8");
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
}
