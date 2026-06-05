// tests/unit/cooldown-effect.test.ts
import { describe, expect, it } from "bun:test";
import { cooldownEffectFor } from "../../src/core/orchestrator.ts";
import type { ReviewResult, ReviewStatus } from "../../src/providers/adapter-base.ts";

const NOW = new Date("2026-06-02T00:00:00Z");
const res = (status: ReviewStatus, statusDetail = "", durationMs = 0): ReviewResult => ({
  reviewerId: "x",
  verdict: "ERROR",
  findings: [],
  usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, quotaUsedPct: null },
  durationMs,
  exitCode: -1,
  rawEventsPath: "",
  status,
  statusDetail,
});

describe("cooldownEffectFor", () => {
  it("emits a default-source backoff on quota-exhausted with no parseable reset", () => {
    // No reset time in the banner → the store applies the escalating backoff window.
    const e = cooldownEffectFor("codex", res("quota-exhausted"), NOW);
    expect(e).toEqual({ provider: "codex", source: "default" });
  });

  it("records a PARSED window when the quota banner carries a reset time", () => {
    const e = cooldownEffectFor("codex", res("quota-exhausted", "try again at 1:30 AM."), NOW);
    expect(e).toMatchObject({ provider: "codex", source: "parsed" });
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

  it("emits a default-source backoff marker for a reviewer's OWN timeout when the gate is on", () => {
    // A reviewer that runs into its own per-reviewer timeoutMs (not a gate-abort) is
    // re-spawned and re-burns the full wall-clock EVERY iteration (field report:
    // claude-code 300s every time). The effect just signals "cool this down"; the
    // escalating window (5min → 20min → 4h) is computed in the store (recordBackoff).
    // timeoutCooldownMs is a GATE (>0 = penalize the timeout), NOT the duration.
    const e = cooldownEffectFor("claude-code", res("timeout"), NOW, 300_000);
    expect(e).toEqual({ provider: "claude-code", source: "default" });
  });

  it("a FAST error (< slow threshold) stays inconclusive — no cooldown", () => {
    // A quick exit≠0 (bad config, crash) is cheap to retry; don't penalize it.
    expect(cooldownEffectFor("codex", res("error", "", 5_000), NOW, 300_000)).toBeNull();
  });

  it("a SLOW error (> slow threshold) gets the escalating backoff like a timeout", () => {
    // Field report: claude-code exited non-zero after 216s on a full-quota account
    // (overload / oversized prompt) — as expensive to re-burn every iteration as a
    // timeout, so it must be cooled down rather than retried forever.
    const e = cooldownEffectFor("claude-code", res("error", "", 216_000), NOW, 300_000);
    expect(e).toEqual({ provider: "claude-code", source: "default" });
  });

  it("a slow error is NOT cooled down on a self-deadline abort (timeoutCooldownMs=0)", () => {
    expect(cooldownEffectFor("claude-code", res("error", "", 216_000), NOW, 0)).toBeNull();
  });

  it("timeoutCooldownMs=0 disables the timeout cooldown (self-deadline-abort path)", () => {
    expect(cooldownEffectFor("claude-code", res("timeout"), NOW, 0)).toBeNull();
  });
});
