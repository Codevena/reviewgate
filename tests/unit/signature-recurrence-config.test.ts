// tests/unit/signature-recurrence-config.test.ts
import { describe, expect, it } from "bun:test";
import { defaultConfig } from "../../src/config/defaults.ts";
import { EscalationReason } from "../../src/schemas/state.ts";

describe("#5 config + escalation reason", () => {
  it("EscalationReason accepts signature-recurrence", () => {
    expect(EscalationReason.parse("signature-recurrence")).toBe("signature-recurrence");
  });

  it("loop.maxSignatureRecurrence defaults to 3", () => {
    expect(defaultConfig.loop.maxSignatureRecurrence).toBe(3);
  });
});
