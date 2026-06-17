// tests/unit/loop-driver-preliminary-pass.test.ts
// #3-timing (field report 2026-06-17): a SHALLOW pass (triage-skip / cache / fewer reviewers
// than configured) must be labelled PRELIMINARY at the allow_stop boundary so the agent does
// not confirm "clean" and push to a push-to-deploy main on a thin review. A full-coverage
// pass — including the SUPPORTED single-reviewer config — must NOT be mislabelled.
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLogger } from "../../src/audit/logger.ts";
import { defaultConfig } from "../../src/config/defaults.ts";
import type { ReviewgateConfig } from "../../src/config/define-config.ts";
import { LoopDriver } from "../../src/core/loop-driver.ts";
import type { IterationResult } from "../../src/core/orchestrator.ts";
import { StateStore } from "../../src/core/state-store.ts";
import type { ProviderStat, RunSummary } from "../../src/schemas/audit-event.ts";
import { auditDir, dirtyFlagPath } from "../../src/utils/paths.ts";

function fakeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-prelim-"));
  writeFileSync(join(dir, "foo.ts"), "x");
  return dir;
}
function writeDirty(repo: string): void {
  writeFileSync(
    dirtyFlagPath(repo),
    JSON.stringify({ diff_hash: "h", ts: new Date().toISOString() }),
  );
}
function stat(provider: ProviderStat["provider"], runs: number, errors: number): ProviderStat {
  return {
    provider,
    personas: ["security"],
    runs,
    errors,
    findings: 0,
    demoted: 0,
    cost_usd: 0,
    duration_ms: 1,
  };
}
function passSummary(over: Partial<RunSummary>): RunSummary {
  return {
    verdict: "PASS",
    source: "panel",
    counts: { critical: 0, warn: 0, info: 0 },
    cost_usd: 0,
    duration_ms: 1,
    demoted: 0,
    signatures: [],
    providers: [stat("codex", 1, 0)],
    ...over,
  };
}
const passStub = (summary: RunSummary) => ({
  runIteration: async (): Promise<IterationResult> => ({
    verdict: "PASS" as const,
    costUsd: 0,
    durationMs: 1,
    signaturesThisIter: [],
    summary,
  }),
});

async function run(config: ReviewgateConfig, summary: RunSummary): Promise<string> {
  const repo = fakeRepo();
  const state = new StateStore(repo);
  await state.initialise("01HXPRELIM");
  writeDirty(repo);
  const decision = await new LoopDriver({
    repoRoot: repo,
    config,
    state,
    audit: new AuditLogger(auditDir(repo)),
    orchestrator: passStub(summary),
    stopHookActive: false,
  }).run();
  return decision.reason;
}

const twoReviewerConfig: ReviewgateConfig = {
  ...defaultConfig,
  phases: {
    ...defaultConfig.phases,
    review: {
      ...defaultConfig.phases.review,
      reviewers: [
        { provider: "codex" as const, persona: "security", fallback: [] },
        { provider: "gemini" as const, persona: "architecture", fallback: [] },
      ],
    },
  },
};

describe("LoopDriver — preliminary-pass label (#3-timing)", () => {
  it("labels a triage-skipped PASS as PRELIMINARY", async () => {
    const reason = await run(defaultConfig, passSummary({ source: "skipped", providers: [] }));
    expect(reason).toContain("PRELIMINARY");
    expect(reason).toContain("triage-skipped");
  });

  it("labels a cache-served PASS as PRELIMINARY", async () => {
    const reason = await run(defaultConfig, passSummary({ source: "cache", providers: [] }));
    expect(reason).toContain("PRELIMINARY");
  });

  it("labels a PASS with fewer ok reviewers than configured as PRELIMINARY", async () => {
    // 2 configured, only codex completed ok → 1 of 2.
    const reason = await run(twoReviewerConfig, passSummary({ providers: [stat("codex", 1, 0)] }));
    expect(reason).toContain("PRELIMINARY");
    expect(reason).toContain("1 of 2 configured reviewers");
  });

  it("does NOT label a full-coverage single-reviewer PASS (supported config)", async () => {
    const reason = await run(defaultConfig, passSummary({ providers: [stat("codex", 1, 0)] }));
    expect(reason).not.toContain("PRELIMINARY");
    expect(reason).toContain("Clear to finish");
  });
});
