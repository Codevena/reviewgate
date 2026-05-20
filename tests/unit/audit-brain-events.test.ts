// tests/unit/audit-brain-events.test.ts
import { describe, expect, it } from "bun:test";
import { EventType } from "../../src/schemas/audit-event.ts";

describe("audit brain events", () => {
  it("includes curator + egress event types", () => {
    expect(EventType.options).toContain("curator.start");
    expect(EventType.options).toContain("curator.complete");
    expect(EventType.options).toContain("brain.egress");
  });
});
