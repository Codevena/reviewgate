import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  type ControlPlanePending,
  type ControlPlaneState,
  ControlPlaneStateSchema,
  type PolicyChangeClass,
} from "../schemas/control-plane.ts";
import { writeFileAtomic } from "../utils/atomic-write.ts";
import { flock } from "../utils/flock.ts";
import {
  controlPlaneFlagPath,
  controlPlaneLockPath,
  controlPlaneStatePath,
  policyChangeReportPath,
  reviewgateDir,
} from "../utils/paths.ts";
import type { ReviewgateConfig } from "./define-config.ts";
import {
  type EffectiveConfigInput,
  inspectConfigSources,
  loadEffectiveConfigSnapshot,
} from "./global.ts";

export interface PolicyChangeAnalysis {
  classification: Exclude<PolicyChangeClass, "invalid">;
  changedPaths: string[];
  reasons: string[];
}

export interface ControlPlaneResolution {
  config: ReviewgateConfig;
  approvedEffectiveFingerprint: string;
  observedSourceFingerprint: string;
  observedEffectiveFingerprint: string | null;
  change: ControlPlanePending | null;
}

export type ControlPlaneFinalizeResult =
  | { kind: "unchanged" }
  | { kind: "auto-approved"; classification: "equivalent" | "strengthening" }
  | { kind: "approval-required"; message: string }
  | { kind: "invalid"; message: string }
  | { kind: "changed-during-review"; message: string };

