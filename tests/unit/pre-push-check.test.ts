// tests/unit/pre-push-check.test.ts
// Rec #3 (deep half): warn-only pre-push gate — decide whether the pushed commit has a recorded
// clean Reviewgate PASS. Pure + fail-safe (the caller never blocks; it only warns).
import { describe, expect, it } from "bun:test";
import { evaluatePrePush } from "../../src/core/pre-push-check.ts";
import { type ReviewgateState, initialState } from "../../src/schemas/state.ts";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);

function passedState(over: Partial<ReviewgateState> = {}): ReviewgateState {
  // A clean PASS re-arms: iteration 0 + last_reviewed_head_sha set, not escalated.
  return {
    ...initialState("S"),
    iteration: 0,
    last_reviewed_head_sha: SHA,
    last_pass_diff_hash: "h",
    escalated: false,
    ...over,
  };
}

describe("evaluatePrePush", () => {
  it("OK when the pushed tip IS the last-reviewed HEAD of a clean pass", () => {
    const v = evaluatePrePush({ pushedShas: [SHA], state: passedState() });
    expect(v.ok).toBe(true);
    expect(v.reason).toContain("clear to push");
  });

  it("WARN when the pushed tip is AHEAD of the last reviewed HEAD (newer commits unreviewed)", () => {
    const v = evaluatePrePush({ pushedShas: [OTHER], state: passedState() });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("not the last reviewed HEAD");
  });

  it("WARN when the last review did not pass (iteration > 0)", () => {
    const v = evaluatePrePush({ pushedShas: [SHA], state: passedState({ iteration: 2 }) });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("no clean Reviewgate PASS");
  });

  it("WARN when the gate is escalated", () => {
    const v = evaluatePrePush({
      pushedShas: [SHA],
      state: passedState({ escalated: true, escalation_reason: "max-iterations" }),
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("ESCALATED");
  });

  it("WARN when there is no state at all", () => {
    const v = evaluatePrePush({ pushedShas: [SHA], state: null });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("no Reviewgate state");
  });

  it("OK (no-op) when there are no pushed shas (delete / up-to-date)", () => {
    expect(evaluatePrePush({ pushedShas: [], state: null }).ok).toBe(true);
  });

  it("OK when the reviewed HEAD is among several pushed tips", () => {
    const v = evaluatePrePush({ pushedShas: [OTHER, SHA], state: passedState() });
    expect(v.ok).toBe(true);
  });
});
