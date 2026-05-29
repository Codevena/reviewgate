// tests/unit/orchestrator-brain-clock.test.ts
//
// F-008 — post-verdict brain/proposal timestamps must use the SAME injectable
// run clock (`this.input.now`) the cooldown path uses, not the wall clock.
// The most directly observable of the four sites is the proposal-pool append:
// `ProposalStore.appendIter` stamps `appended_at: nowIso`. With an injected
// `now`, that stamp must equal the injected timestamp (not the machine wall
// clock), so brain lifecycle windows (decay, candidate TTL) are reproducible
// from the same clock the rest of the run uses.
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../src/config/defaults.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";
import { proposalsPoolPath } from "../../src/utils/paths.ts";

const DIFF = "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-a\n+b\n";
const INJECTED = new Date("2026-01-15T08:30:00.000Z");
const RUN_ID = "RUNX";

// A passing reviewer whose rawText carries one memory_proposal — that is what
// populates the orchestrator's `proposals` array and triggers appendIter.
function proposingStub(id: ProviderAdapter["id"]): ProviderAdapter {
  const rawText = JSON.stringify({
    verdict: "PASS",
    findings: [],
    memory_proposals: [
      {
        type: "convention",
        scope: "this-repo",
        title: "use Bun.file",
        body: "prefer Bun.file over fs.readFileSync",
        confidence: 0.8,
        tags: ["bun"],
        evidence: [{ kind: "reviewer-observation" }],
      },
    ],
  });
  return {
    id,
    async preflight() {
      return { available: true, version: "x", authMode: "oauth", error: null };
    },
    async review(inp) {
      return {
        reviewerId: inp.reviewerId,
        verdict: "PASS",
        findings: [],
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
        durationMs: 1,
        exitCode: 0,
        rawEventsPath: "",
        rawText,
        status: "ok",
      } satisfies ReviewResult;
    },
  };
}

describe("Orchestrator brain proposal-pool stamp uses the injected clock (F-008)", () => {
  it("stamps appended_at with the injected `now`, not the wall clock", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-brain-clock-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    const config = {
      ...defaultConfig,
      phases: {
        review: { reviewers: [{ provider: "codex" as const, persona: "security" }] },
        critic: null,
        triage: null,
        brain: {
          enabled: true,
          maxPromptTokens: 1500,
          embeddings: {
            provider: "openrouter" as const,
            model: "baai/bge-base-en-v1.5",
            apiKeyEnv: "OPENROUTER_API_KEY",
          },
          egressAllowlist: [],
          curatorTimeoutMs: 20_000,
          crossRunCandidates: { enabled: true, ttlDays: 60, maxEntries: 5000 },
        },
      },
    };
    const orch = new Orchestrator({
      repoRoot: repo,
      // biome-ignore lint/suspicious/noExplicitAny: test config shape
      config: config as any,
      adapters: { codex: proposingStub("codex") },
      sandboxMode: "off",
      hostTier: "opus",
      diff: DIFF,
      reasonOnFailEnabled: true,
      providerAvailable: () => true,
      now: () => INJECTED,
    });
    await orch.runIteration({ runId: RUN_ID, iter: 1 });

    const pool = readFileSync(proposalsPoolPath(repo, RUN_ID), "utf8")
      .split("\n")
      .filter((l) => l.trim());
    expect(pool.length).toBeGreaterThan(0);
    const stored = JSON.parse(pool[0] as string);
    expect(stored.appended_at).toBe(INJECTED.toISOString());
  });
});
