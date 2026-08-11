import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { canonicalJson } from "../../audit/canonical.ts";
import { redactHighEntropy } from "../../diff/sanitizer.ts";
import { isAuthoritativeThrowableString } from "../../schemas/bench-result.ts";
import {
  type PolicyReplayEnvelope,
  type PolicyReplayEnvelopeInput,
  PolicyReplayEnvelopeInputSchema,
  PolicyReplayEnvelopeSchema,
} from "../../schemas/policy-replay.ts";
import { writeFileIfAbsent } from "../../utils/atomic-write.ts";
import type { AggregateInput } from "../aggregator.ts";

export const POLICY_REPLAY_MAX_BYTES = 1_048_576;

const FULL_SHA256 = /^[0-9a-f]{64}$/;
const POLICY_REPLAY_REF = /^([0-9a-f]{12})-i(0|[1-9]\d*)-([0-9a-f]{12})\.json$/;

function persistCaptureStatus(
  sinkReal: string,
  envelope: PolicyReplayEnvelope,
  status: "overflow",
): void {
  const runSha12 = sha256(envelope.run_id).slice(0, 12);
  const ref = `${runSha12}-i${envelope.iter}.${status}`;
  const destination = resolve(sinkReal, ref);
  if (!isContained(sinkReal, destination)) return;
  const bytes = canonicalJson({
    schema: "reviewgate.policy-replay-status.v1",
    run_sha256: sha256(envelope.run_id),
    iter: envelope.iter,
    status,
  });
  try {
    writeFileIfAbsent(destination, bytes, { mode: 0o600 });
  } catch {
    // Best effort only. The caller still returns overflow and a missing marker becomes
    // missing-trace, which remains fail-closed even if it is less specific.
  }
}

export type PolicyReplayCaptureResult =
  | { status: "complete"; ref: string; sha256: string; envelope: PolicyReplayEnvelope }
  | { status: "overflow"; reason: "too-large" }
  | {
      status: "error";
      reason:
        | "invalid-envelope"
        | "invalid-sink"
        | "sink-inside-measured-repo"
        | "artifact-collision"
        | "write-error";
    };

export type PolicyReplayVerification =
  | { ok: true; envelope: PolicyReplayEnvelope }
  | {
      ok: false;
      reason:
        | "invalid-reference"
        | "path-escape"
        | "missing"
        | "not-a-file"
        | "too-large"
        | "hash-mismatch"
        | "invalid-encoding"
        | "invalid-json"
        | "invalid-envelope"
        | "non-canonical"
        | "identity-mismatch"
        | "lossy"
        | "catalog-mismatch"
        | "state-digest-mismatch"
        | "response-hash-mismatch"
        | "read-error";
    };

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function exactDirectory(path: string): string | null {
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
  return realpathSync(path);
}

/** Gate-side validation. The environment value is a sink only, never policy control. */
export function resolvePolicyReplayCaptureSink(input: {
  sinkDir: string;
  measuredRepoRoot: string;
}): { sinkDir: string; measuredRepoRoot: string } | null {
  try {
    if (!isAbsolute(input.sinkDir)) return null;
    const sinkReal = exactDirectory(input.sinkDir);
    const repoReal = exactDirectory(input.measuredRepoRoot);
    if (sinkReal === null || repoReal === null) return null;
    if (isContained(repoReal, sinkReal) || isContained(sinkReal, repoReal)) return null;
    return { sinkDir: sinkReal, measuredRepoRoot: repoReal };
  } catch {
    return null;
  }
}

function sanitizeString(value: string): { value: string; changed: boolean } {
  const redacted = redactHighEntropy(value);
  if (redacted.count > 0) {
    const safe = isAuthoritativeThrowableString(redacted.out) ? redacted.out : "<REDACTED:UNSAFE>";
    return { value: safe, changed: true };
  }
  if (!isAuthoritativeThrowableString(value)) {
    return { value: "<REDACTED:UNSAFE>", changed: true };
  }
  return { value, changed: false };
}

