// src/providers/codex.ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { scrubReviewerEnv } from "./availability.ts";
import { COMPLETE_TIMEOUT_MS, failureReason, readFileSafe } from "./complete-helpers.ts";
import { extractQuotaMessage, isQuotaBanner, isQuotaExhausted } from "./quota-signals.ts";
import {
  REVIEW_OUTPUT_SCHEMA,
  mapReviewOutputToFindings,
  parseReviewOutput,
} from "./review-output.ts";

const RETRY_DIRECTIVE =
  "\n\nIMPORTANT: Output ONLY the single JSON object of the required schema now. Do not call any tools or explain.";

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
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  async review(
    input: ReviewInput & { cfg: ProviderConfig; reviewerId: string },
  ): Promise<ReviewResult> {
    // Per-run temp dir holds the schema, per-attempt event/last-message/stderr
    // files AND the untrusted prompt — all removed in finally so we don't leak a
    // /tmp dir containing the diff + reviewer output every iteration (F-1).
    const run = mkdtempSync(join(tmpdir(), "rg-codex-run-"));
    try {
      return await this.reviewInRun(run, input);
    } finally {
      try {
        rmSync(run, { recursive: true, force: true });
      } catch {
        // best-effort temp cleanup
      }
    }
  }

  private async reviewInRun(
    run: string,
    input: ReviewInput & { cfg: ProviderConfig; reviewerId: string },
  ): Promise<ReviewResult> {
    // Always constrain codex to our review schema so the response shape is
    // predictable. Caller may override with their own schema file.
    let schemaPath = input.schemaPath;
    if (!schemaPath) {
      schemaPath = join(run, "schema.json");
      writeFileSync(schemaPath, JSON.stringify(REVIEW_OUTPUT_SCHEMA));
    }

    const env = scrubReviewerEnv(process.env);
    if (input.cfg.auth === "apikey" && input.cfg.apiKeyEnv) {
      const key = process.env[input.cfg.apiKeyEnv];
      if (key) env.OPENAI_API_KEY = key;
    }
    // OAuth mode relies on codex's own credential store; no env change.

    // One codex invocation. Per-attempt filenames so a retry can never read a
    // previous attempt's stale last-message (see spec "stale-output guard").
    const runOnce = async (
      attempt: 1 | 2,
      promptFile: string,
    ): Promise<{ result: ReviewResult; killedByAbort: boolean }> => {
      const lastMsgFile = join(run, `last.${attempt}.md`);
      const eventsFile = join(run, `events.${attempt}.jsonl`);
      const stderrFile = join(run, `stderr.${attempt}.log`);

      // Prompt goes over STDIN, never argv. The prompt embeds research.md + the
      // full review-base diff and can be multiple MB; as a single positional argv
      // element it exceeds Linux MAX_ARG_STRLEN (128 KiB per arg) / macOS ARG_MAX
      // (~1 MiB total) and posix_spawn fails with E2BIG before codex starts —
      // the same shoal 2026-06-02 gate-closed bug fixed for claude/gemini (F-09).
      // `codex exec -` reads the prompt from stdin when the positional prompt is
      // `-`; spawnSafely pipes the file and closes the pipe (EOF) when it ends —
      // codex would otherwise block forever on "Reading additional input from
      // stdin...".
      const args = [
        "exec",
        // Provider calls must be reproducible and isolated from ambient MCP
        // servers/profiles in $CODEX_HOME/config.toml. Authentication still comes
        // from CODEX_HOME; only user configuration is ignored.
        "--ignore-user-config",
        "--disable",
        "shell_tool",
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
        "-",
      ];

      const res = await spawnSafely({
        command: this.binPath,
        args,
        env,
        cwd: input.workingDir,
        stdinFile: promptFile,
        stdoutFile: eventsFile,
        stderrFile,
        timeoutMs: input.cfg.timeoutMs,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.sandbox ? { sandbox: input.sandbox } : {}),
      });

      const stderrText = readFileSafe(stderrFile);
      const eventsText = readFileSafe(eventsFile);
      // codex's usage-limit banner lands on STDOUT (the --json event stream), not
      // stderr — so scan BOTH. But the event stream also carries the model's own
      // reasoning/agent text, which can quote a quota phrase planted in the diff;
      // scan stderr freely (the CLI's own channel) yet scan the events stream only
      // for a SHORT banner-shaped line via isQuotaBanner, so an injected phrase
      // buried in a long echoed line can neither suppress the reviewer (DoS) nor
      // false-trigger a cooldown (F-6b).
      const quotaHit = isQuotaExhausted(stderrText) || isQuotaBanner(eventsText);
      // For statusDetail (reset-time recovery) the banner snippet is extracted
      // from whichever channel signalled it.
      const quotaText = `${stderrText}\n${eventsText}`;
      const baseStatus: ReviewStatus =
        res.killedByTimeout || res.killedByWatchdog
          ? "timeout"
          : res.exitCode === 0
            ? "ok"
            : "error";
      const status: ReviewStatus =
        baseStatus === "error" && quotaHit ? "quota-exhausted" : baseStatus;

      if (status !== "ok") {
        // A deadline-abort (spawnSafely SIGKILL via opts.signal) surfaces as a
        // bare exit!=0 "error" with usually-empty stderr — indistinguishable from
        // a real crash. Tag it explicitly so the deliberate cut is legible in
        // logs and in the orchestrator's "[fallback from <p>: <status>]" prefix
        // rather than reading as a muddy generic failure (F-045).
        const detail =
          status === "quota-exhausted"
            ? (extractQuotaMessage(quotaText) ?? stderrText)
            : res.killedByAbort
              ? `deadline-aborted${stderrText ? `: ${stderrText}` : ""}`
              : stderrText;
        return {
          result: {
            reviewerId: input.reviewerId,
            verdict: "ERROR",
            findings: [],
            usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, quotaUsedPct: null },
            durationMs: res.durationMs,
            exitCode: res.exitCode,
            rawEventsPath: eventsFile,
            status,
            statusDetail: detail.slice(0, 1000),
          },
          killedByAbort: res.killedByAbort,
        };
      }

      const usage = this.extractUsage(eventsFile);
      const findings = this.extractFindings(
        lastMsgFile,
        input.cfg.model,
        input.persona,
        input.workingDir,
      );
      if (findings === null) {
        // Exit 0 but no parseable review. If codex actually printed a usage-limit
        // banner (which lands on exit 0 here, not the exit!=0 path above), classify
        // it as quota-exhausted so the cooldown handles it and we don't retry into
        // the cap. Otherwise it's a genuine unparseable run (retry candidate).
        if (quotaHit) {
          return {
            result: {
              reviewerId: input.reviewerId,
              verdict: "ERROR",
              findings: [],
              usage,
              durationMs: res.durationMs,
              exitCode: res.exitCode,
              rawEventsPath: eventsFile,
              status: "quota-exhausted",
              statusDetail: (extractQuotaMessage(quotaText) ?? "codex usage limit reached").slice(
                0,
                1000,
              ),
            },
            killedByAbort: res.killedByAbort,
          };
        }
        return {
          result: {
            reviewerId: input.reviewerId,
            verdict: "ERROR",
            findings: [],
            usage,
            durationMs: res.durationMs,
            exitCode: res.exitCode,
            rawEventsPath: eventsFile,
            status: "error",
            statusDetail:
              "reviewer exited 0 but produced no valid review JSON (unparseable output)",
          },
          killedByAbort: res.killedByAbort,
        };
      }

      let rawText = "";
      try {
        rawText = readFileSync(lastMsgFile, "utf8");
      } catch {
        rawText = "";
      }
      return {
        result: {
          reviewerId: input.reviewerId,
          verdict: verdictFromFindings(findings),
          findings,
          usage,
          durationMs: res.durationMs,
          exitCode: 0,
          rawEventsPath: eventsFile,
          rawText,
          status: "ok",
        },
        killedByAbort: res.killedByAbort,
      };
    };

    const first = await runOnce(1, input.promptFile);

    // Retry exactly once ONLY on a generic error / unparseable outcome. Never on
    // quota (cooldown owns it), timeout/watchdog (a rerun won't help), or abort:
    // killedByAbort covers a mid-run abort; signal?.aborted guards the pre-aborted
    // case (belt-and-suspenders — spawnSafely sets killedByAbort there too, but the
    // explicit check documents intent and survives a spawnSafely refactor).
    const retriable =
      input.disableRetries !== true &&
      first.result.status === "error" &&
      !first.killedByAbort &&
      !input.signal?.aborted;
    if (!retriable) return first.result;

    // The retry prompt (base + directive) is also delivered via stdin: write it
    // to a per-run temp file rather than appending to argv (same E2BIG ceiling).
    const retryPromptFile = join(run, "prompt.2.txt");
    writeFileSync(retryPromptFile, readFileSync(input.promptFile, "utf8") + RETRY_DIRECTIVE);
    const second = await runOnce(2, retryPromptFile);
    // Only the generic-error outcome gets the "(after retry)" marker; a terminal
    // quota/timeout status on the retry is returned unchanged so its detail stays
    // parseable by the cooldown.
    if (second.result.status === "error") {
      const base = second.result.statusDetail?.trim() ?? "";
      return {
        ...second.result,
        statusDetail: `${base ? `${base} ` : ""}(after retry)`.slice(0, 1000),
      };
    }
    return second.result;
  }

  async complete(prompt: string, opts: CompleteOptions): Promise<string> {
    const run = mkdtempSync(join(tmpdir(), "rg-codex-cmpl-"));
    try {
      const lastMsgFile = join(run, "last.md");
      const eventsFile = join(run, "events.jsonl");
      const stderrFile = join(run, "stderr.log");
      // Prompt over STDIN, never argv — same E2BIG avoidance as review() (a
      // judge/critic prompt can also exceed ARG_MAX). `codex exec -` reads the
      // prompt from stdin; spawnSafely pipes the file and sends EOF.
      const promptFile = join(run, "prompt.txt");
      writeFileSync(promptFile, prompt);
      // NOTE: NO --output-schema — a judge needs a free-form completion.
      // --skip-git-repo-check: the judge runs in a fresh non-git temp dir, and
      // codex `exec` otherwise refuses ("Not inside a trusted directory").
      const args = [
        "exec",
        "--ignore-user-config",
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        // Same as review(): disable agentic shell_tool exploration. Without it a
        // judge prompt can trigger exec_command, ending the turn with no final
        // message → complete() returns "" → the judge silently no-ops to its
        // default (no retry on this path, unlike review()). (F-044)
        "--disable",
        "shell_tool",
        "--json",
        "--output-last-message",
        lastMsgFile,
        "--cd",
        run,
        "--model",
        opts.model,
        "-",
      ];
      const env = scrubReviewerEnv(process.env);
      if (opts.auth === "apikey" && opts.apiKeyEnv) {
        const key = process.env[opts.apiKeyEnv];
        if (key) env.OPENAI_API_KEY = key;
      }
      const res = await spawnSafely({
        command: this.binPath,
        args,
        env,
        cwd: run,
        stdinFile: promptFile,
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
        // Per-line safe parse: a single malformed line is SKIPPED, not allowed to
        // throw out of the loop and drop the remaining (valid) usage events.
        const ev = safeJsonParse(line);
        if (!ev || typeof ev !== "object") continue;
        const e = ev as {
          type?: string;
          event?: string;
          usage?: { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number };
        };
        const kind = e.type ?? e.event;
        if (kind === "turn.completed" && e.usage) {
          input_tokens += e.usage.input_tokens ?? 0;
          output_tokens += e.usage.output_tokens ?? 0;
          cached += e.usage.cached_input_tokens ?? 0;
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
  // Returns the parsed findings (possibly empty for a clean review), or `null`
  // when the last-message could not be read or did not parse as a review — the
  // caller turns `null` into an ERROR rather than a silent empty PASS.
  private extractFindings(
    lastMsgFile: string,
    model: string,
    persona: string,
    workingDir: string,
  ): Finding[] | null {
    let raw: string;
    try {
      raw = readFileSync(lastMsgFile, "utf8");
    } catch {
      return null;
    }
    const out = parseReviewOutput(raw);
    if (!out) return null;
    return mapReviewOutputToFindings(out, { provider: "codex", model, persona, workingDir });
  }
}
