// src/providers/gemini.ts
// Drives the Antigravity CLI (`agy`), the successor to the discontinued Gemini
// CLI (gemini CLI sunsets 2026-06-18 for OAuth/Pro/Ultra/free tiers). The
// provider id stays "gemini" for config compatibility. agy `-p` prints the model
// response verbatim on stdout — there is no -m, no -o json envelope, and no
// API-key auth (OAuth via the Antigravity session only).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { verdictFromFindings } from "./adapter-base.ts";
import { scrubReviewerEnv } from "./availability.ts";
import { COMPLETE_TIMEOUT_MS, failureReason, readFileSafe } from "./complete-helpers.ts";
import { isQuotaBanner, isQuotaExhausted } from "./quota-signals.ts";
import { mapReviewOutputToFindings, parseReviewOutput } from "./review-output.ts";

export interface GeminiAdapterOptions {
  binPath?: string;
}

// agy (Antigravity) is architecturally a coding AGENT, not a one-shot completion
// endpoint: given a review-shaped prompt it spins up a planner/tool loop (ReadFile,
// ViewFile, even running ESLint) regardless of cwd or permission flags — there is
// no flag to disable it. Empirically it either answers a SMALL prompt fast (~6–50s)
// or, on a large review prompt, never converges and self-aborts at --print-timeout.
// Waiting the full configured budget (e.g. 300s) buys nothing, so cap the agy review
// budget. A smaller configured timeoutMs is still honored (Math.min). See
// reference: 2026-05-31 shoal dogfood agy agentic-crawl investigation.
export const AGY_REVIEW_TIMEOUT_CAP_MS = 90_000;
// Extra headroom on the spawn wall-timeout so agy's OWN --print-timeout fires first
// and prints its detectable sentinel, rather than being SIGKILLed mid-output.
const AGY_SPAWN_BUFFER_MS = 10_000;

// agy's stdout sentinel when it abandons an agentic loop at --print-timeout WITHOUT
// producing a review (it still exits 0). Anchored at the start so a genuine review
// — even one whose findings discuss timeouts, or one prefixed with agentic chatter
// before valid JSON — can never match.
const AGY_PRINT_TIMEOUT_RE = /^\s*Error:\s*timed out waiting for response/i;

/** True when agy's output IS its print-timeout give-up sentinel (no review produced). */
export function isAgyPrintTimeout(text: string | undefined | null): boolean {
  return !!text && AGY_PRINT_TIMEOUT_RE.test(text);
}

