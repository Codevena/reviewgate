import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { join, relative } from "node:path";
import { canonicalJson } from "../../src/audit/canonical.ts";
import { AuditLogger } from "../../src/audit/logger.ts";
import { POLICY_PASS_IDS } from "../../src/core/policy/catalog.ts";
import type {
  PolicyDogfoodAdjudication,
  PolicyDogfoodInputManifest,
} from "../../src/schemas/policy-measurement.ts";
import type { PolicyTrace } from "../../src/schemas/policy-trace.ts";
import {
  attestPolicyDogfood,
  policyDogfoodAttestationPreflight,
} from "../../src/stats/policy/dogfood-attestation.ts";
import {
  POLICY_DOGFOOD_EXCLUSION_CODES,
  createPolicyDogfoodInputManifest,
  harvestPolicyDogfood,
} from "../../src/stats/policy/dogfood.ts";

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function trace(runId: string, signature = "sig-a"): PolicyTrace {
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
        source_signatures: [signature],
        final_signature: signature,
      },
    ],
    stages: [
      {
        stage_id: "aggregation.cluster",
        order: 65,
        reason_code: "singleton",
        member_count: 1,
        input_signatures: [signature],
        output_signature: signature,
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
      finding_signatures: [signature],
      finding_severities: [{ signature, severity: "INFO" }],
    },
  };
}

function sourceSha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function replaceManifestEntry(
  manifest: PolicyDogfoodInputManifest,
  ref: string,
  bytes: Buffer,
): PolicyDogfoodInputManifest {
  return {
    ...manifest,
    entries: manifest.entries.map((entry) =>
      entry.ref === ref ? { ...entry, sha256: sourceSha256(bytes), bytes: bytes.length } : entry,
    ),
  };
}

function boundInput(
  manifest: PolicyDogfoodInputManifest,
  rows: readonly PolicyDogfoodAdjudication[],
  overrides: { preregistration?: Record<string, unknown>; attestationManifest?: PolicyDogfoodInputManifest } = {},
) {
  const attestationManifest = overrides.attestationManifest ?? manifest;
  const preflight = policyDogfoodAttestationPreflight({
    manifest: attestationManifest,
    actor: "Markus",
    rows,
  });
  const attestation = attestPolicyDogfood({
    manifest: attestationManifest,
    actor: "Markus",
    rows,
    confirmation: preflight.challenge,
    now: new Date("2026-08-12T09:00:00.000Z"),
  });
  return {
    preregistration: {
      dogfood: {
        since: manifest.since,
        until: manifest.until,
        input_manifest_ref: "artifacts/dogfood-input.json",
        input_manifest_sha256: sha256(manifest),
        attestation_ref: "artifacts/dogfood-attestation.json",
        attestation_sha256: sha256(attestation),
        ...overrides.preregistration,
      },
    } as never,
    inputManifest: manifest,
    attestation,
  };
}

