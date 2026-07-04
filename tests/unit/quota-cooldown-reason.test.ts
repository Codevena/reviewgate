// Regression: a reviewer TIMEOUT / SLOW-ERROR (or an agy silent stall) records a
// "default"-source backoff — the SAME store slot a real quota-with-no-reset uses.
// The user-facing degradation note then labels ALL of them "quota until X", so a
// reviewer that merely ran slow once is reported as quota-capped (field report:
// "claude-code quota bis 18:52" while the model works fine). The fix threads the
// CAUSE (quota | timeout | error) through effect → store → label so the note is honest.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cooldownEffectFor } from "../../src/core/orchestrator.ts";
import {
  QuotaCooldownStore,
  SLOW_ERROR_THRESHOLD_MS,
  cooldownReasonLabel,
} from "../../src/core/quota-cooldown.ts";
import type { ReviewResult } from "../../src/providers/adapter-base.ts";

const NOW = new Date("2026-07-04T12:00:00.000Z");

function res(over: Partial<ReviewResult>): ReviewResult {
  return {
    reviewerId: "codex:security",
    verdict: "ERROR",
    findings: [],
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, quotaUsedPct: null },
    durationMs: 1000,
    exitCode: 1,
    rawEventsPath: "",
    status: "error",
    ...over,
  } as ReviewResult;
}

test("cooldownEffectFor tags a timeout backoff with reason 'timeout'", () => {
  const e = cooldownEffectFor(
    "claude-code",
    res({ status: "timeout", durationMs: 300_000 }),
    NOW,
    5 * 60_000,
  );
  expect(e).toEqual({ provider: "claude-code", source: "default", reason: "timeout" });
});

test("cooldownEffectFor tags a SLOW error backoff with reason 'error'", () => {
  const e = cooldownEffectFor(
    "claude-code",
    res({ status: "error", durationMs: SLOW_ERROR_THRESHOLD_MS + 1000 }),
    NOW,
    5 * 60_000,
  );
  expect(e).toEqual({ provider: "claude-code", source: "default", reason: "error" });
});

test("cooldownEffectFor tags a quota-exhausted-without-reset backoff with reason 'quota'", () => {
  const e = cooldownEffectFor(
    "codex",
    res({ status: "quota-exhausted", statusDetail: "" }),
    NOW,
    0,
  );
  expect(e).toEqual({ provider: "codex", source: "default", reason: "quota" });
});

test("a parsed reset stays source 'parsed' (a real quota banner)", () => {
  const e = cooldownEffectFor(
    "codex",
    res({
      status: "quota-exhausted",
      statusDetail: "You've hit your usage limit. try again at 1:30 PM.",
    }),
    NOW,
    0,
  );
  expect(e && "source" in e && e.source).toBe("parsed");
});

test("recordBackoff persists the reason; activeReason reads it back", () => {
  const repo = mkdtempSync(join(tmpdir(), "rg-qc-reason-"));
  const store = new QuotaCooldownStore(repo);
  store.recordBackoff("claude-code", NOW, "timeout");
  expect(store.activeReason("claude-code", NOW)).toBe("timeout");
  expect(store.activeUntil("claude-code", NOW)).not.toBeNull(); // still capped
});

test("cooldownReasonLabel is honest: timeout/error are NOT called 'quota'", () => {
  expect(cooldownReasonLabel("quota")).toContain("quota");
  expect(cooldownReasonLabel("timeout")).toContain("timed out");
  expect(cooldownReasonLabel("timeout")).not.toContain("quota");
  expect(cooldownReasonLabel("error")).not.toContain("quota");
  // Back-compat: an entry written before the reason field falls back to the quota wording.
  expect(cooldownReasonLabel(undefined)).toContain("quota");
});
