// tests/unit/loop-driver-hook-timeout-clamp.test.ts
//
// Upgrade fail-open guard (post-implementation review CRITICAL, 2026-07-09):
// existing installs keep their .claude/settings.json Stop-hook timeout (900s
// pre-upgrade) while a binary upgrade raises the DEFAULT loop.runTimeoutMs to
// 1800s. Without a runtime clamp the self-deadline would sit ABOVE the OS kill:
// the hook is killed mid-review (non-blocking) and the turn ends UN-reviewED —
// fail-open on exactly the degraded 10-12min panels the deadline exists for.
// The loop therefore clamps its effective deadline to the INSTALLED hook
// timeout minus the setup+settle margin, making the budgets.ts invariant
// self-enforcing instead of init-dependent.
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLogger } from "../../src/audit/logger.ts";
import {
  MIN_RUN_TIMEOUT_MS,
  POST_ABORT_SETTLE_MS_DEFAULT,
  SETUP_BUDGET_MS_DEFAULT,
} from "../../src/config/budgets.ts";
import { defaultConfig } from "../../src/config/defaults.ts";
import { LoopDriver } from "../../src/core/loop-driver.ts";
import type { IterationResult } from "../../src/core/orchestrator.ts";
import { StateStore } from "../../src/core/state-store.ts";
import type { RunSummary } from "../../src/schemas/audit-event.ts";
import { auditDir, dirtyFlagPath } from "../../src/utils/paths.ts";

function fakeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-hookclamp-"));
  writeFileSync(join(dir, "foo.ts"), "x");
  return dir;
}

function writeDirty(repo: string): void {
  writeFileSync(
    dirtyFlagPath(repo),
    JSON.stringify({ diff_hash: "h", ts: new Date().toISOString() }),
  );
}

function writeStopHookTimeout(repo: string, timeoutS: number): void {
  mkdirSync(join(repo, ".claude"), { recursive: true });
  writeFileSync(
    join(repo, ".claude", "settings.json"),
    JSON.stringify({
      hooks: {
        Stop: [
          {
            matcher: "*",
            hooks: [
              {
                type: "command",
                command: '"${CLAUDE_PROJECT_DIR}/.reviewgate/bin/gate"',
                timeout: timeoutS,
              },
            ],
          },
        ],
      },
    }),
  );
}

const PASS_SUMMARY: RunSummary = {
  verdict: "PASS",
  source: "panel",
  counts: { critical: 0, warn: 0, info: 0 },
  cost_usd: 0,
  duration_ms: 1,
  demoted: 0,
  signatures: [],
  providers: [],
};

// Stub orchestrator that captures the deadlineAt the loop passes in.
function capturingStub(seen: { deadlineAt: (number | undefined)[] }) {
  return {
    runIteration: async (opts: { deadlineAt?: number }): Promise<IterationResult> => {
      seen.deadlineAt.push(opts.deadlineAt);
      return {
        verdict: "PASS" as const,
        costUsd: 0,
        durationMs: 1,
        signaturesThisIter: [],
        summary: PASS_SUMMARY,
      };
    },
  };
}

async function runDriver(repo: string, seen: { deadlineAt: (number | undefined)[] }) {
  const state = new StateStore(repo);
  await state.initialise("01HXHOOKCLAMP");
  writeDirty(repo);
  await new LoopDriver({
    repoRoot: repo,
    config: defaultConfig, // runTimeoutMs 1_800_000
    state,
    audit: new AuditLogger(auditDir(repo)),
    orchestrator: capturingStub(seen),
    stopHookActive: false,
    freshHeadSha: async () => null,
  }).run();
}

describe("loop clamps its self-deadline to the installed Stop-hook timeout", () => {
  it("a pre-upgrade 900s hook clamps the 1800s default below the OS kill", async () => {
    const repo = fakeRepo();
    writeStopHookTimeout(repo, 900);
    const seen = { deadlineAt: [] as (number | undefined)[] };
    const before = Date.now();
    await runDriver(repo, seen);
    expect(seen.deadlineAt).toHaveLength(1);
    const deadlineAt = seen.deadlineAt[0];
    expect(deadlineAt).toBeDefined();
    // Effective deadline = 900_000 − setup − settle, NOT the configured 1800s.
    const expected = 900_000 - SETUP_BUDGET_MS_DEFAULT - POST_ABORT_SETTLE_MS_DEFAULT;
    const effective = (deadlineAt as number) - before;
    expect(effective).toBeGreaterThan(expected - 10_000);
    expect(effective).toBeLessThanOrEqual(expected + 10_000);
  });

  it("without an installed hook timeout the configured deadline stands", async () => {
    const repo = fakeRepo(); // no .claude/settings.json at all
    const seen = { deadlineAt: [] as (number | undefined)[] };
    const before = Date.now();
    await runDriver(repo, seen);
    const effective = (seen.deadlineAt[0] as number) - before;
    expect(effective).toBeGreaterThan(1_800_000 - 10_000);
    expect(effective).toBeLessThanOrEqual(1_800_000 + 10_000);
  });

  it("a pathologically small hook timeout floors at MIN_RUN_TIMEOUT_MS (never disables the deadline)", async () => {
    const repo = fakeRepo();
    writeStopHookTimeout(repo, 120); // cap = 120s − 150s < 0 → floor, not disable
    const seen = { deadlineAt: [] as (number | undefined)[] };
    const before = Date.now();
    await runDriver(repo, seen);
    const effective = (seen.deadlineAt[0] as number) - before;
    expect(effective).toBeGreaterThan(MIN_RUN_TIMEOUT_MS - 10_000);
    expect(effective).toBeLessThanOrEqual(MIN_RUN_TIMEOUT_MS + 10_000);
  });
});
