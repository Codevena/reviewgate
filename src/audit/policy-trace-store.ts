import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { type PolicyTrace, PolicyTraceSchema } from "../schemas/policy-trace.ts";
import { writeFileIfAbsent } from "../utils/atomic-write.ts";
import { canonicalJson } from "./canonical.ts";

export const POLICY_TRACE_MAX_BYTES = 1_048_576;

export type PolicyTraceWriteResult =
  | { status: "complete"; ref: string; sha256: string }
  | { status: "error" | "overflow" };

export type PolicyTraceVerification =
  | { ok: true; trace: PolicyTrace }
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
        | "invalid-trace"
        | "non-canonical"
        | "identity-mismatch"
        | "read-error";
    };

export interface WritePolicyTraceInput {
  auditDir: string;
  trace: PolicyTrace;
  maxBytes?: number;
  now?: Date;
}

export interface VerifyPolicyTraceReferenceInput {
  auditDir: string;
  ref: string;
  sha256: string;
}

const POLICY_REF =
  /^(\d{4})\/(\d{2})\/(\d{2})\/policy\/([0-9a-f]{12})-i(0|[1-9]\d*)-([0-9a-f]{12})\.json$/;
const FULL_SHA256 = /^[0-9a-f]{64}$/;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function realNonSymlinkDirectory(path: string): string | null {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
  return realpathSync(path);
}

function mkdirIfMissing(path: string): void {
  if (existsSync(path)) return;
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

function ensureAuditRoot(auditRoot: string): string | null {
  if (!existsSync(auditRoot)) {
    const parent = dirname(auditRoot);
    if (realNonSymlinkDirectory(parent) === null) return null;
    mkdirIfMissing(auditRoot);
  }
  return realNonSymlinkDirectory(auditRoot);
}

function ensureContainedDirectory(
  auditRoot: string,
  realAuditRoot: string,
  parent: string,
  name: string,
): string | null {
  const realParent = realNonSymlinkDirectory(parent);
  if (realParent === null || !isContained(realAuditRoot, realParent)) return null;
  const path = join(parent, name);
  mkdirIfMissing(path);
  const realPath = realNonSymlinkDirectory(path);
  if (realPath === null || !isContained(realAuditRoot, realPath)) return null;
  if (!isContained(auditRoot, path)) return null;
  return path;
}

function isExactRegularArtifact(path: string, realAuditRoot: string, expected: Buffer): boolean {
  const read = readBoundedRegularArtifact(path, realAuditRoot, 0o600);
  return read.ok && read.bytes.equals(expected);
}

function readBoundedRegularArtifact(
  path: string,
  realAuditRoot: string,
  requiredMode?: number,
):
  | { ok: true; bytes: Buffer }
  | { ok: false; reason: "not-a-file" | "path-escape" | "too-large" | "read-error" } {
  const pathBefore = lstatSync(path);
  if (pathBefore.isSymbolicLink() || !pathBefore.isFile() || pathBefore.nlink !== 1) {
    return { ok: false, reason: "not-a-file" };
  }
  if (requiredMode !== undefined && (pathBefore.mode & 0o7777) !== requiredMode) {
    return { ok: false, reason: "not-a-file" };
  }
  if (pathBefore.size > POLICY_TRACE_MAX_BYTES) return { ok: false, reason: "too-large" };
  const realPath = realpathSync(path);
  if (!isContained(realAuditRoot, realPath)) return { ok: false, reason: "path-escape" };

  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const openedBefore = fstatSync(fd);
    if (!openedBefore.isFile() || openedBefore.nlink !== 1) {
      return { ok: false, reason: "not-a-file" };
    }
    if (requiredMode !== undefined && (openedBefore.mode & 0o7777) !== requiredMode) {
      return { ok: false, reason: "not-a-file" };
    }
    if (openedBefore.size > POLICY_TRACE_MAX_BYTES) {
      return { ok: false, reason: "too-large" };
    }
    if (openedBefore.dev !== pathBefore.dev || openedBefore.ino !== pathBefore.ino) {
      return { ok: false, reason: "read-error" };
    }

    const bytes = readFileSync(fd);
    if (bytes.length > POLICY_TRACE_MAX_BYTES) return { ok: false, reason: "too-large" };
    const openedAfter = fstatSync(fd);
    if (
      openedAfter.dev !== openedBefore.dev ||
      openedAfter.ino !== openedBefore.ino ||
      openedAfter.size !== openedBefore.size ||
      openedAfter.mtimeMs !== openedBefore.mtimeMs ||
      openedAfter.ctimeMs !== openedBefore.ctimeMs
    ) {
      return { ok: false, reason: "read-error" };
    }
    const pathAfter = lstatSync(path);
    if (
      pathAfter.isSymbolicLink() ||
      !pathAfter.isFile() ||
      pathAfter.nlink !== 1 ||
      (requiredMode !== undefined && (pathAfter.mode & 0o7777) !== requiredMode) ||
      pathAfter.dev !== openedAfter.dev ||
      pathAfter.ino !== openedAfter.ino ||
      realpathSync(path) !== realPath
    ) {
      return { ok: false, reason: "read-error" };
    }
    return { ok: true, bytes };
  } finally {
    closeSync(fd);
  }
}

