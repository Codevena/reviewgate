// tests/unit/state.test.ts
import { describe, expect, it } from "bun:test";
import {
  type ReviewgateState,
  ReviewgateStateSchema,
  initialState,
} from "../../src/schemas/state.ts";

describe("ReviewgateStateSchema", () => {
  it("accepts an initial state from initialState()", () => {
    const s = initialState("01HXQTEST");
    expect(() => ReviewgateStateSchema.parse(s)).not.toThrow();
    expect(s.iteration).toBe(0);
    expect(s.cost_usd_so_far).toBe(0);
    expect(s.escalated).toBe(false);
  });

  it("round-trips through JSON", () => {
    const s = initialState("01HXQRT");
    const j = JSON.stringify(s);
    const parsed = ReviewgateStateSchema.parse(JSON.parse(j));
    expect(parsed).toEqual(s);
  });

  it("rejects unknown escalation_reason", () => {
    const s = { ...initialState("01HXQX"), escalation_reason: "bogus" as unknown };
    expect(() => ReviewgateStateSchema.parse(s)).toThrow();
  });

  it("initialState seeds reputation_cycle_seq = 0 and the schema accepts it", () => {
    const s = initialState("01HXQREP");
    expect(s.reputation_cycle_seq).toBe(0);
    expect(ReviewgateStateSchema.parse(s).reputation_cycle_seq).toBe(0);
  });

  it("defaults reputation_cycle_seq for back-compat state.json without the field", () => {
    const { reputation_cycle_seq, ...withoutField } = initialState("01HXQREP2");
    expect(ReviewgateStateSchema.parse(withoutField).reputation_cycle_seq).toBe(0);
  });
});
