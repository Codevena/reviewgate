// tests/unit/cooldown-effect.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CooldownEffect,
  applyCooldownEffects,
  cooldownEffectFor,
} from "../../src/core/orchestrator.ts";
import { QuotaCooldownStore } from "../../src/core/quota-cooldown.ts";
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

describe("applyCooldownEffects", () => {
  const repo = () => mkdtempSync(join(tmpdir(), "rg-apply-"));
  const FIVE_MIN = 5 * 60_000;

  it("dedups a provider failing in N slots into ONE backoff strike (not N)", () => {
    // claude-code can appear as its own slot + last-resort/fallback for others. Without
    // dedup, 3 failing slots → 3 recordBackoff(now) calls → strike 1→2→3 (4h) in ONE
    // cycle, defeating the gentle 3-step schedule.
    const s = new QuotaCooldownStore(repo());
    const effects: CooldownEffect[] = [
      { provider: "claude-code", source: "default" },
      { provider: "claude-code", source: "default" },
      { provider: "claude-code", source: "default" },
    ];
    applyCooldownEffects(s, effects, NOW, false);
    expect(s.activeUntil("claude-code", NOW)).toBe(
      new Date(NOW.getTime() + FIVE_MIN).toISOString(),
    );
  });

  it("suppresses default-source backoff when the run was aborted (self-deadline)", () => {
    // The gate self-deadline SIGKILLs healthy reviewers (error/timeout, large duration).
    // They must NOT be cooled down — that is the gate's teardown, not the provider's fault.
    const s = new QuotaCooldownStore(repo());
    applyCooldownEffects(s, [{ provider: "claude-code", source: "default" }], NOW, true);
    expect(s.activeUntil("claude-code", NOW)).toBeNull();
    expect(s.skipUntil("claude-code", NOW)).toBeNull();
  });

  it("still records a PARSED reset on an aborted run (a real quota banner ≠ the abort)", () => {
    const s = new QuotaCooldownStore(repo());
    const resetAt = new Date(NOW.getTime() + 3_600_000).toISOString();
    applyCooldownEffects(s, [{ provider: "codex", resetAt, source: "parsed" }], NOW, true);
    expect(s.activeUntil("codex", NOW)).toBe(resetAt);
  });

  it("clear wins over a same-provider default backoff (it demonstrably worked)", () => {
    const s = new QuotaCooldownStore(repo());
    applyCooldownEffects(
      s,
      [
        { provider: "gemini", source: "default" },
        { provider: "gemini", clear: true },
      ],
      NOW,
      false,
    );
    expect(s.activeUntil("gemini", NOW)).toBeNull();
  });

  it("a parsed reset wins over a same-provider default backoff", () => {
    const s = new QuotaCooldownStore(repo());
    const resetAt = new Date(NOW.getTime() + 3_600_000).toISOString();
    applyCooldownEffects(
      s,
      [
        { provider: "gemini", source: "default" },
        { provider: "gemini", resetAt, source: "parsed" },
      ],
      NOW,
      false,
    );
    expect(s.activeUntil("gemini", NOW)).toBe(resetAt);
  });
});
