import { describe, expect, it } from "bun:test";
import { ReviewgateStateSchema } from "../../src/schemas/state.ts";

describe("ReviewgateStateSchema back-compat", () => {
  it("defaults fp_rejects_history to [] for state written before the field existed", () => {
    // a minimal pre-existing state object WITHOUT fp_rejects_history
    const parsed = ReviewgateStateSchema.parse({
      schema: "reviewgate.state.v1",
      session_id: "s",
      iteration: 2,
      cost_usd_so_far: 0,
      tokens_so_far: { input: 0, output: 0 },
      signature_history: [["a"], ["a", "b"]],
      iteration_stats: [],
      decision_history: [],
      last_diff_hash: null,
      last_stop_ts: null,
      last_pass_diff_hash: null,
      started_at: new Date().toISOString(),
      escalated: false,
      escalation_reason: null,
    });
    expect(parsed.fp_rejects_history).toEqual([]);
  });
});
