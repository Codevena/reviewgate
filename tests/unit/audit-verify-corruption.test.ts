// tests/unit/audit-verify-corruption.test.ts
// F-004: `audit verify` must report a BROKEN CHAIN (graceful, non-zero exit) on a
// malformed/tampered/truncated log line — NOT crash with an uncaught JSON.parse
// SyntaxError / raw stack trace.
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLogger } from "../../src/audit/logger.ts";
import { verifyAuditBytes, verifyChain } from "../../src/audit/verifier.ts";
import { runAuditVerify } from "../../src/cli/commands/audit.ts";

function tmp() {
  return mkdtempSync(join(tmpdir(), "rg-audit-corrupt-"));
}

async function writeChain(): Promise<string> {
  const log = new AuditLogger(tmp());
  await log.append({ event: "session.start", run_id: "r1", iter: 0, trigger: "session-start" });
  await log.append({ event: "run.start", run_id: "r1", iter: 1, trigger: "stop-hook" });
  await log.append({ event: "reviewer.complete", run_id: "r1", iter: 1, trigger: "stop-hook" });
  return log.currentFilePath();
}

describe("verifyChain on a corrupt/non-JSON line", () => {
  it("verifies the exact supplied bytes and preserves the corrupt line number", async () => {
    const path = await writeChain();
    const bytes = readFileSync(path);
    const result = verifyAuditBytes({
      bytes,
      auditDir: join(path, "..", "..", "..", ".."),
    });

    expect(result).toMatchObject({ ok: true });
    const lines = bytes.toString("utf8").trim().split("\n");
    lines[1] = "{not valid json,,,";
    expect(
      verifyAuditBytes({
        bytes: Buffer.from(`${lines.join("\n")}\n`),
        auditDir: join(path, "..", "..", "..", ".."),
      }),
    ).toMatchObject({ ok: false, brokenAtLine: 2, totalLines: 3 });
  });

  it("reports a broken chain (no exception) when a line is not valid JSON", async () => {
    const path = await writeChain();
    const lines = readFileSync(path, "utf8").trim().split("\n");
    lines[1] = "{not valid json,,,"; // corrupt the middle line
    writeFileSync(path, `${lines.join("\n")}\n`);

    // Must NOT throw — returns a structured broken-chain result.
    const v = await verifyChain(path);
    expect(v.ok).toBe(false);
    expect(v.brokenAtLine).toBe(2);
  });

  it("reports corruption when the FINAL line is truncated mid-write", async () => {
    const path = await writeChain();
    const raw = readFileSync(path, "utf8");
    // Simulate a mid-flush truncation: keep the first lines intact, append a partial
    // (non-JSON) final line.
    const keep = raw.trim().split("\n").slice(0, 2);
    writeFileSync(path, `${keep.join("\n")}\n{"schema":"reviewgate.audit.v`);
    const v = await verifyChain(path);
    expect(v.ok).toBe(false);
    expect(v.brokenAtLine).toBe(3);
  });
});

describe("verifyChain policy artifact binding", () => {
  it("accepts legacy chains and rejects a missing complete policy artifact", async () => {
    const legacy = await writeChain();
    expect((await verifyChain(legacy)).ok).toBe(true);

    const auditDir = tmp();
    const log = new AuditLogger(auditDir);
    await log.append({
      event: "run.complete",
      run_id: "policy-run",
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
        policy_trace_ref: "2026/08/10/policy/000000000000-i1-000000000000.json",
        policy_trace_sha256: "0".repeat(64),
      },
    });

    expect(await verifyChain(log.currentFilePath())).toMatchObject({
      ok: false,
      brokenAtLine: 1,
    });
  });

  it("rejects a policy artifact removed after a valid chained append", async () => {
    const auditDir = tmp();
    const log = new AuditLogger(auditDir);
    const stored = log.writePolicyTrace({
      schema: "reviewgate.policy-trace.v1",
      catalog_version: "reviewgate.policy-catalog.v1",
      run_id: "policy-run",
      iter: 1,
      ablated: [],
      raw_response_sha256: ["a".repeat(64)],
      passes: (
        [
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
        ] as const
      ).map((pass_id) => ({
        pass_id,
        status: "ran" as const,
        considered: 0,
        opportunities: 0,
        would_apply: 0,
        applied: 0,
        protected: 0,
        blocking_removed: 0,
        blocking_preserved: 0,
        dropped: 0,
      })),
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
    });
    if (stored.status !== "complete") throw new Error("fixture trace did not persist");
    await log.append({
      event: "run.complete",
      run_id: "policy-run",
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
        policy_trace_status: stored.status,
        policy_trace_ref: stored.ref,
        policy_trace_sha256: stored.sha256,
      },
    });
    expect((await verifyChain(log.currentFilePath())).ok).toBe(true);

    const artifact = join(auditDir, ...stored.ref.split("/"));
    const original = readFileSync(artifact, "utf8");
    writeFileSync(artifact, `${original} `);
    expect(await verifyChain(log.currentFilePath())).toMatchObject({
      ok: false,
      brokenAtLine: 1,
    });
    writeFileSync(artifact, original);
    expect((await verifyChain(log.currentFilePath())).ok).toBe(true);

    rmSync(artifact);
    expect(await verifyChain(log.currentFilePath())).toMatchObject({
      ok: false,
      brokenAtLine: 1,
    });
  });

  it("rejects an escaping complete policy reference even when the audit hash is valid", async () => {
    const auditDir = tmp();
    const log = new AuditLogger(auditDir);
    await log.append({
      event: "run.complete",
      run_id: "policy-run",
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
        policy_trace_ref: "../2026/08/10/policy/000000000000-i1-000000000000.json",
        policy_trace_sha256: "0".repeat(64),
      },
    });

    expect(await verifyChain(log.currentFilePath())).toMatchObject({
      ok: false,
      brokenAtLine: 1,
    });
  });
});

describe("runAuditVerify command exit code + output", () => {
  it("exits non-zero with a clean message (no stack trace) on a corrupt log", async () => {
    const path = await writeChain();
    const lines = readFileSync(path, "utf8").trim().split("\n");
    lines[0] = "garbage { not json";
    writeFileSync(path, `${lines.join("\n")}\n`);

    const errs: string[] = [];
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string) => {
      errs.push(String(s));
      return true;
    }) as typeof process.stderr.write;
    let code: number;
    try {
      code = await runAuditVerify({ file: path });
    } finally {
      process.stderr.write = origErr;
    }
    expect(code).toBe(1);
    const out = errs.join("");
    expect(out).toMatch(/broken|corrupt/i);
    // A clean one-line message, not a multi-frame stack trace.
    expect(out).not.toContain("at verifyChain");
  });

  it("exits 0 on an intact chain", async () => {
    const path = await writeChain();
    const code = await runAuditVerify({ file: path });
    expect(code).toBe(0);
  });
});
