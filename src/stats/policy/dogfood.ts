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
import { canonicalJson } from "../../audit/canonical.ts";
import { verifyAuditBytes } from "../../audit/verifier.ts";
import type { PolicyMeasurementPreregistration } from "../../schemas/policy-measurement-preregistration.ts";
import {
  type PolicyDogfoodAttestation,
  PolicyDogfoodAttestationSchema,
  type PolicyDogfoodInputManifest,
  PolicyDogfoodInputManifestSchema,
  type PolicyDogfoodSnapshot,
  PolicyDogfoodSnapshotSchema,
  policyDogfoodEvaluationEffect,
} from "../../schemas/policy-measurement.ts";
import { type PolicyTrace, PolicyTraceSchema } from "../../schemas/policy-trace.ts";
import { policyDogfoodAttestationPreflight } from "./dogfood-attestation.ts";

export const POLICY_DOGFOOD_SOURCE_MAX_BYTES = 1_048_576;
export const POLICY_DOGFOOD_EXCLUSION_CODES = [
  "agent-only-decision",
  "missing-attestation",
  "attestation-input-manifest-mismatch",
  "missing-decision",
  "incomplete-trace",
  "ambiguous-run-iter",
  "signature-absent-lineage",
  "malformed-chain",
  "changed-source-file",
  "post-registered-at",
] as const;

type DogfoodExclusionCode = (typeof POLICY_DOGFOOD_EXCLUSION_CODES)[number];
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
    if (!contained(resolve(repoRoot), auditRoot))
      throw new Error("dogfood audit root escapes repository");
    for (const auditPath of walkAuditJsonl(auditRoot)) {
      const auditRef = rootRelative(repoRoot, auditPath);
      const auditBytes = stableRead(repoRoot, auditRef);
      const verified = verifyAuditBytes({
        bytes: auditBytes,
        auditDir: resolve(auditPath, "..", "..", "..", ".."),
      });
      if (!verified.ok)
        throw new Error(`dogfood audit chain is malformed at line ${verified.brokenAtLine}`);
      const complete = completeRunEvents(verified.events).filter((event) =>
        timestampInWindow(event.ts, since, until),
      );
      if (complete.length === 0) continue;
      const runs: Extract<ManifestEntry, { kind: "audit" }>["runs"] = [];
      for (const row of complete) {
        const tracePath = resolve(auditRoot, ...row.ref.split("/"));
        const traceRef = rootRelative(repoRoot, tracePath);
        const traceBytes = stableRead(repoRoot, traceRef);
        if (sha256(traceBytes) !== row.sha256)
          throw new Error("dogfood trace hash differs from audit reference");
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
          compareCodeUnits(pairKey(left.run_id, left.iter), pairKey(right.run_id, right.iter)),
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

function exclusions(): Record<DogfoodExclusionCode, number> {
  return Object.fromEntries(POLICY_DOGFOOD_EXCLUSION_CODES.map((code) => [code, 0])) as Record<
    DogfoodExclusionCode,
    number
  >;
}

function increment(target: Record<DogfoodExclusionCode, number>, code: DogfoodExclusionCode): void {
  target[code] += 1;
}

function pairKey(runId: string, iter: number): string {
  return `${runId}\u0000${iter}`;
}

function manifestSha256(value: PolicyDogfoodInputManifest): string {
  return sha256(canonicalJson(PolicyDogfoodInputManifestSchema.parse(value)));
}

function attestationSha256(value: PolicyDogfoodAttestation): string {
  return sha256(canonicalJson(PolicyDogfoodAttestationSchema.parse(value)));
}

function traceLineage(trace: PolicyTrace): Set<string> {
  return new Set([
    ...trace.final.finding_signatures,
    ...trace.evaluations.flatMap((row) => [
      ...row.source_signatures,
      ...(row.final_signature ? [row.final_signature] : []),
    ]),
    ...trace.stages.flatMap((row) => [
      ...row.input_signatures,
      ...(row.output_signature ? [row.output_signature] : []),
    ]),
  ]);
}

function emptySnapshot(input: {
  preregistration: PolicyMeasurementPreregistration;
  exclusions: Record<DogfoodExclusionCode, number>;
}): PolicyDogfoodSnapshot {
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
    exclusions: input.exclusions,
  });
}

