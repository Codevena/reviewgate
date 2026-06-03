// src/cli/commands/gate.ts
import { existsSync, readFileSync, unlinkSync } from "node:fs";
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
import { flock, readLockHolder } from "../../utils/flock.ts";
import {
  DIFF_INCOMPLETE_MARKER,
  collectDiff,
  collectGitInfo,
  gitHeadSha,
  isAncestor,
  mergeBase,
  mergeBaseUpstream,
} from "../../utils/git.ts";
import { detectHostModel } from "../../utils/host-model.ts";
import { notifyDesktop } from "../../utils/notify.ts";
import {
  auditDir,
  deferredFlagPath,
  dirtyFlagPath,
  gateLockPath,
  stateJsonPath,
} from "../../utils/paths.ts";
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

// M-A3: a short " (PID N, running ~Xs)" note about the gate-lock holder for the
// DEFERRED message, so a hung holder (0% CPU for minutes) is identifiable and a
// human can kill it. Empty string when the holder can't be determined.
function formatLockHolder(repoRoot: string): string {
  const h = readLockHolder(gateLockPath(repoRoot));
  if (!h || h.pid === null) return "";
  const ms = h.ts ? Date.now() - Date.parse(h.ts) : Number.NaN;
  return Number.isFinite(ms)
    ? ` (PID ${h.pid}, running ~${Math.round(ms / 1000)}s)`
    : ` (PID ${h.pid})`;
}

// M-A1: cheap "is there anything to review?" probe, run BEFORE the gate lock so a
// pure read/analysis turn (no dirty.flag AND HEAD unchanged since the last review)
// short-circuits to allow_stop WITHOUT acquiring the global lock or doing git/
// pipeline work — removing lock contention for parallel sessions on one checkout.
// Preserves HEAD-advance review: if HEAD moved past the last reviewed sha (e.g.
// work committed via Bash with no Edit/Write), returns false so the lock path runs
// the HEAD-advanced synthesis. State is read WITHOUT the lock — StateStore writes
// are atomic (tmp+rename) so there's no torn read, and a stale read only ever errs
// toward taking the lock (safe). headShaFn is injectable for tests.
export async function stopHasNothingToReview(
  repoRoot: string,
  headShaFn: typeof gitHeadSha = gitHeadSha,
): Promise<boolean> {
  // A pending deferred review (M-A2) always needs the lock path — never skip it.
  if (existsSync(deferredFlagPath(repoRoot))) return false;
  if (existsSync(dirtyFlagPath(repoRoot))) return false;
  try {
    const st = await new StateStore(repoRoot).load();
    const last = st.last_reviewed_head_sha;
    if (last === null) return true; // never reviewed + no edits → nothing to review
    const sha = await headShaFn(repoRoot);
    return sha === last; // no dirty flag + HEAD unchanged → nothing to review
  } catch {
    return false; // any uncertainty → take the lock and let the full path decide
  }
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

  // hook === 'stop'. M-A1: before taking the (contended, multi-minute) gate lock,
  // skip entirely when there's nothing to review — a pure read/analysis turn with
  // no dirty.flag and an unchanged HEAD. This is the common case in a busy
  // multi-session checkout and must not pay lock contention or git/pipeline cost.
  if (await stopHasNothingToReview(input.repoRoot)) {
    return {
      exitCode: 0,
      stdout: "",
      stderr: "🟢 Reviewgate · GATE OPEN — No code changes since last review.",
    };
  }

  // Otherwise serialize the whole pipeline so two stop-hooks on the same checkout
  // can't run reviews in parallel and interleave writes to pending.*, decisions,
  // and the dirty flag. Fail CLOSED on contention (never allow an unreviewed turn).
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
    // M-A2 (D-1 fail-safe-degrade): the lock is held by another (possibly long or
    // hung) gate run. Do NOT block the turn — the old fail-closed behavior made
    // every parallel session busy-loop block→re-stop→block. Instead DEFER: drop a
    // deferred.flag so THIS session's next stop is forced to take the lock and
    // review (even if the dirty.flag is cleared meanwhile by whoever holds the lock
    // now), and allow the stop. The change stays flagged → it WILL be reviewed.
    try {
      writeFileAtomic(
        deferredFlagPath(input.repoRoot),
        JSON.stringify({ ts: new Date().toISOString() }),
        { mode: 0o600 },
      );
    } catch {
      /* best-effort: even without the marker, the persisting dirty.flag re-triggers */
    }
    // M-A3 diagnostics: name the holder (PID + how long it's run) so a human can
    // spot a hung holder (0% CPU for minutes) and `kill` it — a dead PID is then
    // reclaimed automatically by flock's dead-pid recovery on the next stop.
    const reason = `🟠 Reviewgate · GATE DEFERRED — another review${formatLockHolder(input.repoRoot)} is in progress; this turn was not reviewed and is NOT blocked. Your change stays flagged and is reviewed automatically on your next turn.`;
    return { exitCode: 0, stdout: "", stderr: reason };
  }
  try {
    // M-A2: we hold the lock → any prior contention is resolved. Consume a
    // deferred.flag left by an earlier contended turn so it can't loop. If the
    // dirty.flag was already cleared by whichever session won the lock last time,
    // synthesize one so the deferred change still gets a (working-tree) review.
    consumeDeferredFlag(input.repoRoot);
    return await runStopGate(input, cfg, audit, setupDeadlineAt);
  } finally {
    await lock.release();
  }
}

