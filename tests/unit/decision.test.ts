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

  it("rejects an accepted decision missing action", () => {
    expect(() =>
      DecisionEntrySchema.parse({
        schema: "reviewgate.decision.v1",
        finding_id: "F-004",
        verdict: "accepted",
      }),
    ).toThrow();
  });
});
