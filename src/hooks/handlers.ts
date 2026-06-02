// src/hooks/handlers.ts
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { clearAllProposalPools } from "../core/brain/proposal-store.ts";
import { gitHeadSha } from "../utils/git.ts";
import {
  decisionsDir,
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
  if (existsSync(p)) {
    try {
      baseSha = (JSON.parse(readFileSync(p, "utf8")) as { base_sha?: string }).base_sha ?? null;
    } catch {
      baseSha = null;
    }
  }
  if (!baseSha) baseSha = await gitHeadSha(input.repoRoot);
  const body = JSON.stringify({
    diff_hash: diffHash,
    ts: new Date().toISOString(),
    ...(baseSha ? { base_sha: baseSha } : {}),
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
