// src/hooks/handlers.ts
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ulid } from "ulid";
import { clearAllProposalPools } from "../core/brain/proposal-store.ts";
import {
  captureSessionBaseline,
  pruneOldSessionManifests,
  recordSessionOwned,
} from "../core/session-manifest.ts";
import { StateStore } from "../core/state-store.ts";
import { normalizeRepoPath } from "../diff/repo-path.ts";
import { ReviewgateStateSchema } from "../schemas/state.ts";
import {
  collectDiff,
  gitHeadSha,
  isExcludedFromReview,
  workingTreeStateHash,
} from "../utils/git.ts";
import {
  decisionsDir,
  deferredFlagPath,
  dirtyFlagPath,
  escalationMdPath,
  pendingJsonPath,
  pendingMdPath,
  proposalsPoolDir,
  reviewgateDir,
  stateJsonPath,
} from "../utils/paths.ts";

export interface TriggerInput {
  repoRoot: string;
  hookStdinRaw: string;
}

// Slice A (P1): the Claude Code session_id carried in every hook's stdin payload, or "" when
// absent (older CLI / unparseable) — in which case the gate fail-closes to a full review.
function sessionIdOf(parsed: unknown): string {
  const o = parsed as { session_id?: unknown } | null;
  return typeof o?.session_id === "string" ? o.session_id : "";
}

// Slice A (P1): the file paths an edit-tool PostToolUse event touched. Covers Write/Edit
// (`file_path`), NotebookEdit (`notebook_path`), and MultiEdit (`edits[].file_path`). Other
// tools (Bash, Read, …) carry none → []; their working-tree effects are caught by the
// content-hash baseline instead (a Bash edit changes the hash → not foreign → reviewed).
function editedPathsOf(parsed: unknown): string[] {
  const ti = (parsed as { tool_input?: Record<string, unknown> } | null)?.tool_input;
  if (!ti || typeof ti !== "object") return [];
  const out: string[] = [];
  const fp = (ti as { file_path?: unknown }).file_path;
  if (typeof fp === "string" && fp) out.push(fp);
  const np = (ti as { notebook_path?: unknown }).notebook_path;
  if (typeof np === "string" && np) out.push(np);
  const edits = (ti as { edits?: unknown }).edits;
  if (Array.isArray(edits)) {
    for (const e of edits) {
      const efp = (e as { file_path?: unknown })?.file_path;
      if (typeof efp === "string" && efp) out.push(efp);
    }
  }
  return out;
}

// base_ts is captured at the FIRST trigger (PostToolUse), which fires AFTER the edit
// that created/modified the file. A brand-new untracked file from that first edit
// therefore has an mtime/ctime a few ms BEFORE the capture — without a margin the
// diff's untracked-file mtime gate (collectDiff) would wrongly exclude the very file
// that STARTED the batch (under-review / fail-open, codex CRITICAL 2026-06-05). We
// back-date base_ts by a margin that comfortably exceeds the edit→trigger latency
// (sub-second, even under load) while still excluding genuinely-stale pre-existing
// files (foreign migrations / caches / *.bak are minutes-to-days old). Over-inclusion
// (reviewing a file created in this window) is SAFE; under-inclusion is the bug.
const BASE_TS_SAFETY_MARGIN_MS = 30_000;

// Epoch-0 base_ts sentinel = "no untracked scoping": collectDiff's mtime/ctime
// gate compares against it and every untracked file passes (over-inclusion, which
// is SAFE — under-inclusion is the bug). Written by the gate's two dirty.flag
// SYNTHESIS paths (deferred-flag consumption + HEAD-advanced trigger, gate.ts),
// where the batch's true clean→dirty transition time is unknown, and by
// handleTrigger below when it inherits an old base_sha that has no base_ts: a
// fresh "now − margin" stamp there would pair an OLD review base with a NEW
// batch-start time, silently scoping batch-created untracked files OUT of the
// re-review (F-015).
export const BASE_TS_NO_SCOPING_SENTINEL = new Date(0).toISOString();

