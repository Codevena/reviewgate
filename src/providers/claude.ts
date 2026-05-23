// src/providers/claude.ts
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

const DISALLOWED = "Bash,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch,TodoWrite,Task";
const COMPLETE_TIMEOUT_MS = 20_000;

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
      // `claude -p --output-format json` buffers: it emits NOTHING to stdout
      // until the full result is ready, so the default 60s zero-byte idle
      // watchdog would SIGKILL any review that thinks longer than a minute (and
      // mislabel it "timeout"). Tie the idle watchdog to the wall-clock timeout
      // so only a genuine hang past timeoutMs ends the run. (codex streams its
      // --json events, so it keeps the shorter default watchdog.)
      zeroByteWatchdogMs: input.cfg.timeoutMs,
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
    const run = mkdtempSync(join(tmpdir(), "rg-cl-cmpl-"));
    try {
      const outFile = join(run, "out.json");
      const errFile = join(run, "err.log");
      const args = [
        "-p",
        prompt,
        "--model",
        opts.model,
        "--output-format",
        "json",
        "--disallowedTools",
        DISALLOWED,
        "--permission-mode",
        "dontAsk",
        "--no-session-persistence",
      ];
      const env = { ...process.env } as Record<string, string>;
      if (opts.auth === "apikey" && opts.apiKeyEnv) {
        const key = process.env[opts.apiKeyEnv];
        if (key) env.ANTHROPIC_API_KEY = key;
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
      });
      if (res.killedByTimeout || res.killedByWatchdog || res.exitCode !== 0) {
        let detail = "";
        try {
          detail = readFileSync(errFile, "utf8").slice(0, 500);
        } catch {
          detail = "";
        }
        throw new Error(`claude complete ${failureReason(res)}: ${detail}`);
      }
      let fileText = "";
      try {
        fileText = readFileSync(outFile, "utf8");
      } catch {
        return "";
      }
      try {
        const envelope = JSON.parse(fileText) as ClaudeEnvelope;
        return envelope.result ?? "";
      } catch {
        return fileText;
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
    let env: ClaudeEnvelope = {};
    let fileText = "";
    try {
      fileText = readFileSync(outFile, "utf8");
      env = JSON.parse(fileText) as ClaudeEnvelope;
    } catch {
      env = {};
    }
    const text = env.result ?? fileText;
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
      rawText: text,
    };
  }
}
