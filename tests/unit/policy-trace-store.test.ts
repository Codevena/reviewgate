import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { canonicalJson } from "../../src/audit/canonical.ts";
import {
  POLICY_TRACE_MAX_BYTES,
  verifyPolicyTraceReference,
  writePolicyTrace,
} from "../../src/audit/policy-trace-store.ts";
import type { PolicyTrace } from "../../src/schemas/policy-trace.ts";

const NOW = new Date("2026-08-10T12:34:56.000Z");
const PASS_IDS = [
  "evidence.fact-location",
  "evidence.self-refutation",
  "judgment.hypothetical",
  "evidence.grounding-token",
  "judgment.grounding-llm",
  "evidence.redaction-placeholder",
  "judgment.critic",
  "scope.diff",
  "scope.delta",
  "scope.session",
  "history.fp-signature",
  "history.cycle-rejected",
  "history.fp-cluster",
  "judgment.confidence",
  "judgment.reputation",
  "history.region-rejected",
  "judgment.test-security",
  "judgment.docs-cap",
] as const;

function tmp(prefix = "rg-policy-store-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function sha256(bytes: string): string {
  return createHash("sha256").update(Buffer.from(bytes, "utf8")).digest("hex");
}

function emptyRanSummary(pass_id: (typeof PASS_IDS)[number], considered = 0) {
  return {
    pass_id,
    status: "ran" as const,
    considered,
    opportunities: 0,
    would_apply: 0,
    applied: 0,
    protected: 0,
    blocking_removed: 0,
    blocking_preserved: 0,
    dropped: 0,
  };
}

function emptyTrace(runId = "run-1"): PolicyTrace {
  return {
    schema: "reviewgate.policy-trace.v1",
    catalog_version: "reviewgate.policy-catalog.v1",
    run_id: runId,
    iter: 1,
    ablated: [],
    raw_response_sha256: ["a".repeat(64)],
    passes: PASS_IDS.map((passId) => emptyRanSummary(passId)),
    evaluations: [],
    stages: [
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
      counts: { critical: 0, warn: 0, info: 0 },
      finding_signatures: [],
      finding_severities: [],
    },
  };
}

function maximumSignatureTrace(findingCount: number): PolicyTrace {
  const signatures = Array.from({ length: findingCount }, (_, index) =>
    index.toString(16).padStart(64, "0"),
  );
  return {
    ...emptyTrace("worst-case-run"),
    passes: PASS_IDS.map((passId) => emptyRanSummary(passId, findingCount)),
    evaluations: PASS_IDS.flatMap((passId, passIndex) =>
      signatures.map((signature) => ({
        pass_id: passId,
        order: (passIndex + 1) * 10,
        result: "no-opportunity" as const,
        before: "INFO" as const,
        after: "INFO" as const,
        reason_code: "ineligible-starting-state" as const,
        source_signatures: [signature],
        final_signature: signature,
      })),
    ),
    stages: [
      ...signatures.map((signature) => ({
        stage_id: "aggregation.cluster" as const,
        order: 65,
        reason_code: "singleton" as const,
        member_count: 1,
        input_signatures: [signature],
        output_signature: signature,
      })),
      {
        stage_id: "verdict.compute" as const,
        order: 190,
        reason_code: "no-blocking-findings" as const,
        input_signatures: [],
        verdict: "PASS" as const,
      },
    ],
    final: {
      verdict: "PASS",
      counts: { critical: 0, warn: 0, info: findingCount },
      finding_signatures: signatures,
      finding_severities: signatures.map((signature) => ({ signature, severity: "INFO" as const })),
    },
  };
}

function allDescendants(root: string): string[] {
  if (!existsSync(root) || !lstatSync(root).isDirectory()) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? [path, ...allDescendants(path)] : [path];
  });
}

