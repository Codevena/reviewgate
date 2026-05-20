// src/providers/codex.ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeSignature } from "../diff/signature.ts";
import { FindingSchema } from "../schemas/finding.ts";
import { spawnSafely } from "../utils/spawn.ts";
import type {
  Preflight,
  ProviderAdapter,
  ProviderConfig,
  ReviewInput,
  ReviewResult,
  ReviewStatus,
} from "./adapter-base.ts";

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

    const args = [
      "exec",
      "--sandbox",
      "read-only",
      "--json",
      "--output-last-message",
      lastMsgFile,
      "--cd",
      input.workingDir,
      "--model",
      input.cfg.model,
    ];
    if (input.schemaPath) args.push("--output-schema", input.schemaPath);
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
    });

    const status: ReviewStatus = res.killedByTimeout
      ? "timeout"
      : res.killedByWatchdog
        ? "timeout"
        : res.exitCode === 0
          ? "ok"
          : "error";

    if (status !== "ok") {
      return {
        reviewerId: input.reviewerId,
        verdict: "ERROR",
        findings: [],
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, quotaUsedPct: null },
        durationMs: res.durationMs,
        exitCode: res.exitCode,
        rawEventsPath: eventsFile,
        status,
        statusDetail: readFileSync(stderrFile, "utf8").slice(0, 1000),
      };
    }

    const usage = this.extractUsage(eventsFile);
    const findings = this.extractFindings(
      lastMsgFile,
      input.reviewerId,
      input.cfg.model,
      input.persona,
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
      rawEventsPath: eventsFile,
      status: "ok",
    };
  }

  private extractUsage(eventsFile: string): ReviewResult["usage"] {
    let input_tokens = 0;
    let output_tokens = 0;
    let cached = 0;
    try {
      const raw = readFileSync(eventsFile, "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        const ev = JSON.parse(line) as {
          event?: string;
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cached_input_tokens?: number;
          };
        };
        if (ev.event === "turn.completed" && ev.usage) {
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

  private extractFindings(
    lastMsgFile: string,
    reviewerId: string,
    model: string,
    persona: string,
  ): ReviewResult["findings"] {
    let raw: string;
    try {
      raw = readFileSync(lastMsgFile, "utf8");
    } catch {
      return [];
    }
    let parsed: { findings?: unknown[] };
    try {
      parsed = JSON.parse(raw) as { findings?: unknown[] };
    } catch {
      // Codex returned non-JSON; M1 treats this as zero findings (M3+ may parse markdown).
      return [];
    }
    if (!Array.isArray(parsed.findings)) return [];
    const out: ReviewResult["findings"] = [];
    for (const f of parsed.findings) {
      try {
        const obj = f as Record<string, unknown>;
        obj.reviewer = obj.reviewer ?? { provider: "codex", model, persona };
        const fin = FindingSchema.parse(obj);
        // Override signature with our canonical computation to ignore whatever the model emitted.
        fin.signature = computeSignature({
          file: fin.file,
          ruleId: fin.rule_id,
          category: fin.category,
          lineStart: fin.line_start,
          lineEnd: fin.line_end,
        });
        // Force reviewer block to known truth.
        fin.reviewer = { provider: "codex", model, persona };
        out.push(fin);
      } catch {
        // Drop hallucinated/malformed findings; counted by caller as hallucination.
      }
    }
    // reviewerId param is used by caller — suppress unused warning.
    void reviewerId;
    return out;
  }
}
