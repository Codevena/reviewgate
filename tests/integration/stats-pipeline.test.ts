// tests/integration/stats-pipeline.test.ts
//
// End-to-end stats path: a real gate iteration writes a run.complete audit event
// (LoopDriver + Orchestrator + fake-codex), then loadAuditWindow + aggregate
// reflect that run in the StatsReport. No LLM — fake-codex is a deterministic stub.
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLogger } from "../../src/audit/logger.ts";
import { defaultConfig } from "../../src/config/defaults.ts";
import { LoopDriver } from "../../src/core/loop-driver.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import { StateStore } from "../../src/core/state-store.ts";
import { CodexAdapter } from "../../src/providers/codex.ts";
import { aggregate } from "../../src/stats/aggregate.ts";
import { loadAuditWindow } from "../../src/stats/load.ts";
import { auditDir, dirtyFlagPath } from "../../src/utils/paths.ts";

const FAKE_CODEX = join(process.cwd(), "tests/fixtures/fake-codex.sh");
const CODE_DIFF = "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-x\n+y\n";

describe("stats pipeline (record → load → aggregate)", () => {
  it("a real gate run is reflected in the aggregated StatsReport", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-stats-pipe-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    const state = new StateStore(repo);
    await state.initialise("01HXQSTATSPIPE");
    writeFileSync(
      dirtyFlagPath(repo),
      JSON.stringify({ diff_hash: "h", ts: new Date().toISOString() }),
    );
    const driver = new LoopDriver({
      repoRoot: repo,
      config: defaultConfig,
      state,
      audit: new AuditLogger(auditDir(repo)),
      orchestrator: new Orchestrator({
        repoRoot: repo,
        config: defaultConfig,
        adapters: { codex: new CodexAdapter({ binPath: FAKE_CODEX }) },
        sandboxMode: "off",
        hostTier: "opus",
        diff: CODE_DIFF,
        reasonOnFailEnabled: true,
      }),
      stopHookActive: false,
      freshHeadSha: async () => null, // S3b: unused stub for pre-existing fixtures
    });

    await driver.run(); // fake-codex → CRITICAL → FAIL → run.complete emitted

    const window = loadAuditWindow(repo, {});
    expect(window.runs.length).toBe(1);
    const report = aggregate(window.runs, window.escalationCount, [], []);
    expect(report.window.runCount).toBe(1);
    expect(report.verdicts.FAIL).toBe(1);
    expect(report.window.bySource.panel).toBe(1);
    // fake-codex ran as the codex provider and contributed the finding
    expect(report.providers.find((p) => p.provider === "codex")?.runs).toBe(1);
  });
});
