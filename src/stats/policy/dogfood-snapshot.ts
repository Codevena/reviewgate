import { createHash } from "node:crypto";
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

export const POLICY_DOGFOOD_EXCLUSION_CODES = [
  "agent-only-decision",
  "missing-attestation",
  "declined",
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

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validRef(ref: string): boolean {
  return (
    ref.length > 0 &&
    !ref.startsWith("/") &&
    !ref.includes("\\") &&
    !ref.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  );
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

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function timestampInWindow(value: unknown, since: number, until: number): boolean {
  const milliseconds = parseTimestamp(value);
  return milliseconds !== null && milliseconds >= since && milliseconds < until;
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
    declined: 0,
    exclusions: input.exclusions,
  });
}

/**
 * Derive Dogfood dispositions from a caller-owned closed source map. This function never accepts
 * a path and consequently cannot reread a live repository after an authority decision.
 */
export function harvestPolicyDogfoodFromVerifiedSources(input: {
  preregistration: PolicyMeasurementPreregistration;
  inputManifest: PolicyDogfoodInputManifest;
  attestation: PolicyDogfoodAttestation;
  readFrozenSource: (entry: ManifestEntry) => Buffer | undefined;
}): PolicyDogfoodSnapshot {
  const exclusionsByCode = exclusions();
  const pre = input.preregistration.dogfood;
  const manifest = PolicyDogfoodInputManifestSchema.parse(input.inputManifest);
  const attestation = PolicyDogfoodAttestationSchema.parse(input.attestation);
  const since = parseTimestamp(pre.since);
  const until = parseTimestamp(pre.until);
  const manifestSha256 = sha256(canonicalJson(manifest));
  const attestationSha256 = sha256(canonicalJson(attestation));
  const preflight = policyDogfoodAttestationPreflight({
    manifest,
    actor: attestation.actor,
    rows: attestation.rows,
  });
  if (
    since === null ||
    until === null ||
    since >= until ||
    !validRef(pre.input_manifest_ref) ||
    !validRef(pre.attestation_ref) ||
    pre.since !== manifest.since ||
    pre.until !== manifest.until ||
    pre.input_manifest_sha256 !== manifestSha256 ||
    pre.attestation_sha256 !== attestationSha256 ||
    attestation.input_manifest_sha256 !== manifestSha256 ||
    attestation.challenge_sha256 !== preflight.candidateSha256
  ) {
    increment(exclusionsByCode, "attestation-input-manifest-mismatch");
    return emptySnapshot({ preregistration: input.preregistration, exclusions: exclusionsByCode });
  }

  const auditEvents = new Map<string, Record<string, unknown>[]>();
  const auditRunBindings = new Map<
    string,
    { auditRef: string; traceRef: string; sha256: string }
  >();
  const traces = new Map<string, PolicyTrace>();
  const frozenBytes = new Map<string, Buffer | undefined>();
  const readEntry = (entry: ManifestEntry): Buffer | undefined => {
    const key = `${entry.kind}\u0000${entry.ref}\u0000${entry.sha256}`;
    if (frozenBytes.has(key)) return frozenBytes.get(key);
    const bytes = input.readFrozenSource(entry);
    const verified =
      bytes === undefined || bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256
        ? undefined
        : bytes;
    frozenBytes.set(key, verified);
    return verified;
  };
  for (const entry of manifest.entries) {
    const bytes = readEntry(entry);
    if (bytes === undefined) {
      increment(exclusionsByCode, "changed-source-file");
      continue;
    }
    if (entry.kind === "audit") {
      const verified = verifyAuditBytes({
        bytes,
        auditDir: ".",
        verifyPolicyTraceReference: ({ ref, sha256: traceSha256 }) => {
          const traceEntry = manifest.entries.find(
            (candidate) =>
              candidate.kind === "trace" &&
              candidate.audit_ref === entry.ref &&
              candidate.trace_ref === ref &&
              candidate.sha256 === traceSha256,
          );
          if (traceEntry === undefined) return false;
          const traceBytes = readEntry(traceEntry);
          if (traceBytes === undefined) return false;
          try {
            PolicyTraceSchema.parse(
              JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(traceBytes)),
            );
            return true;
          } catch {
            return false;
          }
        },
      });
      if (!verified.ok) {
        increment(exclusionsByCode, "malformed-chain");
        continue;
      }
      for (const run of entry.runs) {
        const key = pairKey(run.run_id, run.iter);
        auditEvents.set(key, verified.events);
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
  let declined = 0;
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
    if (row.disposition === "declined") {
      declined += 1;
      increment(exclusionsByCode, "declined");
      continue;
    }
    for (const evaluation of trace.evaluations) {
      if (
        evaluation.result === "no-opportunity" ||
        !evaluation.source_signatures.includes(row.finding_signature)
      ) {
        continue;
      }
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
    declined,
    exclusions: exclusionsByCode,
  });
}