// Map an agy spawn outcome to a ReviewStatus. Extracted + exported so the
// silent-stall classification is unit-testable without spawning agy.
//
// agy emits its quota/usage banner ("⚠ Individual quota reached … enable overages.
// Resets in 25m38s.") to the interactive TTY ONLY. Quota'd and run non-interactively
// (as Reviewgate runs it, piped) agy HANGS with zero stdout/stderr until the
// watchdog/timeout SIGKILLs it — there is no quota text to match. That silent,
// output-less kill is agy's only observable quota signal, so classify it as
// quota-exhausted → the orchestrator records a cooldown and skips agy instead of
// retrying it (and blocking the full wall timeout) every iteration. A kill that DID
// emit partial output is a genuine slow-review timeout and is left as "timeout".
export function classifyAgyOutcome(input: {
  killedByTimeout: boolean;
  killedByWatchdog: boolean;
  exitCode: number;
  outText: string;
  errText: string;
}): { status: ReviewStatus; silentStall: boolean } {
  const killed = input.killedByTimeout || input.killedByWatchdog;
  const noOutput = input.outText.trim() === "" && input.errText.trim() === "";
  if (killed && noOutput) return { status: "quota-exhausted", silentStall: true };
  // agy ran its agentic loop and gave up at --print-timeout without a review (it
  // prints this sentinel and exits 0; the spawn wall-timeout can also race it to a
  // kill). Either way it is a doomed reviewer for this prompt — classify as
  // quota-exhausted so the orchestrator cools it down + fails over, rather than
  // re-running it and burning the full timeout every iteration.
  if (isAgyPrintTimeout(input.outText)) return { status: "quota-exhausted", silentStall: false };
  const baseStatus: ReviewStatus = killed ? "timeout" : input.exitCode === 0 ? "ok" : "error";
  // Scan stderr freely (agy's own channel); scan stdout (the model response) only
  // for a SHORT banner line (isQuotaBanner), since a quota phrase planted in the
  // diff can be echoed there — an injected echo must not suppress the reviewer nor
  // false-trigger a cooldown (F-6b).
  const quotaHit = isQuotaExhausted(input.errText) || isQuotaBanner(input.outText);
  const status: ReviewStatus = baseStatus === "error" && quotaHit ? "quota-exhausted" : baseStatus;
  return { status, silentStall: false };
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
      // No --add-dir: the diff + full-file context are inline in the prompt. NOTE:
      // this does NOT stop agy from exploring — agy is a coding agent and runs a
      // ReadFile/ViewFile tool loop on any review prompt regardless (verified live).
      // --dangerously-skip-permissions only prevents a hang on the permission prompt;
      // the real bound on agentic runaway is the capped print-timeout below + the
      // print-timeout-sentinel cooldown in classifyAgyOutcome.
      const budgetMs = Math.min(input.cfg.timeoutMs, AGY_REVIEW_TIMEOUT_CAP_MS);
      // Prompt over STDIN, never argv. The prompt embeds research.md + the full
      // review-base diff and can be multiple MB; as a single `-p "<prompt>"` argv it
      // exceeds the OS ARG_MAX and posix_spawn fails with E2BIG before agy starts
      // (shoal 2026-06-02 gate-closed bug). spawnSafely pipes the file and sends EOF.
      // PENDING real-CLI verification (agy rate-limited ~2 days as of 2026-06-02):
      // a probe confirmed `agy -p` with no positional prompt is NOT rejected at
      // argparse, but that agy semantically reads the piped prompt must be re-confirmed
      // live once quota returns. See tests/unit/large-prompt-stdin.test.ts.
      const args = ["-p", "--dangerously-skip-permissions", "--print-timeout", `${budgetMs}ms`];
      const res = await spawnSafely({
        command: this.binPath,
        args,
        // agy authenticates via its own Google OAuth session (no env key), so scrub
        // drops every foreign provider secret without breaking auth (F-2).
        env: scrubReviewerEnv(process.env),
        cwd: input.workingDir,
        stdinFile: input.promptFile,
        stdoutFile: outFile,
        stderrFile: errFile,
        // Wall-timeout sits a buffer ABOVE agy's own --print-timeout so agy self-aborts
        // (printing its detectable sentinel) before this SIGKILL backstop fires.
        timeoutMs: budgetMs + AGY_SPAWN_BUFFER_MS,
        // agy print mode buffers (no streamed stdout), so the default 60s zero-byte
        // idle watchdog would SIGKILL a longer review. Tie it to the review budget so a
        // truly silent (quota'd) agy is still killed promptly → silent-stall cooldown.
        zeroByteWatchdogMs: budgetMs,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.sandbox ? { sandbox: input.sandbox } : {}),
      });
      const errText = readFileSafe(errFile);
      const outText = readFileSafe(outFile);
      const outcome = classifyAgyOutcome({
        killedByTimeout: res.killedByTimeout,
        killedByWatchdog: res.killedByWatchdog,
        exitCode: res.exitCode,
        outText,
        errText,
      });
      const status = outcome.status;
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
          statusDetail: outcome.silentStall
            ? "agy produced no output and was killed by the watchdog/timeout — agy prints its quota/usage banner to the TTY only, so a silent stall is treated as a quota cap (cooling down)."
            : isAgyPrintTimeout(outText)
              ? "agy hit its capped print-timeout inside an agentic tool loop without producing a review — treated as cooldown-worthy so this doomed reviewer is skipped (failover) instead of re-run every iteration."
              : errText.slice(0, 1000) || outText.slice(0, 1000),
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
        const quota = isQuotaExhausted(errText) || isQuotaBanner(outText);
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
      // Prompt over STDIN, never argv — same E2BIG avoidance as review() (see note there).
      const promptFile = join(run, "prompt.txt");
      writeFileSync(promptFile, prompt);
      const args = ["-p", "--dangerously-skip-permissions", "--print-timeout", `${timeoutMs}ms`];
      const res = await spawnSafely({
        command: this.binPath,
        args,
        env: scrubReviewerEnv(process.env),
        cwd: run,
        stdinFile: promptFile,
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
