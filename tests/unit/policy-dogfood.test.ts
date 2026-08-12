import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { join, relative } from "node:path";
import { canonicalJson } from "../../src/audit/canonical.ts";
import { AuditLogger } from "../../src/audit/logger.ts";
import { POLICY_PASS_IDS } from "../../src/core/policy/catalog.ts";
import type { PolicyTrace } from "../../src/schemas/policy-trace.ts";
import {
  attestPolicyDogfood,
  policyDogfoodAttestationPreflight,
} from "../../src/stats/policy/dogfood-attestation.ts";
import {
  createPolicyDogfoodInputManifest,
  harvestPolicyDogfood,
} from "../../src/stats/policy/dogfood.ts";

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function trace(runId: string): PolicyTrace {
  return {
    schema: "reviewgate.policy-trace.v1",
    catalog_version: "reviewgate.policy-catalog.v1",
    run_id: runId,
    iter: 1,
    ablated: [],
    raw_response_sha256: ["a".repeat(64)],
    passes: POLICY_PASS_IDS.map((passId) =>
      passId === "judgment.confidence"
        ? {
            pass_id: passId,
            status: "ran",
            considered: 1,
            opportunities: 1,
            would_apply: 1,
            applied: 1,
            protected: 0,
            blocking_removed: 1,
            blocking_preserved: 0,
            dropped: 0,
          }
        : {
            pass_id: passId,
            status: "ran",
            considered: 0,
            opportunities: 0,
            would_apply: 0,
            applied: 0,
            protected: 0,
            blocking_removed: 0,
            blocking_preserved: 0,
            dropped: 0,
          },
    ),
    evaluations: [
      {
        pass_id: "judgment.confidence",
        order: 140,
        result: "applied",
        before: "WARN",
        after: "INFO",
        reason_code: "below-confidence-floor",
        source_signatures: ["sig-a"],
        final_signature: "sig-a",
      },
    ],
    stages: [
      {
        stage_id: "aggregation.cluster",
        order: 65,
        reason_code: "singleton",
        member_count: 1,
        input_signatures: ["sig-a"],
        output_signature: "sig-a",
      },
      {
        stage_id: "verdict.compute",
        order: 190,
        reason_code: "no-blocking-findings",
        input_signatures: [],
        verdict: "PASS",
      },
    ],
    final: {
      verdict: "PASS",
      counts: { critical: 0, warn: 0, info: 1 },
      finding_signatures: ["sig-a"],
      finding_severities: [{ signature: "sig-a", severity: "INFO" }],
    },
  };
}

function frozenFixture(disposition: "tp" | "fp") {
  const root = mkdtempSync(join(process.cwd(), ".rg-policy-dogfood-"));
  const auditDir = join(root, "audit");
  mkdirSync(auditDir, { recursive: true, mode: 0o700 });
  const log = new AuditLogger(auditDir);
  const stored = log.writePolicyTrace(trace("run-a"));
  if (stored.status !== "complete") throw new Error("expected complete trace fixture");
  return (async () => {
    await log.append({
      event: "run.complete",
      run_id: "run-a",
      iter: 1,
      trigger: "stop-hook",
      run_summary: {
        verdict: "PASS",
        source: "panel",
        counts: { critical: 0, warn: 0, info: 0 },
        cost_usd: 0,
        duration_ms: 1,
        demoted: 0,
        signatures: [],
        providers: [],
        policy_trace_status: "complete",
        policy_trace_ref: stored.ref,
        policy_trace_sha256: stored.sha256,
      },
    });
    await log.append({
      event: "decision.applied",
      run_id: "run-a",
      iter: 1,
      trigger: "stop-hook",
      finding_signatures: ["sig-a"],
      decision_outcome: {
        finding_id: "F-001",
        severity: "WARN",
        bucket: disposition,
        providers: ["codex"],
      },
    });
    const now = new Date("2026-08-12T09:00:00.000Z");
    const since = "2000-01-01T00:00:00.000Z";
    const until = "2100-01-01T00:00:00.000Z";
    const manifest = createPolicyDogfoodInputManifest({
      auditRoots: [relative(process.cwd(), auditDir)],
      since,
      until,
    });
    const rows = [{ run_id: "run-a", iter: 1, finding_signature: "sig-a", disposition }] as const;
    const preflight = policyDogfoodAttestationPreflight({ manifest, actor: "Markus", rows });
    const attestation = attestPolicyDogfood({
      manifest,
      actor: "Markus",
      rows,
      confirmation: preflight.challenge,
      now,
    });
    const preregistration = {
      dogfood: {
        since,
        until,
        input_manifest_ref: "artifacts/dogfood-input.json",
        input_manifest_sha256: sha256(manifest),
        attestation_ref: "artifacts/dogfood-attestation.json",
        attestation_sha256: sha256(attestation),
      },
    } as never;
    return { root, manifest, attestation, preregistration };
  })();
}

describe("policy dogfood harvesting", () => {
  test("freezes a closed, code-unit-sorted audit and trace inventory", () => {
    expect(
      createPolicyDogfoodInputManifest({
        auditRoots: [],
        since: "2026-08-01T00:00:00.000Z",
        until: "2026-08-12T09:00:00.000Z",
      }),
    ).toMatchObject({ schema: "reviewgate.policy-dogfood-input-manifest.v1", entries: [] });
  });

  test("requires preregistration and attestation bindings before it can open frozen sources", () => {
    expect(
      harvestPolicyDogfood({
        preregistration: {
          dogfood: {
            since: "2026-08-01T00:00:00.000Z",
            until: "2026-08-12T09:00:00.000Z",
            input_manifest_ref: "artifacts/policy-dogfood-input/a.json",
            input_manifest_sha256: "a".repeat(64),
            attestation_ref: "artifacts/policy-dogfood-attestation/a.json",
            attestation_sha256: "a".repeat(64),
          },
        } as never,
        inputManifest: {
          schema: "reviewgate.policy-dogfood-input-manifest.v1",
          since: "2026-08-01T00:00:00.000Z",
          until: "2026-08-12T09:00:00.000Z",
          entries: [],
        },
        attestation: {
          schema: "reviewgate.policy-dogfood-attestation.v1",
          actor: "Markus",
          attested_at: "2026-08-12T09:00:00.000Z",
          challenge_sha256: "a".repeat(64),
          input_manifest_sha256: "b".repeat(64),
          rows: [{ run_id: "run-a", iter: 1, finding_signature: "sig-a", disposition: "tp" }],
        },
      }).exclusions["attestation-input-manifest-mismatch"],
    ).toBe(1);
  });

  test("joins only human-attested signatures to complete frozen trace lineage", async () => {
    const fixture = await frozenFixture("tp");
    try {
      const snapshot = harvestPolicyDogfood({
        preregistration: fixture.preregistration,
        inputManifest: fixture.manifest,
        attestation: fixture.attestation,
      });
      expect(snapshot.exclusions).toEqual({
        "agent-only-decision": 0,
        "missing-attestation": 0,
        "attestation-input-manifest-mismatch": 0,
        "missing-decision": 0,
        "incomplete-trace": 0,
        "ambiguous-run-iter": 0,
        "signature-absent-lineage": 0,
        "malformed-chain": 0,
        "changed-source-file": 0,
        "post-registered-at": 0,
      });
      expect(snapshot.labels).toEqual([
        {
          pass_id: "judgment.confidence",
          run_id: "run-a",
          iter: 1,
          finding_signature: "sig-a",
          disposition: "tp",
          source_signatures: ["sig-a"],
        },
      ]);
      expect(Object.values(snapshot.exclusions).every((count) => count === 0)).toBe(true);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
