// tests/unit/orchestrator-abort-attribution.test.ts
//
// A reviewer that hits its OWN per-reviewer timeout BEFORE the gate deadline
// aborts the run must be cooled down even when the run is aborted later —
// otherwise the next run re-burns the identical hung chain (timeout treadmill:
// FlashBuddy 2026-07-08, 2× 12-min abort → review-timeout escalation).
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "../../src/config/define-config.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import { QuotaCooldownStore } from "../../src/core/quota-cooldown.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";

// >30 changed lines: at or below SMALL_DIFF_LINES the triage matrix imposes its
// small-diff reviewer-timeout cap, which (correctly) zeroes the timeout-cooldown
// gate (`triageCapActive`) — that would mask exactly the attribution this test
// exercises. A large diff keeps the cooldown gate armed.
const added = Array.from({ length: 40 }, (_, i) => `+line ${i}`).join("\n");
const diff = `diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1,41 @@\n-a\n${added}\n`;

const mkres = (reviewerId: string, status: ReviewResult["status"]): ReviewResult => ({
  reviewerId,
  verdict: status === "ok" ? "PASS" : "ERROR",
  findings: [],
  usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
  durationMs: 300_000,
  exitCode: status === "ok" ? 0 : -1,
  rawEventsPath: "",
  status,
});

// codex times out (its OWN timeout — signal NOT yet aborted), then the gate
// deadline fires (ac.abort()) while claude-code is still in flight; claude-code
// settles as timeout AFTER the abort. Ordering is made robust (not just
// microtask-lucky) by having claude-code park on a 100ms macrotask BEFORE
// aborting: codex's settle + effect computation are pure microtasks and finish
// well inside that window. In-process stubs, no subprocess → CI-safe.
function adapters(ac: AbortController): Record<string, ProviderAdapter> {
  return {
    codex: {
      id: "codex",
      async preflight() {
        return { available: true, version: "x", authMode: "oauth", error: null };
      },
      async review(inp) {
        return mkres(inp.reviewerId, "timeout"); // settles pre-abort (microtask)
      },
    },
    "claude-code": {
      id: "claude-code",
      async preflight() {
        return { available: true, version: "x", authMode: "oauth", error: null };
      },
      async review(inp) {
        // Park a full macrotask so codex's slot finishes settle+effect first,
        // THEN fire the deadline abort, THEN settle as a killed-by-abort timeout.
        await new Promise((r) => setTimeout(r, 100));
        ac.abort();
        return mkres(inp.reviewerId, "timeout"); // killed BY the abort
      },
    },
  };
}

describe("per-settle abort attribution", () => {
  it("cools a reviewer that timed out pre-abort; not one killed by the abort", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-abort-attr-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    const ac = new AbortController();
    const orch = new Orchestrator({
      repoRoot: repo,
      config: defineConfig({
        providers: {
          codex: { enabled: true, auth: "oauth", model: "m", timeoutMs: 300_000 },
          "claude-code": { enabled: true, auth: "oauth", model: "m", timeoutMs: 300_000 },
        },
        phases: {
          review: {
            reviewers: [
              { provider: "codex", persona: "security" },
              { provider: "claude-code", persona: "security" },
            ],
          },
          triage: null,
        },
        loop: { timeoutCooldownMs: 60_000 },
      }),
      adapters: adapters(ac),
      sandboxMode: "off",
      hostTier: "opus",
      diff,
      reasonOnFailEnabled: true,
      disableLastResortFailover: true,
    });
    await orch.runIteration({ runId: "R", iter: 1, signal: ac.signal }).catch(() => {});
    const store = new QuotaCooldownStore(repo);
    const now = new Date();
    // codex hit its OWN timeout before the abort → MUST be cooled.
    expect(store.skipUntil("codex", now)).not.toBeNull();
    // claude-code was killed BY the abort → must NOT be penalized.
    expect(store.skipUntil("claude-code", now)).toBeNull();
  });
});
