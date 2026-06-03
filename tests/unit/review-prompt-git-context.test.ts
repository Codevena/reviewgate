import { describe, expect, it } from "bun:test";
import { REVIEW_PROMPT_PREAMBLE } from "../../src/core/orchestrator.ts";

// S7 (hammihan F-001): the reviewer flagged an UNTRACKED working-tree migration as
// "committed in the diff / breaks the deploy" — a confident-wrong CRITICAL. The diff is
// working-tree state (committed + staged + untracked together); the reviewer cannot tell
// commit/deploy state from it, so the preamble must correct that mental model.
describe("review prompt git-context (S7)", () => {
  it("tells the reviewer the diff is working-tree state, not a commit/deploy record", () => {
    const p = REVIEW_PROMPT_PREAMBLE.toLowerCase();
    expect(p).toContain("working-tree");
    expect(p).toContain("untracked");
    expect(p).toContain("deploy");
  });
});