function sanitizeStrings(value: unknown): { value: unknown; changed: boolean } {
  if (typeof value === "string") return sanitizeString(value);
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((entry) => {
      const sanitized = sanitizeStrings(entry);
      changed ||= sanitized.changed;
      return sanitized.value;
    });
    return { value: out, changed };
  }
  if (value !== null && typeof value === "object") {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const sanitized = sanitizeStrings(entry);
      changed ||= sanitized.changed;
      out[key] = sanitized.value;
    }
    return { value: out, changed };
  }
  return { value, changed: false };
}

function sortedStrings<T extends string>(values: Iterable<T>): T[] {
  return [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/** Convert Map/Set policy inputs at the production call site into a stable persisted shape. */
export function serializePolicyReplayAggregateInputs(
  input: AggregateInput,
): PolicyReplayEnvelopeInput["aggregate"] {
  return {
    findings: structuredClone(input.findings),
    reviewers_total: input.reviewersTotal,
    changed_ranges: [...(input.changedRanges ?? [])]
      .map(([file, ranges]) => ({
        file,
        ranges: [...ranges]
          .map(([start, end]) => ({ start, end }))
          .sort((left, right) => left.start - right.start || left.end - right.end),
      }))
      .sort((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0)),
    scope_to_diff: input.scopeToDiff !== false,
    out_of_diff_blocking: sortedStrings(input.outOfDiffBlocking ?? []),
    confidence_floor: input.confidenceFloor ?? 0,
    demote_correctness: input.demoteCorrectness === true,
    corroborate_critical: input.corroborateCritical === true,
    demote_test_security: input.demoteTestSecurity === true,
    cap_docs_severity: input.capDocsSeverity === true,
    critic: [...(input.critic ?? [])]
      .map(([signature, verdict]) => ({ signature, ...verdict }))
      .sort((left, right) =>
        left.signature < right.signature ? -1 : left.signature > right.signature ? 1 : 0,
      ),
    fp_active: [...(input.fpActive ?? [])]
      .map(([signature, value]) => ({ signature, id: value.id }))
      .sort((left, right) =>
        left.signature < right.signature ? -1 : left.signature > right.signature ? 1 : 0,
      ),
    fp_active_clusters: [...(input.fpActiveClusters ?? [])]
      .map(([key, value]) => ({ key, member_ids: sortedStrings(value.member_ids) }))
      .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0)),
    rep_unreliable: sortedStrings(input.repUnreliable ?? []),
    protected_reviewers: sortedStrings(input.protectedReviewers ?? []),
    foreign_files: sortedStrings(input.foreignFiles ?? []),
    cycle_rejected: sortedStrings(input.cycleRejected ?? []),
    claimed_fixed: [...(input.claimedFixed ?? [])]
      .map(([signature, iter]) => ({ signature, iter }))
      .sort((left, right) =>
        left.signature < right.signature ? -1 : left.signature > right.signature ? 1 : 0,
      ),
    delta_scope: sortedStrings(input.deltaScope ?? []),
    rejected_regions: [...(input.rejectedRegions ?? [])]
      .map((region) => ({ ...region, categories: sortedStrings(region.categories) }))
      .sort(
        (left, right) =>
          (left.file < right.file ? -1 : left.file > right.file ? 1 : 0) ||
          left.start_line - right.start_line ||
          left.end_line - right.end_line,
      ),
    policy_inactive: Object.entries(input.policyInactive ?? {})
      .map(([pass_id, reason_code]) => ({
        pass_id: pass_id as "judgment.critic" | "scope.diff" | "scope.delta" | "scope.session",
        reason_code,
      }))
      .sort((left, right) =>
        left.pass_id < right.pass_id ? -1 : left.pass_id > right.pass_id ? 1 : 0,
      ),
  };
}

