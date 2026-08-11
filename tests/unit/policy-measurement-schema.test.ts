import { describe, expect, test } from "bun:test";
import {
  PolicyDogfoodAttestationSchema,
  PolicyDogfoodInputManifestSchema,
  PolicyMeasurementSchema,
} from "../../src/schemas/policy-measurement.ts";

const SHA = "b".repeat(64);

describe("policy measurement result contracts", () => {
  test("rejects a non-code-unit-sorted or partial dogfood input inventory", () => {
    const manifest = {
      schema: "reviewgate.policy-dogfood-input-manifest.v1",
      since: "2026-08-01T00:00:00.000Z",
      until: "2026-08-12T09:00:00.000Z",
      entries: [
        { kind: "audit", ref: "audit/a.jsonl", sha256: SHA, bytes: 1, run_id: "run-a", iter: 1 },
        { kind: "trace", ref: "trace/a.json", sha256: SHA, bytes: 1, run_id: "run-a", iter: 1 },
      ],
    };
    expect(() => PolicyDogfoodInputManifestSchema.parse(manifest)).not.toThrow();
    expect(() =>
      PolicyDogfoodInputManifestSchema.parse({
        ...manifest,
        entries: [...manifest.entries].reverse(),
      }),
    ).toThrow();
    expect(() =>
      PolicyDogfoodInputManifestSchema.parse({ ...manifest, entries: [manifest.entries[0]] }),
    ).toThrow();
  });

  test("requires a content-bound human TP/FP attestation", () => {
    const attestation = {
      schema: "reviewgate.policy-dogfood-attestation.v1",
      actor: "Markus",
      attested_at: "2026-08-12T09:00:00.000Z",
      challenge_sha256: SHA,
      input_manifest_sha256: SHA,
      rows: [{ run_id: "run-a", iter: 1, finding_signature: SHA, disposition: "tp" }],
    };
    expect(() => PolicyDogfoodAttestationSchema.parse(attestation)).not.toThrow();
    expect(() =>
      PolicyDogfoodAttestationSchema.parse({
        ...attestation,
        rows: [{ ...attestation.rows[0], disposition: "declined" }],
      }),
    ).toThrow();
  });

  test("never accepts an authoritative partial measurement result", () => {
    expect(() =>
      PolicyMeasurementSchema.parse({
        schema: "reviewgate.policy-measurement.v1",
        preregistration: { ref: "bench/preregistrations/a.json", sha256: SHA },
        catalog_version: "reviewgate.policy-catalog.v1",
        passes: [],
        interactions: [],
        artifacts: { authoritative: true, sources: [] },
      }),
    ).toThrow();
  });
});
