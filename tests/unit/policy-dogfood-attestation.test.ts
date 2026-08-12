import { describe, expect, test } from "bun:test";
import type {
  PolicyDogfoodAdjudication,
  PolicyDogfoodInputManifest,
} from "../../src/schemas/policy-measurement.ts";
import {
  attestPolicyDogfood,
  policyDogfoodAttestationPreflight,
} from "../../src/stats/policy/dogfood-attestation.ts";

const SHA = "a".repeat(64);
const manifest: PolicyDogfoodInputManifest = {
  schema: "reviewgate.policy-dogfood-input-manifest.v1",
  since: "2026-08-01T00:00:00.000Z",
  until: "2026-08-12T09:00:00.000Z",
  entries: [
    { kind: "audit", ref: "audit/a.jsonl", sha256: SHA, bytes: 1, run_id: "run-a", iter: 1 },
    { kind: "trace", ref: "trace/a.json", sha256: SHA, bytes: 1, run_id: "run-a", iter: 1 },
  ],
};
const rows: readonly PolicyDogfoodAdjudication[] = [
  { run_id: "run-a", iter: 1, finding_signature: "sig-a", disposition: "tp" },
];

describe("policy dogfood human attestation", () => {
  test("binds every defanged disposition and identity to the exact preflight challenge", () => {
    const preflight = policyDogfoodAttestationPreflight({ manifest, actor: "Markus", rows });

    expect(preflight.rendered).toContain("run-a");
    expect(preflight.rendered).toContain("sig-a");
    expect(preflight.rendered).toContain("tp");
    expect(preflight.challenge).toMatch(/^ATTEST [0-9a-f]{12}$/);
    expect(preflight.candidateSha256).toMatch(/^[0-9a-f]{64}$/);

    expect(
      attestPolicyDogfood({
        manifest,
        actor: "Markus",
        rows,
        confirmation: preflight.challenge,
        now: new Date("2026-08-12T09:01:00.000Z"),
      }),
    ).toMatchObject({
      schema: "reviewgate.policy-dogfood-attestation.v1",
      actor: "Markus",
      input_manifest_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      rows,
    });
  });

  test("refuses a mismatched confirmation without revealing a fresh challenge", () => {
    expect(() =>
      attestPolicyDogfood({
        manifest,
        actor: "Markus",
        rows,
        confirmation: "ATTEST wrong",
        now: new Date("2026-08-12T09:01:00.000Z"),
      }),
    ).toThrow(/confirmation did not match/i);
  });
});