export function sanitizePolicyReplayEnvelope(
  input: PolicyReplayEnvelopeInput,
): PolicyReplayEnvelope {
  const structural = PolicyReplayEnvelopeInputSchema.parse(input);
  const sanitized = sanitizeStrings(structural);
  const value = sanitized.value as PolicyReplayEnvelopeInput;
  return PolicyReplayEnvelopeSchema.parse({
    ...value,
    lossless: value.lossless && !sanitized.changed,
  });
}

function readArtifact(
  path: string,
  realSink: string,
):
  | { ok: true; bytes: Buffer }
  | { ok: false; reason: "not-a-file" | "path-escape" | "too-large" | "read-error" } {
  const before = lstatSync(path);
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.nlink !== 1 ||
    (before.mode & 0o7777) !== 0o600
  ) {
    return { ok: false, reason: "not-a-file" };
  }
  if (before.size > POLICY_REPLAY_MAX_BYTES) return { ok: false, reason: "too-large" };
  const realPath = realpathSync(path);
  if (!isContained(realSink, realPath)) return { ok: false, reason: "path-escape" };

  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || (opened.mode & 0o7777) !== 0o600) {
      return { ok: false, reason: "not-a-file" };
    }
    if (opened.size > POLICY_REPLAY_MAX_BYTES) return { ok: false, reason: "too-large" };
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      return { ok: false, reason: "read-error" };
    }
    const bytes = readFileSync(fd);
    if (bytes.length > POLICY_REPLAY_MAX_BYTES) return { ok: false, reason: "too-large" };
    const after = fstatSync(fd);
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    ) {
      return { ok: false, reason: "read-error" };
    }
    const pathAfter = lstatSync(path);
    if (
      pathAfter.isSymbolicLink() ||
      !pathAfter.isFile() ||
      pathAfter.nlink !== 1 ||
      (pathAfter.mode & 0o7777) !== 0o600 ||
      pathAfter.dev !== after.dev ||
      pathAfter.ino !== after.ino ||
      realpathSync(path) !== realPath
    ) {
      return { ok: false, reason: "read-error" };
    }
    return { ok: true, bytes };
  } finally {
    closeSync(fd);
  }
}

export function capturePolicyReplayEnvelope(input: {
  sinkDir: string;
  measuredRepoRoot: string;
  envelope: PolicyReplayEnvelopeInput;
  maxBytes?: number;
}): PolicyReplayCaptureResult {
  let envelope: PolicyReplayEnvelope;
  try {
    envelope = sanitizePolicyReplayEnvelope(input.envelope);
  } catch {
    return { status: "error", reason: "invalid-envelope" };
  }
  let sinkReal: string;
  try {
    if (!isAbsolute(input.sinkDir) || lstatSync(input.sinkDir).isSymbolicLink()) {
      return { status: "error", reason: "invalid-sink" };
    }
    sinkReal = exactDirectory(input.sinkDir) ?? "";
    if (sinkReal.length === 0) return { status: "error", reason: "invalid-sink" };
    const repoReal = realpathSync(input.measuredRepoRoot);
    if (isContained(repoReal, sinkReal) || isContained(sinkReal, repoReal)) {
      return { status: "error", reason: "sink-inside-measured-repo" };
    }
  } catch {
    return { status: "error", reason: "invalid-sink" };
  }

  const bytes = Buffer.from(canonicalJson(envelope), "utf8");
  const maxBytes = input.maxBytes ?? POLICY_REPLAY_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    return { status: "error", reason: "invalid-envelope" };
  }
  if (bytes.length > maxBytes) {
    persistCaptureStatus(sinkReal, envelope, "overflow");
    return { status: "overflow", reason: "too-large" };
  }
  const contentSha256 = sha256(bytes);
  const runSha12 = sha256(envelope.run_id).slice(0, 12);
  const ref = `${runSha12}-i${envelope.iter}-${contentSha256.slice(0, 12)}.json`;
  const destination = resolve(sinkReal, ref);
  if (!isContained(sinkReal, destination)) return { status: "error", reason: "invalid-sink" };
  try {
    if (existsSync(destination)) {
      const existing = readArtifact(destination, sinkReal);
      return existing.ok && existing.bytes.equals(bytes)
        ? { status: "complete", ref, sha256: contentSha256, envelope }
        : { status: "error", reason: "artifact-collision" };
    }
    const created = writeFileIfAbsent(destination, bytes.toString("utf8"), { mode: 0o600 });
    if (!created && !existsSync(destination)) return { status: "error", reason: "write-error" };
    const published = readArtifact(destination, sinkReal);
    if (!published.ok || !published.bytes.equals(bytes)) {
      return { status: "error", reason: "artifact-collision" };
    }
    return { status: "complete", ref, sha256: contentSha256, envelope };
  } catch {
    return { status: "error", reason: "write-error" };
  }
}

