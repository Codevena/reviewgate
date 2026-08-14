import { createHash } from "node:crypto";
import { canonicalJson } from "../../audit/canonical.ts";
import {
  type PolicyDogfoodAdjudication,
  PolicyDogfoodAdjudicationSchema,
  type PolicyDogfoodAttestation,
  PolicyDogfoodAttestationSchema,
  type PolicyDogfoodInputManifest,
  PolicyDogfoodInputManifestSchema,
} from "../../schemas/policy-measurement.ts";

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function defang(value: string): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}

function manifestSha256(manifest: PolicyDogfoodInputManifest): string {
  return sha256(canonicalJson(PolicyDogfoodInputManifestSchema.parse(manifest)));
}

function attestationCandidate(input: {
  manifest: PolicyDogfoodInputManifest;
  actor: string;
  rows: readonly PolicyDogfoodAdjudication[];
}): { manifestSha256: string; canonical: string } {
  const manifest = PolicyDogfoodInputManifestSchema.parse(input.manifest);
  const rows = input.rows.map((row) => PolicyDogfoodAdjudicationSchema.parse(row));
  if (input.actor.trim().length === 0) throw new Error("dogfood attestation actor is required");
  if (rows.length === 0) throw new Error("dogfood attestation requires at least one disposition");
  return {
    manifestSha256: manifestSha256(manifest),
    canonical: canonicalJson({ actor: input.actor, manifest, rows }),
  };
}

export function policyDogfoodAttestationPreflight(input: {
  manifest: PolicyDogfoodInputManifest;
  actor: string;
  rows: readonly PolicyDogfoodAdjudication[];
}): { rendered: string; challenge: `ATTEST ${string}`; candidateSha256: string } {
  const candidate = attestationCandidate(input);
  const candidateSha256 = sha256(candidate.canonical);
  const rows = input.rows.map((row) => PolicyDogfoodAdjudicationSchema.parse(row));
  const rendered = [
    "Policy dogfood attestation",
    `actor: ${defang(input.actor)}`,
    `input manifest sha256: ${candidate.manifestSha256}`,
    "frozen manifest inventory:",
    ...input.manifest.entries.flatMap((entry) =>
      entry.kind === "audit"
        ? [
            `- audit ref=${defang(entry.ref)} sha256=${entry.sha256} bytes=${entry.bytes}`,
            ...entry.runs.map(
              (run) =>
                `  - run=${defang(run.run_id)} iter=${run.iter} trace_ref=${defang(run.trace_ref)} trace_sha256=${run.trace_sha256}`,
            ),
          ]
        : [
            `- trace ref=${defang(entry.ref)} sha256=${entry.sha256} bytes=${entry.bytes} audit_ref=${defang(entry.audit_ref)} trace_ref=${defang(entry.trace_ref)} run=${defang(entry.run_id)} iter=${entry.iter}`,
          ],
    ),
    "dispositions:",
    ...rows.map(
      (row) =>
        `- run=${defang(row.run_id)} iter=${row.iter} finding=${defang(row.finding_signature)} disposition=${row.disposition}`,
    ),
  ].join("\n");
  return { rendered, challenge: `ATTEST ${candidateSha256.slice(0, 12)}`, candidateSha256 };
}

export function attestPolicyDogfood(input: {
  manifest: PolicyDogfoodInputManifest;
  actor: string;
  rows: readonly PolicyDogfoodAdjudication[];
  confirmation: string;
  now: Date;
}): PolicyDogfoodAttestation {
  // Re-run preflight at the actual trust boundary. A caller must display that
  // preflight via the future TTY command; this pure layer never prints a challenge.
  const preflight = policyDogfoodAttestationPreflight(input);
  if (input.confirmation.trim() !== preflight.challenge) {
    throw new Error("Confirmation did not match — no dogfood attestation was created");
  }
  const manifest = PolicyDogfoodInputManifestSchema.parse(input.manifest);
  const result = {
    schema: "reviewgate.policy-dogfood-attestation.v1" as const,
    actor: input.actor,
    attested_at: input.now.toISOString(),
    challenge_sha256: preflight.candidateSha256,
    input_manifest_sha256: manifestSha256(manifest),
    rows: input.rows.map((row) => PolicyDogfoodAdjudicationSchema.parse(row)),
  };
  return PolicyDogfoodAttestationSchema.parse(result);
}
