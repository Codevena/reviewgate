import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { canonicalJson } from "../../src/audit/canonical.ts";
import {
  POLICY_TRACE_MAX_BYTES,
  type PolicyTraceWriteResult,
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

function sha256(bytes: string | Buffer): string {
  return createHash("sha256")
    .update(typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes)
    .digest("hex");
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

function writeUncheckedArtifact(
  auditDir: string,
  trace: PolicyTrace,
  bytes: Buffer,
): { ref: string; sha256: string; path: string } {
  const contentSha256 = sha256(bytes);
  const ref = `2026/08/10/policy/${sha256(trace.run_id).slice(0, 12)}-i${trace.iter}-${contentSha256.slice(0, 12)}.json`;
  const path = join(auditDir, ...ref.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes, { mode: 0o600 });
  return { ref, sha256: contentSha256, path };
}

function artifactDescriptor(auditDir: string, trace: PolicyTrace) {
  const canonical = canonicalJson(trace);
  const sha = sha256(canonical);
  const ref = `2026/08/10/policy/${sha256(trace.run_id).slice(0, 12)}-i${trace.iter}-${sha.slice(0, 12)}.json`;
  return { canonical, ref, sha256: sha, path: join(auditDir, ...ref.split("/")) };
}

async function runSynchronizedWriters(
  inputs: Array<{ auditDir: string; trace: PolicyTrace }>,
): Promise<PolicyTraceWriteResult[]> {
  const barrierDir = tmp("rg-policy-writer-barrier-");
  const startPath = join(barrierDir, "start");
  const childSource = `
    const input = JSON.parse(process.env.RG_POLICY_WRITER_INPUT);
    const fs = require("node:fs");
    const mkdirSync = fs.mkdirSync;
    const wait = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    fs.mkdirSync = (path, options) => {
      if (path === input.auditDir) {
        fs.writeFileSync(input.readyPath, "ready");
        while (!fs.existsSync(input.startPath)) Atomics.wait(wait, 0, 0, 1);
      }
      try {
        return mkdirSync(path, options);
      } finally {
        if (path === input.auditDir) Atomics.wait(wait, 0, 0, input.releaseDelayMs);
      }
    };
    const { writePolicyTrace } = await import(process.env.RG_POLICY_STORE_URL);
    process.stdout.write(JSON.stringify(writePolicyTrace({
      auditDir: input.auditDir,
      trace: input.trace,
      now: new Date(input.now),
    })));
  `;
  const storeUrl = new URL("../../src/audit/policy-trace-store.ts", import.meta.url).href;
  const children = inputs.map((input, index) => {
    const payload = JSON.stringify({
      ...input,
      now: NOW.toISOString(),
      readyPath: join(barrierDir, `ready-${index}`),
      releaseDelayMs: index * 4,
      startPath,
    });
    return Bun.spawn([process.execPath, "-e", childSource], {
      env: {
        ...process.env,
        RG_POLICY_STORE_URL: storeUrl,
        RG_POLICY_WRITER_INPUT: payload,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
  });

  try {
    const readyDeadline = Date.now() + 15_000;
    while (readdirSync(barrierDir).length !== children.length) {
      if (Date.now() >= readyDeadline) throw new Error("parallel writer ready barrier timed out");
      await Bun.sleep(5);
    }
    writeFileSync(startPath, "start");

    return await Promise.all(
      children.map(async (child) => {
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        if (exitCode !== 0) throw new Error(`parallel writer exited ${exitCode}: ${stderr}`);
        return JSON.parse(stdout) as PolicyTraceWriteResult;
      }),
    );
  } catch (error) {
    for (const child of children) child.kill();
    await Promise.allSettled(children.map((child) => child.exited));
    throw error;
  }
}

async function runWriterWithCreatedRootFault(
  auditDir: string,
  trace: PolicyTrace,
): Promise<PolicyTraceWriteResult> {
  const storeUrl = new URL("../../src/audit/policy-trace-store.ts", import.meta.url).href;
  const childSource = `
    const input = JSON.parse(process.env.RG_POLICY_WRITER_INPUT);
    const fs = require("node:fs");
    const mkdirSync = fs.mkdirSync;
    fs.mkdirSync = (path, options) => {
      if (path === input.auditDir) {
        mkdirSync(path, options);
        const error = new Error("injected non-EEXIST mkdir failure");
        error.code = "EACCES";
        throw error;
      }
      return mkdirSync(path, options);
    };
    const { writePolicyTrace } = await import(process.env.RG_POLICY_STORE_URL);
    process.stdout.write(JSON.stringify(writePolicyTrace({
      auditDir: input.auditDir,
      trace: input.trace,
      now: new Date(input.now),
    })));
  `;
  const child = Bun.spawn([process.execPath, "-e", childSource], {
    env: {
      ...process.env,
      RG_POLICY_STORE_URL: storeUrl,
      RG_POLICY_WRITER_INPUT: JSON.stringify({
        auditDir,
        trace,
        now: NOW.toISOString(),
      }),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`faulted writer exited ${exitCode}: ${stderr}`);
  return JSON.parse(stdout) as PolicyTraceWriteResult;
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

  it("rejects a symlinked year parent before creating a policy path outside the audit root", () => {
    const root = tmp();
    const auditDir = join(root, "audit");
    const outside = join(root, "outside");
    mkdirSync(auditDir);
    mkdirSync(outside);
    symlinkSync(outside, join(auditDir, "2026"));

    expect(writePolicyTrace({ auditDir, trace: emptyTrace(), now: NOW })).toEqual({
      status: "error",
    });
    expect(existsSync(join(outside, "08"))).toBe(false);
    expect(existsSync(join(auditDir, "2026", "08", "10", "policy"))).toBe(false);
    expect(allDescendants(outside)).toEqual([]);
  });

  it("rejects a symlinked audit root without mutating its target", () => {
    const root = tmp();
    const outside = join(root, "outside");
    const auditDir = join(root, "audit");
    mkdirSync(outside);
    symlinkSync(outside, auditDir);

    expect(writePolicyTrace({ auditDir, trace: emptyTrace(), now: NOW })).toEqual({
      status: "error",
    });
    expect(allDescendants(outside)).toEqual([]);
  });

  it("never follows or replaces a pre-existing final symlink, hardlink, or wrong file", () => {
    const trace = emptyTrace();

    const symlinkRoot = tmp();
    const symlinkAudit = join(symlinkRoot, "audit");
    const symlinkArtifact = artifactDescriptor(symlinkAudit, trace);
    const symlinkVictim = join(symlinkRoot, "victim.json");
    mkdirSync(dirname(symlinkArtifact.path), { recursive: true });
    writeFileSync(symlinkVictim, "victim-must-not-change");
    symlinkSync(symlinkVictim, symlinkArtifact.path);
    expect(writePolicyTrace({ auditDir: symlinkAudit, trace, now: NOW })).toEqual({
      status: "error",
    });
    expect(lstatSync(symlinkArtifact.path).isSymbolicLink()).toBe(true);
    expect(readFileSync(symlinkVictim, "utf8")).toBe("victim-must-not-change");

    const hardlinkRoot = tmp();
    const hardlinkAudit = join(hardlinkRoot, "audit");
    const hardlinkArtifact = artifactDescriptor(hardlinkAudit, trace);
    const hardlinkVictim = join(hardlinkRoot, "victim.json");
    mkdirSync(dirname(hardlinkArtifact.path), { recursive: true });
    writeFileSync(hardlinkVictim, "hardlink-must-not-change");
    linkSync(hardlinkVictim, hardlinkArtifact.path);
    expect(writePolicyTrace({ auditDir: hardlinkAudit, trace, now: NOW })).toEqual({
      status: "error",
    });
    expect(readFileSync(hardlinkArtifact.path, "utf8")).toBe("hardlink-must-not-change");
    expect(readFileSync(hardlinkVictim, "utf8")).toBe("hardlink-must-not-change");

    const wrongRoot = tmp();
    const wrongAudit = join(wrongRoot, "audit");
    const wrongArtifact = artifactDescriptor(wrongAudit, trace);
    mkdirSync(dirname(wrongArtifact.path), { recursive: true });
    writeFileSync(wrongArtifact.path, "wrong-existing-content");
    const wrongInode = statSync(wrongArtifact.path).ino;
    expect(writePolicyTrace({ auditDir: wrongAudit, trace, now: NOW })).toEqual({
      status: "error",
    });
    expect(readFileSync(wrongArtifact.path, "utf8")).toBe("wrong-existing-content");
    expect(statSync(wrongArtifact.path).ino).toBe(wrongInode);
  });

  it("reuses a pre-existing exact regular artifact without replacing its inode", () => {
    const auditDir = join(tmp(), "audit");
    const trace = emptyTrace();
    const artifact = artifactDescriptor(auditDir, trace);
    mkdirSync(dirname(artifact.path), { recursive: true });
    writeFileSync(artifact.path, artifact.canonical, { mode: 0o600 });
    const inode = statSync(artifact.path).ino;

    expect(writePolicyTrace({ auditDir, trace, now: NOW })).toEqual({
      status: "complete",
      ref: artifact.ref,
      sha256: artifact.sha256,
    });
    expect(statSync(artifact.path).ino).toBe(inode);
    expect(readFileSync(artifact.path, "utf8")).toBe(artifact.canonical);
  });

  it("lets synchronized identical writers share a freshly-created verified partition", async () => {
    const root = tmp();
    const auditDir = join(root, "audit");
    const outside = join(root, "outside");
    mkdirSync(outside);
    const trace = emptyTrace("parallel-identical");
    const artifact = artifactDescriptor(auditDir, trace);

    const results = await runSynchronizedWriters(
      Array.from({ length: 64 }, () => ({ auditDir, trace })),
    );

    expect(results).toEqual(
      Array.from({ length: 64 }, () => ({
        status: "complete",
        ref: artifact.ref,
        sha256: artifact.sha256,
      })),
    );
    expect(readdirSync(dirname(artifact.path))).toEqual([basename(artifact.path)]);
    expect(readFileSync(artifact.path, "utf8")).toBe(artifact.canonical);
    const finalStat = lstatSync(artifact.path);
    expect(finalStat.mode & 0o777).toBe(0o600);
    expect(finalStat.nlink).toBe(1);
    expect(allDescendants(root).some((path) => path.endsWith(".tmp"))).toBe(false);
    expect(allDescendants(outside)).toEqual([]);
  }, 30_000);

  it("lets synchronized distinct writers populate one freshly-created verified partition", async () => {
    const root = tmp();
    const auditDir = join(root, "audit");
    const outside = join(root, "outside");
    mkdirSync(outside);
    const traces = Array.from({ length: 32 }, (_, index) =>
      emptyTrace(`parallel-distinct-${index}`),
    );
    const artifacts = traces.map((trace) => artifactDescriptor(auditDir, trace));

    const results = await runSynchronizedWriters(traces.map((trace) => ({ auditDir, trace })));

    expect(results.every((result) => result.status === "complete")).toBe(true);
    const complete = results.filter(
      (result): result is Extract<PolicyTraceWriteResult, { status: "complete" }> =>
        result.status === "complete",
    );
    expect(new Set(complete.map(({ ref }) => ref)).size).toBe(traces.length);
    expect(new Set(complete.map(({ sha256 }) => sha256)).size).toBe(traces.length);
    const firstArtifact = artifacts[0];
    if (firstArtifact === undefined) throw new Error("parallel fixture was empty");
    expect(readdirSync(dirname(firstArtifact.path)).sort()).toEqual(
      artifacts.map(({ path }) => basename(path)).sort(),
    );
    for (const artifact of artifacts) {
      expect(readFileSync(artifact.path, "utf8")).toBe(artifact.canonical);
      const finalStat = lstatSync(artifact.path);
      expect(finalStat.mode & 0o777).toBe(0o600);
      expect(finalStat.nlink).toBe(1);
    }
    expect(allDescendants(root).some((path) => path.endsWith(".tmp"))).toBe(false);
    expect(allDescendants(outside)).toEqual([]);
  }, 30_000);

  it("does not forgive a non-EEXIST mkdir failure when the root appeared", async () => {
    const root = tmp();
    const auditDir = join(root, "audit");

    expect(await runWriterWithCreatedRootFault(auditDir, emptyTrace())).toEqual({
      status: "error",
    });
    expect(lstatSync(auditDir).isDirectory()).toBe(true);
    expect(existsSync(join(auditDir, "2026"))).toBe(false);
    expect(allDescendants(root).some((path) => path.endsWith(".tmp"))).toBe(false);
  });
});

describe("policy trace reference security", () => {
  it("rejects a hash-valid policy trace unless its mode remains exactly 0600", () => {
    const auditDir = join(tmp(), "audit");
    const stored = writePolicyTrace({ auditDir, trace: emptyTrace(), now: NOW });
    if (stored.status !== "complete") throw new Error("fixture trace did not persist");
    const artifact = join(auditDir, ...stored.ref.split("/"));

    for (const unsafeMode of [0o644, 0o4600]) {
      execFileSync("/bin/chmod", [unsafeMode.toString(8), artifact]);
      expect(lstatSync(artifact).mode & 0o7777).toBe(unsafeMode);
      const verified = verifyPolicyTraceReference({
        auditDir,
        ref: stored.ref,
        sha256: stored.sha256,
      });
      expect(verified).toEqual({ ok: false, reason: "not-a-file" });
    }
  });

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

  it("rejects invalid UTF-8 even when the raw hash, filename, and lossy JSON are consistent", () => {
    const auditDir = join(tmp(), "audit");
    const trace = emptyTrace("invalid-\uFFFD-byte");
    const canonical = Buffer.from(canonicalJson(trace), "utf8");
    const replacement = Buffer.from("\uFFFD", "utf8");
    const replacementAt = canonical.indexOf(replacement);
    expect(replacementAt).toBeGreaterThan(-1);
    const raw = Buffer.concat([
      canonical.subarray(0, replacementAt),
      Buffer.from([0xff]),
      canonical.subarray(replacementAt + replacement.length),
    ]);
    expect(raw.toString("utf8")).toBe(canonical.toString("utf8"));
    const artifact = writeUncheckedArtifact(auditDir, trace, raw);

    const verified = verifyPolicyTraceReference({
      auditDir,
      ref: artifact.ref,
      sha256: artifact.sha256,
    });
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.reason).toBe("invalid-encoding");
  });

  it("rejects a schema-valid hash-consistent artifact above the verification byte limit", () => {
    const auditDir = join(tmp(), "audit");
    const trace = maximumSignatureTrace(170);
    const bytes = Buffer.from(canonicalJson(trace), "utf8");
    expect(bytes.length).toBe(1_053_027);
    const artifact = writeUncheckedArtifact(auditDir, trace, bytes);

    const verified = verifyPolicyTraceReference({
      auditDir,
      ref: artifact.ref,
      sha256: artifact.sha256,
    });
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.reason).toBe("too-large");
  });

  it("rejects final policy files that are symlinks or have another hardlink", () => {
    const symlinkAudit = join(tmp(), "audit");
    const symlinkStored = writePolicyTrace({
      auditDir: symlinkAudit,
      trace: emptyTrace(),
      now: NOW,
    });
    if (symlinkStored.status !== "complete") throw new Error("fixture trace did not persist");
    const symlinkArtifact = join(symlinkAudit, ...symlinkStored.ref.split("/"));
    const containedTarget = join(symlinkAudit, "contained-copy.json");
    writeFileSync(containedTarget, readFileSync(symlinkArtifact));
    rmSync(symlinkArtifact);
    symlinkSync(containedTarget, symlinkArtifact);
    const symlinkVerified = verifyPolicyTraceReference({
      auditDir: symlinkAudit,
      ref: symlinkStored.ref,
      sha256: symlinkStored.sha256,
    });
    expect(symlinkVerified.ok).toBe(false);
    if (!symlinkVerified.ok) expect(symlinkVerified.reason).toBe("not-a-file");

    const hardlinkAudit = join(tmp(), "audit");
    const hardlinkStored = writePolicyTrace({
      auditDir: hardlinkAudit,
      trace: emptyTrace(),
      now: NOW,
    });
    if (hardlinkStored.status !== "complete") throw new Error("fixture trace did not persist");
    const hardlinkArtifact = join(hardlinkAudit, ...hardlinkStored.ref.split("/"));
    linkSync(hardlinkArtifact, join(hardlinkAudit, "alias.json"));
    const hardlinkVerified = verifyPolicyTraceReference({
      auditDir: hardlinkAudit,
      ref: hardlinkStored.ref,
      sha256: hardlinkStored.sha256,
    });
    expect(hardlinkVerified.ok).toBe(false);
    if (!hardlinkVerified.ok) expect(hardlinkVerified.reason).toBe("not-a-file");
  });
});
