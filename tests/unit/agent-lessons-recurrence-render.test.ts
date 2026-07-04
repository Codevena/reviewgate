import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../src/config/defaults.ts";
import { AgentLessonsStore } from "../../src/core/agent-lessons/store.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import type { ProviderAdapter } from "../../src/providers/adapter-base.ts";
import type { Finding } from "../../src/schemas/finding.ts";
import { pendingMdPath } from "../../src/utils/paths.ts";

const DIFF =
  "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-const a = 0;\n+const a = 1;\n";

// A stub reviewer that raises ONE finding whose (category, rule_id) will match the seeded lesson.
function stubWithFinding(): ProviderAdapter {
  const f: Finding = {
    id: "F-001",
    signature: "sig-x",
    severity: "WARN",
    category: "correctness",
    rule_id: "rule-a",
    file: "src/a.ts",
    line_start: 1,
    line_end: 1,
    message: "fix it",
    details: "d",
    reviewer: { provider: "codex", model: "m", persona: "security" },
    confidence: 0.9,
    consensus: "singleton",
  };
  return {
    id: "codex",
    async preflight() {
      return { available: true, version: "x", authMode: "oauth" as const, error: null };
    },
    async review(inp: { reviewerId: string }) {
      return {
        reviewerId: inp.reviewerId,
        verdict: "FAIL" as const,
        findings: [f],
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
        durationMs: 1,
        exitCode: 0,
        rawEventsPath: "",
        rawText: "",
        status: "ok" as const,
      };
    },
  };
}

function cfg(enabled: boolean) {
  return {
    ...defaultConfig,
    phases: {
      ...defaultConfig.phases,
      review: {
        ...defaultConfig.phases.review,
        reviewers: [{ provider: "codex" as const, persona: "security" }],
      },
      critic: null,
      triage: null,
      ...(enabled
        ? {
            agentLessons: {
              enabled: true,
              minRecurrence: 3,
              topK: 5,
              maxInjectChars: 1500,
              ttlDays: 90,
            },
          }
        : {}),
    },
  } as never;
}

async function seedLesson(repo: string): Promise<void> {
  const store = new AgentLessonsStore(repo);
  for (let i = 0; i < 3; i++)
    await store.recordOccurrence(
      { category: "correctness", rule_id: "rule-a", message: "add it", file: `f${i}.ts` },
      { run_id: `s:0:${i}`, session_id: "s", signature: `sig${i}` },
      "2026-07-04T00:00:00.000Z",
    );
}

function orch(repo: string, config: unknown) {
  return new Orchestrator({
    repoRoot: repo,
    config: config as never,
    adapters: { codex: stubWithFinding() },
    sandboxMode: "off",
    hostTier: "opus",
    diff: DIFF,
    reasonOnFailEnabled: true,
  });
}

test("pending.md carries the recurrence banner when a finding matches a surfaced lesson", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rg-al-recrender-"));
  await seedLesson(repo);
  await orch(repo, cfg(true)).runIteration({ runId: "01HXREC", iter: 1 });
  const md = readFileSync(pendingMdPath(repo), "utf8");
  expect(md).toContain("Recurring mistake");
  expect(md).toContain("caught 3x");
});

test("no banner when phases.agentLessons is off", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rg-al-recrender-off-"));
  await seedLesson(repo);
  await orch(repo, cfg(false)).runIteration({ runId: "01HXRECOFF", iter: 1 });
  const md = readFileSync(pendingMdPath(repo), "utf8");
  expect(md).not.toContain("Recurring mistake");
});