export function verifyPolicyReplayEnvelope(input: {
  sinkDir: string;
  ref: string;
  sha256: string;
  authoritative?: boolean;
  expectedCatalogVersion?: string;
  expectedStateSha256?: string;
  expectedResponseSha256?: string[];
}): PolicyReplayVerification {
  if (
    !FULL_SHA256.test(input.sha256) ||
    isAbsolute(input.ref) ||
    input.ref.includes("\\") ||
    !POLICY_REPLAY_REF.test(input.ref)
  ) {
    return { ok: false, reason: "invalid-reference" };
  }
  try {
    const sinkReal = exactDirectory(input.sinkDir);
    if (sinkReal === null) return { ok: false, reason: "path-escape" };
    const candidate = resolve(input.sinkDir, input.ref);
    if (!isContained(resolve(input.sinkDir), candidate))
      return { ok: false, reason: "path-escape" };
    if (!existsSync(candidate)) return { ok: false, reason: "missing" };
    const read = readArtifact(candidate, sinkReal);
    if (!read.ok) return read;
    const contentSha256 = sha256(read.bytes);
    if (contentSha256 !== input.sha256) return { ok: false, reason: "hash-mismatch" };
    const match = POLICY_REPLAY_REF.exec(input.ref);
    if (match === null || match[3] !== contentSha256.slice(0, 12)) {
      return { ok: false, reason: "identity-mismatch" };
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
    } catch {
      return { ok: false, reason: "invalid-encoding" };
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch {
      return { ok: false, reason: "invalid-json" };
    }
    const parsed = PolicyReplayEnvelopeSchema.safeParse(decoded);
    if (!parsed.success) return { ok: false, reason: "invalid-envelope" };
    const canonical = Buffer.from(canonicalJson(parsed.data), "utf8");
    if (!canonical.equals(read.bytes)) return { ok: false, reason: "non-canonical" };
    if (
      match[1] !== sha256(parsed.data.run_id).slice(0, 12) ||
      Number(match[2]) !== parsed.data.iter
    ) {
      return { ok: false, reason: "identity-mismatch" };
    }
    if (input.authoritative === true && !parsed.data.lossless) {
      return { ok: false, reason: "lossy" };
    }
    if (
      input.expectedCatalogVersion !== undefined &&
      parsed.data.catalog_version !== input.expectedCatalogVersion
    ) {
      return { ok: false, reason: "catalog-mismatch" };
    }
    if (
      input.expectedStateSha256 !== undefined &&
      parsed.data.state_sha256 !== input.expectedStateSha256
    ) {
      return { ok: false, reason: "state-digest-mismatch" };
    }
    if (
      input.expectedResponseSha256 !== undefined &&
      (input.expectedResponseSha256.length !== parsed.data.raw_response_sha256.length ||
        input.expectedResponseSha256.some(
          (hash, index) => hash !== parsed.data.raw_response_sha256[index],
        ))
    ) {
      return { ok: false, reason: "response-hash-mismatch" };
    }
    return { ok: true, envelope: parsed.data };
  } catch {
    return { ok: false, reason: "read-error" };
  }
}
