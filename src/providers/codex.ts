// src/providers/codex.ts
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { computeSignature } from "../diff/signature.ts";
import { type Finding, type FindingCategory, FindingSchema } from "../schemas/finding.ts";
import { spawnSafely } from "../utils/spawn.ts";
import type {
  Preflight,
  ProviderAdapter,
  ProviderConfig,
  ReviewInput,
  ReviewResult,
  ReviewStatus,
} from "./adapter-base.ts";

// The JSON Schema codex must emit via --output-schema. OpenAI strict structured
// output requires EVERY property to appear in `required` and
// additionalProperties:false at each level — otherwise codex returns a 400
// invalid_json_schema. This is the codex-native review shape (one line per
// finding); extractFindings maps it into the richer Reviewgate Finding.
const REVIEW_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "findings"],
  properties: {
    verdict: { type: "string", enum: ["PASS", "FAIL"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "severity",
          "category",
          "rule_id",
          "file",
          "line",
          "message",
          "details",
          "confidence",
        ],
        properties: {
          severity: { type: "string", enum: ["CRITICAL", "WARN", "INFO"] },
          category: {
            type: "string",
            enum: [
              "security",
              "correctness",
              "quality",
              "architecture",
              "performance",
              "testing",
              "docs",
            ],
          },
          rule_id: { type: "string" },
          file: { type: "string" },
          line: { type: "integer" },
          message: { type: "string" },
          details: { type: "string" },
          confidence: { type: "number" },
        },
      },
    },
  },
} as const;

// One finding as codex emits it under REVIEW_OUTPUT_SCHEMA.
interface CodexFinding {
  severity: "CRITICAL" | "WARN" | "INFO";
  category: string;
  rule_id: string;
  file: string;
  line: number;
  message: string;
  details: string;
  confidence: number;
}

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

  // Maps codex's review-schema output (severity/category/rule_id/file/line/
  // message/details/confidence) into the richer Reviewgate Finding: assigns a
  // stable F-NNN id, computes the canonical signature, relativizes the file
  // path, and pins the reviewer block. Malformed entries are dropped.
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
    let parsed: { findings?: unknown[] };
    try {
      parsed = JSON.parse(raw) as { findings?: unknown[] };
    } catch {
      // Codex returned non-JSON; M1 treats this as zero findings (M3+ may parse markdown).
      return [];
    }
    if (!Array.isArray(parsed.findings)) return [];
    const out: Finding[] = [];
    let n = 0;
    for (const raw of parsed.findings) {
      const cf = raw as Partial<CodexFinding>;
      if (
        typeof cf.severity !== "string" ||
        typeof cf.category !== "string" ||
        typeof cf.file !== "string" ||
        typeof cf.line !== "number" ||
        typeof cf.message !== "string"
      ) {
        continue; // not the expected shape — drop
      }
      n += 1;
      const id = `F-${String(n).padStart(3, "0")}`;
      const file = isAbsolute(cf.file) ? relative(workingDir, cf.file) || cf.file : cf.file;
      const line = Math.max(1, Math.trunc(cf.line));
      const candidate = {
        id,
        signature: computeSignature({
          file,
          ruleId: cf.rule_id ?? cf.severity,
          // Cast is safe: an invalid category fails FindingSchema.safeParse below
          // and the finding is dropped, so a bogus signature never escapes.
          category: cf.category as FindingCategory,
          lineStart: line,
          lineEnd: line,
        }),
        severity: cf.severity,
        category: cf.category,
        rule_id: cf.rule_id && cf.rule_id.length > 0 ? cf.rule_id : "unspecified",
        file,
        line_start: line,
        line_end: line,
        message: cf.message.slice(0, 200),
        details: (cf.details ?? cf.message).slice(0, 2000),
        reviewer: { provider: "codex", model, persona },
        confidence:
          typeof cf.confidence === "number" ? Math.min(1, Math.max(0, cf.confidence)) : 0.7,
        consensus: "singleton" as const,
      };
      // FindingSchema validates enums (severity/category) and bounds; drop on failure.
      const result = FindingSchema.safeParse(candidate);
      if (result.success) out.push(result.data);
    }
    return out;
  }
}
