// src/cli/commands/gate.ts
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { ulid } from "ulid";
import { AuditLogger } from "../../audit/logger.ts";
import { SETUP_BUDGET_MS_DEFAULT } from "../../config/budgets.ts";
import {
  type ControlPlaneResolution,
  finalizeControlPlaneReview,
  resolveControlPlaneConfig,
} from "../../config/control-plane.ts";
import type { ReviewgateConfig } from "../../config/define-config.ts";
import type { loadEffectiveConfig } from "../../config/global.ts";
import { buildSessionStartInjection } from "../../core/agent-lessons/inject.ts";
import { LoopDriver } from "../../core/loop-driver.ts";
import { Orchestrator } from "../../core/orchestrator.ts";
import { type SnapshotFileEntry, snapshotReviewedFiles } from "../../core/reviewed-snapshot.ts";
import { computeForeignFiles } from "../../core/session-manifest.ts";
import { StateStore } from "../../core/state-store.ts";
import {
  SETTLE_INTERVAL_MS,
  SETTLE_MAX_MS,
  SETTLE_QUIET_WINDOW_MS,
  awaitWorkspaceSettle,
} from "../../core/workspace-settle.ts";
import {
  BASE_TS_NO_SCOPING_SENTINEL,
  handleReset,
  handleTrigger,
  parseHookStdin,
} from "../../hooks/handlers.ts";
import type { ProviderAdapter } from "../../providers/adapter-base.ts";
import type { ProviderId } from "../../providers/registry.ts";
import { computeDiffFacts } from "../../research/diff-facts.ts";
import { writeFileAtomic, writeFileIfAbsent } from "../../utils/atomic-write.ts";
import { FlockTimeoutError, flock, readLockHolder } from "../../utils/flock.ts";
import {
  DIFF_INCOMPLETE_MARKER,
  collectDiff,
  collectGitInfo,
  gitHeadSha,
  isAncestor,
  mergeBase,
  mergeBaseUpstream,
  workingTreeDirtyFiles,
  workingTreeStateHash,
} from "../../utils/git.ts";
import { detectHostModel } from "../../utils/host-model.ts";
import { notifyDesktop } from "../../utils/notify.ts";
import {
  auditDir,
  deferredFlagPath,
  dirtyFlagPath,
  escalationMdPath,
  gateLockPath,
  policyChangeReportPath,
  stateJsonPath,
} from "../../utils/paths.ts";
import { withTimeout } from "../../utils/with-timeout.ts";
import { buildAdapters } from "../build-adapters.ts";

// Lock-ACQUIRE timeout for the stop-hook gate lock. Deliberately short and NOT
// tied to loop.runTimeoutMs (1_800_000ms default): a contended gate may hold the
// lock for a full multi-minute review, and waiting that long would let the OS
// Stop-hook timeout KILL this process before it can emit the fail-closed block
// (→ fail OPEN). Instead we give up quickly and fail CLOSED with a "re-run"
// block; the agent's re-stop retries, bounded by the holder's own self-deadline.
const GATE_LOCK_ACQUIRE_TIMEOUT_MS = 10_000;

interface ReviewContext {
  gitInfo: Awaited<ReturnType<typeof collectGitInfo>>;
  diff: string;
  reviewBase: string | null;
  // True when the captured review scope was lost (corrupt dirty.flag) and the diff
  // was recovered against a wider fallback base — surfaced to reviewers so the diff
  // isn't trusted as a complete picture even when collectDiff didn't itself truncate.
  diffIncomplete: boolean;
  // Snapshot-race fix (Dealbarg field incident 2026-07): the working-tree
  // fingerprint sampled in the SAME verify round as the shipped diff — the
  // reviewed-through blessing is bound to the reviewed artifact instead of being
  // hashed later against whatever the tree looks like then (the old "residual
  // micro-window"). May be null (fingerprint indeterminate) — consumers already
  // treat null as "changed" (fail toward review).
  snapshotTree: string | null;
  // Set when the paired verify rounds exhausted their cap with the tree still
  // changing between reads (a concurrent writer). The shipped diff is the LATEST
  // read; downstream: render banner + reviewed-snapshot manifest suppression.
  snapshotUnstable?: { recaptures: number };
  // Per-file manifest captured inside the accepted verification round. null means
  // the capture remained unstable, so downstream identity/delta optimizations
  // must stay disabled.
  capturedSnapshotFiles: Record<string, SnapshotFileEntry> | null;
  // #7: set when the pre-review settle-check hit its cap without the working tree
  // going quiet (a writer was still active). Render-only banner downstream.
  workspaceUnsettled?: { last_write_ms_ago: number; waited_ms: number };
  // Slice A (P1): files FOREIGN to this session (in its baseline, unchanged since, not
  // tool-owned) → demoted to advisory in the aggregator. null = no scoping (no session_id /
  // empty baseline / synthesized-flag review) → full review (fail-closed). Folded into the
  // review cache key so a scoped result can't be served to a differently-scoped run.
  foreignFiles?: Set<string> | null;
  // S2 (field report 2026-06-23): the session_id + working-tree-dirty snapshot for the orchestrator
  // to compute the sound uncommitted-attribution set over facts.files. null when scoping is off, no
  // session_id, or the dirtyNow snapshot failed (→ no attribution → out-of-session disown unavailable).
  attribution?: { sessionId: string; dirtyNow: string[] } | null;
}

