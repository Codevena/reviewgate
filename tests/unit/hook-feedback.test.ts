// tests/unit/hook-feedback.test.ts
import { describe, expect, it } from "bun:test";
import { hookFeedbackMessage } from "../../src/cli/hook-feedback.ts";

describe("hookFeedbackMessage", () => {
  it("confirms a reset when run interactively (TTY)", () => {
    const msg = hookFeedbackMessage("reset", true);
    expect(msg).not.toBeNull();
    expect(msg).toContain("reset");
  });

  it("stays silent for reset when NOT a TTY (the real SessionStart hook — no output pollution)", () => {
    expect(hookFeedbackMessage("reset", false)).toBeNull();
  });

  it("stays silent for the stop/trigger hooks even on a TTY (they have their own output contract)", () => {
    expect(hookFeedbackMessage("stop", true)).toBeNull();
    expect(hookFeedbackMessage("trigger", true)).toBeNull();
  });
});
