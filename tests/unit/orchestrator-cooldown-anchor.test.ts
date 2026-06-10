// tests/unit/orchestrator-cooldown-anchor.test.ts
// F-01 — cooldown backoff windows must be anchored at the time the effects are
// APPLIED (panel end), not at panel START. With both the default reviewer
// timeout and the first-strike backoff at 5 min, a start-anchored window is
// already expired the moment it is written, so the timed-out provider re-burns
// its full wall-clock every turn — the loop the escalating backoff exists to stop.
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../src/config/defaults.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";

const T0 = Date.parse("2026-06-10T12:00:00.000Z");
const PANEL_MS = 6 * 60_000; // reviewer burns 6 min before timing out
const DIFF = "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-a\n+b\n";

describe("Orchestrator cooldown anchoring (F-01)", () => {
  it("anchors a timed-out reviewer's backoff at panel END, so the window is live next turn", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-cd-anchor-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    const clock = { t: T0 };
    const timingOutStub: ProviderAdapter = {
      id: "codex",
      async preflight() {
        return { available: true, version: "x", authMode: "oauth", error: null };
      },
      async review(inp) {
        clock.t += PANEL_MS; // the run consumes 6 min of (fake) wall-clock
        return {
          reviewerId: inp.reviewerId,
          verdict: "ERROR",
          findings: [],
          usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, quotaUsedPct: null },
          durationMs: PANEL_MS,
          exitCode: 1,
          rawEventsPath: "",
          status: "timeout",
        } satisfies ReviewResult;
      },
    };
    const config = {
      ...defaultConfig, // loop.timeoutCooldownMs = 300_000 → timeout gets a backoff
      phases: {
        review: { reviewers: [{ provider: "codex" as const, persona: "security" }] },
        critic: null,
        triage: null,
      },
    };
    const orch = new Orchestrator({
      repoRoot: repo,
      // biome-ignore lint/suspicious/noExplicitAny: test config shape
      config: config as any,
      adapters: { codex: timingOutStub },
      sandboxMode: "off",
      hostTier: "opus",
      diff: DIFF,
      reasonOnFailEnabled: true,
      providerAvailable: () => true,
      now: () => new Date(clock.t),
    });
    await orch.runIteration({ runId: "R", iter: 1 });

    const cd = JSON.parse(readFileSync(join(repo, ".reviewgate", "quota-cooldowns.json"), "utf8"))
      .providers.codex;
    expect(cd.source).toBe("default");
    const panelEnd = T0 + PANEL_MS;
    // recorded_at = apply time (panel end), NOT panel start.
    expect(Date.parse(cd.recorded_at)).toBeGreaterThanOrEqual(panelEnd);
    // The first-strike 5-min window must still be LIVE at panel end — anchored at
    // panel start it would read T0+5min < T0+6min, i.e. expired when written.
    expect(Date.parse(cd.reset_at)).toBeGreaterThan(panelEnd);
  });
});
