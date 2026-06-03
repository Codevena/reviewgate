// src/cli/commands/gate.ts
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { ulid } from "ulid";
import { AuditLogger } from "../../audit/logger.ts";
import { SETUP_BUDGET_MS_DEFAULT } from "../../config/budgets.ts";
import { loadEffectiveConfig } from "../../config/global.ts";
import { LoopDriver } from "../../core/loop-driver.ts";
import { Orchestrator } from "../../core/orchestrator.ts";
import { StateStore } from "../../core/state-store.ts";
import { handleReset, handleTrigger, parseHookStdin } from "../../hooks/handlers.ts";
import type { ProviderAdapter } from "../../providers/adapter-base.ts";
import type { ProviderId } from "../../providers/registry.ts";
import { writeFileAtomic } from "../../utils/atomic-write.ts";
import { flock } from "../../utils/flock.ts";
import { DIFF_INCOMPLETE_MARKER, collectDiff, collectGitInfo } from "../../utils/git.ts";
import { detectHostModel } from "../../utils/host-model.ts";
import { notifyDesktop } from "../../utils/notify.ts";
import { auditDir, dirtyFlagPath, gateLockPath } from "../../utils/paths.ts";
import { withTimeout } from "../../utils/with-timeout.ts";
import { buildAdapters } from "../build-adapters.ts";

// Lock-ACQUIRE timeout for the stop-hook gate lock. Deliberately short and NOT
// tied to loop.runTimeoutMs (720_000ms default): a contended gate may hold the
// lock for a full multi-minute review, and waiting that long would let the OS
// Stop-hook timeout KILL this process before it can emit the fail-closed block
// (→ fail OPEN). Instead we give up quickly and fail CLOSED with a "re-run"
// block; the agent's re-stop retries, bounded by the holder's own self-deadline.
const GATE_LOCK_ACQUIRE_TIMEOUT_MS = 10_000;

interface ReviewContext {
  gitInfo: Awaited<ReturnType<typeof collectGitInfo>>;
  diff: string;
  reviewBase: string | null;
}

// Everything produced by the pre-loop setup phase, bundled so it can be computed
// inside a SINGLE bounded block (shared setup deadline) — see runStopGate.
interface SetupBundle {
  host: ReturnType<typeof detectHostModel>;
  adapters: ReturnType<typeof buildAdapters>;
  ctx: ReviewContext;
}

export interface GateInput {
  repoRoot: string;
  hook: "trigger" | "stop" | "reset";
  hookStdinRaw: string;
  providerOverrides?: Partial<Record<ProviderId, ProviderAdapter>>;
  sandboxModeOverride?: "strict" | "permissive" | "off";
  // Override the gate-lock acquire timeout (ms). Tests pass a tiny value to
  // exercise the fail-closed-on-contention path quickly.
  lockTimeoutMs?: number;
  // M-A0.2: budget (ms) for the pre-deadline setup work (collectGitInfo +
  // collectDiff) that runs OUTSIDE the loop self-deadline. On overrun the gate
  // fails CLOSED instead of being OS-killed mid-run (fail-open). Tests pass a
  // tiny value; 0 disables the budget. Defaults to SETUP_BUDGET_MS_DEFAULT.
  setupBudgetMs?: number;
  // Test seams: inject the git helpers so the setup-budget path can be exercised
  // deterministically (e.g. a collectGitInfo that hangs on index.lock contention).
  collectGitInfoFn?: typeof collectGitInfo;
  collectDiffFn?: typeof collectDiff;
  loadConfigFn?: typeof loadEffectiveConfig;
}

export interface GateOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function stopHookActiveFlag(parsed: unknown): boolean {
  const obj = parsed as { stop_hook_active?: boolean } | null;
  return Boolean(obj?.stop_hook_active);
}

// True only when collectDiff actually APPENDED its incompleteness trailer —
// not when the literal marker string merely appears somewhere in the diff body.
// collectDiff (git.ts) only ever emits the marker as the final trailing line
// (`${out}\n\n${DIFF_INCOMPLETE_MARKER}\n`), so a genuine "diff incomplete"
// signal is the marker at the END of the diff. A `diff.includes(...)` check
// would mis-fire whenever an edited file's content carries the literal text —
// most acutely when src/utils/git.ts (which DEFINES the constant) is itself in
// the reviewed diff, which this repo's own dogfooding hits routinely. The
// signal must be out-of-band-ish: positional, not substring-anywhere.
export function diffMarkedIncomplete(diff: string): boolean {
  return diff.trimEnd().endsWith(DIFF_INCOMPLETE_MARKER);
}

