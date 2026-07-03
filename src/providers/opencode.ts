// src/providers/opencode.ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { verdictFromFindings } from "./adapter-base.ts";
import { scrubReviewerEnv } from "./availability.ts";
import { COMPLETE_TIMEOUT_MS, failureReason, readFileSafe } from "./complete-helpers.ts";
import { isQuotaBanner, isQuotaExhausted } from "./quota-signals.ts";
import {
  mapReviewOutputToFindingsCounted,
  mappingLooksLossy,
  parseReviewOutput,
} from "./review-output.ts";

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
    // Removed in finally so we don't leak a /tmp dir holding the reviewer output
    // every iteration (F-1).
    const run = mkdtempSync(join(tmpdir(), "rg-oc-run-"));
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
    // Prompt goes over STDIN, never argv. The prompt embeds research.md + the
    // full review-base diff and can be multiple MB; as a single positional
    // message argv element it exceeds Linux MAX_ARG_STRLEN (128 KiB per arg) /
    // macOS ARG_MAX (~1 MiB total) and posix_spawn fails with E2BIG before
    // opencode starts — the shoal 2026-06-02 gate-closed bug class fixed for
    // claude/gemini in PR #59 (F-10). `opencode run` with NO positional message
    // reads the message from piped stdin (run.ts: `process.stdin.isTTY ?
    // undefined : await Bun.stdin.text()`, used when message args are empty);
    // spawnSafely pipes the file and sends EOF.

    const res = await spawnSafely({
      command: this.binPath,
      args,
      // opencode authenticates via its own credential store (no env key to keep),
      // so scrub drops every foreign provider secret without breaking auth (F-2).
      env: scrubReviewerEnv(process.env),
      cwd: input.workingDir,
      stdinFile: input.promptFile,
      stdoutFile,
      stderrFile,
      timeoutMs: input.cfg.timeoutMs,
      // opencode is the heavy fallback for long codex reviews; don't let the 60s
      // idle watchdog cut it short — bound it by the wall-clock timeout instead.
      zeroByteWatchdogMs: input.cfg.timeoutMs,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.sandbox ? { sandbox: input.sandbox } : {}),
    });

    const errText = readFileSafe(stderrFile);
    // Scan stderr freely (the CLI's own channel); scan stdout (the model's review
    // text) only for a SHORT banner line (isQuotaBanner) so a quota phrase planted
    // in the diff and echoed back can neither suppress the reviewer nor false-
    // trigger a cooldown (F-6b).
    const quotaHit = isQuotaExhausted(errText) || isQuotaBanner(readFileSafe(stdoutFile));
    const baseStatus: ReviewStatus =
      res.killedByTimeout || res.killedByWatchdog ? "timeout" : res.exitCode === 0 ? "ok" : "error";
    const status: ReviewStatus =
      baseStatus === "error" && quotaHit ? "quota-exhausted" : baseStatus;

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
    if (!out) {
      // Exit 0 but stdout is not a parseable review (opencode/MiniMax can
      // truncate before emitting valid JSON). NOT a clean review → ERROR
      // (status !== "ok" → excluded from okRuns) rather than a silent empty PASS.
      // If the output is actually a quota/usage-limit banner (printed on an
      // exit-0 run), classify it quota-exhausted so cooldown+failover fires
      // (F-043 — mirrors codex/claude/gemini; closes the F-11 gap).
      const quota = isQuotaExhausted(errText) || isQuotaBanner(stdout);
      return {
        reviewerId: input.reviewerId,
        verdict: "ERROR",
        findings: [],
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, quotaUsedPct: null },
        durationMs: res.durationMs,
        exitCode: res.exitCode,
        rawEventsPath: stdoutFile,
        status: quota ? "quota-exhausted" : "error",
        statusDetail: quota
          ? "reviewer exited 0 but printed a quota/usage-limit banner"
          : "reviewer exited 0 but produced no valid review JSON (unparseable output)",
      };
    }
    const mapped = mapReviewOutputToFindingsCounted(out, {
      provider: "opencode",
      model: input.cfg.model,
      persona: input.persona,
      workingDir: input.workingDir,
    });
    const findings = mapped.findings;
    const lossy = mappingLooksLossy(out, mapped);
    if (lossy) {
      // S2 fail-closed: "all findings failed mapping" must be indistinguishable
      // from a crash, NOT from a clean pass — verdictFromFindings([]) === PASS
      // would ship a CRITICAL the reviewer actually reported. ERROR routes into
      // the existing failover/retry machinery instead.
      return {
        reviewerId: input.reviewerId,
        verdict: "ERROR",
        findings: [],
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, quotaUsedPct: null },
        durationMs: res.durationMs,
        exitCode: res.exitCode,
        rawEventsPath: stdoutFile,
        status: "error",
        // Round-12 W3: the counts ride along in EVERY lossy branch, not just
        // the blocking-drop reason string.
        statusDetail: `review output failed schema mapping: ${lossy} (dropped ${mapped.droppedCount}, blocking ${mapped.droppedBlockingCount})`,
      };
    }

    return {
      reviewerId: input.reviewerId,
      verdict: verdictFromFindings(findings),
      findings,
      // opencode provides no token stats — use zero cost like gemini
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, quotaUsedPct: null },
      durationMs: res.durationMs,
      exitCode: 0,
      rawEventsPath: stdoutFile,
      rawText: stdout,
      // S2: partial (non-lossy) drops are advisory-only — some blocking findings
      // survived, so the review is still trustworthy, but note the loss for triage.
      ...(mapped.droppedCount > 0
        ? { statusDetail: `${mapped.droppedCount} finding(s) dropped in schema mapping` }
        : {}),
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
      // Prompt over STDIN, never argv — same E2BIG avoidance as review() (a
      // judge/curator prompt can also exceed ARG_MAX). With no positional
      // message, `opencode run` reads the message from piped stdin.
      const promptFile = join(run, "prompt.txt");
      writeFileSync(promptFile, prompt);
      const res = await spawnSafely({
        command: this.binPath,
        args,
        env: scrubReviewerEnv(process.env),
        cwd: run,
        stdinFile: promptFile,
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
