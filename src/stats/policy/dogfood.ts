import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { verifyCanonicalJsonArtifact } from "../../artifacts/canonical-json.ts";
import { verifyAuditBytes } from "../../audit/verifier.ts";
import type { PolicyMeasurementPreregistration } from "../../schemas/policy-measurement-preregistration.ts";
import {
  type PolicyDogfoodAttestation,
  PolicyDogfoodAttestationSchema,
  type PolicyDogfoodInputManifest,
  PolicyDogfoodInputManifestSchema,
  type PolicyDogfoodSnapshot,
  PolicyDogfoodSnapshotSchema,
} from "../../schemas/policy-measurement.ts";
import { PolicyTraceSchema } from "../../schemas/policy-trace.ts";
import {
  POLICY_DOGFOOD_EXCLUSION_CODES,
  harvestPolicyDogfoodFromVerifiedSources,
} from "./dogfood-snapshot.ts";

export { POLICY_DOGFOOD_EXCLUSION_CODES } from "./dogfood-snapshot.ts";

export const POLICY_DOGFOOD_SOURCE_MAX_BYTES = 1_048_576;

type ManifestEntry = PolicyDogfoodInputManifest["entries"][number];

export const __test: {
  readSync: (fd: number, buffer: Buffer) => number;
  afterRead: (() => void) | undefined;
} = {
  readSync: (fd, buffer) => readSync(fd, buffer, 0, buffer.length, null),
  afterRead: undefined,
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validRef(ref: string): boolean {
  return (
    ref.length > 0 &&
    !isAbsolute(ref) &&
    !ref.includes("\\") &&
    !ref.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  );
}

function contained(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

/** Exact 0600, nlink=1, final-leaf no-follow, single-FD bounded read. */
function stableRead(root: string, ref: string, onRead?: () => void): Buffer {
  if (!validRef(ref)) throw new Error("dogfood source has an invalid reference");
  const realRoot = realpathSync(root);
  const path = resolve(root, ...ref.split("/"));
  if (!contained(resolve(root), path)) throw new Error("dogfood source escapes its root");
  let parent = resolve(root);
  for (const component of ref.split("/").slice(0, -1)) {
    parent = join(parent, component);
    const parentStat = lstatSync(parent);
    if (
      parentStat.isSymbolicLink() ||
      !parentStat.isDirectory() ||
      !contained(realRoot, realpathSync(parent))
    ) {
      throw new Error("dogfood source has an unsafe parent component");
    }
  }
  const before = lstatSync(path);
  const realPath = realpathSync(path);
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.nlink !== 1 ||
    (before.mode & 0o7777) !== 0o600 ||
    !contained(realRoot, realPath) ||
    before.size > POLICY_DOGFOOD_SOURCE_MAX_BYTES
  ) {
    throw new Error("dogfood source is not a private regular file");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      (opened.mode & 0o7777) !== 0o600 ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size > POLICY_DOGFOOD_SOURCE_MAX_BYTES
    ) {
      throw new Error("dogfood source identity changed before read");
    }
    const bounded = Buffer.allocUnsafe(POLICY_DOGFOOD_SOURCE_MAX_BYTES + 1);
    const bytesRead = __test.readSync(fd, bounded);
    if (bytesRead > POLICY_DOGFOOD_SOURCE_MAX_BYTES) {
      throw new Error("dogfood source exceeds bounded read limit");
    }
    const bytes = bounded.subarray(0, bytesRead);
    onRead?.();
    __test.afterRead?.();
    const after = fstatSync(fd);
    const pathAfter = lstatSync(path);
    if (
      bytes.length > POLICY_DOGFOOD_SOURCE_MAX_BYTES ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs ||
      pathAfter.isSymbolicLink() ||
      !pathAfter.isFile() ||
      pathAfter.nlink !== 1 ||
      (pathAfter.mode & 0o7777) !== 0o600 ||
      pathAfter.dev !== after.dev ||
      pathAfter.ino !== after.ino ||
      realpathSync(path) !== realPath
    ) {
      throw new Error("dogfood source identity changed during read");
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function walkAuditJsonl(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    const stat = lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("dogfood audit root contains a non-directory component");
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("dogfood audit root contains a symlink");
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(path);
    }
  };
  walk(root);
  return found.sort(compareCodeUnits);
}

function rootRelative(root: string, path: string): string {
  const ref = relative(root, path).split(sep).join("/");
  if (!validRef(ref)) throw new Error("dogfood source lies outside the repository root");
  return ref;
}

function completeRunEvents(events: readonly Record<string, unknown>[]): Array<{
  runId: string;
  iter: number;
  ref: string;
  sha256: string;
  ts: unknown;
}> {
  const rows: Array<{ runId: string; iter: number; ref: string; sha256: string; ts: unknown }> = [];
  for (const event of events) {
    if (
      event.event !== "run.complete" ||
      typeof event.run_id !== "string" ||
      !Number.isInteger(event.iter)
    ) {
      continue;
    }
    const summary = event.run_summary;
    if (summary === null || typeof summary !== "object") continue;
    const value = summary as Record<string, unknown>;
    if (
      value.policy_trace_status === "complete" &&
      typeof value.policy_trace_ref === "string" &&
      typeof value.policy_trace_sha256 === "string"
    ) {
      rows.push({
        runId: event.run_id,
        iter: event.iter as number,
        ref: value.policy_trace_ref,
        sha256: value.policy_trace_sha256,
        ts: event.ts,
      });
    }
  }
  return rows;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function timestampInWindow(value: unknown, since: number, until: number): boolean {
  const milliseconds = parseTimestamp(value);
  return milliseconds !== null && milliseconds >= since && milliseconds < until;
}

export function createPolicyDogfoodInputManifest(input: {
  auditRoots: readonly string[];
  since: string;
  until: string;
}): PolicyDogfoodInputManifest {
  const since = parseTimestamp(input.since);
  const until = parseTimestamp(input.until);
  if (since === null || until === null || since >= until) {
    throw new Error("dogfood window must be a valid non-empty [since, until) interval");
  }
  const repoRoot = process.cwd();
  const entries: ManifestEntry[] = [];
  for (const auditRootInput of input.auditRoots) {
    const auditRoot = resolve(repoRoot, auditRootInput);
    if (!contained(resolve(repoRoot), auditRoot)) {
      throw new Error("dogfood audit root escapes repository");
    }
    for (const auditPath of walkAuditJsonl(auditRoot)) {
      const auditRef = rootRelative(repoRoot, auditPath);
      const auditBytes = stableRead(repoRoot, auditRef);
      const verified = verifyAuditBytes({
        bytes: auditBytes,
        auditDir: resolve(auditPath, "..", "..", "..", ".."),
      });
      if (!verified.ok) {
        throw new Error(`dogfood audit chain is malformed at line ${verified.brokenAtLine}`);
      }
      const complete = completeRunEvents(verified.events).filter((event) =>
        timestampInWindow(event.ts, since, until),
      );
      if (complete.length === 0) continue;
      const runs: Extract<ManifestEntry, { kind: "audit" }>["runs"] = [];
      for (const row of complete) {
        const tracePath = resolve(auditRoot, ...row.ref.split("/"));
        const traceRef = rootRelative(repoRoot, tracePath);
        const traceBytes = stableRead(repoRoot, traceRef);
        if (sha256(traceBytes) !== row.sha256) {
          throw new Error("dogfood trace hash differs from audit reference");
        }
        const trace = PolicyTraceSchema.parse(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(traceBytes)),
        );
        if (trace.run_id !== row.runId || trace.iter !== row.iter) {
          throw new Error("dogfood trace identity differs from audit run/iteration");
        }
        runs.push({
          run_id: row.runId,
          iter: row.iter,
          trace_ref: row.ref,
          trace_sha256: row.sha256,
        });
        entries.push({
          kind: "trace",
          ref: traceRef,
          audit_ref: auditRef,
          trace_ref: row.ref,
          sha256: sha256(traceBytes),
          bytes: traceBytes.length,
          run_id: row.runId,
          iter: row.iter,
        });
      }
      entries.push({
        kind: "audit",
        ref: auditRef,
        sha256: sha256(auditBytes),
        bytes: auditBytes.length,
        runs: runs.sort((left, right) =>
          compareCodeUnits(
            `${left.run_id}\u0000${left.iter}`,
            `${right.run_id}\u0000${right.iter}`,
          ),
        ),
      });
    }
  }
  return PolicyDogfoodInputManifestSchema.parse({
    schema: "reviewgate.policy-dogfood-input-manifest.v1",
    since: input.since,
    until: input.until,
    entries: entries.sort((left, right) => compareCodeUnits(left.ref, right.ref)),
  });
}

function artifactFailureSnapshot(input: {
  preregistration: PolicyMeasurementPreregistration;
}): PolicyDogfoodSnapshot {
  const exclusions = Object.fromEntries(
    POLICY_DOGFOOD_EXCLUSION_CODES.map((code) => [
      code,
      code === "attestation-input-manifest-mismatch" ? 1 : 0,
    ]),
  );
  return PolicyDogfoodSnapshotSchema.parse({
    schema: "reviewgate.policy-dogfood-snapshot.v1",
    input_manifest: {
      ref: input.preregistration.dogfood.input_manifest_ref,
      sha256: input.preregistration.dogfood.input_manifest_sha256,
    },
    attestation: {
      ref: input.preregistration.dogfood.attestation_ref,
      sha256: input.preregistration.dogfood.attestation_sha256,
    },
    labels: [],
    declined: 0,
    exclusions,
  });
}

/**
 * Live harvesting authenticates the two registered artifacts, then delegates all semantic
 * derivation to the same pure byte-owned snapshot core used by publication verification.
 */
export function harvestPolicyDogfood(input: {
  preregistration: PolicyMeasurementPreregistration;
  inputManifest: PolicyDogfoodInputManifest;
  attestation: PolicyDogfoodAttestation;
  artifactRoot: string;
  sourceRoot?: string;
  onFrozenSourceRead?: (entry: ManifestEntry) => void;
}): PolicyDogfoodSnapshot {
  const pre = input.preregistration.dogfood;
  const manifestArtifact = verifyCanonicalJsonArtifact({
    root: input.artifactRoot,
    directory: "policy-dogfood-input",
    schema: PolicyDogfoodInputManifestSchema,
    ref: pre.input_manifest_ref,
    sha256: pre.input_manifest_sha256,
    maxBytes: POLICY_DOGFOOD_SOURCE_MAX_BYTES,
  });
  const attestationArtifact = verifyCanonicalJsonArtifact({
    root: input.artifactRoot,
    directory: "policy-dogfood-attestation",
    schema: PolicyDogfoodAttestationSchema,
    ref: pre.attestation_ref,
    sha256: pre.attestation_sha256,
    maxBytes: POLICY_DOGFOOD_SOURCE_MAX_BYTES,
  });
  if (!manifestArtifact.ok || !attestationArtifact.ok) {
    return artifactFailureSnapshot({ preregistration: input.preregistration });
  }
  const sourceRoot = input.sourceRoot ?? process.cwd();
  return harvestPolicyDogfoodFromVerifiedSources({
    preregistration: input.preregistration,
    inputManifest: manifestArtifact.value,
    attestation: attestationArtifact.value,
    readFrozenSource: (entry) => {
      try {
        return stableRead(sourceRoot, entry.ref, () => input.onFrozenSourceRead?.(entry));
      } catch {
        return undefined;
      }
    },
  });
}