export function harvestPolicyDogfood(input: {
  preregistration: PolicyMeasurementPreregistration;
  inputManifest: PolicyDogfoodInputManifest;
  attestation: PolicyDogfoodAttestation;
  artifactRoot: string;
  /** Repository root that contains the frozen audit/trace refs. Defaults to the caller cwd. */
  sourceRoot?: string;
  /** Observability-only hook; callers cannot change the frozen source set. */
  onFrozenSourceRead?: (entry: ManifestEntry) => void;
}): PolicyDogfoodSnapshot {
  const sourceRoot = input.sourceRoot ?? process.cwd();
  const exclusionsByCode = exclusions();
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
    increment(exclusionsByCode, "attestation-input-manifest-mismatch");
    return emptySnapshot({ preregistration: input.preregistration, exclusions: exclusionsByCode });
  }
  const manifest = manifestArtifact.value;
  const attestation = attestationArtifact.value;
  const since = parseTimestamp(pre.since);
  const until = parseTimestamp(pre.until);
  if (since === null || until === null || since >= until) {
    increment(exclusionsByCode, "attestation-input-manifest-mismatch");
    return emptySnapshot({ preregistration: input.preregistration, exclusions: exclusionsByCode });
  }
  const sourceManifestSha = manifestSha256(manifest);
  const sourceAttestationSha = attestationSha256(attestation);
  const expectedPreflight = policyDogfoodAttestationPreflight({
    manifest,
    actor: attestation.actor,
    rows: attestation.rows,
  });
  if (
    pre.since !== manifest.since ||
    pre.until !== manifest.until ||
    pre.input_manifest_sha256 !== sourceManifestSha ||
    pre.attestation_sha256 !== sourceAttestationSha ||
    attestation.input_manifest_sha256 !== sourceManifestSha ||
    attestation.challenge_sha256 !== expectedPreflight.candidateSha256
  ) {
    increment(exclusionsByCode, "attestation-input-manifest-mismatch");
    return emptySnapshot({ preregistration: input.preregistration, exclusions: exclusionsByCode });
  }
  if (!validRef(pre.input_manifest_ref) || !validRef(pre.attestation_ref)) {
    throw new Error("dogfood preregistration artifact reference is invalid");
  }

  const auditEvents = new Map<string, Record<string, unknown>[]>();
  const auditRunBindings = new Map<
    string,
    { auditRef: string; traceRef: string; sha256: string }
  >();
  const traces = new Map<string, PolicyTrace>();
  for (const entry of manifest.entries) {
    let bytes: Buffer;
    try {
      bytes = stableRead(sourceRoot, entry.ref, () => input.onFrozenSourceRead?.(entry));
    } catch {
      increment(exclusionsByCode, "changed-source-file");
      continue;
    }
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) {
      increment(exclusionsByCode, "changed-source-file");
      continue;
    }
    if (entry.kind === "audit") {
      const result = verifyAuditBytes({
        bytes,
        auditDir: resolve(sourceRoot, entry.ref, "..", "..", "..", ".."),
      });
      if (!result.ok) {
        increment(exclusionsByCode, "malformed-chain");
        continue;
      }
      for (const run of entry.runs) {
        const key = pairKey(run.run_id, run.iter);
        auditEvents.set(key, result.events);
        auditRunBindings.set(key, {
          auditRef: entry.ref,
          traceRef: run.trace_ref,
          sha256: run.trace_sha256,
        });
      }
    } else {
      try {
        const trace = PolicyTraceSchema.parse(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        );
        if (trace.run_id !== entry.run_id || trace.iter !== entry.iter) throw new Error("identity");
        traces.set(`${entry.audit_ref}\u0000${entry.trace_ref}`, trace);
      } catch {
        increment(exclusionsByCode, "incomplete-trace");
      }
    }
  }

  const labels: PolicyDogfoodSnapshot["labels"] = [];
  for (const row of attestation.rows) {
    const key = pairKey(row.run_id, row.iter);
    const events = auditEvents.get(key);
    const binding = auditRunBindings.get(key);
    const trace =
      binding === undefined
        ? undefined
        : traces.get(`${binding.auditRef}\u0000${binding.traceRef}`);
    if (events === undefined || trace === undefined) {
      increment(exclusionsByCode, "incomplete-trace");
      continue;
    }
    const completions = completeRunEvents(events).filter(
      (event) => event.runId === row.run_id && event.iter === row.iter,
    );
    if (completions.length !== 1) {
      increment(
        exclusionsByCode,
        completions.length === 0 ? "incomplete-trace" : "ambiguous-run-iter",
      );
      continue;
    }
    const decisions = events.filter(
      (event) =>
        event.event === "decision.applied" &&
        event.run_id === row.run_id &&
        event.iter === row.iter &&
        Array.isArray(event.finding_signatures) &&
        event.finding_signatures.includes(row.finding_signature),
    );
    if (decisions.length !== 1) {
      increment(
        exclusionsByCode,
        decisions.length === 0 ? "missing-decision" : "ambiguous-run-iter",
      );
      continue;
    }
    const decision = decisions[0];
    const completion = completions[0];
    if (
      decision === undefined ||
      completion === undefined ||
      binding === undefined ||
      binding.traceRef !== completion.ref ||
      binding.sha256 !== completion.sha256 ||
      !timestampInWindow(decision.ts, since, until) ||
      !timestampInWindow(completion.ts, since, until)
    ) {
      increment(exclusionsByCode, "post-registered-at");
      continue;
    }
    if (!traceLineage(trace).has(row.finding_signature)) {
      increment(exclusionsByCode, "signature-absent-lineage");
      continue;
    }
    for (const evaluation of trace.evaluations) {
      if (
        evaluation.result === "no-opportunity" ||
        !evaluation.source_signatures.includes(row.finding_signature)
      )
        continue;
      labels.push({
        pass_id: evaluation.pass_id,
        run_id: row.run_id,
        iter: row.iter,
        finding_signature: row.finding_signature,
        disposition: row.disposition,
        evaluation_result: evaluation.result,
        before: evaluation.before,
        after: evaluation.after,
        ...(evaluation.protected_by === undefined ? {} : { protected_by: evaluation.protected_by }),
        effect: policyDogfoodEvaluationEffect({
          result: evaluation.result,
          before: evaluation.before,
          after: evaluation.after,
        }),
        source_signatures: evaluation.source_signatures,
      });
    }
  }

  for (const [key, events] of auditEvents) {
    const [runId, iterText] = key.split("\u0000");
    const iter = Number(iterText);
    for (const decision of events.filter(
      (event) =>
        event.event === "decision.applied" && event.run_id === runId && event.iter === iter,
    )) {
      const signatures = Array.isArray(decision.finding_signatures)
        ? decision.finding_signatures.filter((value): value is string => typeof value === "string")
        : [];
      if (signatures.length === 0) {
        increment(exclusionsByCode, "agent-only-decision");
      } else if (
        !attestation.rows.some(
          (row) =>
            row.run_id === runId && row.iter === iter && signatures.includes(row.finding_signature),
        )
      ) {
        increment(exclusionsByCode, "missing-attestation");
      }
    }
  }

  return PolicyDogfoodSnapshotSchema.parse({
    schema: "reviewgate.policy-dogfood-snapshot.v1",
    input_manifest: { ref: pre.input_manifest_ref, sha256: pre.input_manifest_sha256 },
    attestation: { ref: pre.attestation_ref, sha256: pre.attestation_sha256 },
    labels: labels.sort((left, right) =>
      compareCodeUnits(
        `${left.pass_id}\u0000${left.run_id}\u0000${left.iter}\u0000${left.finding_signature}`,
        `${right.pass_id}\u0000${right.run_id}\u0000${right.iter}\u0000${right.finding_signature}`,
      ),
    ),
    exclusions: exclusionsByCode,
  });
}
