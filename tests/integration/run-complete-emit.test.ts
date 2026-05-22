// tests/integration/run-complete-emit.test.ts
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLogger } from "../../src/audit/logger.ts";
import { defaultConfig } from "../../src/config/defaults.ts";
import { LoopDriver } from "../../src/core/loop-driver.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import { StateStore } from "../../src/core/state-store.ts";
import { CodexAdapter } from "../../src/providers/codex.ts";
import type { AuditEvent } from "../../src/schemas/audit-event.ts";
import { auditDir, dirtyFlagPath } from "../../src/utils/paths.ts";

const FAKE_CODEX = join(process.cwd(), "tests/fixtures/fake-codex.sh");

// A code diff so triage runs the reviewer panel (fake-codex returns one CRITICAL
// → verdict FAIL, source "panel"). This exercises the iteration path that must
// emit the run.complete audit event.
const CODE_DIFF = "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-x\n+y\n";

function fakeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-runcomplete-"));
  writeFileSync(join(dir, "foo.ts"), "x");
  return dir;
}

// Read every audit JSONL line under the date-partitioned audit dir.
function readAuditEvents(repo: string): AuditEvent[] {
  const events: AuditEvent[] = [];
  if (!existsSync(auditDir(repo))) return events;
  const glob = new Bun.Glob("**/*.jsonl");
  for (const rel of glob.scanSync({ cwd: auditDir(repo) })) {
    const lines = readFileSync(join(auditDir(repo), rel), "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    for (const l of lines) events.push(JSON.parse(l) as AuditEvent);
  }
  return events;
}

describe("LoopDriver run.complete emit", () => {
  it("emits a run.complete audit event carrying the iteration's RunSummary", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQRUNCOMPLETE");
    writeFileSync(
      dirtyFlagPath(repo),
      JSON.stringify({ diff_hash: "h", ts: new Date().toISOString() }),
    );
    const audit = new AuditLogger(auditDir(repo));
    const driver = new LoopDriver({
      repoRoot: repo,
      config: defaultConfig,
      state,
      audit,
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
    });

    const decision = await driver.run();
    // fake-codex emits a CRITICAL → FAIL → block (iteration runs, run.complete emitted).
    expect(decision.kind).toBe("block");

    const events = readAuditEvents(repo);
    const runComplete = events.find((e) => e.event === "run.complete");
    expect(runComplete).toBeDefined();
    expect(runComplete?.run_summary).toBeDefined();
    expect(runComplete?.run_summary?.verdict).toBe("FAIL");
    expect(runComplete?.run_summary?.providers).toBeDefined();
    expect(Array.isArray(runComplete?.run_summary?.providers)).toBe(true);
  });
});
