// tests/unit/host-model.test.ts
import { describe, expect, it } from "bun:test";
import { type HostTier, detectHostModel, reviewerTierFor } from "../../src/utils/host-model.ts";

describe("detectHostModel", () => {
  it("prefers REVIEWGATE_HOST_MODEL env when set", () => {
    const got = detectHostModel({
      env: { REVIEWGATE_HOST_MODEL: "claude-opus-4-7", CLAUDE_MODEL: "claude-haiku-4-5" },
      hookStdin: { session: { model: "claude-sonnet-4-6" } },
    });
    expect(got.tier).toBe("opus");
    expect(got.source).toBe("env:REVIEWGATE_HOST_MODEL");
  });

  it("falls back to CLAUDE_MODEL env", () => {
    const got = detectHostModel({
      env: { CLAUDE_MODEL: "claude-sonnet-4-6" },
      hookStdin: null,
    });
    expect(got.tier).toBe("sonnet");
    expect(got.source).toBe("env:CLAUDE_MODEL");
  });

  it("falls back to hook stdin session.model", () => {
    const got = detectHostModel({
      env: {},
      hookStdin: { session: { model: "claude-haiku-4-5" } },
    });
    expect(got.tier).toBe("haiku");
    expect(got.source).toBe("hook-stdin:session.model");
  });

  it("falls back to assume-opus when nothing is known", () => {
    const got = detectHostModel({ env: {}, hookStdin: null });
    expect(got.tier).toBe("opus");
    expect(got.source).toBe("fallback:assume-opus");
  });

  it("reviewerTierFor downgrades opus→sonnet, sonnet→haiku, haiku→disabled", () => {
    expect(reviewerTierFor("opus")).toBe("sonnet");
    expect(reviewerTierFor("sonnet")).toBe("haiku");
    expect(reviewerTierFor("haiku")).toBe("disabled");
  });

  it("reviewerTierFor handles unknown gracefully (assume-opus → sonnet)", () => {
    expect(reviewerTierFor("unknown" as HostTier)).toBe("sonnet");
  });
});
