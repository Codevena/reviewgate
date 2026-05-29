// src/providers/claude.ts
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Finding } from "../schemas/finding.ts";
import { safeJsonParse } from "../utils/safe-json.ts";
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
import { verdictFromFindings } from "./adapter-base.ts";
import { COMPLETE_TIMEOUT_MS, failureReason, readFileSafe } from "./complete-helpers.ts";
import { isQuotaExhausted } from "./quota-signals.ts";
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
    } finally {
      rmSync(tmp, { recursive: true, force: true });
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
    const { out, findings, usage, rawText } = this.parse(
      outFile,
      input.cfg.model,
      input.persona,
      input.workingDir,
    );
    if (!out) {
      // Exit 0 but the result envelope is not a parseable review (`claude -p
      // --output-format json` can truncate before emitting valid JSON). NOT a
      // clean review → ERROR (status !== "ok" → excluded from okRuns) rather than
      // a silent empty PASS, matching codex/opencode's fail-closed behavior. If the
      // output is actually a quota/usage-limit banner (printed on an exit-0 run),
      // classify it quota-exhausted so cooldown+failover fires (F-043).
      const quota = isQuotaExhausted(errText + readFileSafe(outFile));
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
      verdict: verdictFromFindings(findings),
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
        ...(opts.signal ? { signal: opts.signal } : {}),
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
      const envelope = safeJsonParse(fileText);
      if (envelope && typeof envelope === "object" && !Array.isArray(envelope)) {
        return (envelope as ClaudeEnvelope).result ?? "";
      }
      // Not a parseable JSON object → return the raw text as the completion.
      return fileText;
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
  ): {
    out: ReturnType<typeof parseReviewOutput>;
    findings: Finding[];
    usage: ReviewResult["usage"];
    rawText: string;
  } {
    let env: ClaudeEnvelope = {};
    let fileText = "";
    try {
      fileText = readFileSync(outFile, "utf8");
      // safeJsonParse never throws; "null"/"42"/"[..]" parse to non-objects, so
      // keep env={} unless it's a real object — `env.result` on a null/primitive
      // would otherwise throw an uncaught TypeError (fail-OPEN) instead of failing
      // closed to the !out ERROR path.
      const parsed = safeJsonParse(fileText);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        env = parsed as ClaudeEnvelope;
      }
    } catch {
      env = {};
    }
    const text = env.result ?? fileText;
    const out = parseReviewOutput(text);
    const findings = out
      ? mapReviewOutputToFindings(out, { provider: "claude-code", model, persona, workingDir })
      : [];
    return {
      out,
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