function utcPartition(now: Date): { year: string; month: string; day: string } {
  return {
    year: String(now.getUTCFullYear()),
    month: String(now.getUTCMonth() + 1).padStart(2, "0"),
    day: String(now.getUTCDate()).padStart(2, "0"),
  };
}

export function writePolicyTrace(input: WritePolicyTraceInput): PolicyTraceWriteResult {
  try {
    const trace = PolicyTraceSchema.parse(input.trace);
    const canonical = canonicalJson(trace);
    const canonicalBytes = Buffer.from(canonical, "utf8");
    const byteLength = canonicalBytes.length;
    const maxBytes = input.maxBytes ?? POLICY_TRACE_MAX_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) return { status: "error" };

    // The complete canonical buffer is bounded before any directory, temp file,
    // reference, or content hash is materialized on disk.
    if (byteLength > maxBytes) return { status: "overflow" };

    const now = input.now ?? new Date();
    const { year, month, day } = utcPartition(now);
    const contentSha256 = sha256(canonicalBytes);
    const runSha12 = sha256(trace.run_id).slice(0, 12);
    const filename = `${runSha12}-i${trace.iter}-${contentSha256.slice(0, 12)}.json`;
    const ref = `${year}/${month}/${day}/policy/${filename}`;
    const auditRoot = resolve(input.auditDir);
    const destination = resolve(auditRoot, ...ref.split("/"));
    if (!isContained(auditRoot, destination)) return { status: "error" };

    const realRoot = ensureAuditRoot(auditRoot);
    if (realRoot === null) return { status: "error" };
    let policyDir = auditRoot;
    for (const component of [year, month, day, "policy"]) {
      const next = ensureContainedDirectory(auditRoot, realRoot, policyDir, component);
      if (next === null) return { status: "error" };
      policyDir = next;
    }

    const finalPolicyDir = realNonSymlinkDirectory(policyDir);
    if (finalPolicyDir === null || !isContained(realRoot, finalPolicyDir)) {
      return { status: "error" };
    }
    if (existsSync(destination)) {
      return isExactRegularArtifact(destination, realRoot, canonicalBytes)
        ? { status: "complete", ref, sha256: contentSha256 }
        : { status: "error" };
    }

    // Publish without replacement: if another writer or an attacker creates the
    // final path after the existence check, link(2) returns EEXIST and their path
    // is validated below rather than overwritten.
    const created = writeFileIfAbsent(destination, canonical, { mode: 0o600 });
    if (!created && !existsSync(destination)) return { status: "error" };
    if (!isExactRegularArtifact(destination, realRoot, canonicalBytes)) {
      return { status: "error" };
    }
    return { status: "complete", ref, sha256: contentSha256 };
  } catch {
    return { status: "error" };
  }
}

export function verifyPolicyTraceReference(
  input: VerifyPolicyTraceReferenceInput,
): PolicyTraceVerification {
  if (!FULL_SHA256.test(input.sha256) || isAbsolute(input.ref) || input.ref.includes("\\")) {
    return { ok: false, reason: "invalid-reference" };
  }
  const match = POLICY_REF.exec(input.ref);
  if (!match) return { ok: false, reason: "invalid-reference" };

  const auditRoot = resolve(input.auditDir);
  const candidate = resolve(auditRoot, ...input.ref.split("/"));
  if (!isContained(auditRoot, candidate)) return { ok: false, reason: "path-escape" };
  if (!existsSync(candidate)) return { ok: false, reason: "missing" };

  try {
    const realRoot = realNonSymlinkDirectory(auditRoot);
    if (realRoot === null) return { ok: false, reason: "path-escape" };
    let parent = auditRoot;
    for (const component of input.ref.split("/").slice(0, -1)) {
      parent = join(parent, component);
      const realParent = realNonSymlinkDirectory(parent);
      if (realParent === null || !isContained(realRoot, realParent)) {
        return { ok: false, reason: "path-escape" };
      }
    }
    const read = readBoundedRegularArtifact(candidate, realRoot, 0o600);
    if (!read.ok) return read;
    const { bytes } = read;
    const contentSha256 = sha256(bytes);
    if (contentSha256 !== input.sha256) return { ok: false, reason: "hash-mismatch" };
    if (match[6] !== contentSha256.slice(0, 12)) {
      return { ok: false, reason: "identity-mismatch" };
    }

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return { ok: false, reason: "invalid-encoding" };
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch {
      return { ok: false, reason: "invalid-json" };
    }
    const parsed = PolicyTraceSchema.safeParse(decoded);
    if (!parsed.success) return { ok: false, reason: "invalid-trace" };
    const canonicalBytes = Buffer.from(canonicalJson(parsed.data), "utf8");
    if (!canonicalBytes.equals(bytes)) {
      return { ok: false, reason: "non-canonical" };
    }
    if (
      match[4] !== sha256(parsed.data.run_id).slice(0, 12) ||
      Number(match[5]) !== parsed.data.iter
    ) {
      return { ok: false, reason: "identity-mismatch" };
    }
    return { ok: true, trace: parsed.data };
  } catch {
    return { ok: false, reason: "read-error" };
  }
}