// Everything produced by the pre-loop setup phase, bundled so it can be computed
// inside a SINGLE bounded block (shared setup deadline) — see runStopGate.
interface SetupBundle {
  host: ReturnType<typeof detectHostModel>;
  adapters: ReturnType<typeof buildAdapters>;
  ctx: ReviewContext;
  // Dogfood F-001: the working-tree fingerprint hashed ONCE, immediately after
  // gatherReviewContext (i.e. the tree the reviewed diff was computed from). All
  // LoopDriver tree-hash writes use THIS memoized value — hashing fresh at
  // state-write time (post-review) would bless a concurrent session's mid-review
  // Bash edit as reviewed-through and the next Stop would skip-clean over it.
  snapshotTree: string | null;
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
  // Test seam for the paired snapshot verification (dwell/rounds/clock): the
  // REAL 2s dwell would push every gate-invoking unit test past bun's 5s
  // per-test cap. Merged over the production wiring; deadlineAt stays the
  // gate's own setup deadline unless explicitly overridden.
  snapshotVerifyOpts?: SnapshotVerifyOpts;
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

// Slice 3 (field report #6): pure predicate for the large-diff warning. Counts FILES via
// raw `diff --git ` headers — NOT computeDiffFacts (which filters renames/binary/mode-only
// and would undercount operational diff size). Bytes via UTF-8 length. A threshold of 0
// disables that check. Returns the counts when over either limit, else undefined.
export function computeLargeDiff(
  diff: string,
  diffWarnBytes: number,
  diffWarnFiles: number,
): { files: number; bytes: number } | undefined {
  const bytes = Buffer.byteLength(diff, "utf8");
  const files = (diff.match(/^diff --git /gm) ?? []).length;
  const over =
    (diffWarnBytes > 0 && bytes > diffWarnBytes) || (diffWarnFiles > 0 && files > diffWarnFiles);
  return over ? { files, bytes } : undefined;
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

// Decide what to do when flock() failed to acquire the gate lock (F-002). ONLY
// genuine CONTENTION (a FlockTimeoutError — timed out waiting on a live holder)
// DEFERS, and only if the deferred-review marker can be durably written (else the
// eventual-review guarantee is void). A lock-SYSTEM failure (EACCES/ENOSPC/
// unwritable .reviewgate — flock rethrew a raw fs error, NOT a timeout) means we
// have no reliable lock and likely can't persist a marker → FAIL CLOSED, never
// allow an unreviewed turn. M-A3: name the holder so a human can kill a hung one.
export function lockContentionDecision(repoRoot: string, err: unknown): GateOutput {
  if (!(err instanceof FlockTimeoutError)) {
    const msg = err instanceof Error ? err.message : String(err);
    const reason = `🔴 Reviewgate · GATE CLOSED — could not acquire the gate lock (lock-system error: ${msg}). Failing closed (this is not normal contention). Ensure .reviewgate is writable, then re-run; \`reviewgate doctor\` for diagnostics.`;
    return { exitCode: 0, stdout: JSON.stringify({ decision: "block", reason }), stderr: reason };
  }
  // Genuine contention → DEFER, but only with a durable retry marker.
  let markerWritten = false;
  try {
    writeFileAtomic(deferredFlagPath(repoRoot), JSON.stringify({ ts: new Date().toISOString() }), {
      mode: 0o600,
    });
    markerWritten = true;
  } catch {
    markerWritten = false;
  }
  if (!markerWritten) {
    const reason =
      "🔴 Reviewgate · GATE CLOSED — the gate lock is contended AND the deferred-review marker could not be written; failing closed rather than ending the turn unreviewed. Re-run; ensure .reviewgate is writable.";
    return { exitCode: 0, stdout: JSON.stringify({ decision: "block", reason }), stderr: reason };
  }
  const reason = `🟠 Reviewgate · GATE DEFERRED — another review${formatLockHolder(repoRoot)} is in progress; this turn was not reviewed and is NOT blocked. Your change stays flagged and is reviewed automatically on your next turn.`;
  return { exitCode: 0, stdout: "", stderr: reason };
}

// M-A1: cheap "is there anything to review?" probe, run BEFORE the gate lock so a
// pure read/analysis turn (no dirty.flag AND HEAD unchanged since the last review
// AND the working tree is byte-identical to the last review, S1) short-circuits to
// allow_stop WITHOUT acquiring the global lock or doing git/pipeline work —
// removing lock contention for parallel sessions on one checkout. Preserves
// HEAD-advance review: if HEAD moved past the last reviewed sha (e.g. work
// committed via Bash with no Edit/Write), returns "review" so the lock path runs
// the HEAD-advanced synthesis. State is read WITHOUT the lock — StateStore writes
// are atomic (tmp+rename) so there's no torn read, and a stale read only ever errs
// toward taking the lock (safe). headShaFn/treeHashFn are injectable for tests.
//
// S1: closes the Bash-mutation bypass — an uncommitted edit made via a shell tool
// (sed -i / tee / git apply, ...) leaves NO dirty.flag and does NOT move HEAD, so
// the old HEAD-only fast-exit skipped it entirely (unreviewed code ships,
// core-loop#2). The probe now additionally compares a content-true working-tree
// fingerprint (workingTreeStateHash, Task 1) recorded at the last review against
// the CURRENT one; only an exact match on BOTH HEAD and tree fast-exits.
export type StopProbeResult = "review" | "skip-clean" | "skip-escalated";

export async function stopProbe(
  repoRoot: string,
  headShaFn: typeof gitHeadSha = gitHeadSha,
  treeHashFn: (repoRoot: string) => Promise<string | null> = workingTreeStateHash,
): Promise<StopProbeResult> {
  // A pending deferred review (M-A2) always needs the lock path — never skip it.
  if (existsSync(deferredFlagPath(repoRoot))) return "review";
  if (existsSync(dirtyFlagPath(repoRoot))) return "review";
  try {
    const st = await new StateStore(repoRoot).load();
    // Round-5 W1: resolve HEAD exactly ONCE per probe execution and use that
    // value in EVERY branch (including Task 5's escalated branch) — two reads
    // racing a concurrent commit could compare tree and HEAD from different
    // instants (stand down over new work, or spuriously re-review).
    const sha = await headShaFn(repoRoot);
    // S3b standing-down: the escalation handed this range to the human; with no
    // new flag and BOTH head and tree unmoved since the announce there is
    // nothing to (re-)review — but the stop must not read as a green "no
    // changes" either. The caller prints the loud escalated variant. HEAD moved
    // past the announce sha OR the tree changed (a post-escalation Bash
    // mutation — round-2 C1) OR either hash unknowable → "review" (lock path:
    // Path-A recovery / synthesis of the new work).
    if (st.escalated && st.escalation_announced) {
      // Round-13 W1: the persistent-quota latch NEVER stands down — its whole
      // design routes every stop through the lock path into handleAllQuotaLocked
      // (bounded defer + provider-recovery check). Even if the dirty flag were
      // lost despite Task 7's keep-invariant, the probe must fail toward review.
      if (st.escalation_reason === "quota-exhausted-persistent") return "review";
      // Round-4 W1: standing down is only honest while the handoff artifact
      // actually exists — a deleted/never-written ESCALATION.md means the human
      // was NOT (or is no longer) informed; fail toward the lock path, which
      // re-announces or reviews.
      if (!existsSync(escalationMdPath(repoRoot))) return "review";
      // A null announce-time sha (freshHeadSha git-error at announce) makes the
      // full-match stand-down unreachable — but the escalated state must STILL
      // be captured by this branch: putting the non-null check in the ENTRY
      // guard instead would fall through to the escalation-blind S1 comparison
      // below, which can return "skip-clean" (🟢) on an escalated,
      // un-remediated range — and would silently defeat the two always-review
      // checks above too.
      if (st.escalated_head_sha === null) return "review";
      if (sha !== st.escalated_head_sha) return "review"; // `sha` = the probe's single HEAD read (round-5 W1)
      if (st.escalated_tree_hash === null) return "review";
      const tree = await treeHashFn(repoRoot);
      return tree !== null && tree === st.escalated_tree_hash ? "skip-escalated" : "review";
    }
    const last = st.last_reviewed_head_sha;
    // S1: `last === null` no longer fast-exits. Post-reset it is always seeded;
    // null now means "unknown baseline" → let the full (locked) path decide.
    if (last === null) return "review";
    if (sha !== last) return "review"; // HEAD advanced → lock path (synthesis)
    // HEAD unchanged: the old fast-exit here was the Bash-mutation hole — an
    // uncommitted `sed -i`/`tee`/`git apply` edit leaves no dirty flag and no
    // HEAD move. Compare the working-tree fingerprint recorded at the last
    // review; any mismatch or ANY unknown (null) → take the lock path.
    const stored = st.last_reviewed_tree_hash;
    if (stored === null) return "review";
    const current = await treeHashFn(repoRoot);
    return current !== null && current === stored ? "skip-clean" : "review";
  } catch {
    return "review"; // any uncertainty → take the lock and let the full path decide
  }
}

export async function runGate(input: GateInput): Promise<GateOutput> {
  // Triggering must never depend on a valid config. In particular, the edit that
  // MAKES reviewgate.config.ts invalid must still arm the dedicated control-plane
  // flag; loading first would throw and lose that signal.
  if (input.hook === "trigger") {
    await handleTrigger({ repoRoot: input.repoRoot, hookStdinRaw: input.hookStdinRaw });
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  // ONE setup deadline shared across config-load + lock + git setup (M-A0.2 /
  // codex CRITICAL): the per-phase budgets must not each be the full budget, or
  // their SUM (config + lock + git + loop + settle) could exceed the OS Stop-hook
  // timeout → the gate is OS-killed mid-run with empty stdout = fail-open. A
  // shared wall-clock deadline caps config+lock+git COMBINED at setupBudgetMs.
  // Config load runs BEFORE the lock, so a hanging config import (stuck top-level
  // await / wedged fs read) is bounded too; on timeout withTimeout REJECTS →
  // runGateSafe converts it into a fail-closed block (for the stop hook).
  const setupBudgetMs = input.setupBudgetMs ?? SETUP_BUDGET_MS_DEFAULT;
  const setupDeadlineAt = setupBudgetMs > 0 ? Date.now() + setupBudgetMs : null;
  // Tests that inject a config keep their existing seam and intentionally bypass
  // persistent control-plane state. Production always resolves to the approved
  // last-known-good snapshot and reports any candidate separately.
  const policyP: Promise<{ cfg: ReviewgateConfig; policy: ControlPlaneResolution | null }> =
    input.loadConfigFn
      ? input
          .loadConfigFn({
            cwd: input.repoRoot,
            env: process.env as Record<string, string | undefined>,
            home: homedir(),
          })
          .then((cfg) => ({ cfg, policy: null }))
      : resolveControlPlaneConfig({
          cwd: input.repoRoot,
          env: process.env as Record<string, string | undefined>,
          home: homedir(),
        }).then((policy) => ({ cfg: policy.config, policy }));
  const loaded =
    setupDeadlineAt !== null
      ? await withTimeout(policyP, Math.max(1, setupDeadlineAt - Date.now()), "config-load")
      : await policyP;
  const { cfg, policy } = loaded;
  // Enforce config's audit.retentionDays (previously never applied → unbounded
  // growth): the logger prunes day-partitions older than the cutoff on its first
  // append.
  const audit = new AuditLogger(auditDir(input.repoRoot), cfg.audit.retentionDays);

  if (input.hook === "reset") {
    // Take the SAME gate lock the stop path uses before deleting state/decisions/
    // pending: SessionStart reset can race a stop-gate still in flight on the same
    // checkout (parallel session, or a slow prior turn) and rmSync state.json /
    // decisions / pending out from under it → torn reads + a corrupted review. Hold
    // the lock for the (fast, local) reset, then release. On contention we fall back
    // to an UNLOCKED reset (the pre-lock behaviour — never worse) rather than
    // deadlock session start, but bound the wait so a hung holder can't stall it.
    const resetLockMs =
      setupDeadlineAt !== null
        ? Math.min(
            input.lockTimeoutMs ?? GATE_LOCK_ACQUIRE_TIMEOUT_MS,
            Math.max(1, setupDeadlineAt - Date.now()),
          )
        : (input.lockTimeoutMs ?? GATE_LOCK_ACQUIRE_TIMEOUT_MS);
    let resetLock: { release: () => Promise<void> } | null = null;
    let stderr = "";
    try {
      resetLock = await flock(gateLockPath(input.repoRoot), resetLockMs);
    } catch {
      stderr =
        "🟠 Reviewgate · reset ran WITHOUT the gate lock (a review is in flight on this checkout); state may be briefly inconsistent until the in-flight review finishes.";
    }
    try {
      // Pass the SessionStart stdin so handleReset can capture this session's ownership
      // baseline (Slice A / P1) keyed by its session_id.
      await handleReset({ repoRoot: input.repoRoot, hookStdinRaw: input.hookStdinRaw });
    } finally {
      if (resetLock) await resetLock.release();
    }
    // Agent Lessons: after reset (read-only + additive; handleReset already seeded the
    // reviewed-through markers), emit recurring-mistake lessons as SessionStart
    // additionalContext. buildSessionStartInjection NEVER throws and returns "" (a
    // guaranteed no-op) when disabled, not startup/resume, empty, or on ANY error — so
    // reset can never break session startup.
    const source =
      (parseHookStdin(input.hookStdinRaw) as { source?: string } | null)?.source ?? null;
    const stdout = await buildSessionStartInjection({
      repoRoot: input.repoRoot,
      cfg: cfg.phases.agentLessons,
      source,
    });
    return { exitCode: 0, stdout, stderr };
  }

  // hook === 'stop'. M-A1: before taking the (contended, multi-minute) gate lock,
  // skip entirely when there's nothing to review — a pure read/analysis turn with
  // no dirty.flag, an unchanged HEAD, and (S1) an unchanged working-tree fingerprint.
  // This is the common case in a busy multi-session checkout and must not pay lock
  // contention or git/pipeline cost.
  // A config candidate is outside the normal working-tree fingerprint by design,
  // so it explicitly forces the lock path. This covers Edit and Bash mutations,
  // committed and uncommitted, without feeding config source to reviewers.
  const probe = policy?.change ? "review" : await stopProbe(input.repoRoot);
  if (probe === "skip-clean") {
    return {
      exitCode: 0,
      stdout: "",
      stderr: "🟢 Reviewgate · GATE OPEN — No code changes since last review.",
    };
  }
  if (probe === "skip-escalated") {
    // stopProbe's escalated standing-down branch (escalated + HEAD/tree unmoved
    // since the announce) PRODUCES this value; mapped here — never silently
    // falls through to the green message. Exact copy per the plan (2026-07-03
    // fail-open-remediation.md, Task 5 Step 3a).
    return {
      exitCode: 0,
      stdout: "",
      stderr:
        "🟠 Reviewgate · GATE STANDING DOWN — an escalation is pending human review (.reviewgate/ESCALATION.md). The escalated change-set has NOT been machine-reviewed; new work will re-arm the gate.",
    };
  }
  // probe === "review" → fall through to the lock path below.

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
  } catch (err) {
    return lockContentionDecision(input.repoRoot, err);
  }
  try {
    // M-A2: we hold the lock → any prior contention is resolved. Consume a
    // deferred.flag left by an earlier contended turn so it can't loop. If the
    // dirty.flag was already cleared by whichever session won the lock last time,
    // synthesize one so the deferred change still gets a (working-tree) review.
    consumeDeferredFlag(input.repoRoot);
    return await runStopGate(input, cfg, audit, setupDeadlineAt, policy);
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
          // F-015: a synthesized flag has no known clean→dirty transition time.
          // Carry the explicit no-scoping sentinel so a later handleTrigger
          // PRESERVES it instead of back-dating only 30s from the next edit —
          // which would silently scope batch-created untracked files OUT of the
          // re-review while keeping the old base_sha.
          base_ts: BASE_TS_NO_SCOPING_SENTINEL,
        }),
        { mode: 0o600 },
      );
    } catch {
      // Synthesis failed → do NOT consume the marker. Keeping deferred.flag forces
      // the next stop to retry (stopProbe keeps returning "review"), so the change
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
// stderr and exits 1 with EMPTY stdout, which the host Stop-hook protocol can
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

// Snapshot-race verification (Dealbarg field incident 2026-07): dwell between
// paired verify rounds. A transient in-place mutation (apply → test → restore)
// shorter than the dwell can never satisfy two consecutive rounds, so it is
// detected and re-captured instead of reviewed. Defense-in-depth, NOT a
// guarantee — a mutation held across the ENTIRE verified window is
// indistinguishable from real state (the guaranteed fix is cooperating
// isolation: run mutation tests in a copy/worktree, never in-place concurrently
// with turn-end).
export const SNAPSHOT_VERIFY_DWELL_MS = 2000;
// Verification re-reads after round 0. Exhausting them with the tree still
// changing between reads → snapshotUnstable (banner + manifest suppression).
export const SNAPSHOT_VERIFY_MAX_ROUNDS = 3;

// Test seams + budget wiring for the paired verify rounds. All optional —
// production callers pass only deadlineAt (the shared setup deadline).
export interface SnapshotVerifyOpts {
  treeHashFn?: typeof workingTreeStateHash;
  snapshotFilesFn?: typeof snapshotReviewedFiles;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  // Epoch ms of the setup deadline; null/absent = no budget. The guard stops
  // verifying BEFORE starting a read that cannot fit (silent unverified path —
  // status-quo behavior), so verification never turns a slow-but-working setup
  // into a fail-closed block.
  deadlineAt?: number | null;
  dwellMs?: number;
  maxRounds?: number;
}

function snapshotFilesEqual(
  left: Record<string, SnapshotFileEntry>,
  right: Record<string, SnapshotFileEntry>,
): boolean {
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every((path) => {
    if (!Object.hasOwn(right, path)) return false;
    const a = left[path];
    const b = right[path];
    return a?.status === b?.status && a?.hash === b?.hash;
  });
}

// Pre-deadline setup: resolve the review base + collect the diff (incl. the
// HEAD-advanced synthesis path). Extracted so runStopGate can bound it with a
// setup budget (M-A0.2). The git helpers are injected so the budget path can be
// exercised deterministically in tests.
export async function gatherReviewContext(
  input: GateInput,
  state: StateStore,
  gitInfoFn: typeof collectGitInfo,
  diffFn: typeof collectDiff,
  settleBeforeReview: boolean,
  scopeToSession = false,
  verifyOpts: SnapshotVerifyOpts = {},
): Promise<ReviewContext> {
  const gitInfo = await gitInfoFn(input.repoRoot);
  // #7: before snapshotting the working tree (either diffFn call below), wait
  // (bounded ≤ SETTLE_MAX_MS) for it to stop changing so we don't review a
  // half-written state. Best-effort and fail-safe — it NEVER blocks/skips the
  // review; on a churning tree it only records a banner. Runs inside the gate's
  // setup budget; a thrown error is swallowed (review proceeds, no banner).
  let workspaceUnsettled: { last_write_ms_ago: number; waited_ms: number } | undefined;
  if (settleBeforeReview) {
    try {
      const r = await awaitWorkspaceSettle({
        repoRoot: input.repoRoot,
        quietWindowMs: SETTLE_QUIET_WINDOW_MS,
        settleIntervalMs: SETTLE_INTERVAL_MS,
        maxSettleMs: SETTLE_MAX_MS,
        now: () => Date.now(),
        sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
      });
      if (!r.settled)
        workspaceUnsettled = { last_write_ms_ago: r.lastWriteMsAgo, waited_ms: r.waitedMs };
    } catch {
      /* best-effort: a settle failure must never block or skip the review */
    }
  }
  // Review base: the pre-batch HEAD captured in dirty.flag, so commit-per-task
  // work (committed mid-batch) is reviewed too — not just the working tree.
  const dp = dirtyFlagPath(input.repoRoot);
  const hasDirtyFlag = existsSync(dp);
  let reviewBase: string | null = null;
  // Batch-start timestamp from dirty.flag — scopes OUT pre-existing untracked files
  // in collectDiff. Null on the HEAD-advanced path (no dirty.flag) → all untracked
  // reviewed there, which is correct (committed/merged work, not a dirty tree).
  let reviewBaseTs: string | null = null;
  // Reused when the HEAD-advanced path already computed the since-base diff, so
  // the gate doesn't run collectDiff twice for the same base.
  let precomputedDiff: string | undefined;
  // Wall-clock cost of that precompute — folded into the verify budget guard's
  // round-0 estimate when the precomputed diff is reused, since the reused
  // round 0 then times only the (near-clean-tree) hash while a verify round
  // costs a full diff+hash pair (round-2 plan review).
  let precomputedMs = 0;
  // Set when the dirty.flag could not be parsed (truncated / half-written / hand-
  // edited). Forces diffIncomplete downstream so reviewers don't trust the diff as
  // a complete picture (we recovered the widest base we could, but the captured
  // batch scope is lost).
  let dirtyFlagUnparsed = false;
  if (hasDirtyFlag) {
    try {
      const flag = JSON.parse(readFileSync(dp, "utf8")) as { base_sha?: string; base_ts?: string };
      reviewBase = flag.base_sha ?? null;
      reviewBaseTs = flag.base_ts ?? null;
    } catch {
      // A corrupt dirty.flag must NOT silently narrow the review to the working
      // tree only — that would DROP any commit-per-task work landed mid-batch
      // (fail-open: unreviewed committed code ships). Fail toward MORE coverage:
      // fall back to the last reviewed sha as the base (covers committed +
      // uncommitted since the last review), reviewing ALL untracked files
      // (reviewBaseTs stays null → no mtime scoping). With no prior review, base
      // stays null (working-tree) — but we still flag the diff incomplete so the
      // narrowing is surfaced to reviewers rather than trusted as complete.
      dirtyFlagUnparsed = true;
      reviewBaseTs = null;
      try {
        const st = await state.load();
        reviewBase = st.last_reviewed_head_sha ?? null;
      } catch {
        reviewBase = null;
      }
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
    // S1: also fires when HEAD did NOT move — an uncommitted Bash-tool edit
    // (no PostToolUse, no dirty flag) reaches here via the tree-hash probe in
    // stopProbe. collectDiff(base=last) covers committed AND
    // uncommitted (+ untracked) work since the last review, so one call handles
    // both the HEAD-advance and the dirty-tree case. Reaching this line at all
    // means the fast-exit already saw a change; the extra diff is not wasted.
    const precomputeStart = Date.now();
    const sinceLast = gitInfo.sha && last ? await diffFn(input.repoRoot, last) : "";
    precomputedMs = Date.now() - precomputeStart;
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
            // F-015: same no-scoping sentinel as the deferred-flag synthesis —
            // this path deliberately reviews ALL untracked files (reviewBaseTs
            // stays null below), and the persisted flag must keep that scope on
            // re-review instead of letting the next trigger back-date a fresh
            // batch-start beside the old base_sha.
            base_ts: BASE_TS_NO_SCOPING_SENTINEL,
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
  // --- Paired verified snapshot (Dealbarg field incident 2026-07) ---
  // A single read of the live working tree is not a safe review input: a parallel
  // writer (an in-place mutation test, codegen) can transiently mutate files and
  // restore them, and a capture landing inside that window reviews a state that
  // never corresponded to any commit → phantom findings. The pre-capture
  // settle-check cannot catch this (an applied-and-held mutation looks QUIET).
  // Each round samples BOTH artifacts — the review diff and the working-tree
  // fingerprint plus the per-file identity manifest — and the capture is accepted
  // only when two consecutive rounds agree on all three, separated by a dwell (a
  // transient shorter than the dwell can never satisfy both rounds). Convergence
  // re-captures the restored true state.
  // Exits:
  //   verified  — consecutive rounds agreed; blessed hash = same round as diff.
  //   unverified (silent, status-quo) — diff marked incomplete (positional check;
  //     doubling a capped 60s collection could blow the setup budget), budget
  //     guard fired, or fingerprint indeterminate (null) with agreeing diffs.
  //   unstable  — rounds exhausted while still flapping → ship the LATEST pair +
  //     banner + reviewed-snapshot manifest suppression downstream.
  const treeHashFn = verifyOpts.treeHashFn ?? workingTreeStateHash;
  const snapshotFilesFn = verifyOpts.snapshotFilesFn ?? snapshotReviewedFiles;
  const vSleep =
    verifyOpts.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
  const vNow = verifyOpts.now ?? Date.now;
  const vDeadlineAt = verifyOpts.deadlineAt ?? null;
  const dwellMs = verifyOpts.dwellMs ?? SNAPSHOT_VERIFY_DWELL_MS;
  const requestedMaxRounds = verifyOpts.maxRounds ?? SNAPSHOT_VERIFY_MAX_ROUNDS;
  const maxRounds = Number.isFinite(requestedMaxRounds)
    ? Math.max(1, Math.floor(requestedMaxRounds))
    : SNAPSHOT_VERIFY_MAX_ROUNDS;
  const round0Start = vNow();
  let diff = precomputedDiff ?? (await diffFn(input.repoRoot, reviewBase, undefined, reviewBaseTs));
  let snapshotTree = await treeHashFn(input.repoRoot);
  let capturedSnapshotFiles = snapshotFilesFn(
    input.repoRoot,
    computeDiffFacts(diff).files.map((file) => file.path),
  );
  const round0Ms = vNow() - round0Start + (precomputedDiff !== undefined ? precomputedMs : 0);
  let snapshotUnstable: { recaptures: number } | undefined;
  let snapshotVerified = false;
  let recaptures = 0;
  let mismatchSeen = false;
  for (;;) {
    // Incompleteness FIRST (codex step-2 W2): a diff that came back truncated —
    // including one returned by the FINAL allowed re-capture — ends verification
    // silently. Collection jitter (the truncation trailer flapping in and out of
    // consecutive reads) must never masquerade as a concurrent-writer banner;
    // the diffIncomplete path already trust-limits everything downstream.
    if (diffMarkedIncomplete(diff)) break;
    if (recaptures >= maxRounds) {
      snapshotUnstable = { recaptures };
      break;
    }
    if (vDeadlineAt !== null && vDeadlineAt - vNow() < dwellMs + 2 * round0Ms) {
      // Budget exhausted (codex step-2 W1): if churn was already OBSERVED, a
      // silent exit would let the reviewed-snapshot artifacts be seeded off a
      // tree we KNOW was changing — take the unstable path instead. Only a
      // budget exit with zero observed mismatches stays silent (unverified).
      if (mismatchSeen) snapshotUnstable = { recaptures };
      break;
    }
    await vSleep(dwellMs);
    const d = await diffFn(input.repoRoot, reviewBase, undefined, reviewBaseTs);
    const h = await treeHashFn(input.repoRoot);
    const files = snapshotFilesFn(
      input.repoRoot,
      computeDiffFacts(d).files.map((file) => file.path),
    );
    const diffAgrees = d === diff;
    const hashAgrees = h !== null && h === snapshotTree;
    const filesAgree = snapshotFilesEqual(files, capturedSnapshotFiles);
    const hashIndeterminate = h === null || snapshotTree === null;
    diff = d;
    snapshotTree = h;
    capturedSnapshotFiles = files;
    if (diffAgrees && hashAgrees && filesAgree) {
      snapshotVerified = true;
      break;
    }
    // Agreeing diffs but an indeterminate fingerprint: nothing observably flapped,
    // we just cannot PROVE stability — silent unverified, never the unstable banner.
    if (diffAgrees && filesAgree && hashIndeterminate) break;
    mismatchSeen = true;
    recaptures++;
  }
  // Slice A (P1): files FOREIGN to this session (byte-identical to its SessionStart baseline,
  // not tool-owned). Computed from the per-session manifest, keyed by the session_id in the
  // Stop stdin. No session_id / empty baseline (single-agent, clean start) / scoping disabled
  // → null = full review (fail-closed). Committed/HEAD-advanced files are never in the
  // working-tree baseline → never foreign, so the synthesized-diff paths are safe unchanged.
  let foreignFiles: Set<string> | null = null;
  let attribution: { sessionId: string; dirtyNow: string[] } | null = null;
  if (scopeToSession) {
    try {
      const parsedForScope = parseHookStdin(input.hookStdinRaw) as { session_id?: unknown } | null;
      const sessionId =
        typeof parsedForScope?.session_id === "string" ? parsedForScope.session_id : "";
      if (sessionId) {
        const set = computeForeignFiles(input.repoRoot, sessionId);
        if (set.size > 0) foreignFiles = set;
        // S2: snapshot the working-tree-dirty set so the orchestrator can compute the SOUND
        // uncommitted-attribution set over its facts.files. A dirtyNow snapshot FAILURE is
        // fail-CLOSED for attribution: without it we can't prove which files the session has
        // uncommitted skin in, so we disable the out-of-session disown entirely (attribution=null
        // → whole_diff_attributable absent → disown unavailable) rather than risk an empty
        // dirtyNow making the agent's own Bash-edited-but-uncommitted file look disownable.
        try {
          const dirtyNow = await workingTreeDirtyFiles(input.repoRoot);
          attribution = { sessionId, dirtyNow };
        } catch {
          attribution = null;
        }
      }
    } catch {
      foreignFiles = null; // any failure → no scoping → full review (fail-closed)
      attribution = null;
    }
  }
  return {
    gitInfo,
    diff,
    reviewBase,
    diffIncomplete: dirtyFlagUnparsed,
    // Unstable capture (codex step-2 C2): within one round the diff and the hash
    // are read sequentially, so with ZERO agreement evidence the final H may
    // fingerprint a DIFFERENT state than the shipped diff (writer raced between
    // the two reads) — blessing it could record a never-reviewed state as
    // reviewed-through and let the next Stop skip-clean over it. Ship null
    // instead: consumers treat null as "changed" (fail toward review).
    snapshotTree: snapshotUnstable ? null : snapshotTree,
    ...(snapshotUnstable ? { snapshotUnstable } : {}),
    // Delta/content-identity state is a new optimization and has no legacy
    // unverified mode: persist it only after the full triple agreed. Budget,
    // incomplete, and indeterminate-fingerprint exits explicitly disable it.
    capturedSnapshotFiles: snapshotVerified ? capturedSnapshotFiles : null,
    ...(workspaceUnsettled ? { workspaceUnsettled } : {}),
    foreignFiles,
    attribution,
  };
}

// The stop-hook review pipeline, run under the gate lock by runGate. Split out so
// the lock acquire/release wraps the entire body without re-indenting it.
async function runStopGate(
  input: GateInput,
  cfg: ReviewgateConfig,
  audit: AuditLogger,
  // Shared setup deadline (epoch ms) started in runGate before config-load; null
  // when the budget is disabled. The git setup uses the time REMAINING until it,
  // so config + lock + git together never exceed setupBudgetMs (codex CRITICAL).
  setupDeadlineAt: number | null,
  policy: ControlPlaneResolution | null,
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
      const ctx = await gatherReviewContext(
        input,
        state,
        gitInfoFn,
        diffFn,
        cfg.phases.review.settleBeforeReview ?? false,
        cfg.phases.review.scopeToSession ?? true,
        // Budget wiring for the paired verify rounds: the guard stops verifying
        // before starting a read that can't fit the shared setup deadline.
        // Test-seam overrides (dwell/rounds/clock) merge over it.
        { deadlineAt: setupDeadlineAt, ...input.snapshotVerifyOpts },
      );
      // Dogfood F-001 + snapshot-race fix: "reviewed-through" records the tree
      // fingerprint sampled in the SAME verify round as the shipped diff (inside
      // gatherReviewContext) — never a fresh post-review hash, which would bless
      // a concurrent session's mid-review edit as reviewed (stored == post-edit
      // tree → the next Stop skip-cleans, fail-open). The old residual
      // micro-window (ticket 1: an edit landing between collectDiff and a later
      // separate hash) is closed in the verified-stable case by the same-round
      // pairing; in the unverified/unstable cases the binding is single-round —
      // no worse than the old behavior, with the unstable case additionally
      // suppressing the reviewed-snapshot manifest downstream.
      const snapshotTree = ctx.snapshotTree;
      return { host, adapters, ctx, snapshotTree };
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
  const { host, adapters, ctx, snapshotTree } = setup;
  const { gitInfo, diff, reviewBase, workspaceUnsettled, foreignFiles, attribution } = ctx;

  // S1-C1 BELT (codex CRITICAL, reviewed 2026-07-03): gatherReviewContext can hand
  // back a correctly populated, non-empty `diff` WITHOUT a dirty.flag ever landing
  // on disk — either because last_reviewed_head_sha was null (the null-last branch's
  // `sinceLast` short-circuits to "" so its persistence write never even runs) or
  // because that write silently FAILED (ENOSPC/EACCES, swallowed by the try/catch in
  // gatherReviewContext). LoopDriver.run() independently RE-READS the flag from disk
  // and green-allows ("No code changes since last review") when it finds none — so a
  // diff that only ever existed in THIS function's memory would ship unreviewed even
  // though the Orchestrator below is built with the correct diff. Belt: whenever we're
  // holding a non-empty diff and no flag is on disk at this point, synthesize one now.
  // If that write ALSO fails, fail CLOSED instead of letting the driver's disk read
  // silently win. This single check covers both origin cases — no per-branch fix
  // needed upstream.
  //
  // base_sha: preserve the last-reviewed base whenever the state knows it. A
  // base-LESS flag scopes the NEXT cycle to working-tree-only — fine when `last`
  // is null (there IS no wider base), but when `last` is non-null (the
  // failed-synthesis origin) it would silently DROP committed last..HEAD work
  // from the follow-up cycle's scope if THIS turn's review FAILs (the flag
  // survives a FAIL and becomes that cycle's review base) — a fail-open one
  // cycle later. Same conditional shape as handleTrigger/consumeDeferredFlag:
  // base_sha present iff known. An unreadable state here (pathological — setup
  // just loadOrRecover'd it) degrades to the base-less flag, never skips the belt.
  //
  // Write protocol (dirty-flag-race-clobber, codex CRITICAL 2026-07-03): the write
  // MUST be an atomic CREATE-IF-ABSENT (writeFileIfAbsent — tmp + link(2), the
  // flock.ts protocol), NOT check-then-writeFileAtomic. PostToolUse triggers are
  // not serialized by the gate lock, so a concurrent session's trigger can land a
  // fresh dirty.flag between our existsSync check above and the write — a rename
  // would CLOBBER that newer flag with our synthesized one, whose diff was computed
  // BEFORE the concurrent edit; a later clean-pass tree hash could then record the
  // post-edit tree as reviewed and the next Stop would fast-exit over code no panel
  // ever saw. On EEXIST (writeFileIfAbsent returns false) we neither clobber nor
  // fail-close: the concurrent flag is newer truth, the driver gates on whatever is
  // on disk, and the F-005 compare-and-delete already preserves a flag rewritten
  // mid-review for the next stop. Only a real write failure keeps the fail-closed
  // block below.
  if (diff.trim().length > 0 && !existsSync(dirtyFlagPath(input.repoRoot))) {
    let lastReviewed: string | null = null;
    try {
      lastReviewed = (await state.load()).last_reviewed_head_sha ?? null;
    } catch {
      lastReviewed = null;
    }
    try {
      writeFileIfAbsent(
        dirtyFlagPath(input.repoRoot),
        JSON.stringify({
          diff_hash: gitInfo.sha.slice(0, 16),
          ts: new Date().toISOString(),
          ...(lastReviewed ? { base_sha: lastReviewed } : {}),
          base_ts: BASE_TS_NO_SCOPING_SENTINEL,
        }),
        { mode: 0o600 },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const reason = `🔴 Reviewgate · GATE CLOSED — a non-empty diff could not be flagged for review (dirty.flag persistence failed: ${msg}). Failing closed rather than let this turn end unreviewed. Ensure .reviewgate is writable, then re-run; \`reviewgate doctor\` for diagnostics.`;
      return { exitCode: 0, stdout: JSON.stringify({ decision: "block", reason }), stderr: reason };
    }
  }

  // Slice 3: warn EARLY (stderr survives a self-deadline abort that writes no pending.md)
  // when the diff is large enough to risk a timeout. This runs in the gate, OUTSIDE the
  // loop self-deadline (which wraps only LoopDriver→runIteration). WARN-only — never
  // auto-scales the timeout (could exceed the OS Stop-hook timeout → fail-open).
  const largeDiff = computeLargeDiff(diff, cfg.loop.diffWarnBytes, cfg.loop.diffWarnFiles);
  if (largeDiff) {
    console.warn(
      `🟡 Reviewgate · Large diff: ${largeDiff.files} files / ${Math.round(
        largeDiff.bytes / 1000,
      )} KB — if the review times out, raise loop.runTimeoutMs AND the Stop-hook timeout (both).`,
    );
  }
  // A corrupt dirty.flag (ctx.diffIncomplete) OR a collectDiff-truncation trailer
  // both mean the diff isn't a trustworthy complete picture.
  const diffIncomplete = ctx.diffIncomplete || diffMarkedIncomplete(diff);
  const orchestrator = new Orchestrator({
    repoRoot: input.repoRoot,
    config: cfg,
    adapters,
    // Same hash-chained logger the LoopDriver uses, so the curator's egress events
    // and the gate's run events share one intact chain (F-028).
    audit,
    sandboxMode: input.sandboxModeOverride ?? cfg.sandbox.mode,
    hostTier: host.tier,
    agentHost: host.agentHost,
    diff,
    gitInfo,
    reasonOnFailEnabled: true,
    reviewBaseSha: reviewBase,
    // Partial-diff guard: surfaced to reviewers as trusted context (not buried in
    // the untrusted fence) so a truncated/timed-out diff — or one recovered after a
    // corrupt dirty.flag — isn't trusted as complete.
    diffIncomplete,
    ...(largeDiff ? { largeDiff } : {}),
    ...(workspaceUnsettled ? { workspaceUnsettled } : {}),
    // Snapshot-race: unstable capture → banner + reviewed-snapshot suppression.
    ...(ctx.snapshotUnstable ? { snapshotUnstable: ctx.snapshotUnstable } : {}),
    // Bind delta/content-identity state to the exact manifest sampled inside the
    // accepted diff/tree verification round. null explicitly disables it.
    capturedSnapshotFiles: ctx.capturedSnapshotFiles,
    // Slice A (P1): files this session did not author → demoted to advisory in the aggregator.
    ...(foreignFiles ? { foreignFiles } : {}),
    // S2: session_id + dirtyNow snapshot → orchestrator stamps session_attributable / whole_diff_attributable.
    ...(attribution ? { attribution } : {}),
  });

  const driver = new LoopDriver({
    repoRoot: input.repoRoot,
    config: cfg,
    state,
    audit,
    orchestrator,
    stopHookActive: stopHookActiveFlag(parsedStdin),
    headSha: gitInfo.sha,
    // S1 + dogfood F-001: the DIFF-SNAPSHOT-TIME fingerprint, memoized once right
    // after gatherReviewContext (the tree the reviewed diff was computed from).
    // Previously computed FRESH at state-write time — which blessed a concurrent
    // session's mid-review Bash edit as reviewed-through. Every driver write site
    // (head-move record, post-review write, escalation announce) flows through
    // this same snapshot — see LoopInput.treeHash and SetupBundle.snapshotTree.
    treeHash: async () => snapshotTree,
    // S3b (round-14 W1): resolved FRESH at escalation-announce time, not reused
    // from gitInfo.sha (captured at gate start) — see LoopInput.freshHeadSha.
    freshHeadSha: () => gitHeadSha(input.repoRoot),
  });
  const decision = await driver.run();

  if (decision.kind === "block") {
    let policyNotice = "";
    if (policy?.change) {
      if (decision.policyReviewPassed === true && policy.change.classification !== "invalid") {
        // A clean PASS/SOFT-PASS under LKG that acknowledgePass/forceSoftAck rendered
        // as a block must STILL finalize the control-plane review — mirroring the
        // allow_stop path below — or a pending candidate never reaches
        // reviewed_under_lkg and `reviewgate config approve` deadlocks (FlashBuddy bug).
        const finalized = await finalizeControlPlaneReview(input.repoRoot, policy, {
          env: process.env as Record<string, string | undefined>,
          home: homedir(),
        });
        if (finalized.kind === "auto-approved") {
          policyNotice = `\n\n🔐 Gate policy ${finalized.classification === "strengthening" ? "strengthening" : "source-equivalent change"} adopted after this pass under the prior approved policy.`;
        } else if (
          finalized.kind === "approval-required" ||
          finalized.kind === "invalid" ||
          finalized.kind === "changed-during-review"
        ) {
          policyNotice = `\n\n${finalized.message}`;
        }
        // "unchanged" (candidate reverted to LKG mid-batch) → no notice needed.
      } else {
        policyNotice = `\n\n🔐 Gate policy candidate remains pending. Code is still being reviewed under approved policy ${policy.approvedEffectiveFingerprint.slice(0, 12)}; details: ${policyChangeReportPath(input.repoRoot).replace(`${input.repoRoot}/`, "")}.`;
      }
    }
    const reason = `${decision.reason}${policyNotice}`;
    if (cfg.notify.desktop) notifyDesktop("Reviewgate", reason);
    return {
      exitCode: 0,
      stdout: JSON.stringify({ decision: "block", reason }),
      stderr: reason,
    };
  }

  let signal = decision.reason;
  if (policy) {
    // DEFER/ESCALATION can intentionally be allow_stop without being PASS. Such
    // an outcome must never mark a policy candidate reviewed or auto-adopt it.
    // Invalid candidates are still rendered by finalize below so their precise
    // fail-closed message wins.
    if (
      policy.change &&
      policy.change.classification !== "invalid" &&
      decision.policyReviewPassed !== true
    ) {
      const report = policyChangeReportPath(input.repoRoot).replace(`${input.repoRoot}/`, "");
      const message = `🔐 Reviewgate · GATE POLICY PENDING — the candidate was NOT adopted because the gate did not complete with PASS/SOFT-PASS under the last-known-good policy. ${decision.reason} Details: ${report}`;
      if (cfg.notify.desktop) notifyDesktop("Reviewgate", message);
      return {
        exitCode: 0,
        stdout: JSON.stringify({ decision: "block", reason: message }),
        stderr: message,
      };
    }
    const finalized = await finalizeControlPlaneReview(input.repoRoot, policy, {
      env: process.env as Record<string, string | undefined>,
      home: homedir(),
    });
    if (
      finalized.kind === "approval-required" ||
      finalized.kind === "invalid" ||
      finalized.kind === "changed-during-review"
    ) {
      if (cfg.notify.desktop) notifyDesktop("Reviewgate", finalized.message);
      return {
        exitCode: 0,
        stdout: JSON.stringify({ decision: "block", reason: finalized.message }),
        stderr: finalized.message,
      };
    }
    if (finalized.kind === "auto-approved") {
      signal = `${decision.reason}\n🔐 Gate policy ${finalized.classification === "strengthening" ? "strengthening" : "source-equivalent change"} adopted after this pass under the prior approved policy.`;
    }
  }

  // allow_stop: the summary still goes to stderr so "green" is visible.
  if (cfg.notify.desktop) notifyDesktop("Reviewgate", signal);
  return { exitCode: 0, stdout: "", stderr: signal };
}
