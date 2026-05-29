// src/providers/gemini.ts
// Drives the Antigravity CLI (`agy`), the successor to the discontinued Gemini
// CLI (gemini CLI sunsets 2026-06-18 for OAuth/Pro/Ultra/free tiers). The
// provider id stays "gemini" for config compatibility. agy `-p` prints the model
// response verbatim on stdout — there is no -m, no -o json envelope, and no
// API-key auth (OAuth via the Antigravity session only).
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

export class GeminiAdapter implements ProviderAdapter {
  readonly id = "gemini" as const;
  private readonly binPath: string;
  constructor(opts: GeminiAdapterOptions = {}) {
    this.binPath = opts.binPath ?? "agy";
  }

  async preflight(cfg: ProviderConfig): Promise<Preflight> {
    const tmp = mkdtempSync(join(tmpdir(), "rg-agy-pf-"));
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
          error: `agy --version exit=${res.exitCode}`,
        };
      return {
        available: true,
        version: readFileSafe(join(tmp, "o")).trim(),
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
    const run = mkdtempSync(join(tmpdir(), "rg-agy-run-"));
    try {
      const outFile = join(run, "out.txt");
      const errFile = join(run, "err.log");
      // No --add-dir: the diff is supplied inline in the prompt, so the reviewer
      // needs no workspace access (no agentic file exploration, no edit risk).
      // --dangerously-skip-permissions prevents a hang on the permission prompt.
      const args = [
        "-p",
        readFileSync(input.promptFile, "utf8"),
        "--dangerously-skip-permissions",
        "--print-timeout",
        `${input.cfg.timeoutMs}ms`,
      ];
      const res = await spawnSafely({
        command: this.binPath,
        args,
        env: { ...process.env } as Record<string, string>,
        cwd: input.workingDir,
        stdoutFile: outFile,
        stderrFile: errFile,
        timeoutMs: input.cfg.timeoutMs,
        // agy print mode buffers (no streamed stdout), so the default 60s zero-byte
        // idle watchdog would SIGKILL a longer review. Tie it to the wall timeout.
        zeroByteWatchdogMs: input.cfg.timeoutMs,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const errText = readFileSafe(errFile);
      const outText = readFileSafe(outFile);
      const baseStatus: ReviewStatus =
        res.killedByTimeout || res.killedByWatchdog
          ? "timeout"
          : res.exitCode === 0
            ? "ok"
            : "error";
      const status: ReviewStatus =
        baseStatus === "error" && isQuotaExhausted(errText + outText)
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
          // run is cleaned up in finally; the orchestrator stores this path as a
          // string and never reads the file back (it uses the in-memory rawText).
          rawEventsPath: outFile,
          status,
          statusDetail: errText.slice(0, 1000),
        };
      }
      const { out, findings, rawText } = this.parse(
        outText,
        input.cfg.model,
        input.persona,
        input.workingDir,
      );
      if (!out) {
        // Exit 0 but stdout is not a parseable review (agy `-p` print mode can
        // truncate before emitting valid JSON). NOT a clean review → ERROR
        // (status !== "ok" → excluded from okRuns) rather than a silent empty PASS,
        // matching codex/opencode's fail-closed behavior. If the unparseable output
        // is actually a quota/usage-limit banner (agy can print one and still exit
        // 0), classify it as quota-exhausted so the orchestrator's cooldown+failover
        // fires instead of treating the capped provider as a generic error (F-043).
        const quota = isQuotaExhausted(outText + errText);
        return {
          reviewerId: input.reviewerId,
          verdict: "ERROR",
          findings: [],
          usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, quotaUsedPct: null },
          durationMs: res.durationMs,
          exitCode: res.exitCode,
          rawEventsPath: outFile,
          status: quota ? "quota-exhausted" : "error",
          statusDetail: quota
            ? "reviewer exited 0 but printed a quota/usage-limit banner"
            : "reviewer exited 0 but produced no valid review JSON (unparseable output)",
        };
      }
      return {
        reviewerId: input.reviewerId,
        verdict: findings.some((f) => f.severity === "CRITICAL" || f.severity === "WARN")
          ? "FAIL"
          : "PASS",
        findings,
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, quotaUsedPct: null },
        durationMs: res.durationMs,
        exitCode: 0,
        rawEventsPath: outFile,
        rawText,
        status: "ok",
      };
    } finally {
      try {
        rmSync(run, { recursive: true, force: true });
      } catch {
        // best-effort temp cleanup
      }
    }
  }

  async complete(prompt: string, opts: CompleteOptions): Promise<string> {
    const run = mkdtempSync(join(tmpdir(), "rg-agy-cmpl-"));
    try {
      const outFile = join(run, "out.txt");
      const errFile = join(run, "err.log");
      const timeoutMs = opts.timeoutMs ?? COMPLETE_TIMEOUT_MS;
      const args = [
        "-p",
        prompt,
        "--dangerously-skip-permissions",
        "--print-timeout",
        `${timeoutMs}ms`,
      ];
      const res = await spawnSafely({
        command: this.binPath,
        args,
        env: { ...process.env } as Record<string, string>,
        cwd: run,
        stdoutFile: outFile,
        stderrFile: errFile,
        timeoutMs,
        zeroByteWatchdogMs: timeoutMs,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      if (res.killedByTimeout || res.killedByWatchdog || res.exitCode !== 0) {
        throw new Error(
          `agy complete ${failureReason(res)}: ${readFileSafe(errFile).slice(0, 500)}`,
        );
      }
      // agy `-p` prints the response verbatim — stdout IS the completion.
      return readFileSafe(outFile);
    } finally {
      try {
        rmSync(run, { recursive: true, force: true });
      } catch {
        // best-effort temp cleanup
      }
    }
  }

  private parse(
    rawText: string,
    model: string,
    persona: string,
    workingDir: string,
  ): { out: ReturnType<typeof parseReviewOutput>; findings: Finding[]; rawText: string } {
    const out = rawText ? parseReviewOutput(rawText) : null;
    const findings = out
      ? mapReviewOutputToFindings(out, { provider: "gemini", model, persona, workingDir })
      : [];
    return { out, findings, rawText };
  }
}
