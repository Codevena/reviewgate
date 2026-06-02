// tests/unit/cooldown-effect.test.ts
import { describe, expect, it } from "bun:test";
import { cooldownEffectFor } from "../../src/core/orchestrator.ts";
import type { ReviewResult, ReviewStatus } from "../../src/providers/adapter-base.ts";

const NOW = new Date("2026-06-02T00:00:00Z");
const res = (status: ReviewStatus, statusDetail = ""): ReviewResult => ({
  reviewerId: "x",
  verdict: "ERROR",
  findings: [],
  usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, quotaUsedPct: null },
  durationMs: 0,
  exitCode: -1,
  rawEventsPath: "",
  status,
  statusDetail,
});

describe("cooldownEffectFor", () => {
  it("records a cooldown on quota-exhausted", () => {
    const e = cooldownEffectFor("codex", res("quota-exhausted"), NOW);
    expect(e && "resetAt" in e).toBe(true);
  });

  it("clears the cooldown only on a successful (ok) run", () => {
    expect(cooldownEffectFor("codex", res("ok"), NOW)).toEqual({ provider: "codex", clear: true });
  });

  it("does NOT clear on timeout/error (inconclusive — e.g. deadline-abort) — preserves cooldown", () => {
    // A run killed by the gate self-deadline surfaces as timeout/error; clearing
    // the cooldown there falsely asserts the provider recovered and re-exposes a
    // still-capped provider on the next review.
    expect(cooldownEffectFor("codex", res("timeout"), NOW)).toBeNull();
    expect(cooldownEffectFor("codex", res("error"), NOW)).toBeNull();
  });
});
