import { describe, expect, it } from "bun:test";
import { ImplicitOutcomeSchema } from "../../src/schemas/implicit-outcome.ts";

const valid = {
  schema: "reviewgate.implicit_outcome.v1",
  signature: "sig-1",
  reviewer_key: "codex:security",
  category: "correctness",
  demote_reason: "critic_likely_fp",
  run_id: "RUN",
  iter: 3,
  created_at: "2026-06-02T00:00:00Z",
};

describe("ImplicitOutcomeSchema", () => {
  it("accepts a valid record", () => {
    expect(ImplicitOutcomeSchema.parse(valid)).toMatchObject({ demote_reason: "critic_likely_fp" });
  });
  it("rejects an unknown demote_reason", () => {
    expect(() => ImplicitOutcomeSchema.parse({ ...valid, demote_reason: "??" })).toThrow();
  });
  it("rejects a missing required field", () => {
    const { signature, ...rest } = valid;
    expect(() => ImplicitOutcomeSchema.parse(rest)).toThrow();
  });
});