export class ControlPlaneBootstrapRequiredError extends Error {
  constructor() {
    super(
      "Gate policy has no last-known-good baseline. Run `reviewgate config approve` from an interactive terminal to bootstrap it; an already-installed gate will not silently re-baseline through `init`.",
    );
    this.name = "ControlPlaneBootstrapRequiredError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function effectiveConfigFingerprint(config: ReviewgateConfig): string {
  return sha256(canonical(config));
}

function deepEqual(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function collectChangedPaths(a: unknown, b: unknown, path = "", out: string[] = []): string[] {
  if (deepEqual(a, b)) return out;
  if (
    a &&
    b &&
    typeof a === "object" &&
    typeof b === "object" &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
      collectChangedPaths(left[key], right[key], path ? `${path}.${key}` : key, out);
    }
    return out;
  }
  out.push(path || "(root)");
  return out;
}

function valueAt(root: unknown, path: string): unknown {
  if (path === "(root)") return root;
  let value = root;
  for (const part of path.split(".")) {
    if (!value || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function setContainsAll(candidate: unknown, approved: unknown): boolean {
  if (!Array.isArray(candidate) || !Array.isArray(approved)) return false;
  const values = new Set(candidate.map(canonical));
  return approved.every((entry) => values.has(canonical(entry)));
}

function safeStrengthening(
  path: string,
  approved: ReviewgateConfig,
  candidate: ReviewgateConfig,
): boolean {
  const before = valueAt(approved, path);
  const after = valueAt(candidate, path);
  if (path === "sandbox.mode") {
    const rank: Record<string, number> = { off: 0, permissive: 1, strict: 2 };
    const beforeRank = typeof before === "string" ? rank[before] : undefined;
    const afterRank = typeof after === "string" ? rank[after] : undefined;
    return beforeRank !== undefined && afterRank !== undefined && afterRank > beforeRank;
  }
  if (path === "sandbox.writablePaths") {
    return Array.isArray(before) && Array.isArray(after) && setContainsAll(before, after);
  }
  if (path === "sandbox.deniedReads") {
    return setContainsAll(after, before);
  }
  if (path === "loop.softPassPolicy") {
    const rank: Record<string, number> = { allow: 0, "ask-once": 1, block: 2 };
    const beforeRank = typeof before === "string" ? rank[before] : undefined;
    const afterRank = typeof after === "string" ? rank[after] : undefined;
    return beforeRank !== undefined && afterRank !== undefined && afterRank > beforeRank;
  }
  // Reviewer/provider additions are deliberately NOT auto-classified as safe:
  // they can change consensus, disclose source to a new service, or enable an
  // agentic CLI with host-tool access. Likewise phases.checks contains shell
  // commands; adding a command is more enforcement, but also new code execution.
  // Those transitions are non-monotonic and require a human checkpoint.
  return false;
}

export function analysePolicyChange(
  approved: ReviewgateConfig,
  candidate: ReviewgateConfig,
): PolicyChangeAnalysis {
  if (deepEqual(approved, candidate)) {
    return {
      classification: "equivalent",
      changedPaths: [],
      reasons: ["Source bytes changed, but the validated effective policy is identical."],
    };
  }
  const changedPaths = collectChangedPaths(approved, candidate);
  const unsafe = changedPaths.filter((path) => !safeStrengthening(path, approved, candidate));
  if (unsafe.length === 0) {
    return {
      classification: "strengthening",
      changedPaths,
      reasons: ["Every effective change is a provable monotonic strengthening."],
    };
  }
  return {
    classification: "approval-required",
    changedPaths,
    reasons: [
      `Potential weakening or non-monotonic policy change: ${unsafe.join(", ")}.`,
      "Reviewgate refuses to infer maintainer intent for this change.",
    ],
  };
}

function readState(repoRoot: string): ControlPlaneState | null {
  const path = controlPlaneStatePath(repoRoot);
  if (!existsSync(path)) return null;
  const state = ControlPlaneStateSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  const actual = effectiveConfigFingerprint(state.approved_config);
  if (actual !== state.approved_effective_fingerprint) {
    throw new Error(
      "Control-plane state integrity check failed: the stored last-known-good config does not match its fingerprint.",
    );
  }
  return state;
}

function writeState(repoRoot: string, state: ControlPlaneState): void {
  const parsed = ControlPlaneStateSchema.parse(state);
  const path = controlPlaneStatePath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
}

function clearPolicyArtifacts(repoRoot: string): void {
  rmSync(controlPlaneFlagPath(repoRoot), { force: true });
  rmSync(policyChangeReportPath(repoRoot), { force: true });
}

async function clearRevertedCandidate(
  repoRoot: string,
  approved: ControlPlaneState,
): Promise<ControlPlaneState> {
  if (!approved.pending && !existsSync(controlPlaneFlagPath(repoRoot))) return approved;
  const lock = await flock(controlPlaneLockPath(repoRoot));
  try {
    const current = readState(repoRoot);
    if (!current) throw new ControlPlaneBootstrapRequiredError();
    if (current.approved_source_fingerprint !== approved.approved_source_fingerprint) {
      throw new Error("Gate policy changed concurrently; retry.");
    }
    const next = current.pending ? { ...current, pending: null } : current;
    if (current.pending) writeState(repoRoot, next);
    clearPolicyArtifacts(repoRoot);
    return next;
  } finally {
    await lock.release();
  }
}

function short(hash: string | null): string {
  return hash ? hash.slice(0, 12) : "invalid";
}

function renderReport(state: ControlPlaneState): string {
  const pending = state.pending;
  if (!pending) return "";
  return [
    "# Gate policy changed",
    "",
    "> This is a Reviewgate control-plane event, not part of the normal source-code diff.",
    "",
    `- Approved policy: \`${short(state.approved_effective_fingerprint)}\``,
    `- Candidate policy: \`${short(pending.effective_fingerprint)}\``,
    `- Classification: **${pending.classification}**`,
    `- Reviewed under last-known-good policy: ${pending.reviewed_under_lkg_at ? `yes (${pending.reviewed_under_lkg_at})` : "not yet"}`,
    "",
    "## Changed policy paths",
    "",
    ...(pending.changed_paths.length > 0
      ? pending.changed_paths.map((path) => `- \`${path}\``)
      : ["- Effective policy unchanged (source-only change)."]),
    "",
    "## Why the gate stopped",
    "",
    ...pending.reasons.map((reason) => `- ${reason}`),
    ...(pending.error ? ["", `Config error: \`${pending.error.replaceAll("`", "'")}\``] : []),
    "",
    "## Next step",
    "",
    pending.classification === "approval-required"
      ? "After the normal diff passes under the approved policy, inspect `reviewgate.config.ts`, run `reviewgate config status`, then approve from a real interactive terminal with `reviewgate config approve`."
      : pending.classification === "invalid"
        ? "Fix the invalid config. Reviewgate continues to use the approved policy and will not accept this candidate."
        : "Reviewgate will adopt this policy automatically only after the normal diff passes under the approved policy.",
    "",
  ].join("\n");
}

async function persistPending(
  repoRoot: string,
  approved: ControlPlaneState,
  pending: ControlPlanePending,
): Promise<ControlPlaneState> {
  const lock = await flock(controlPlaneLockPath(repoRoot));
  try {
    const current = readState(repoRoot) ?? approved;
    if (current.approved_effective_fingerprint !== approved.approved_effective_fingerprint) {
      throw new Error("Gate policy changed concurrently; retry the stop hook.");
    }
    // A shipped-default/schema change can alter the effective policy while the
    // config bytes stay identical. A prior LKG pass belongs to the exact source +
    // effective candidate pair and must never carry across that runtime change.
    const sameCandidate =
      current.pending?.source_fingerprint === pending.source_fingerprint &&
      current.pending?.effective_fingerprint === pending.effective_fingerprint;
    const nextPending = sameCandidate
      ? {
          ...pending,
          first_seen_at: current.pending?.first_seen_at ?? pending.first_seen_at,
          reviewed_under_lkg_at: current.pending?.reviewed_under_lkg_at ?? null,
        }
      : pending;
    const next = { ...current, pending: nextPending };
    writeState(repoRoot, next);
    writeFileAtomic(policyChangeReportPath(repoRoot), renderReport(next), { mode: 0o600 });
    return next;
  } finally {
    await lock.release();
  }
}

function baseState(
  config: ReviewgateConfig,
  sourceFingerprint: string,
  approvedVia: ControlPlaneState["approved_via"],
): ControlPlaneState {
  return {
    schema: "reviewgate.control-plane.v1",
    approved_source_fingerprint: sourceFingerprint,
    approved_effective_fingerprint: effectiveConfigFingerprint(config),
    approved_config: config,
    approved_at: new Date().toISOString(),
    approved_via: approvedVia,
    pending: null,
  };
}

export async function bootstrapControlPlane(
  input: EffectiveConfigInput & { approvedVia: "defaults" | "init" | "human" },
): Promise<ControlPlaneState> {
  mkdirSync(reviewgateDir(input.cwd), { recursive: true });
  const lock = await flock(controlPlaneLockPath(input.cwd));
  try {
    const existing = readState(input.cwd);
    if (existing) return existing;
    const snapshot = await loadEffectiveConfigSnapshot(input);
    const state = baseState(snapshot.config, snapshot.sourceFingerprint, input.approvedVia);
    writeState(input.cwd, state);
    clearPolicyArtifacts(input.cwd);
    return state;
  } finally {
    await lock.release();
  }
}

function managedHookExists(repoRoot: string): boolean {
  return existsSync(join(repoRoot, ".reviewgate", "bin", "gate"));
}

export async function resolveControlPlaneConfig(
  input: EffectiveConfigInput,
): Promise<ControlPlaneResolution> {
  const source = inspectConfigSources(input);
  let approved = readState(input.cwd);
  if (!approved) {
    // Defaults have no mutable project/global policy to approve. For an unmanaged
    // manual gate invocation, the first valid config establishes its baseline.
    // An initialized repo whose state vanished MUST block instead of blessing the
    // current file, because deletion must not reset human approval.
    if (managedHookExists(input.cwd)) throw new ControlPlaneBootstrapRequiredError();
    approved = await bootstrapControlPlane({
      ...input,
      approvedVia: source.hasCustomSource ? "init" : "defaults",
    });
  }

  const now = new Date().toISOString();
  try {
    const candidate = await loadEffectiveConfigSnapshot(input);
    if (candidate.sourceFingerprint !== source.sourceFingerprint) {
      throw new Error("Gate policy changed while it was being read; retry the stop hook.");
    }
    const candidateFingerprint = effectiveConfigFingerprint(candidate.config);
    // Always compare the EFFECTIVE config as well as source bytes. A Reviewgate
    // upgrade can change shipped defaults while reviewgate.config.ts stays byte-
    // identical; preserving an old weaker default forever would turn the LKG into
    // a downgrade pin. Such runtime-policy deltas use the same review/adoption path.
    if (
      source.sourceFingerprint === approved.approved_source_fingerprint &&
      candidateFingerprint === approved.approved_effective_fingerprint
    ) {
      approved = await clearRevertedCandidate(input.cwd, approved);
      return {
        config: approved.approved_config,
        approvedEffectiveFingerprint: approved.approved_effective_fingerprint,
        observedSourceFingerprint: source.sourceFingerprint,
        observedEffectiveFingerprint: candidateFingerprint,
        change: null,
      };
    }
    const analysis = analysePolicyChange(approved.approved_config, candidate.config);
    const pending: ControlPlanePending = {
      source_fingerprint: source.sourceFingerprint,
      effective_fingerprint: candidateFingerprint,
      classification: analysis.classification,
      changed_paths: analysis.changedPaths,
      reasons: analysis.reasons,
      error: null,
      first_seen_at: now,
      reviewed_under_lkg_at: null,
    };
    const next = await persistPending(input.cwd, approved, pending);
    return {
      config: approved.approved_config,
      approvedEffectiveFingerprint: approved.approved_effective_fingerprint,
      observedSourceFingerprint: source.sourceFingerprint,
      observedEffectiveFingerprint: candidateFingerprint,
      change: next.pending,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const pending: ControlPlanePending = {
      source_fingerprint: source.sourceFingerprint,
      effective_fingerprint: null,
      classification: "invalid",
      changed_paths: ["reviewgate.config.ts"],
      reasons: ["The present config is invalid and cannot replace the last-known-good policy."],
      error: message,
      first_seen_at: now,
      reviewed_under_lkg_at: null,
    };
    const next = await persistPending(input.cwd, approved, pending);
    return {
      config: approved.approved_config,
      approvedEffectiveFingerprint: approved.approved_effective_fingerprint,
      observedSourceFingerprint: source.sourceFingerprint,
      observedEffectiveFingerprint: null,
      change: next.pending,
    };
  }
}

function approvalMessage(repoRoot: string, pending: ControlPlanePending): string {
  const report = policyChangeReportPath(repoRoot).replace(`${repoRoot}/`, "");
  if (pending.classification === "invalid") {
    return `🔴 Reviewgate · GATE POLICY INVALID — ${pending.error ?? "the current config is invalid"}. Code was checked under the last-known-good policy; fix reviewgate.config.ts. Details: ${report}`;
  }
  return `🔐 Reviewgate · GATE POLICY CHANGED — code passed under the last-known-good policy, but this non-monotonic change requires explicit human approval. Inspect ${report}, then run \`reviewgate config status\` and \`reviewgate config approve\` in an interactive terminal.`;
}

export async function finalizeControlPlaneReview(
  repoRoot: string,
  resolution: ControlPlaneResolution,
  input: Omit<EffectiveConfigInput, "cwd"> = {},
): Promise<ControlPlaneFinalizeResult> {
  const observedNow = inspectConfigSources({ cwd: repoRoot, ...input });
  if (observedNow.sourceFingerprint !== resolution.observedSourceFingerprint) {
    return {
      kind: "changed-during-review",
      message:
        "🔴 Reviewgate · GATE CLOSED — gate policy changed during the review. The completed verdict was not allowed to bless the new policy; end the turn again to retry under a stable snapshot.",
    };
  }
  if (!resolution.change) return { kind: "unchanged" };
  if (resolution.change.classification === "invalid") {
    return { kind: "invalid", message: approvalMessage(repoRoot, resolution.change) };
  }

  let candidate: Awaited<ReturnType<typeof loadEffectiveConfigSnapshot>>;
  try {
    candidate = await loadEffectiveConfigSnapshot({ cwd: repoRoot, ...input });
  } catch (err) {
    return {
      kind: "changed-during-review",
      message: `🔴 Reviewgate · GATE CLOSED — gate policy became invalid during review: ${(err as Error).message}`,
    };
  }
  const candidateFingerprint = effectiveConfigFingerprint(candidate.config);
  if (
    candidate.sourceFingerprint !== resolution.observedSourceFingerprint ||
    candidateFingerprint !== resolution.observedEffectiveFingerprint
  ) {
    return {
      kind: "changed-during-review",
      message:
        "🔴 Reviewgate · GATE CLOSED — gate policy changed during the review. End the turn again to review the new candidate.",
    };
  }

  const lock = await flock(controlPlaneLockPath(repoRoot));
  try {
    const state = readState(repoRoot);
    if (
      !state ||
      state.approved_effective_fingerprint !== resolution.approvedEffectiveFingerprint
    ) {
      return {
        kind: "changed-during-review",
        message: "🔴 Reviewgate · GATE CLOSED — the approved policy changed concurrently; retry.",
      };
    }
    const pending = state.pending;
    if (!pending || pending.source_fingerprint !== candidate.sourceFingerprint) {
      return {
        kind: "changed-during-review",
        message:
          "🔴 Reviewgate · GATE CLOSED — the pending policy candidate changed concurrently; retry.",
      };
    }
    if (pending.classification === "equivalent" || pending.classification === "strengthening") {
      const next = baseState(
        candidate.config,
        candidate.sourceFingerprint,
        pending.classification === "strengthening" ? "automatic-strengthening" : state.approved_via,
      );
      writeState(repoRoot, next);
      clearPolicyArtifacts(repoRoot);
      return { kind: "auto-approved", classification: pending.classification };
    }
    const reviewed = { ...pending, reviewed_under_lkg_at: new Date().toISOString() };
    const next = { ...state, pending: reviewed };
    writeState(repoRoot, next);
    writeFileAtomic(policyChangeReportPath(repoRoot), renderReport(next), { mode: 0o600 });
    return { kind: "approval-required", message: approvalMessage(repoRoot, reviewed) };
  } finally {
    await lock.release();
  }
}

export interface ControlPlaneStatus {
  state: ControlPlaneState | null;
  resolution: ControlPlaneResolution | null;
  challenge: string | null;
}

export async function controlPlaneStatus(
  repoRoot: string,
  input: Omit<EffectiveConfigInput, "cwd"> = {
    env: process.env as Record<string, string | undefined>,
    home: homedir(),
  },
): Promise<ControlPlaneStatus> {
  const state = readState(repoRoot);
  if (!state) {
    const snapshot = await loadEffectiveConfigSnapshot({ cwd: repoRoot, ...input });
    return {
      state: null,
      resolution: null,
      challenge: `APPROVE ${effectiveConfigFingerprint(snapshot.config).slice(0, 12)}`,
    };
  }
  const resolution = await resolveControlPlaneConfig({ cwd: repoRoot, ...input });
  return {
    state: readState(repoRoot),
    resolution,
    challenge:
      resolution.change?.classification === "approval-required" &&
      resolution.change.reviewed_under_lkg_at &&
      resolution.change.effective_fingerprint
        ? `APPROVE ${resolution.change.effective_fingerprint.slice(0, 12)}`
        : null,
  };
}

export async function approveControlPlane(
  repoRoot: string,
  confirmation: string,
  input: Omit<EffectiveConfigInput, "cwd"> = {
    env: process.env as Record<string, string | undefined>,
    home: homedir(),
  },
): Promise<ControlPlaneState> {
  let state = readState(repoRoot);
  if (!state) {
    const snapshot = await loadEffectiveConfigSnapshot({ cwd: repoRoot, ...input });
    const snapshotFingerprint = effectiveConfigFingerprint(snapshot.config);
    const expected = `APPROVE ${snapshotFingerprint.slice(0, 12)}`;
    if (confirmation !== expected)
      throw new Error(`Confirmation did not match. Type exactly: ${expected}`);
    mkdirSync(reviewgateDir(repoRoot), { recursive: true });
    const lock = await flock(controlPlaneLockPath(repoRoot));
    try {
      const existing = readState(repoRoot);
      if (existing) throw new Error("A policy baseline appeared concurrently; run status again.");
      const fresh = await loadEffectiveConfigSnapshot({ cwd: repoRoot, ...input });
      if (
        fresh.sourceFingerprint !== snapshot.sourceFingerprint ||
        effectiveConfigFingerprint(fresh.config) !== snapshotFingerprint
      ) {
        throw new Error(
          "The config changed while the initial approval was being recorded; run status again.",
        );
      }
      const created = baseState(fresh.config, fresh.sourceFingerprint, "human");
      writeState(repoRoot, created);
      clearPolicyArtifacts(repoRoot);
      return created;
    } finally {
      await lock.release();
    }
  }

  const resolution = await resolveControlPlaneConfig({ cwd: repoRoot, ...input });
  const pending = resolution.change;
  if (!pending) return readState(repoRoot) ?? state;
  if (pending.classification === "invalid" || !pending.effective_fingerprint) {
    throw new Error("The current config is invalid and cannot be approved.");
  }
  if (!pending.reviewed_under_lkg_at) {
    throw new Error(
      "This policy has not yet passed a gate run under the last-known-good configuration. End the agent turn once, resolve any code findings, then approve it.",
    );
  }
  const expected = `APPROVE ${pending.effective_fingerprint.slice(0, 12)}`;
  if (confirmation !== expected)
    throw new Error(`Confirmation did not match. Type exactly: ${expected}`);
  const candidate = await loadEffectiveConfigSnapshot({ cwd: repoRoot, ...input });
  if (
    candidate.sourceFingerprint !== pending.source_fingerprint ||
    effectiveConfigFingerprint(candidate.config) !== pending.effective_fingerprint
  ) {
    throw new Error(
      "The config changed after the approval challenge was issued; run status again.",
    );
  }
  const lock = await flock(controlPlaneLockPath(repoRoot));
  try {
    state = readState(repoRoot);
    if (
      !state?.pending ||
      state.approved_effective_fingerprint !== resolution.approvedEffectiveFingerprint ||
      state.pending.source_fingerprint !== pending.source_fingerprint ||
      state.pending.effective_fingerprint !== pending.effective_fingerprint ||
      state.pending.classification !== pending.classification ||
      !state.pending.reviewed_under_lkg_at
    ) {
      throw new Error("The pending policy changed concurrently; run status again.");
    }
    const next = baseState(candidate.config, candidate.sourceFingerprint, "human");
    writeState(repoRoot, next);
    clearPolicyArtifacts(repoRoot);
    return next;
  } finally {
    await lock.release();
  }
}

export function markControlPlaneDirty(repoRoot: string, source: "edit" | "bash" = "edit"): void {
  mkdirSync(reviewgateDir(repoRoot), { recursive: true });
  writeFileAtomic(
    controlPlaneFlagPath(repoRoot),
    `${JSON.stringify({ source, detected_at: new Date().toISOString() })}\n`,
    { mode: 0o600 },
  );
}
