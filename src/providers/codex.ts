// src/providers/codex.ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { extractQuotaMessage, isQuotaExhausted } from "./quota-signals.ts";
import {
  REVIEW_OUTPUT_SCHEMA,
  mapReviewOutputToFindings,
  parseReviewOutput,
} from "./review-output.ts";

const COMPLETE_TIMEOUT_MS = 20_000;

export interface CodexAdapterOptions {
  binPath?: string;
}

export class CodexAdapter implements ProviderAdapter {
  readonly id = "codex" as const;
  private readonly binPath: string;

  constructor(opts: CodexAdapterOptions = {}) {
    this.binPath = opts.binPath ?? "codex";
  }

  async preflight(cfg: ProviderConfig): Promise<Preflight> {
    const tmp = mkdtempSync(join(tmpdir(), "rg-codex-pf-"));
    const stdoutFile = join(tmp, "out.log");
    const stderrFile = join(tmp, "err.log");
    try {
      const res = await spawnSafely({
        command: this.binPath,
        args: ["--version"],
        stdoutFile,
        stderrFile,
        timeoutMs: 5_000,
      });
      if (res.exitCode !== 0) {
        return {
          available: false,
          version: null,
          authMode: cfg.auth,
          error: `codex --version exit=${res.exitCode}`,
        };
      }
      const version = readFileSync(stdoutFile, "utf8").trim();
      return { available: true, version, authMode: cfg.auth, error: null };
    } catch (err) {
      return { available: false, version: null, authMode: cfg.auth, error: (err as Error).message };
    }
  }

  async review(
    input: ReviewInput & { cfg: ProviderConfig; reviewerId: string },
  ): Promise<ReviewResult> {
    const run = mkdtempSync(join(tmpdir(), "rg-codex-run-"));
    const lastMsgFile = join(run, "last.md");
    const eventsFile = join(run, "events.jsonl");
    const stderrFile = join(run, "stderr.log");

    // Always constrain codex to our review schema so the response shape is
    // predictable. Caller may override with their own schema file.
    let schemaPath = input.schemaPath;
    if (!schemaPath) {
      schemaPath = join(run, "schema.json");
      writeFileSync(schemaPath, JSON.stringify(REVIEW_OUTPUT_SCHEMA));
    }

    const args = [
      "exec",
      "--sandbox",
      "read-only",
      "--json",
      "--output-last-message",
      lastMsgFile,
      "--output-schema",
      schemaPath,
      "--cd",
      input.workingDir,
      "--model",
      input.cfg.model,
    ];
    args.push(readFileSync(input.promptFile, "utf8"));

    const env = { ...process.env } as Record<string, string>;
    if (input.cfg.auth === "apikey" && input.cfg.apiKeyEnv) {
      const key = process.env[input.cfg.apiKeyEnv];
      if (key) env.OPENAI_API_KEY = key;
    }
    // OAuth mode relies on codex's own credential store; no env change.

    const res = await spawnSafely({
      command: this.binPath,
      args,
      env,
      cwd: input.workingDir,
      stdoutFile: eventsFile,
      stderrFile,
      timeoutMs: input.cfg.timeoutMs,
      ...(input.signal ? { signal: input.signal } : {}),
    });

    const stderrText = readFileSafe(stderrFile);
    // codex's usage-limit banner ("You've hit your usage limit … try again at
    // <date>") lands on STDOUT (the --json event stream), while stderr may only
    // show the generic stdin notice — so scan BOTH before classifying, and when
    // it IS a quota hit surface the events' banner (with the reset time) as
    // statusDetail so the cooldown can parse when codex's limit resets.
    const quotaText = `${stderrText}\n${readFileSafe(eventsFile)}`;
    const baseStatus: ReviewStatus =
      res.killedByTimeout || res.killedByWatchdog ? "timeout" : res.exitCode === 0 ? "ok" : "error";
    const status: ReviewStatus =
      baseStatus === "error" && isQuotaExhausted(quotaText) ? "quota-exhausted" : baseStatus;

    if (status !== "ok") {
      const detail =
        status === "quota-exhausted" ? (extractQuotaMessage(quotaText) ?? stderrText) : stderrText;
      return {
        reviewerId: input.reviewerId,
        verdict: "ERROR",
        findings: [],
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, quotaUsedPct: null },
        durationMs: res.durationMs,
        exitCode: res.exitCode,
        rawEventsPath: eventsFile,
        status,
        statusDetail: detail.slice(0, 1000),
      };
    }

