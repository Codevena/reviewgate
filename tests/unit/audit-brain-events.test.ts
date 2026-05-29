// tests/unit/audit-brain-events.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLogger } from "../../src/audit/logger.ts";
import { appendEgressAudit } from "../../src/core/orchestrator.ts";
import { AuditEventSchema, EventType } from "../../src/schemas/audit-event.ts";

function readAuditEvents(dir: string): unknown[] {
  const events: unknown[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".jsonl"))
        for (const line of readFileSync(p, "utf8").split("\n").filter(Boolean))
          events.push(JSON.parse(line));
    }
  };
  walk(dir);
  return events;
}

describe("audit brain events", () => {
  it("appendEgressAudit persists one brain.egress event per fetch attempt (F-028)", async () => {
    const auditDir = mkdtempSync(join(tmpdir(), "rg-egress-"));
    const audit = new AuditLogger(auditDir);
    await appendEgressAudit(audit, "run-1", 1, [
      {
        url: "https://docs.example.com/x",
        decision: "allow",
        resolved_ip: "93.184.216.34",
        status: 200,
        bytes: 12,
        sha256: "abc",
      },
      { url: "https://evil.invalid/y", decision: "deny", reason: "resolves to blocked ip" },
    ]);
    const events = readAuditEvents(auditDir).map(
      (e) =>
        e as {
          event: string;
          egress?: { decision: string; resolved_ip?: string; reason?: string };
        },
    );
    const egressEvents = events.filter((e) => e.event === "brain.egress");
    expect(egressEvents.length).toBe(2);
    expect(egressEvents[0]?.egress?.decision).toBe("allow");
    expect(egressEvents[0]?.egress?.resolved_ip).toBe("93.184.216.34");
    expect(egressEvents[1]?.egress?.decision).toBe("deny");
    expect(egressEvents[1]?.egress?.reason).toContain("blocked");
  });

  it("includes curator + egress event types", () => {
    expect(EventType.options).toContain("curator.start");
    expect(EventType.options).toContain("curator.complete");
    expect(EventType.options).toContain("brain.egress");
  });

  it("accepts a brain.egress event carrying the optional structured egress block", () => {
    const e = {
      schema: "reviewgate.audit.v1" as const,
      ts: "2026-05-21T00:00:00Z",
      run_id: "r1",
      iter: 0,
      event: "brain.egress" as const,
      trigger: "manual" as const,
      egress: {
        url: "https://docs.example.com/page?leak=secret",
        final_url: "https://docs.example.com/page",
        resolved_ip: "93.184.216.34",
        status: 200,
        bytes: 42,
        sha256: "a".repeat(64),
        decision: "allow" as const,
      },
      prev_event_hash: "h0",
      this_event_hash: "h1",
    };
    expect(() => AuditEventSchema.parse(e)).not.toThrow();
  });

  it("accepts a brain.egress deny event with reason and no payload fields", () => {
    const e = {
      schema: "reviewgate.audit.v1" as const,
      ts: "2026-05-21T00:00:00Z",
      run_id: "r1",
      iter: 0,
      event: "brain.egress" as const,
      trigger: "manual" as const,
      egress: {
        url: "https://evil.com/x",
        decision: "deny" as const,
        reason: "host not allowlisted",
      },
      prev_event_hash: "h0",
      this_event_hash: "h1",
    };
    expect(() => AuditEventSchema.parse(e)).not.toThrow();
  });

  it("remains backward-compatible: events without egress still parse", () => {
    const e = {
      schema: "reviewgate.audit.v1" as const,
      ts: "2026-05-21T00:00:00Z",
      run_id: "r1",
      iter: 0,
      event: "curator.start" as const,
      trigger: "manual" as const,
      prev_event_hash: "h0",
      this_event_hash: "h1",
    };
    expect(() => AuditEventSchema.parse(e)).not.toThrow();
  });
});
