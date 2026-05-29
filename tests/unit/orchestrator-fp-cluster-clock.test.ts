// tests/unit/orchestrator-fp-cluster-clock.test.ts
//
// F-007 — the FP-cluster demote stage must be driven by the INJECTABLE run clock
// (`this.input.now`), NOT the wall clock. The cluster's active/sticky stage is a
// windowed function of `now`: with the SAME on-disk ledger, an injected `now`
// inside the 60-day active window must demote a matching finding (WARN→INFO +
// fp_cluster_match), and an injected `now` well past that window must NOT demote
// it (the rejects have aged out → candidate stage → no suppression). Before the
// fix, computeFpClusters read `new Date()`, so both injected clocks produced the
// same wall-clock behavior and this test could not distinguish them.
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../src/config/defaults.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";
import type { Finding } from "../../src/schemas/finding.ts";

const DIFF = "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-a\n+b\n";

// Reviewer emits a single finding whose (rule_id_token0, file) is "prisma@foo.ts"
// — the exact key of the seeded cluster below.
const FINDING: Finding = {
  id: "F-1",
  signature: "sig-live",
  severity: "WARN",
  category: "correctness",
  rule_id: "prisma-attribute-corruption",
  file: "foo.ts",
  line_start: 1,
  line_end: 1,
  message: "looks corrupted",
  details: "d",
  reviewer: { provider: "codex", model: "m", persona: "security" },
  confidence: 0.9,
  consensus: "singleton",
};

function stub(id: ProviderAdapter["id"]): ProviderAdapter {
  return {
    id,
    async preflight() {
      return { available: true, version: "x", authMode: "oauth", error: null };
    },
    async review(inp) {
      return {
        reviewerId: inp.reviewerId,
        verdict: "FAIL",
        findings: [{ ...FINDING }],
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
        durationMs: 1,
        exitCode: 0,
        rawEventsPath: "",
        rawText: "",
        status: "ok",
      } satisfies ReviewResult;
    },
  };
}

// Seed a 2-member FP-cluster on (prisma, foo.ts): 3 rejects across 2 distinct
// providers, all timestamped at REJECT_TS. Whether this cluster is "active"
// depends entirely on how far `now` is from REJECT_TS (60-day active window).
const REJECT_TS = "2026-03-01T00:00:00.000Z";

function seedLedger(repo: string): void {
  mkdirSync(join(repo, ".reviewgate", "learnings"), { recursive: true });
  const reject = (provider: string) => ({
    run_id: "old-run",
    provider,
    ts: REJECT_TS,
    reason: "prior hallucination",
  });
  const idx = {
    schema: "reviewgate.fpledger.v1",
    seq: 2,
    entries: [
      {
        id: "FP-001",
        signature: "sig-a",
        rule_id: "prisma-attribute-corruption",
        category: "correctness",
        file: "foo.ts",
        symbol: "",
        stage: "candidate",
        rejects: [reject("codex"), reject("gemini")],
        distinct_providers: ["codex", "gemini"],
        first_seen_at: REJECT_TS,
        last_seen_at: REJECT_TS,
        created_at: REJECT_TS,
      },
      {
        id: "FP-002",
        signature: "sig-b",
        rule_id: "prisma-corrupted-attribute",
        category: "correctness",
        file: "foo.ts",
        symbol: "",
        stage: "candidate",
        rejects: [reject("gemini")],
        distinct_providers: ["gemini"],
        first_seen_at: REJECT_TS,
        last_seen_at: REJECT_TS,
        created_at: REJECT_TS,
      },
    ],
  };
  writeFileSync(join(repo, ".reviewgate", "learnings", "known_fp.jsonl"), JSON.stringify(idx));
}

function makeOrch(repo: string, now: Date): Orchestrator {
  const config = {
    ...defaultConfig,
    phases: {
      review: { reviewers: [{ provider: "codex" as const, persona: "security" }] },
      critic: null,
      triage: null,
      fpLedger: { enabled: true },
    },
  };
  return new Orchestrator({
    repoRoot: repo,
    // biome-ignore lint/suspicious/noExplicitAny: test config shape
    config: config as any,
    adapters: { codex: stub("codex") },
    sandboxMode: "off",
    hostTier: "opus",
    diff: DIFF,
    reasonOnFailEnabled: true,
    providerAvailable: () => true,
    now: () => now,
  });
}

const readReport = (repo: string) =>
  JSON.parse(readFileSync(join(repo, ".reviewgate", "pending.json"), "utf8"));

describe("Orchestrator FP-cluster demote uses the injected clock (F-007)", () => {
  it("DEMOTES (WARN→INFO + fp_cluster_match) when injected now is inside the 60-day active window", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-fpc-in-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    seedLedger(repo);
    // 31 days after the rejects → still inside the 60-day active window.
    const now = new Date("2026-04-01T00:00:00.000Z");
    await makeOrch(repo, now).runIteration({ runId: "R", iter: 1 });
    const out = readReport(repo).findings[0];
    expect(out.severity).toBe("INFO");
    expect(out.fp_cluster_match?.cluster_key).toBe("prisma@foo.ts");
    expect(out.fp_cluster_match?.suppressed).toBe(true);
  });

  it("DOES NOT demote when injected now is past the active window (rejects aged out → candidate)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-fpc-out-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    seedLedger(repo);
    // 92 days after the rejects → outside the 60-day active window. Wall-clock
    // (today, 2026-05) would be ~60+ days off too, so the discriminator here is
    // that the SAME ledger + a far-future injected now yields no demote, which
    // only holds if computeFpClusters reads the injected clock.
    const now = new Date("2026-06-01T00:00:00.000Z");
    await makeOrch(repo, now).runIteration({ runId: "R", iter: 1 });
    const out = readReport(repo).findings[0];
    expect(out.severity).toBe("WARN");
    expect(out.fp_cluster_match).toBeUndefined();
  });
});