describe("canonical policy trace storage", () => {
  it("keeps the audit canonicalizer sorted recursively and byte-stable", () => {
    expect(canonicalJson({ z: 1, a: { d: 4, b: 2 }, c: [2, { y: 1, x: 0 }] })).toBe(
      '{"a":{"b":2,"d":4},"c":[2,{"x":0,"y":1}],"z":1}',
    );
  });

  it("stores canonical UTF-8 bytes at a hashed UTC path with mode 0600", () => {
    const auditDir = join(tmp(), "audit");
    const trace = emptyTrace("../../escape/raw-run-id");
    const canonical = canonicalJson(trace);
    const contentHash = sha256(canonical);
    const runHash = sha256(trace.run_id);

    const stored = writePolicyTrace({ auditDir, trace, now: NOW });

    expect(stored).toEqual({
      status: "complete",
      ref: `2026/08/10/policy/${runHash.slice(0, 12)}-i1-${contentHash.slice(0, 12)}.json`,
      sha256: contentHash,
    });
    if (stored.status !== "complete") throw new Error("fixture trace did not persist");
    const artifact = join(auditDir, ...stored.ref.split("/"));
    expect(readFileSync(artifact, "utf8")).toBe(canonical);
    expect(lstatSync(artifact).mode & 0o777).toBe(0o600);
    expect(stored.ref).not.toContain("escape");
    expect(stored.ref).not.toContain(trace.run_id);
    expect(
      verifyPolicyTraceReference({ auditDir, ref: stored.ref, sha256: stored.sha256 }),
    ).toMatchObject({ ok: true });
  });

  it("accepts exactly maxBytes and overflows one byte above it before creating a path", () => {
    const trace = emptyTrace();
    const bytes = Buffer.byteLength(canonicalJson(trace), "utf8");
    const exactAudit = join(tmp(), "audit-exact");
    const overflowAudit = join(tmp(), "audit-overflow");

    expect(
      writePolicyTrace({ auditDir: exactAudit, trace, maxBytes: bytes, now: NOW }).status,
    ).toBe("complete");
    expect(
      writePolicyTrace({ auditDir: overflowAudit, trace, maxBytes: bytes - 1, now: NOW }),
    ).toEqual({ status: "overflow" });
    expect(existsSync(overflowAudit)).toBe(false);
  });

  it("returns overflow for exactly 1,048,577 canonical bytes with no dir, ref, hash, or temp", () => {
    const base = emptyTrace("x");
    const baseBytes = Buffer.byteLength(canonicalJson(base), "utf8");
    const trace = emptyTrace("x".repeat(1 + 1_048_577 - baseBytes));
    expect(Buffer.byteLength(canonicalJson(trace), "utf8")).toBe(1_048_577);
    const auditDir = join(tmp(), "never-created-audit");

    expect(writePolicyTrace({ auditDir, trace, now: NOW })).toEqual({ status: "overflow" });
    expect(POLICY_TRACE_MAX_BYTES).toBe(1_048_576);
    expect(existsSync(auditDir)).toBe(false);
  });

  it("cleans its private temp and omits identity when the atomic write fails", () => {
    const auditDir = join(tmp(), "audit");
    mkdirSync(auditDir, { recursive: true });
    writeFileSync(join(auditDir, "2026"), "blocks the UTC directory");

    expect(writePolicyTrace({ auditDir, trace: emptyTrace(), now: NOW })).toEqual({
      status: "error",
    });
    expect(allDescendants(auditDir).some((path) => path.endsWith(".tmp"))).toBe(false);
  });
});

describe("policy trace reference security", () => {
  it("rejects missing, absolute, traversing, wrong-hash, tampered, and symlink-escaping refs", () => {
    const root = tmp();
    const auditDir = join(root, "audit");
    const stored = writePolicyTrace({ auditDir, trace: emptyTrace(), now: NOW });
    if (stored.status !== "complete") throw new Error("fixture trace did not persist");
    const artifact = join(auditDir, ...stored.ref.split("/"));

    expect(
      verifyPolicyTraceReference({
        auditDir,
        ref: "2026/08/10/policy/000000000000-i1-000000000000.json",
        sha256: "0".repeat(64),
      }).ok,
    ).toBe(false);
    expect(verifyPolicyTraceReference({ auditDir, ref: artifact, sha256: stored.sha256 }).ok).toBe(
      false,
    );
    expect(
      verifyPolicyTraceReference({
        auditDir,
        ref: `../${stored.ref}`,
        sha256: stored.sha256,
      }).ok,
    ).toBe(false);
    expect(
      verifyPolicyTraceReference({ auditDir, ref: stored.ref, sha256: "0".repeat(64) }).ok,
    ).toBe(false);

    const symlinkAudit = join(root, "symlink-audit");
    const symlinkDay = join(symlinkAudit, "2026", "08", "10");
    mkdirSync(symlinkDay, { recursive: true });
    symlinkSync(dirname(artifact), join(symlinkDay, "policy"));
    expect(
      verifyPolicyTraceReference({
        auditDir: symlinkAudit,
        ref: stored.ref,
        sha256: stored.sha256,
      }).ok,
    ).toBe(false);

    chmodSync(artifact, 0o600);
    writeFileSync(artifact, `${readFileSync(artifact, "utf8")} `);
    expect(
      verifyPolicyTraceReference({ auditDir, ref: stored.ref, sha256: stored.sha256 }).ok,
    ).toBe(false);
  });

  it("stores the 1,046,855-byte maximum-signature all-pass trace and overflows the 1,053,027-byte next finding", () => {
    const below = maximumSignatureTrace(169);
    const above = maximumSignatureTrace(170);
    const belowBytes = Buffer.byteLength(canonicalJson(below), "utf8");
    const aboveBytes = Buffer.byteLength(canonicalJson(above), "utf8");
    expect(belowBytes).toBe(1_046_855);
    expect(aboveBytes).toBe(1_053_027);
    expect(
      writePolicyTrace({ auditDir: join(tmp(), "below"), trace: below, now: NOW }).status,
    ).toBe("complete");
    expect(writePolicyTrace({ auditDir: join(tmp(), "above"), trace: above, now: NOW })).toEqual({
      status: "overflow",
    });
  });
});