function frozenFixture(
  disposition: "tp" | "fp",
  opts: { legacyAgentDecision?: boolean; extraDecisionSignature?: string } = {},
) {
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
    if (opts.extraDecisionSignature !== undefined) {
      await log.append({
        event: "decision.applied",
        run_id: "run-a",
        iter: 1,
        trigger: "stop-hook",
        finding_signatures: [opts.extraDecisionSignature],
        decision_outcome: {
          finding_id: "F-not-lineage",
          severity: "WARN",
          bucket: "tp",
          providers: ["codex"],
        },
      });
    }
    if (opts.legacyAgentDecision) {
      await log.append({
        event: "decision.applied",
        run_id: "run-a",
        iter: 1,
        trigger: "stop-hook",
        decision_outcome: {
          finding_id: "F-legacy",
          severity: "WARN",
          bucket: "fp",
          providers: ["codex"],
        },
      });
    }
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

async function frozenMultiFixture() {
  const root = mkdtempSync(join(process.cwd(), ".rg-policy-dogfood-multi-"));
  const auditDir = join(root, "audit");
  mkdirSync(auditDir, { recursive: true, mode: 0o700 });
  const writeRun = async (runId: string, signature: string, findingId: string) => {
    const log = new AuditLogger(auditDir);
    const stored = log.writePolicyTrace(trace(runId, signature));
    if (stored.status !== "complete") throw new Error("expected complete trace fixture");
    await log.append({
      event: "run.complete",
      run_id: runId,
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
      run_id: runId,
      iter: 1,
      trigger: "stop-hook",
      finding_signatures: [signature],
      decision_outcome: {
        finding_id: findingId,
        severity: "WARN",
        bucket: "tp",
        providers: ["codex"],
      },
    });
    return { auditPath: log.currentFilePath(), stored };
  };
  const first = await writeRun("run-a", "sig-a", "F-unrelated-a");
  const second = await writeRun("run-b", "sig-b", "F-unrelated-b");
  const manifest = createPolicyDogfoodInputManifest({
    auditRoots: [relative(process.cwd(), auditDir)],
    since: "2000-01-01T00:00:00.000Z",
    until: "2100-01-01T00:00:00.000Z",
  });
  const rows = [
    { run_id: "run-a", iter: 1, finding_signature: "sig-a", disposition: "tp" },
    { run_id: "run-b", iter: 1, finding_signature: "sig-b", disposition: "fp" },
  ] as const;
  return { root, auditDir, first, second, manifest, rows, writeRun };
}

describe("policy dogfood harvesting", () => {
  test("keeps the dogfood exclusion inventory closed at ten authority failures", () => {
    expect(POLICY_DOGFOOD_EXCLUSION_CODES).toEqual([
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
    ]);
  });

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

  test("excludes agent-authored legacy labels and an attestation without a decision", async () => {
    const fixture = await frozenFixture("tp", {
      legacyAgentDecision: true,
      extraDecisionSignature: "sig-unattested",
    });
    try {
      const rows = [
        ...fixture.attestation.rows,
        {
          run_id: "run-a",
          iter: 1,
          finding_signature: "sig-no-decision",
          disposition: "fp" as const,
        },
      ];
      const preflight = policyDogfoodAttestationPreflight({
        manifest: fixture.manifest,
        actor: "Markus",
        rows,
      });
      const attestation = attestPolicyDogfood({
        manifest: fixture.manifest,
        actor: "Markus",
        rows,
        confirmation: preflight.challenge,
        now: new Date("2026-08-12T09:00:00.000Z"),
      });
      const snapshot = harvestPolicyDogfood({
        preregistration: {
          ...fixture.preregistration,
          dogfood: { ...fixture.preregistration.dogfood, attestation_sha256: sha256(attestation) },
        },
        inputManifest: fixture.manifest,
        attestation,
      });
      expect(snapshot.exclusions["agent-only-decision"]).toBe(1);
      expect(snapshot.exclusions["missing-decision"]).toBe(1);
      expect(snapshot.exclusions["missing-attestation"]).toBe(1);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("keeps two matching human attestations eligible by signature lineage, not finding ID", async () => {
    const fixture = await frozenMultiFixture();
    try {
      const matched = harvestPolicyDogfood(boundInput(fixture.manifest, fixture.rows));
      const unmatchedRows = fixture.rows.map((row) => ({
        ...row,
        finding_signature: `missing-${row.finding_signature}`,
      }));
      const unmatched = harvestPolicyDogfood(boundInput(fixture.manifest, unmatchedRows));

      // The decision IDs deliberately differ from every trace signature. Both labels
      // prove the join is through finding_signatures/source_signatures, not F-ids.
      expect(matched.labels).toHaveLength(2);
      expect(matched.labels.map((label) => label.finding_signature)).toEqual(["sig-a", "sig-b"]);
      expect(unmatched.labels).toHaveLength(0);
      expect(unmatched.exclusions["missing-decision"]).toBe(2);
      expect(unmatched.exclusions["missing-attestation"]).toBe(2);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("rejects an attestation signed over a different frozen manifest", async () => {
    const fixture = await frozenMultiFixture();
    try {
      const foreignManifest = { ...fixture.manifest, since: "1999-01-01T00:00:00.000Z" };
      const snapshot = harvestPolicyDogfood(
        boundInput(fixture.manifest, fixture.rows, { attestationManifest: foreignManifest }),
      );
      expect(snapshot.labels).toHaveLength(0);
      expect(snapshot.exclusions["attestation-input-manifest-mismatch"]).toBe(1);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("does not rescan a later audit file outside the four frozen source refs", async () => {
    const fixture = await frozenMultiFixture();
    try {
      const later = await fixture.writeRun("run-later", "sig-later", "F-later");
      const rows = [
        ...fixture.rows,
        { run_id: "run-later", iter: 1, finding_signature: "sig-later", disposition: "tp" as const },
      ];
      const reads: string[] = [];
      const snapshot = harvestPolicyDogfood({
        ...boundInput(fixture.manifest, rows),
        onFrozenSourceRead: (entry) => reads.push(entry.ref),
      });
      expect(fixture.manifest.entries).toHaveLength(4);
      expect(fixture.manifest.entries.some((entry) => entry.ref === relative(process.cwd(), later.auditPath))).toBe(false);
      expect(reads).toHaveLength(4);
      expect(reads.filter((ref) => ref === relative(process.cwd(), later.auditPath))).toHaveLength(0);
      expect(snapshot.labels).toHaveLength(2);
      expect(snapshot.exclusions["incomplete-trace"]).toBe(1);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("reads each frozen audit pathname once into the verified hashing buffer", async () => {
    const fixture = await frozenFixture("tp");
    try {
      const auditReads: string[] = [];
      const snapshot = harvestPolicyDogfood({
        preregistration: fixture.preregistration,
        inputManifest: fixture.manifest,
        attestation: fixture.attestation,
        onFrozenSourceRead: (entry) => {
          if (entry.kind === "audit") auditReads.push(entry.ref);
        },
      });
      expect(snapshot.labels).toHaveLength(1);
      expect(auditReads).toHaveLength(1);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("counts changed frozen source bytes and malformed audit bytes as separate authority failures", async () => {
    const changed = await frozenMultiFixture();
    const malformed = await frozenMultiFixture();
    try {
      const changedAudit = changed.manifest.entries.find((entry) => entry.kind === "audit");
      if (changedAudit === undefined) throw new Error("missing frozen audit");
      const changedPath = join(process.cwd(), changedAudit.ref);
      writeFileSync(changedPath, Buffer.concat([readFileSync(changedPath), Buffer.from("\n")]));
      chmodSync(changedPath, 0o600);
      expect(harvestPolicyDogfood(boundInput(changed.manifest, changed.rows)).exclusions["changed-source-file"]).toBe(1);

      const malformedAudit = malformed.manifest.entries.find((entry) => entry.kind === "audit");
      if (malformedAudit === undefined) throw new Error("missing frozen audit");
      const malformedPath = join(process.cwd(), malformedAudit.ref);
      const malformedBytes = Buffer.concat([readFileSync(malformedPath), Buffer.from("not-json\n")]);
      writeFileSync(malformedPath, malformedBytes);
      chmodSync(malformedPath, 0o600);
      const mutatedManifest = replaceManifestEntry(malformed.manifest, malformedAudit.ref, malformedBytes);
      expect(harvestPolicyDogfood(boundInput(mutatedManifest, malformed.rows)).exclusions["malformed-chain"]).toBe(1);
    } finally {
      rmSync(changed.root, { recursive: true, force: true });
      rmSync(malformed.root, { recursive: true, force: true });
    }
  });

  test("counts incomplete trace and ambiguous run/iteration from real chained audit rows", async () => {
    const root = mkdtempSync(join(process.cwd(), ".rg-policy-dogfood-invalid-"));
    const auditDir = join(root, "audit");
    mkdirSync(auditDir, { recursive: true, mode: 0o700 });
    try {
      const incompleteLog = new AuditLogger(auditDir);
      await incompleteLog.append({
        event: "run.complete", run_id: "run-incomplete", iter: 1, trigger: "stop-hook",
        run_summary: { verdict: "PASS", source: "panel", counts: { critical: 0, warn: 0, info: 0 }, cost_usd: 0, duration_ms: 1, demoted: 0, signatures: [], providers: [], policy_trace_status: "error" },
      });
      await incompleteLog.append({
        event: "decision.applied", run_id: "run-incomplete", iter: 1, trigger: "stop-hook", finding_signatures: ["sig-incomplete"],
        decision_outcome: { finding_id: "F-incomplete", severity: "WARN", bucket: "tp", providers: ["codex"] },
      });
      const invalidTracePath = join(auditDir, "invalid-trace.json");
      writeFileSync(invalidTracePath, "{}", { mode: 0o600 });
      const incompleteAuditPath = incompleteLog.currentFilePath();
      const incompleteManifest: PolicyDogfoodInputManifest = {
        schema: "reviewgate.policy-dogfood-input-manifest.v1", since: "2000-01-01T00:00:00.000Z", until: "2100-01-01T00:00:00.000Z",
        entries: [
          { kind: "audit", ref: relative(process.cwd(), incompleteAuditPath), sha256: sourceSha256(readFileSync(incompleteAuditPath)), bytes: readFileSync(incompleteAuditPath).length, run_id: "run-incomplete", iter: 1 },
          { kind: "trace", ref: relative(process.cwd(), invalidTracePath), sha256: sourceSha256(readFileSync(invalidTracePath)), bytes: 2, run_id: "run-incomplete", iter: 1 },
        ].sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0)),
      };
      const incompleteRows = [{ run_id: "run-incomplete", iter: 1, finding_signature: "sig-incomplete", disposition: "tp" }] as const;
      // One invalid trace entry is counted at source validation and once for the
      // attested row that consequently lacks a complete trace: 2 exact outcomes.
      expect(harvestPolicyDogfood(boundInput(incompleteManifest, incompleteRows)).exclusions["incomplete-trace"]).toBe(2);

      const ambiguousLog = new AuditLogger(auditDir);
      const stored = ambiguousLog.writePolicyTrace(trace("run-ambiguous", "sig-ambiguous"));
      if (stored.status !== "complete") throw new Error("expected trace");
      const summary = { verdict: "PASS" as const, source: "panel" as const, counts: { critical: 0, warn: 0, info: 0 }, cost_usd: 0, duration_ms: 1, demoted: 0, signatures: [], providers: [], policy_trace_status: "complete" as const, policy_trace_ref: stored.ref, policy_trace_sha256: stored.sha256 };
      await ambiguousLog.append({ event: "run.complete", run_id: "run-ambiguous", iter: 1, trigger: "stop-hook", run_summary: summary });
      await ambiguousLog.append({ event: "run.complete", run_id: "run-ambiguous", iter: 1, trigger: "stop-hook", run_summary: summary });
      await ambiguousLog.append({ event: "decision.applied", run_id: "run-ambiguous", iter: 1, trigger: "stop-hook", finding_signatures: ["sig-ambiguous"], decision_outcome: { finding_id: "F-ambiguous", severity: "WARN", bucket: "tp", providers: ["codex"] } });
      const ambiguousAudit = ambiguousLog.currentFilePath();
      const ambiguousTrace = join(auditDir, ...stored.ref.split("/"));
      const ambiguousManifest: PolicyDogfoodInputManifest = { schema: "reviewgate.policy-dogfood-input-manifest.v1", since: "2000-01-01T00:00:00.000Z", until: "2100-01-01T00:00:00.000Z", entries: [
        { kind: "audit", ref: relative(process.cwd(), ambiguousAudit), sha256: sourceSha256(readFileSync(ambiguousAudit)), bytes: readFileSync(ambiguousAudit).length, run_id: "run-ambiguous", iter: 1 },
        { kind: "trace", ref: relative(process.cwd(), ambiguousTrace), sha256: sourceSha256(readFileSync(ambiguousTrace)), bytes: readFileSync(ambiguousTrace).length, run_id: "run-ambiguous", iter: 1 },
      ].sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0)) };
      const ambiguousRows = [{ run_id: "run-ambiguous", iter: 1, finding_signature: "sig-ambiguous", disposition: "tp" }] as const;
      expect(harvestPolicyDogfood(boundInput(ambiguousManifest, ambiguousRows)).exclusions["ambiguous-run-iter"]).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("counts signatures outside trace lineage and decisions at or after registered_at", async () => {
    const lineage = await frozenFixture("tp", { extraDecisionSignature: "sig-not-in-trace" });
    const post = await frozenFixture("tp");
    try {
      const rows = [{ run_id: "run-a", iter: 1, finding_signature: "sig-not-in-trace", disposition: "tp" }] as const;
      const preflight = policyDogfoodAttestationPreflight({ manifest: lineage.manifest, actor: "Markus", rows });
      const attestation = attestPolicyDogfood({ manifest: lineage.manifest, actor: "Markus", rows, confirmation: preflight.challenge, now: new Date() });
      // The matching decision makes the row reach the trace-lineage guard.
      const lineageInput = boundInput(lineage.manifest, rows);
      expect(harvestPolicyDogfood(lineageInput).exclusions["signature-absent-lineage"]).toBe(1);

      const lateManifest = { ...post.manifest, until: "2026-08-12T00:00:00.000Z" };
      const lateInput = boundInput(lateManifest, post.attestation.rows);
      expect(harvestPolicyDogfood(lateInput).exclusions["post-registered-at"]).toBe(1);
    } finally {
      rmSync(lineage.root, { recursive: true, force: true });
      rmSync(post.root, { recursive: true, force: true });
    }
  });
});
