// tests/unit/orchestrator-budget-clamp.test.ts
//
// With a deadline in sight, a reviewer spawn must clamp its timeout to the
// remaining budget (minus the tail reserve for critic/aggregate/report), skip
// spawns entirely below the floor, and never cooldown-penalize a MATERIALLY
// budget-capped timeout (same posture as the triage small-diff cap — the GATE
// tore it down) while a NEAR-full-window timeout keeps its cooldown.
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CRITIC_TAIL_RESERVE_MS,
  MIN_REVIEWER_BUDGET_MS,
  PANEL_TAIL_RESERVE_MS,
} from "../../src/config/budgets.ts";
import { defineConfig } from "../../src/config/define-config.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import { QuotaCooldownStore } from "../../src/core/quota-cooldown.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";
import type { Finding } from "../../src/schemas/finding.ts";

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

// Reviewer/critic double-duty stub: raises ONE finding (so the critic phase has
// input) and probes the critic's complete() options. onReview lets a case
// advance a mutable test clock "during" the panel.
function makeCriticProbeAdapter(
  seenCritic: { timeoutMs: (number | undefined)[] },
  hooks: { onReview?: () => void } = {},
): ProviderAdapter {
  const finding: Finding = {
    id: "F-001",
    signature: "sig-1",
    severity: "WARN",
    category: "correctness",
    rule_id: "rule.x",
    file: "foo.ts",
    line_start: 1,
    line_end: 1,
    message: "a problem",
    details: "some details",
    reviewer: { provider: "codex", model: "m", persona: "security" },
    confidence: 0.9,
    consensus: "singleton",
  } as Finding;
  return {
    id: "codex",
    async preflight() {
      return { available: true, version: "x", authMode: "oauth", error: null };
    },
    async review(inp) {
      hooks.onReview?.();
      return {
        reviewerId: inp.reviewerId,
        verdict: "FAIL",
        findings: [finding],
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
        durationMs: 1000,
        exitCode: 0,
        rawEventsPath: "",
        status: "ok",
      } satisfies ReviewResult;
    },
    async complete(_prompt, opts) {
      seenCritic.timeoutMs.push(opts?.timeoutMs);
      return '{"verdicts":[]}'; // parsed but zero demotions
    },
  };
}

function criticOrch(repo: string, adapter: ProviderAdapter, now: () => Date): Orchestrator {
  return new Orchestrator({
    repoRoot: repo,
    config: defineConfig({
      providers: {
        codex: { enabled: true, auth: "oauth", model: "m", timeoutMs: 300_000 },
      },
      phases: {
        review: { reviewers: [{ provider: "codex", persona: "security" }] },
        critic: { provider: "codex", persona: "adversarial" },
        triage: null,
      },
    }),
    adapters: { codex: adapter },
    sandboxMode: "off",
    hostTier: "opus",
    diff,
    reasonOnFailEnabled: true,
    disableLastResortFailover: true,
    now,
  });
}

describe("deadline-aware critic budget", () => {
  it("clamps the critic timeout to remaining budget minus the critic tail reserve", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-budget-critic-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    const t0 = Date.now();
    const seenCritic = { timeoutMs: [] as (number | undefined)[] };
    const o = criticOrch(repo, makeCriticProbeAdapter(seenCritic), () => new Date(t0));
    const res = await o.runIteration({ runId: "R", iter: 1, deadlineAt: t0 + 200_000 });
    // One WARN from one reviewer → severity-weighted SOFT-PASS (panel verdict).
    expect(res.verdict).toBe("SOFT-PASS");
    // 200s budget − CRITIC_TAIL_RESERVE_MS(30s) = 170s < the 300s configured.
    expect(seenCritic.timeoutMs).toEqual([200_000 - CRITIC_TAIL_RESERVE_MS]);
  });

  it("SKIPS the critic below the floor (fail-safe: the panel verdict stands)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-budget-critic-skip-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    const t0 = Date.now();
    // Mutable clock: the reviewer "consumes" 190s of the 200s budget, so the
    // critic sees 10s remaining − 30s reserve < 15s floor → skipped entirely.
    const clock = { ms: t0 };
    const seenCritic = { timeoutMs: [] as (number | undefined)[] };
    const adapter = makeCriticProbeAdapter(seenCritic, {
      onReview: () => {
        clock.ms += 190_000;
      },
    });
    const o = criticOrch(repo, adapter, () => new Date(clock.ms));
    const res = await o.runIteration({ runId: "R", iter: 1, deadlineAt: t0 + 200_000 });
    expect(seenCritic.timeoutMs).toEqual([]);
    // The panel verdict stands (one WARN → SOFT-PASS), produced WITHOUT the critic.
    expect(res.verdict).toBe("SOFT-PASS");
    // Observability: pending.json records WHY there are no critic verdicts.
    const pending = JSON.parse(readFileSync(join(repo, ".reviewgate", "pending.json"), "utf8"));
    expect(pending.critic?.status).toBe("skipped-budget");
  });
});
