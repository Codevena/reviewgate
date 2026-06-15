// tests/unit/audit-logger-retention.test.ts
// F-005: audit.retentionDays was declared in config but NEVER enforced — the log
// grew forever. The logger must prune day-partitions older than retentionDays.
import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLogger } from "../../src/audit/logger.ts";

function tmp() {
  return mkdtempSync(join(tmpdir(), "rg-audit-retain-"));
}

// Seed a day-partition (audit/YYYY/MM/DD/HHMMSS.jsonl) for an arbitrary UTC date.
function seedDay(auditDir: string, d: Date): string {
  const y = String(d.getUTCFullYear());
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const dir = join(auditDir, y, m, day);
  mkdirSync(dir, { recursive: true });
  const f = join(dir, "120000.jsonl");
  writeFileSync(f, "{}\n");
  return dir;
}

describe("AuditLogger retention pruning", () => {
  it("deletes day-partitions older than retentionDays on the first append", async () => {
    const auditDir = tmp();
    const now = Date.now();
    const oldDir = seedDay(auditDir, new Date(now - 200 * 24 * 60 * 60 * 1000)); // 200d ago
    const recentDir = seedDay(auditDir, new Date(now - 5 * 24 * 60 * 60 * 1000)); // 5d ago
    expect(existsSync(oldDir)).toBe(true);
    expect(existsSync(recentDir)).toBe(true);

    const log = new AuditLogger(auditDir, 180);
    await log.append({ event: "session.start", run_id: "r1", iter: 0, trigger: "session-start" });

    // Older-than-180d partition pruned; the recent one and today's new file remain.
    expect(existsSync(oldDir)).toBe(false);
    expect(existsSync(recentDir)).toBe(true);
    expect(existsSync(log.currentFilePath())).toBe(true);
  });

  it("does NOT prune when retentionDays is null (back-compat default)", async () => {
    const auditDir = tmp();
    const oldDir = seedDay(auditDir, new Date(Date.now() - 999 * 24 * 60 * 60 * 1000));
    const log = new AuditLogger(auditDir); // no retentionDays
    await log.append({ event: "session.start", run_id: "r1", iter: 0, trigger: "session-start" });
    expect(existsSync(oldDir)).toBe(true);
  });

  it("never prunes today's freshly-written partition", async () => {
    const auditDir = tmp();
    const log = new AuditLogger(auditDir, 1); // aggressive 1-day retention
    await log.append({ event: "session.start", run_id: "r1", iter: 0, trigger: "session-start" });
    // The file we just wrote is from today — it must survive an aggressive cutoff.
    expect(existsSync(log.currentFilePath())).toBe(true);
  });
});
