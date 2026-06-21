import { describe, expect, it } from "bun:test";
import { type DecisionEntry, DecisionEntrySchema } from "../../src/schemas/decision.ts";

describe("DecisionEntrySchema", () => {
  it("accepts an accepted decision", () => {
    const d: DecisionEntry = {
      schema: "reviewgate.decision.v1",
      finding_id: "F-001",
      verdict: "accepted",
      action: "fixed",
      files_touched: ["src/db.ts"],
    };
    expect(() => DecisionEntrySchema.parse(d)).not.toThrow();
  });

  it("accepts a rejected decision with reason", () => {
    const d: DecisionEntry = {
      schema: "reviewgate.decision.v1",
      finding_id: "F-002",
      verdict: "rejected",
      reason: "This is an intentional pattern documented in test:42 — see context",
      reviewer_was_wrong: true,
    };
    expect(() => DecisionEntrySchema.parse(d)).not.toThrow();
  });

  it("rejects a rejection with a too-short reason", () => {
    expect(() =>
      DecisionEntrySchema.parse({
        schema: "reviewgate.decision.v1",
        finding_id: "F-003",
        verdict: "rejected",
        reason: "nope",
      }),
    ).toThrow();
  });

  it("accepts the N2 'acknowledged-low-value' action", () => {
    const d: DecisionEntry = {
      schema: "reviewgate.decision.v1",
      finding_id: "F-009",
      verdict: "accepted",
      action: "acknowledged-low-value",
    };
    expect(() => DecisionEntrySchema.parse(d)).not.toThrow();
  });

  it("rejects an accepted decision missing action", () => {
    expect(() =>
      DecisionEntrySchema.parse({
        schema: "reviewgate.decision.v1",
        finding_id: "F-004",
        verdict: "accepted",
      }),
    ).toThrow();
  });

  // P6: "valid finding, verified not-applicable" — the reviewer was right to raise it but
  // the agent verified (with evidence) it does not apply here. Requires a reason >= 20.
  it("accepts the P6 'verified-not-applicable' action WITH a >= 20-char reason", () => {
    const d: DecisionEntry = {
      schema: "reviewgate.decision.v1",
      finding_id: "F-010",
      verdict: "accepted",
      action: "verified-not-applicable",
      reason: "Checked prod DB: the override row is true/100, so the default is irrelevant here",
    };
    expect(() => DecisionEntrySchema.parse(d)).not.toThrow();
  });

  it("rejects 'verified-not-applicable' with NO reason (fail-closed → stays blocking)", () => {
    expect(() =>
      DecisionEntrySchema.parse({
        schema: "reviewgate.decision.v1",
        finding_id: "F-011",
        verdict: "accepted",
        action: "verified-not-applicable",
      }),
    ).toThrow();
  });

  it("rejects 'verified-not-applicable' with a too-short reason", () => {
    expect(() =>
      DecisionEntrySchema.parse({
        schema: "reviewgate.decision.v1",
        finding_id: "F-012",
        verdict: "accepted",
        action: "verified-not-applicable",
        reason: "nope",
      }),
    ).toThrow();
  });

  it("rejects 'verified-not-applicable' with a whitespace-only reason (20 spaces is not evidence)", () => {
    expect(() =>
      DecisionEntrySchema.parse({
        schema: "reviewgate.decision.v1",
        finding_id: "F-015",
        verdict: "accepted",
        action: "verified-not-applicable",
        reason: " ".repeat(25),
      }),
    ).toThrow();
  });

  it("rejects a rejection with a whitespace-only reason (20 spaces must not pin an FP)", () => {
    expect(() =>
      DecisionEntrySchema.parse({
        schema: "reviewgate.decision.v1",
        finding_id: "F-016",
        verdict: "rejected",
        reason: " ".repeat(25),
        reviewer_was_wrong: true,
      }),
    ).toThrow();
  });

  it("still accepts 'fixed' / 'acknowledged-low-value' WITHOUT a reason (reason only required for verified-not-applicable)", () => {
    expect(() =>
      DecisionEntrySchema.parse({
        schema: "reviewgate.decision.v1",
        finding_id: "F-013",
        verdict: "accepted",
        action: "fixed",
      }),
    ).not.toThrow();
    expect(() =>
      DecisionEntrySchema.parse({
        schema: "reviewgate.decision.v1",
        finding_id: "F-014",
        verdict: "accepted",
        action: "acknowledged-low-value",
      }),
    ).not.toThrow();
  });
});
