import { describe, expect, it } from "bun:test";
import { ReputationSchema, emptyReputation } from "../../src/schemas/reputation.ts";

describe("ReputationSchema", () => {
  it("accepts an empty store", () => {
    expect(ReputationSchema.parse(emptyReputation())).toEqual({
      schema: "reviewgate.reputation.v1",
      reviewers: {},
    });
  });
  it("accepts provider entries with correct/wrong events", () => {
    const parsed = ReputationSchema.parse({
      schema: "reviewgate.reputation.v1",
      reviewers: { codex: { correct: [{ ts: "2026-05-25T00:00:00Z", eid: "a" }], wrong: [] } },
    });
    expect(parsed.reviewers.codex?.correct).toHaveLength(1);
  });
  it("rejects a wrong schema literal", () => {
    expect(() => ReputationSchema.parse({ schema: "x", reviewers: {} })).toThrow();
  });
});
