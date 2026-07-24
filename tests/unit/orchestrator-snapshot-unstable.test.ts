import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../src/config/defaults.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";
import type { Finding } from "../../src/schemas/finding.ts";
import { PendingReportSchema } from "../../src/schemas/pending-report.ts";

const DIFF = "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-a\n+b\n";

function stub(): ProviderAdapter {
  const finding: Finding = {
    id: "F",
    signature: "snapshot-race",
    severity: "CRITICAL",
    category: "correctness",
    rule_id: "snapshot-race",
    file: "foo.ts",
    line_start: 1,
    line_end: 1,
    message: "transient state",
    details: "the reviewer saw a transient state",
    reviewer: { provider: "codex", model: "m", persona: "security" },
    confidence: 0.9,
    consensus: "singleton",
  };
  return {
    id: "codex",
    async preflight() {
      return { available: true, version: "x", authMode: "oauth", error: null };
    },
    async review(input) {
      return {
        reviewerId: input.reviewerId,
        verdict: "FAIL",
        findings: [finding],
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
        durationMs: 1,
        exitCode: 0,
        rawEventsPath: "",
        status: "ok",
      } satisfies ReviewResult;
    },
  };
}

function config() {
  return {
    ...defaultConfig,
    phases: {
      ...defaultConfig.phases,
      review: { reviewers: [{ provider: "codex" as const, persona: "security" }] },
      critic: null,
      triage: null,
    },
  };
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-orch-snapshot-"));
  writeFileSync(join(dir, "foo.ts"), "b\n");
  return dir;
}

describe("orchestrator unstable snapshot handling", () => {
  it("suppresses the reviewed manifest and propagates the instability count to JSON and Markdown", async () => {
    const dir = repo();
    const orchestrator = new Orchestrator({
      repoRoot: dir,
      config: config(),
      adapters: { codex: stub() },
      sandboxMode: "off",
      hostTier: "opus",
      diff: DIFF,
      reasonOnFailEnabled: true,
      snapshotUnstable: { recaptures: 3 },
      capturedSnapshotFiles: null,
    });

    const result = await orchestrator.runIteration({ runId: "RUN", iter: 1 });
    const raw = JSON.parse(
      readFileSync(join(dir, ".reviewgate", "pending.json"), "utf8"),
    ) as unknown;
    const report = PendingReportSchema.parse(raw);
    const markdown = readFileSync(join(dir, ".reviewgate", "pending.md"), "utf8");

    expect(result.reviewedSnapshotFiles).toBeUndefined();
    expect(report.snapshot_unstable).toEqual({ recaptures: 3 });
    expect(markdown).toContain("Snapshot unstable");
    expect(markdown).toContain("re-captured 3×");
    expect(markdown).toContain("LATEST read");
  });

  it("keeps the reviewed manifest and omits the banner for a stable snapshot", async () => {
    const dir = repo();
    const orchestrator = new Orchestrator({
      repoRoot: dir,
      config: config(),
      adapters: { codex: stub() },
      sandboxMode: "off",
      hostTier: "opus",
      diff: DIFF,
      reasonOnFailEnabled: true,
      capturedSnapshotFiles: {
        "foo.ts": { status: "present", hash: "captured-inside-verified-round" },
      },
    });

    const result = await orchestrator.runIteration({ runId: "RUN", iter: 1 });
    const report = JSON.parse(readFileSync(join(dir, ".reviewgate", "pending.json"), "utf8")) as {
      snapshot_unstable?: unknown;
    };
    const markdown = readFileSync(join(dir, ".reviewgate", "pending.md"), "utf8");

    expect(result.reviewedSnapshotFiles?.["foo.ts"]).toEqual({
      status: "present",
      hash: "captured-inside-verified-round",
    });
    expect(report.snapshot_unstable).toBeUndefined();
    expect(markdown).not.toContain("Snapshot unstable");
  });

  it("rejects a zero recapture count at the pending-report schema boundary", () => {
    const base = {
      schema: "reviewgate.pending.v1",
      run_id: "RUN",
      iter: 1,
      max_iter: 3,
      verdict: "FAIL",
      counts: { critical: 0, warn: 0, info: 0 },
      reviewers: [],
      findings: [],
      snapshot_unstable: { recaptures: 0 },
      cost_usd_total: 0,
      duration_ms_total: 1,
      generated_at: "2026-07-23T00:00:00.000Z",
      git: { sha: "a".repeat(40), branch: "main", dirty_files: [] },
    };

    expect(PendingReportSchema.safeParse(base).success).toBe(false);
  });
});
