// tests/unit/audit-verify-corruption.test.ts
// F-004: `audit verify` must report a BROKEN CHAIN (graceful, non-zero exit) on a
// malformed/tampered/truncated log line — NOT crash with an uncaught JSON.parse
// SyntaxError / raw stack trace.
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLogger } from "../../src/audit/logger.ts";
import { verifyChain } from "../../src/audit/verifier.ts";
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
