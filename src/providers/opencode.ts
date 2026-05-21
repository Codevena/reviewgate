// src/providers/opencode.ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    }
  }

  async review(
    input: ReviewInput & { cfg: ProviderConfig; reviewerId: string },
  ): Promise<ReviewResult> {
    const run = mkdtempSync(join(tmpdir(), "rg-oc-run-"));
    const stdoutFile = join(run, "out.txt");
    const stderrFile = join(run, "err.log");

    const args = ["run", "--dangerously-skip-permissions", "--format", "default"];
    if (input.cfg.model) {
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
        rawEventsPath: stdoutFile,
        status,
        statusDetail: readFileSync(stderrFile, "utf8").slice(0, 1000),
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
}