// Consume a deferred.flag now that the lock is held (M-A2). We must GUARANTEE the
// deferred change is reviewed: if no dirty.flag remains (the prior holder PASSed
// and cleared it), synthesize one (base = last reviewed sha, else working-tree) so
// LoopDriver doesn't take its no-flag allow_stop short-circuit and silently drop
// the change. CRITICAL (codex): only delete the deferred.flag AFTER a dirty.flag is
// confirmed present — if synthesis fails (ENOSPC/EACCES/tmp collision), KEEP the
// marker so the next stop retries. Never delete it with no dirty.flag left, or the
// deferred review is permanently lost (un-reviewed code ships).
export function consumeDeferredFlag(repoRoot: string): void {
  const dfp = deferredFlagPath(repoRoot);
  if (!existsSync(dfp)) return;
  if (!existsSync(dirtyFlagPath(repoRoot))) {
    let base: string | null = null;
    try {
      const sp = stateJsonPath(repoRoot);
      base = existsSync(sp)
        ? ((JSON.parse(readFileSync(sp, "utf8")) as { last_reviewed_head_sha?: string | null })
            .last_reviewed_head_sha ?? null)
        : null;
    } catch {
      base = null;
    }
    try {
      writeFileAtomic(
        dirtyFlagPath(repoRoot),
        JSON.stringify({
          diff_hash: "deferred",
          ts: new Date().toISOString(),
          ...(base ? { base_sha: base } : {}),
        }),
        { mode: 0o600 },
      );
    } catch {
      // Synthesis failed → do NOT consume the marker. Keeping deferred.flag forces
      // the next stop to retry (stopHasNothingToReview stays false), so the change
      // is never silently dropped. Fail-safe per the eventual-review guarantee.
      return;
    }
  }
  // A dirty.flag is now present (pre-existing or freshly synthesized) → the change
  // WILL be reviewed; safe to consume the deferred marker.
  try {
    unlinkSync(dfp);
  } catch {
    /* already gone */
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

// M-A5: resolve the effective review base, correcting for a rebase. If the captured
// base is still an ancestor of HEAD it is used as-is (the normal commit-per-task
// case). If NOT, a rebase rewrote history — diffing against it would pull in the
// foreign commits the rebase landed (e.g. a parallel merged PR); re-base on the
// branch's upstream divergence point (rebase-stable), or null (working-tree-only)
// when there is no upstream. Deps are injectable for tests.
export async function resolveReviewBase(
  repoRoot: string,
  base: string | null,
  deps?: {
    isAncestor?: typeof isAncestor;
    mergeBaseUpstream?: typeof mergeBaseUpstream;
    mergeBase?: typeof mergeBase;
  },
): Promise<string | null> {
  if (base === null) return null;
  const isAnc = deps?.isAncestor ?? isAncestor;
  const mbu = deps?.mergeBaseUpstream ?? mergeBaseUpstream;
  const mb = deps?.mergeBase ?? mergeBase;
  if (await isAnc(repoRoot, base, "HEAD")) return base; // normal: base still valid
  // Rebase/amend rewrote history → the captured base is no longer an ancestor of
  // HEAD. Prefer the upstream divergence point (excludes the foreign commits a
  // rebase pulled in). With NO upstream, do NOT narrow to working-tree-only — that
  // would DROP committed branch-owned work (codex CRITICAL). Over-review from the
  // common ancestor of the stale base and HEAD (always a valid ancestor of HEAD),
  // or — unrelated histories — the stale base itself. Over-review is acceptable;
  // under-review (missing committed changes) is not.
  const fork = await mbu(repoRoot);
  if (fork !== null) return fork;
  // No upstream. Use the common ancestor of the stale base and HEAD (a verified
  // ancestor of HEAD → over-reviews, never under-reviews). If there is NO common
  // ancestor (unrelated histories — pathological), return null (working-tree-only)
  // rather than the stale base: a non-ancestor base makes `git diff base..HEAD` a
  // TREE comparison that can HIDE real changes via coincidental matches (codex).
  return await mb(repoRoot, "HEAD", base);
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
  // M-A5: correct the resolved base for a rebase (covers both the dirty.flag base
  // and the HEAD-advanced `last`). If it changed, the captured base was stale
  // (history rewritten) — drop any eagerly-precomputed diff and recompute against
  // the corrected base so the review excludes foreign commits a rebase pulled in.
  const correctedBase = await resolveReviewBase(input.repoRoot, reviewBase);
  if (correctedBase !== reviewBase) {
    reviewBase = correctedBase;
    precomputedDiff = undefined;
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
