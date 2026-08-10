import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { type PolicyTrace, PolicyTraceSchema } from "../schemas/policy-trace.ts";
import { writeFileAtomic } from "../utils/atomic-write.ts";
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
        | "hash-mismatch"
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
    const byteLength = Buffer.byteLength(canonical, "utf8");
    const maxBytes = input.maxBytes ?? POLICY_TRACE_MAX_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) return { status: "error" };

    // The complete canonical buffer is bounded before any directory, temp file,
    // reference, or content hash is materialized on disk.
    if (byteLength > maxBytes) return { status: "overflow" };

    const now = input.now ?? new Date();
    const { year, month, day } = utcPartition(now);
    const contentSha256 = sha256(Buffer.from(canonical, "utf8"));
    const runSha12 = sha256(trace.run_id).slice(0, 12);
    const filename = `${runSha12}-i${trace.iter}-${contentSha256.slice(0, 12)}.json`;
    const ref = `${year}/${month}/${day}/policy/${filename}`;
    const auditRoot = resolve(input.auditDir);
    const destination = resolve(auditRoot, ...ref.split("/"));
    if (!isContained(auditRoot, destination)) return { status: "error" };

    const policyDir = join(auditRoot, year, month, day, "policy");
    mkdirSync(policyDir, { recursive: true, mode: 0o700 });
    const realRoot = realpathSync(auditRoot);
    const realPolicyDir = realpathSync(policyDir);
    if (!isContained(realRoot, realPolicyDir)) return { status: "error" };

    writeFileAtomic(destination, canonical, { mode: 0o600 });
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
    const realRoot = realpathSync(auditRoot);
    const realCandidate = realpathSync(candidate);
    if (!isContained(realRoot, realCandidate)) return { ok: false, reason: "path-escape" };
    if (!lstatSync(realCandidate).isFile()) return { ok: false, reason: "not-a-file" };

    const bytes = readFileSync(realCandidate);
    const contentSha256 = sha256(bytes);
    if (contentSha256 !== input.sha256) return { ok: false, reason: "hash-mismatch" };
    if (match[6] !== contentSha256.slice(0, 12)) {
      return { ok: false, reason: "identity-mismatch" };
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(bytes.toString("utf8"));
    } catch {
      return { ok: false, reason: "invalid-json" };
    }
    const parsed = PolicyTraceSchema.safeParse(decoded);
    if (!parsed.success) return { ok: false, reason: "invalid-trace" };
    if (canonicalJson(parsed.data) !== bytes.toString("utf8")) {
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
