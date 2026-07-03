// src/providers/claude.ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { isQuotaBanner, isQuotaExhausted } from "./quota-signals.ts";
import {
  type MappedReview,
  mapReviewOutputToFindingsCounted,
  mappingLooksLossy,
  parseReviewOutput,
} from "./review-output.ts";

const DISALLOWED = "Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch,TodoWrite,Task";

// NOTE: a hardcoded review-budget cap (CLAUDE_REVIEW_TIMEOUT_CAP_MS=180s) was tried
// here and REVERTED. Field data (2026-06-02 dogfood across hammihan/geometrywars) shows
// a real claude-code-security review of a non-trivial diff legitimately takes 130–185s+
// (a 770-line plan doc timed out at 183s; a successful review took 141s). A 180s cap
// sat mid-distribution and CLIPPED legit slow reviews into false timeouts — worst when
// codex is quota-locked and claude is the only working fallback. `claude -p` is buffered
// (no progress signal), so a wall cap cannot tell "slow" from "hung"; the configured
// cfg.timeoutMs (300s default, user-tunable) is therefore the correct single bound, and
// the gate self-deadline (runTimeoutMs=720s) backstops the whole failover chain. Do not
// re-add a tighter hardcoded cap without evidence that real reviews finish well under it.

// Hermetic reviewer flags. The hook-free temp CWD only escapes PROJECT-level
// .claude/settings.json; without these a nested `claude -p` still loads the HOST
// user-level ~/.claude — every configured MCP server (incl. Gmail/Calendar/Drive
// connectors) plus SessionStart hooks — into the reviewer subprocess. That is both a
// hang surface (a blocking MCP init stalls the reviewer to the watchdog) and a
// privilege leak (the reviewer gains the host's connected-service access).
// --strict-mcp-config with NO --mcp-config loads zero MCP servers; --setting-sources
// project skips user/local settings. OAuth creds load independently, so auth survives.
const HERMETIC_ARGS = ["--strict-mcp-config", "--setting-sources", "project"];

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
    // need the real repo tree. Removed in finally so we don't leak a /tmp dir
    // holding the reviewer output every iteration (F-1).
    const run = mkdtempSync(join(tmpdir(), "rg-cl-run-"));
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
    const outFile = join(run, "out.json");
    const errFile = join(run, "err.log");

    // Prompt goes over STDIN, never argv. The prompt embeds research.md + the full
    // review-base diff and can be multiple MB; as a single `-p "<prompt>"` argv it
    // exceeds the OS ARG_MAX and posix_spawn fails with E2BIG before the reviewer
    // starts (shoal 2026-06-02 gate-closed bug). `claude -p` reads the prompt from
    // stdin when run in a pipe, which has no size ceiling. spawnSafely pipes the
    // file and closes the pipe (EOF) when it ends.
    const args = [
      "-p",
      "--model",
      input.cfg.model,
      "--output-format",
      "json",
      "--disallowedTools",
      DISALLOWED,
      "--permission-mode",
      "dontAsk",
      "--no-session-persistence",
      ...HERMETIC_ARGS,
    ];
    const env = scrubReviewerEnv(process.env);
    if (input.cfg.auth === "apikey" && input.cfg.apiKeyEnv) {
      const key = process.env[input.cfg.apiKeyEnv];
      if (key) env.ANTHROPIC_API_KEY = key;
    }
    const res = await spawnSafely({
      command: this.binPath,
      args,
      env,
      cwd: run,
      stdinFile: input.promptFile,
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
      ...(input.sandbox ? { sandbox: input.sandbox } : {}),
    });
    const errText = readFileSafe(errFile);
    // Scan stderr freely (the CLI's own channel); scan the JSON output envelope
    // only for a SHORT banner line (isQuotaBanner), since its `result` field holds
    // the model review, which can quote a quota phrase planted in the diff — an
    // injected echo must not suppress the reviewer or false-trigger a cooldown (F-6b).
    const quotaHit = isQuotaExhausted(errText) || isQuotaBanner(readFileSafe(outFile));
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
        rawEventsPath: outFile,
        status,
        statusDetail: errText.slice(0, 1000),
      };
    }
    const { out, mapped, usage, rawText } = this.parse(
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
      const quota = isQuotaExhausted(errText) || isQuotaBanner(readFileSafe(outFile));
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
        usage,
        durationMs: res.durationMs,
        exitCode: res.exitCode,
        rawEventsPath: outFile,
        // The temp run dir (and thus rawEventsPath) is reaped in finally, so the
        // raw reviewer text — containing the malformed finding — is the ONLY
        // surviving triage evidence. Carry it exactly like the ok-path does.
        rawText,
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
      usage,
      durationMs: res.durationMs,
      exitCode: 0,
      rawEventsPath: outFile,
      rawText,
      // S2: partial (non-lossy) drops are advisory-only — some blocking findings
      // survived, so the review is still trustworthy, but note the loss for triage.
      ...(mapped.droppedCount > 0
        ? { statusDetail: `${mapped.droppedCount} finding(s) dropped in schema mapping` }
        : {}),
      status: "ok",
    };
  }

  async complete(prompt: string, opts: CompleteOptions): Promise<string> {
    const run = mkdtempSync(join(tmpdir(), "rg-cl-cmpl-"));
    try {
      const outFile = join(run, "out.json");
      const errFile = join(run, "err.log");
      // Prompt over STDIN, never argv — same E2BIG avoidance as review() (a judge/
      // critic/curator prompt can also exceed ARG_MAX). `claude -p` reads stdin.
      const promptFile = join(run, "prompt.txt");
      writeFileSync(promptFile, prompt);
      const args = [
        "-p",
        "--model",
        opts.model,
        "--output-format",
        "json",
        "--disallowedTools",
        DISALLOWED,
        "--permission-mode",
        "dontAsk",
        "--no-session-persistence",
        ...HERMETIC_ARGS,
      ];
      const env = scrubReviewerEnv(process.env);
      if (opts.auth === "apikey" && opts.apiKeyEnv) {
        const key = process.env[opts.apiKeyEnv];
        if (key) env.ANTHROPIC_API_KEY = key;
      }
      const res = await spawnSafely({
        command: this.binPath,
        args,
        env,
        cwd: run,
        stdinFile: promptFile,
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
    mapped: MappedReview;
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
    const mapped = out
      ? mapReviewOutputToFindingsCounted(out, {
          provider: "claude-code",
          model,
          persona,
          workingDir,
        })
      : { findings: [], droppedCount: 0, droppedBlockingCount: 0 };
    return {
      out,
      mapped,
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
