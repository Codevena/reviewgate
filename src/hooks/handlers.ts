// src/hooks/handlers.ts
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { clearAllProposalPools } from "../core/brain/proposal-store.ts";
import { gitHeadSha } from "../utils/git.ts";
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

export async function handleTrigger(input: TriggerInput): Promise<void> {
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
}

export interface ResetInput {
  repoRoot: string;
}

export interface ResetSummary {
  /** Human-facing labels of the artifacts that were present at reset time (best-effort removal). */
  cleared: string[];
}

export async function handleReset(input: ResetInput): Promise<ResetSummary> {
  const dir = reviewgateDir(input.repoRoot);
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