// S3a: the PostToolUse matcher only fires for these tools, each of which carries
// exactly ONE canonical file_path — the shape the excluded-path skip below relies
// on being "fully understood" before it dares to no-op.
const KNOWN_SINGLE_PATH_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export async function handleTrigger(input: TriggerInput): Promise<void> {
  // S3a: an edit that ONLY touches reviewgate-managed/excluded paths (e.g. the
  // decisions file the escalation block message asks the agent to write) is not
  // reviewable work and must not arm the gate — a post-escalation decisions
  // write would otherwise mint a fresh dirty flag at the CURRENT head, re-arm
  // the cycle against an empty diff, and neutralize the escalation with a 🟢.
  // Fail-safe (round-6 W2): the skip requires a FULLY-understood tool shape,
  // not merely "some paths parsed" — a partially-parsed multi-path payload
  // could hide a reviewable path behind an excluded one. Anything else (unknown
  // tool name, missing/extra path fields, unparseable stdin, zero extracted
  // paths) → fall through and arm.
  // (round-8 I1: if editedPathsOf expands MultiEdit per-operation into several
  // entries for the SAME file, dedupe before the length check; if they are
  // genuinely different paths, arming is the correct fail-closed outcome.)
  try {
    const parsed = parseHookStdin(input.hookStdinRaw);
    const toolName =
      typeof (parsed as { tool_name?: unknown } | null)?.tool_name === "string"
        ? ((parsed as { tool_name?: string }).tool_name as string)
        : null;
    const files = [...new Set(editedPathsOf(parsed))];
    const shapeFullyUnderstood =
      toolName !== null && KNOWN_SINGLE_PATH_TOOLS.has(toolName) && files.length === 1;
    if (
      shapeFullyUnderstood &&
      files.every((f) => isExcludedFromReview(normalizeRepoPath(f, input.repoRoot)))
    ) {
      return;
    }
  } catch {
    /* fall through: arm the flag (fail toward review) */
  }

  const dir = reviewgateDir(input.repoRoot);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const diffHash = createHash("sha256").update(input.hookStdinRaw).digest("hex").slice(0, 16);
  const p = dirtyFlagPath(input.repoRoot);
  // Capture the review BASE = HEAD at the FIRST edit of this batch (clean→dirty
  // transition). Preserve it across subsequent edits AND any commits the agent
  // makes mid-batch, so the gate reviews `git diff <base>` (committed +
  // uncommitted since then), not just the now-clean working tree.
  let baseSha: string | null = null;
  // Batch-start timestamp: captured at the clean→dirty transition (first edit) and
  // preserved across the batch exactly like base_sha. The gate uses it to scope OUT
  // pre-existing untracked files (those whose mtime predates the batch — the agent
  // never touched them). Distinct from `ts` below, which is the LAST edit's time.
  let baseTs: string | null = null;
  if (existsSync(p)) {
    try {
      const prev = JSON.parse(readFileSync(p, "utf8")) as { base_sha?: string; base_ts?: string };
      baseSha = prev.base_sha ?? null;
      baseTs = prev.base_ts ?? null;
    } catch {
      baseSha = null;
      baseTs = null;
    }
  }
  // Whether the existing flag already carried a review base: then THIS trigger is
  // NOT the batch's clean→dirty transition, so it must never stamp a fresh
  // batch-start time (F-015) — see below.
  const inheritedBaseSha = baseSha !== null;
  if (!baseSha) baseSha = await gitHeadSha(input.repoRoot);
  const nowIso = new Date().toISOString();
  if (!baseTs) {
    // base_ts absent. Two cases:
    //  • Fresh capture (no prior base_sha → this IS the clean→dirty transition):
    //    stamp now − margin so a file created by THIS triggering edit is not
    //    mistaken for pre-existing noise (see BASE_TS_SAFETY_MARGIN_MS).
    //  • Inherited base_sha without base_ts (a SYNTHESIZED flag — deferred/
    //    HEAD-advanced — or a legacy pre-base_ts flag): the batch started at some
    //    UNKNOWN earlier time, so "now − margin" would wrongly scope out untracked
    //    files created during the batch (they were in the first review's scope —
    //    F-015). Never pair an old base_sha with a fresh base_ts: fall back to the
    //    no-scoping sentinel (all untracked stay in scope; over-review is safe).
    baseTs = inheritedBaseSha
      ? BASE_TS_NO_SCOPING_SENTINEL
      : new Date(Date.now() - BASE_TS_SAFETY_MARGIN_MS).toISOString();
  }
  const body = JSON.stringify({
    diff_hash: diffHash,
    ts: nowIso,
    ...(baseSha ? { base_sha: baseSha } : {}),
    base_ts: baseTs,
  });
  // Unique temp name (not a shared `${p}.tmp`) so parallel PostToolUse triggers
  // on the same checkout can't clobber each other's in-flight write before the
  // atomic rename completes.
  const tmp = `${p}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
  if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true });
  writeFileSync(tmp, body, { mode: 0o600 });
  const { renameSync } = await import("node:fs");
  renameSync(tmp, p);

  // Slice A (P1): record the files this session edited via a captured tool (ownership
  // belt over the content-hash baseline). Best-effort — never let it break the trigger.
  try {
    const parsed = parseHookStdin(input.hookStdinRaw);
    const sid = sessionIdOf(parsed);
    const files = editedPathsOf(parsed);
    if (sid && files.length > 0) recordSessionOwned(input.repoRoot, sid, files);
  } catch {
    /* best-effort ownership recording */
  }
}

export interface ResetInput {
  repoRoot: string;
  // The SessionStart hook stdin (carries session_id). Absent for the manual
  // `reviewgate reset` CLI (no stdin) → no baseline capture, which is correct: an
  // existing session manifest is preserved and a manual reset never folds the
  // session's own edits into a fresh baseline.
  hookStdinRaw?: string;
}

export interface ResetSummary {
  /** Human-facing labels of the artifacts that were present at reset time (best-effort removal). */
  cleared: string[];
}

export async function handleReset(input: ResetInput): Promise<ResetSummary> {
  const dir = reviewgateDir(input.repoRoot);
  // F-002 (dogfood, reset-seeds-unreviewed-tree): capture the PRE-wipe state
  // BEFORE the artifact groups below rmSync state.json. If the wiped session was
  // ESCALATED, its reviewed-through markers must survive the reset: blessing the
  // CURRENT HEAD/tree would mark the escalated (possibly committed, never
  // machine-reviewed) range as reviewed-through, and the next Stop would
  // skip-clean over it. The carried markers keep that range inside the next
  // synthesis diff. A missing/corrupt prior state → null → normal seeding.
  let preWipe: { escalated: boolean; sha: string | null; tree: string | null } | null = null;
  try {
    const prev = await new StateStore(input.repoRoot).load();
    preWipe = {
      escalated: prev.escalated === true,
      sha: prev.last_reviewed_head_sha,
      tree: prev.last_reviewed_tree_hash,
    };
  } catch {
    preWipe = null;
  }
  // Ordered artifact groups. Each group is removed together (behaviour unchanged
  // from before: best-effort rmSync with force) and contributes ONE human-facing
  // label to the summary if any of its paths was present.
  const groups: { label: string; paths: string[] }[] = [
    { label: "dirty flag", paths: [dirtyFlagPath(input.repoRoot)] },
    { label: "deferred review", paths: [deferredFlagPath(input.repoRoot)] },
    { label: "session state", paths: [stateJsonPath(input.repoRoot)] },
    { label: "decisions", paths: [decisionsDir(input.repoRoot)] },
    {
      label: "pending findings",
      paths: [pendingMdPath(input.repoRoot), pendingJsonPath(input.repoRoot)],
    },
    { label: "research", paths: [`${dir}/research.md`] },
    { label: "escalation", paths: [escalationMdPath(input.repoRoot)] },
  ];
  const cleared: string[] = [];
  for (const g of groups) {
    const present = g.paths.some((p) => existsSync(p));
    for (const p of g.paths) {
      try {
        rmSync(p, { recursive: true, force: true });
      } catch {
        // noop (best-effort, unchanged)
      }
    }
    if (present) cleared.push(g.label);
  }
  // F2: drop all per-run proposal pools so a new session can't see a prior
  // session's accumulated proposals. Detect presence BEFORE clearing because
  // clearAllProposalPools is silent.
  let poolPresent = false;
  try {
    const poolDir = proposalsPoolDir(input.repoRoot);
    poolPresent =
      existsSync(poolDir) &&
      readdirSync(poolDir).some((n) => n.endsWith(".jsonl") && n !== "errors.jsonl");
  } catch {
    poolPresent = false;
  }
  clearAllProposalPools(input.repoRoot);
  if (poolPresent) cleared.push("proposal pools");

  // Slice A (P1): on SessionStart, prune stale session manifests and capture THIS session's
  // ownership baseline (the working-tree-dirty files at session start, before it edits
  // anything). Best-effort + idempotent (an existing baseline is preserved on resume / manual
  // reset). No session_id (manual `reviewgate reset` CLI) → no capture. Deliberately does NOT
  // appear in `cleared` — it's a capture, not a clear, and runs even when nothing was cleared.
  try {
    pruneOldSessionManifests(input.repoRoot, Date.now());
    const sid = sessionIdOf(parseHookStdin(input.hookStdinRaw ?? ""));
    if (sid) await captureSessionBaseline(input.repoRoot, sid, new Date().toISOString());
  } catch {
    /* best-effort: a baseline-capture failure just means the next review is unscoped (full) */
  }

  // S1: seed the reviewed-through markers at session start. `last === null`
  // previously meant an unconditional Stop fast-exit — a first-turn Bash
  // `git commit`/`git merge` shipped unreviewed (core-loop#2). Pre-session
  // COMMITTED work is by definition not this session's responsibility, so
  // "reviewed through session-start HEAD" is the honest baseline for the sha.
  //
  // F-002 (dogfood, reset-seeds-unreviewed-tree): the TREE hash is a stronger
  // claim — "this exact working-tree content was reviewed" — and a reset must
  // never manufacture it:
  //  (a) escalated pre-wipe state → carry over ITS markers (see preWipe above)
  //      instead of blessing the current HEAD/tree;
  //  (b) otherwise seed the tree hash ONLY when the working tree is genuinely
  //      clean (empty working-tree diff). A dirty (unreviewed) tree seeds NULL,
  //      so the next Stop's probe fails toward review — ownership demotion
  //      (Slice A) handles any foreign findings in that first review. The hash
  //      is computed BEFORE the clean-check so an edit racing the two steps
  //      fails safe either way: landing before the check → non-empty diff →
  //      null; landing after → stored hash predates it → probe mismatch →
  //      review. Any error → nulls (fail toward review).
  //
  // Drift from the brief: the "session state" group above unconditionally
  // rmSync's state.json (best-effort), so it does NOT exist at this point.
  // StateStore.update() calls load() → readFileSync, which throws ENOENT on a
  // missing file (no auto-create) — a bare update() here would silently no-op
  // inside its own try/catch. loadOrRecover (the same ulid()-seeded pattern
  // runStopGate uses) recreates state.json first so update() has something to
  // patch, landing the seed in the FRESH state as the brief requires.
  try {
    const store = new StateStore(input.repoRoot);
    await store.loadOrRecover(ulid());
    let sha: string | null;
    let tree: string | null;
    if (preWipe?.escalated) {
      sha = preWipe.sha;
      tree = preWipe.tree;
    } else {
      sha = await gitHeadSha(input.repoRoot);
      tree = null;
      try {
        const candidate = await workingTreeStateHash(input.repoRoot);
        const wtDiff = await collectDiff(input.repoRoot, null);
        if (wtDiff.trim().length === 0) tree = candidate;
      } catch {
        tree = null;
      }
    }
    await store.update((cur) =>
      ReviewgateStateSchema.parse({
        ...cur,
        last_reviewed_head_sha: sha ?? cur.last_reviewed_head_sha,
        last_reviewed_tree_hash: tree,
      }),
    );
  } catch {
    /* best-effort: a failed seed leaves null → the Stop path fails toward review */
  }

  return { cleared };
}

export interface GateOutput {
  decision: "block" | "approve" | undefined; // 'approve' = allow_stop (no key)
  reason: string;
}

export function formatBlockJson(reason: string): string {
  return JSON.stringify({ decision: "block", reason });
}

export function formatAllowStopJson(reason?: string): string {
  // Stop hook with empty body / exit 0 / no decision = allow_stop.
  return reason
    ? JSON.stringify({ continue: false, suppressOutput: false, systemMessage: reason })
    : "{}";
}

// Quick utility to read hook stdin JSON safely. Returns null if no stdin or parse fails.
export function parseHookStdin(raw: string): unknown {
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Exposed for the gate command — reads the configured/located file path that
// matches the actual decisions file written by Claude in the prior iteration.
export function readDecisions(repoRoot: string, iter: number): { finding_id: string }[] {
  const p = `${reviewgateDir(repoRoot)}/decisions/${iter}.jsonl`;
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  const out: { finding_id: string }[] = [];
  for (const l of lines) {
    try {
      const o = JSON.parse(l) as { finding_id?: string };
      if (typeof o.finding_id === "string") out.push({ finding_id: o.finding_id });
    } catch {
      // skip
    }
  }
  return out;
}