    const usage = this.extractUsage(eventsFile);
    const findings = this.extractFindings(
      lastMsgFile,
      input.cfg.model,
      input.persona,
      input.workingDir,
    );
    let rawText = "";
    try {
      rawText = readFileSync(lastMsgFile, "utf8");
    } catch {
      rawText = "";
    }
    return {
      reviewerId: input.reviewerId,
      verdict: findings.some((f) => f.severity === "CRITICAL" || f.severity === "WARN")
        ? "FAIL"
        : "PASS",
      findings,
      usage,
      durationMs: res.durationMs,
      exitCode: 0,
      rawEventsPath: eventsFile,
      rawText,
      status: "ok",
    };
  }

  async complete(prompt: string, opts: CompleteOptions): Promise<string> {
    const run = mkdtempSync(join(tmpdir(), "rg-codex-cmpl-"));
    try {
      const lastMsgFile = join(run, "last.md");
      const eventsFile = join(run, "events.jsonl");
      const stderrFile = join(run, "stderr.log");
      // NOTE: NO --output-schema — a judge needs a free-form completion.
      // --skip-git-repo-check: the judge runs in a fresh non-git temp dir, and
      // codex `exec` otherwise refuses ("Not inside a trusted directory").
      const args = [
        "exec",
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "--json",
        "--output-last-message",
        lastMsgFile,
        "--cd",
        run,
        "--model",
        opts.model,
        prompt,
      ];
      const env = { ...process.env } as Record<string, string>;
      if (opts.auth === "apikey" && opts.apiKeyEnv) {
        const key = process.env[opts.apiKeyEnv];
        if (key) env.OPENAI_API_KEY = key;
      }
      const res = await spawnSafely({
        command: this.binPath,
        args,
        env,
        cwd: run,
        stdoutFile: eventsFile,
        stderrFile,
        timeoutMs: opts.timeoutMs ?? COMPLETE_TIMEOUT_MS,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      if (res.killedByTimeout || res.killedByWatchdog || res.exitCode !== 0) {
        let detail = "";
        try {
          detail = readFileSync(stderrFile, "utf8").slice(0, 500);
        } catch {
          detail = "";
        }
        throw new Error(`codex complete ${failureReason(res)}: ${detail}`);
      }
      try {
        return readFileSync(lastMsgFile, "utf8");
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

  private extractUsage(eventsFile: string): ReviewResult["usage"] {
    let input_tokens = 0;
    let output_tokens = 0;
    let cached = 0;
    try {
      const raw = readFileSync(eventsFile, "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        // Real codex streams events keyed by "type" (e.g. "turn.completed").
        // The older "event" key is kept as a fallback for compatibility.
        const ev = JSON.parse(line) as {
          type?: string;
          event?: string;
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cached_input_tokens?: number;
          };
        };
        const kind = ev.type ?? ev.event;
        if (kind === "turn.completed" && ev.usage) {
          input_tokens += ev.usage.input_tokens ?? 0;
          output_tokens += ev.usage.output_tokens ?? 0;
          cached += ev.usage.cached_input_tokens ?? 0;
        }
      }
    } catch {
      // tolerate missing/partial events file
    }
    return {
      inputTokens: input_tokens,
      outputTokens: output_tokens,
      cachedInputTokens: cached,
      costUsd: 0, // OAuth mode; apikey mode would compute from price table (M2)
      quotaUsedPct: null,
    };
  }

  // Maps codex's review-schema output into the richer Reviewgate Finding via
  // the shared review-output module. Malformed entries are dropped.
  private extractFindings(
    lastMsgFile: string,
    model: string,
    persona: string,
    workingDir: string,
  ): Finding[] {
    let raw: string;
    try {
      raw = readFileSync(lastMsgFile, "utf8");
    } catch {
      return [];
    }
    const out = parseReviewOutput(raw);
    if (!out) return [];
    return mapReviewOutputToFindings(out, { provider: "codex", model, persona, workingDir });
  }
}
