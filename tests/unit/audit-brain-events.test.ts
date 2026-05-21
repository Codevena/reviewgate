// tests/unit/audit-brain-events.test.ts
import { describe, expect, it } from "bun:test";
import { AuditEventSchema, EventType } from "../../src/schemas/audit-event.ts";

describe("audit brain events", () => {
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