export async function runGate(input: GateInput): Promise<GateOutput> {
  // ONE setup deadline shared across config-load + lock + git setup (M-A0.2 /
  // codex CRITICAL): the per-phase budgets must not each be the full budget, or
  // their SUM (config + lock + git + loop + settle) could exceed the OS Stop-hook
  // timeout → the gate is OS-killed mid-run with empty stdout = fail-open. A
  // shared wall-clock deadline caps config+lock+git COMBINED at setupBudgetMs.
  // Config load runs BEFORE the lock, so a hanging config import (stuck top-level
  // await / wedged fs read) is bounded too; on timeout withTimeout REJECTS →
  // runGateSafe converts it into a fail-closed block (for the stop hook).
  const loadConfig = input.loadConfigFn ?? loadEffectiveConfig;
  const setupBudgetMs = input.setupBudgetMs ?? SETUP_BUDGET_MS_DEFAULT;
  const setupDeadlineAt = setupBudgetMs > 0 ? Date.now() + setupBudgetMs : null;
  const loadConfigP = loadConfig({
    cwd: input.repoRoot,
    env: process.env as Record<string, string | undefined>,
    home: homedir(),
  });
  const cfg =
    setupDeadlineAt !== null
      ? await withTimeout(loadConfigP, Math.max(1, setupDeadlineAt - Date.now()), "config-load")
      : await loadConfigP;
  const audit = new AuditLogger(auditDir(input.repoRoot));

  if (input.hook === "reset") {
    await handleReset({ repoRoot: input.repoRoot });
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  if (input.hook === "trigger") {
    await handleTrigger({ repoRoot: input.repoRoot, hookStdinRaw: input.hookStdinRaw });
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  // hook === 'stop' — serialize the whole pipeline so two stop-hooks on the same
  // checkout can't run reviews in parallel and interleave writes to pending.*,
  // decisions, and the dirty flag. Fail CLOSED on contention (never allow an
  // unreviewed turn through).
  let lock: { release: () => Promise<void> };
  // Cap the lock acquire by the REMAINING shared setup budget too, so lock wait +
  // config + state + git can't collectively exceed setupBudgetMs (codex CRITICAL).
  // This only ever SHORTENS the deliberately-short acquire timeout (never longer),
  // preserving the fail-fast-on-contention intent documented above.
  const lockAcquireMs =
    setupDeadlineAt !== null
      ? Math.min(
          input.lockTimeoutMs ?? GATE_LOCK_ACQUIRE_TIMEOUT_MS,
          Math.max(1, setupDeadlineAt - Date.now()),
        )
      : (input.lockTimeoutMs ?? GATE_LOCK_ACQUIRE_TIMEOUT_MS);
  try {
    lock = await flock(gateLockPath(input.repoRoot), lockAcquireMs);
  } catch {
    const reason =
      "🔴 Reviewgate · GATE CLOSED — another gate run is in progress (could not acquire the gate lock). Re-run to review once it finishes.";
    return { exitCode: 0, stdout: JSON.stringify({ decision: "block", reason }), stderr: reason };
  }
  try {
    return await runStopGate(input, cfg, audit, setupDeadlineAt);
  } finally {
    await lock.release();
  }
}

// Fail-CLOSED wrapper around runGate (M-A0.1). Any uncaught error from the gate
// pipeline (zod parse, fs error, adapter-build crash, a sync throw from
// writeFileAtomic, …) MUST NOT escape to citty — citty prints the stack to
// stderr and exits 1 with EMPTY stdout, which Claude Code's Stop-hook protocol
// reads as "allow" → the turn ends UN-reviewed = fail-OPEN, the exact failure
// this gate exists to prevent (field report: "stop hook 2/3 then disappears").
// On a STOP error we emit a block (fail closed); a trigger/reset is NOT the
// review, so a crash there must not block the turn. `run` is injectable for
// tests. Exits 0 in all cases (the hook protocol carries the verdict in stdout).
export async function runGateSafe(
  input: GateInput,
  run: (i: GateInput) => Promise<GateOutput> = runGate,
): Promise<GateOutput> {
  try {
    return await run(input);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (input.hook === "stop") {
      const reason = `🔴 Reviewgate · GATE CLOSED — internal error: ${msg}. Run \`reviewgate doctor\`; end your turn again to retry.`;
      return { exitCode: 0, stdout: JSON.stringify({ decision: "block", reason }), stderr: reason };
    }
    return { exitCode: 0, stdout: "", stderr: `Reviewgate ${input.hook} error: ${msg}` };
  }
}

// Pre-deadline setup: resolve the review base + collect the diff (incl. the
// HEAD-advanced synthesis path). Extracted so runStopGate can bound it with a
// setup budget (M-A0.2). The git helpers are injected so the budget path can be
// exercised deterministically in tests.
async function gatherReviewContext(
  input: GateInput,
  state: StateStore,
  gitInfoFn: typeof collectGitInfo,
  diffFn: typeof collectDiff,
): Promise<ReviewContext> {
  const gitInfo = await gitInfoFn(input.repoRoot);
  // Review base: the pre-batch HEAD captured in dirty.flag, so commit-per-task
  // work (committed mid-batch) is reviewed too — not just the working tree.
  const dp = dirtyFlagPath(input.repoRoot);
  const hasDirtyFlag = existsSync(dp);
  let reviewBase: string | null = null;
  // Reused when the HEAD-advanced path already computed the since-base diff, so
  // the gate doesn't run collectDiff twice for the same base.
  let precomputedDiff: string | undefined;
  if (hasDirtyFlag) {
    try {
      reviewBase = (JSON.parse(readFileSync(dp, "utf8")) as { base_sha?: string }).base_sha ?? null;
    } catch {
      reviewBase = null;
    }
  } else {
    // HEAD-advanced trigger: committed/merged work can arrive WITHOUT an Edit/Write
    // — e.g. a `git merge` or `git commit` run via Bash, or a worktree merge into
    // the watched checkout. No PostToolUse fires, so no dirty.flag, and the gate
    // would allow the turn UNREVIEWED. If HEAD moved past the last reviewed sha AND
    // there is a real diff since then, synthesize the trigger (base = last reviewed
    // sha) so that committed work is actually reviewed. (Requires a prior review to
    // have set last_reviewed_head_sha — the common case once the session is going.)
    const st = await state.load();
    const last = st.last_reviewed_head_sha;
    // Compute the since-`last` diff ONCE here and reuse it below when this path
    // sets reviewBase = last (avoids a second identical collectDiff = duplicate git work).
    const sinceLast =
      gitInfo.sha && last && gitInfo.sha !== last ? await diffFn(input.repoRoot, last) : "";
    if (sinceLast.trim().length > 0) {
      reviewBase = last;
      precomputedDiff = sinceLast;
      // Atomic (tmp+rename): the gate runs under flock (single writer), so a
      // fixed-suffix temp is safe; rename ensures a reader never sees a partial
      // dirty.flag (which the gate parses as JSON — a truncated file would error).
      // Persisting the synthesized flag is best-effort: reviewBase + precomputedDiff
      // are already set in memory, so THIS review proceeds correctly even if the
      // write fails. Swallow the (sync) error rather than fail-closing the whole
      // gate on a transient fs hiccup (M-A0.1 hardening of gate.ts:155).
      try {
        writeFileAtomic(
          dp,
          JSON.stringify({
            diff_hash: gitInfo.sha.slice(0, 16),
            ts: new Date().toISOString(),
            base_sha: last,
          }),
          { mode: 0o600 },
        );
      } catch {
        /* flag persistence failed — current review still runs on the in-memory base */
      }
    }
  }
  const diff = precomputedDiff ?? (await diffFn(input.repoRoot, reviewBase));
  return { gitInfo, diff, reviewBase };
}

// The stop-hook review pipeline, run under the gate lock by runGate. Split out so
// the lock acquire/release wraps the entire body without re-indenting it.
async function runStopGate(
  input: GateInput,
  cfg: Awaited<ReturnType<typeof loadEffectiveConfig>>,
  audit: AuditLogger,
  // Shared setup deadline (epoch ms) started in runGate before config-load; null
  // when the budget is disabled. The git setup uses the time REMAINING until it,
  // so config + lock + git together never exceed setupBudgetMs (codex CRITICAL).
  setupDeadlineAt: number | null,
): Promise<GateOutput> {
  const parsedStdin = parseHookStdin(input.hookStdinRaw);
  const state = new StateStore(input.repoRoot);
  const gitInfoFn = input.collectGitInfoFn ?? collectGitInfo;
  const diffFn = input.collectDiffFn ?? collectDiff;

  // ALL pre-loop setup (state load + host detect + adapter build + git/diff) runs
  // under the REMAINING shared setup deadline (M-A0.2 / codex CRITICAL): state's
  // own flock timeout and the git work were otherwise NOT capped by the budget, so
  // the worst-case sum (config + lock + state + git + loop + settle) could exceed
  // the OS Stop-hook timeout → the gate is OS-killed mid-run with empty stdout =
  // fail-OPEN. Bounding them together caps config+lock+setup at setupBudgetMs, so
  // setupBudget + runTimeoutMs + post-abort-settle stays under the OS timeout. On
  // overrun we fail CLOSED with a clear block.
  let setup: SetupBundle;
  try {
    const setupWork: Promise<SetupBundle> = (async () => {
      await state.loadOrRecover(ulid());
      const host = detectHostModel({
        env: process.env as Record<string, string>,
        hookStdin: parsedStdin as { session?: { model?: string } } | null,
      });
      const adapters = buildAdapters(cfg, input.providerOverrides);
      const ctx = await gatherReviewContext(input, state, gitInfoFn, diffFn);
      return { host, adapters, ctx };
    })();
    setup =
      setupDeadlineAt !== null
        ? await withTimeout(setupWork, Math.max(1, setupDeadlineAt - Date.now()), "review-setup")
        : await setupWork;
  } catch {
    const secs = Math.round((input.setupBudgetMs ?? SETUP_BUDGET_MS_DEFAULT) / 1000);
    const reason = `🔴 Reviewgate · GATE CLOSED — review setup (git/state/diff) did not complete within ${secs}s (likely git index-lock contention from a parallel session). End your turn again to retry; run \`reviewgate doctor\` if it persists.`;
    return { exitCode: 0, stdout: JSON.stringify({ decision: "block", reason }), stderr: reason };
  }
  const { host, adapters, ctx } = setup;
  const { gitInfo, diff, reviewBase } = ctx;
  const orchestrator = new Orchestrator({
    repoRoot: input.repoRoot,
    config: cfg,
    adapters,
    // Same hash-chained logger the LoopDriver uses, so the curator's egress events
    // and the gate's run events share one intact chain (F-028).
    audit,
    sandboxMode: input.sandboxModeOverride ?? cfg.sandbox.mode,
    hostTier: host.tier,
    diff,
    gitInfo,
    reasonOnFailEnabled: true,
    reviewBaseSha: reviewBase,
    // Partial-diff guard: surfaced to reviewers as trusted context (not buried in
    // the untrusted fence) so a truncated/timed-out diff isn't trusted as complete.
    diffIncomplete: diffMarkedIncomplete(diff),
  });

  const driver = new LoopDriver({
    repoRoot: input.repoRoot,
    config: cfg,
    state,
    audit,
    orchestrator,
    stopHookActive: stopHookActiveFlag(parsedStdin),
    headSha: gitInfo.sha,
  });
  const decision = await driver.run();

  // Completion signal — so a passing review is no longer SILENT (the agent
  // can't be pinged on allow_stop by the hook architecture, but the human can):
  //  - always write the gate status to stderr (surfaced in the hook output),
  //  - optionally fire a desktop notification when notify.desktop is enabled.
  // The reason is already self-branded ("🟢 Reviewgate · GATE OPEN — …").
  const signal = decision.reason;
  if (cfg.notify.desktop) {
    notifyDesktop("Reviewgate", decision.reason);
  }

  if (decision.kind === "block") {
    return {
      exitCode: 0,
      stdout: JSON.stringify({ decision: "block", reason: decision.reason }),
      stderr: signal,
    };
  }
  // allow_stop: exit 0. The summary still goes to stderr so "green" is visible.
  return { exitCode: 0, stdout: "", stderr: signal };
}
