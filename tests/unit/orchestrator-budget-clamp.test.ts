// tests/unit/orchestrator-budget-clamp.test.ts
//
// With a deadline in sight, a reviewer spawn must clamp its timeout to the
// remaining budget (minus the tail reserve for critic/aggregate/report), skip
// spawns entirely below the floor, and never cooldown-penalize a MATERIALLY
// budget-capped timeout (same posture as the triage small-diff cap — the GATE
// tore it down) while a NEAR-full-window timeout keeps its cooldown.
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIN_REVIEWER_BUDGET_MS, PANEL_TAIL_RESERVE_MS } from "../../src/config/budgets.ts";
import { defineConfig } from "../../src/config/define-config.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import { QuotaCooldownStore } from "../../src/core/quota-cooldown.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";

// >30 changed lines: at or below SMALL_DIFF_LINES the triage matrix imposes its
// own reviewer-timeout cap (240s) and zeroes the timeout-cooldown gate — both
// would contaminate the budget-clamp arithmetic these tests assert.
const added = Array.from({ length: 40 }, (_, i) => `+line ${i}`).join("\n");
const diff = `diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1,41 @@\n-a\n${added}\n`;

function stub(
  id: ProviderAdapter["id"],
  seen: { timeoutMs: number[] },
  status: ReviewResult["status"],
): ProviderAdapter {
  return {
    id,
    async preflight() {
      return { available: true, version: "x", authMode: "oauth", error: null };
    },
    async review(inp) {
      seen.timeoutMs.push(inp.cfg.timeoutMs);
      return {
        reviewerId: inp.reviewerId,
        verdict: status === "ok" ? "PASS" : "ERROR",
        findings: [],
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
        durationMs: 1000,
        exitCode: status === "ok" ? 0 : -1,
        rawEventsPath: "",
        status,
      };
    },
  };
}

function orch(
  repo: string,
  adapters: Record<string, ProviderAdapter>,
  opts: {
    reviewers: { provider: string; persona: string; fallback?: string[] }[];
    now: () => Date;
  },
) {
  return new Orchestrator({
    repoRoot: repo,
    config: defineConfig({
      providers: {
        codex: { enabled: true, auth: "oauth", model: "m", timeoutMs: 300_000 },
        gemini: { enabled: true, auth: "oauth", model: "m", timeoutMs: 300_000 },
      },
      phases: { review: { reviewers: opts.reviewers as never }, triage: null },
    }),
    adapters,
    sandboxMode: "off",
    hostTier: "opus",
    diff,
    reasonOnFailEnabled: true,
    disableLastResortFailover: true,
    now: opts.now,
  });
}

describe("deadline-aware reviewer budgets", () => {
  it("clamps the reviewer timeout to remaining budget minus the tail reserve", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-budget-clamp-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    const t0 = Date.now();
    const seen = { timeoutMs: [] as number[] };
    const o = orch(
      repo,
      { codex: stub("codex", seen, "ok") },
      {
        reviewers: [{ provider: "codex", persona: "security" }],
        now: () => new Date(t0),
      },
    );
    // 200s of budget left → clamp = 200_000 − PANEL_TAIL_RESERVE_MS < 300_000.
    await o.runIteration({ runId: "R", iter: 1, deadlineAt: t0 + 200_000 });
    expect(seen.timeoutMs).toEqual([200_000 - PANEL_TAIL_RESERVE_MS]);
  });

  it("skips the spawn below the floor and does not run fallbacks either", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-budget-floor-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    const t0 = Date.now();
    const seenP = { timeoutMs: [] as number[] };
    const seenF = { timeoutMs: [] as number[] };
    const o = orch(
      repo,
      { codex: stub("codex", seenP, "ok"), gemini: stub("gemini", seenF, "ok") },
      {
        reviewers: [{ provider: "codex", persona: "security", fallback: ["gemini"] }],
        now: () => new Date(t0),
      },
    );
    // Budget below the spawn floor → NOTHING spawns; the run must still settle
    // (fail-closed ERROR verdict via the existing 0-ok-reviewers path).
    const res = await o.runIteration({
      runId: "R",
      iter: 1,
      deadlineAt: t0 + PANEL_TAIL_RESERVE_MS + MIN_REVIEWER_BUDGET_MS - 1_000,
    });
    expect(seenP.timeoutMs).toEqual([]);
    expect(seenF.timeoutMs).toEqual([]);
    expect(res.verdict).toBe("ERROR");
  });

  it("a MATERIALLY budget-capped timeout is not cooldown-penalized", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-budget-nocool-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    const t0 = Date.now();
    const seen = { timeoutMs: [] as number[] };
    const o = orch(
      repo,
      { codex: stub("codex", seen, "timeout") },
      {
        reviewers: [{ provider: "codex", persona: "security" }],
        now: () => new Date(t0),
      },
    );
    await o.runIteration({ runId: "R", iter: 1, deadlineAt: t0 + 200_000 });
    // Granted window 140s (200s − 60s reserve) is MORE than the 30s slack below
    // the configured 300s → gate's fault → no backoff recorded.
    expect(new QuotaCooldownStore(repo).skipUntil("codex", new Date(t0))).toBeNull();
  });

  it("a NEAR-FULL-window timeout keeps its cooldown (provider's fault)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-budget-cool-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    const t0 = Date.now();
    const seen = { timeoutMs: [] as number[] };
    const o = orch(
      repo,
      { codex: stub("codex", seen, "timeout") },
      {
        reviewers: [{ provider: "codex", persona: "security" }],
        now: () => new Date(t0),
      },
    );
    // Budget 350s → granted window 290s of the configured 300s — inside the
    // 30s attribution slack. The provider demonstrably hung for (nearly) its
    // whole window → the escalating backoff MUST be recorded, else the next
    // run re-burns it (this is the CRITICAL from the plan-gate review).
    await o.runIteration({ runId: "R", iter: 1, deadlineAt: t0 + 350_000 });
    expect(seen.timeoutMs).toEqual([290_000]);
    expect(new QuotaCooldownStore(repo).skipUntil("codex", new Date(t0))).not.toBeNull();
  });
});
