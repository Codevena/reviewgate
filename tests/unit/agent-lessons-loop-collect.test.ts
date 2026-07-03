// tests/unit/agent-lessons-loop-collect.test.ts
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AuditLogger } from "../../src/audit/logger.ts";
import { defineConfig } from "../../src/config/define-config.ts";
import { AgentLessonsStore } from "../../src/core/agent-lessons/store.ts";
import { LoopDriver } from "../../src/core/loop-driver.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import { StateStore } from "../../src/core/state-store.ts";
import { CodexAdapter } from "../../src/providers/codex.ts";
import { auditDir, decisionsPath, dirtyFlagPath, pendingJsonPath } from "../../src/utils/paths.ts";

const FAKE_CODEX = join(process.cwd(), "tests/fixtures/fake-codex.sh");
const DOC_DIFF =
  "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-a\n+b\n";

function seedAcceptedFixed(repo: string): void {
  writeFileSync(join(repo, "foo.ts"), "x");
  writeFileSync(
    dirtyFlagPath(repo),
    JSON.stringify({ diff_hash: "h", ts: new Date().toISOString() }),
  );
  writeFileSync(
    pendingJsonPath(repo),
    JSON.stringify({
      findings: [
        {
          id: "F-001",
          signature: "sig-al",
          severity: "WARN",
          category: "correctness",
          rule_id: "rule-al",
          file: "a.ts",
          line_start: 1,
          line_end: 1,
          message: "fix it",
          details: "d",
          reviewer: { provider: "codex", model: "x", persona: "security" },
          confidence: 0.5,
          consensus: "singleton",
        },
      ],
    }),
  );
  const dp = decisionsPath(repo, 1);
  mkdirSync(dirname(dp), { recursive: true });
  writeFileSync(
    dp,
    `${JSON.stringify({ schema: "reviewgate.decision.v1", finding_id: "F-001", verdict: "accepted", action: "fixed" })}\n`,
  );
}

function makeDriver(
  repo: string,
  config: ReturnType<typeof defineConfig>,
  state: StateStore,
  audit: AuditLogger,
) {
  return new LoopDriver({
    repoRoot: repo,
    config,
    state,
    audit,
    orchestrator: new Orchestrator({
      repoRoot: repo,
      config,
      adapters: { codex: new CodexAdapter({ binPath: FAKE_CODEX }) },
      sandboxMode: "off",
      hostTier: "opus",
      diff: DOC_DIFF,
      reasonOnFailEnabled: true,
    }),
    stopHookActive: true,
    freshHeadSha: async () => null,
  });
}

test("run() collects an accepted+fixed lesson when phases.agentLessons is enabled", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rg-al-loop-on-"));
  const state = new StateStore(repo);
  await state.initialise("01HXQAL1");
  await state.update((cur) => ({ ...cur, iteration: 1 }));
  seedAcceptedFixed(repo);
  // `phases.agentLessons` is a `.nullable().default(null).optional()` schema, so its
  // inferred type is `{...} | null | undefined` — DeepPartial can't distribute over that
  // union, so a partial override needs the same `as never` escape hatch already used in
  // tests/unit/agent-lessons-schema.test.ts for this exact field.
  const config = defineConfig({ phases: { agentLessons: { enabled: true } } as never });
  await makeDriver(repo, config, state, new AuditLogger(auditDir(repo))).run();
  const idx = await new AgentLessonsStore(repo).snapshot();
  expect(idx.entries).toHaveLength(1);
  // rule_id is stored NORMALIZED (normalizeRuleId sorts tokens alphabetically):
  // "rule-al" -> tokens ["rule","al"] -> sorted ["al","rule"] -> "al-rule".
  // biome-ignore lint/style/noNonNullAssertion: test asserts presence
  expect(idx.entries[0]!.rule_id).toBe("al-rule");
});

test("run() collects NOTHING when phases.agentLessons is off (default config)", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rg-al-loop-off-"));
  const state = new StateStore(repo);
  await state.initialise("01HXQAL2");
  await state.update((cur) => ({ ...cur, iteration: 1 }));
  seedAcceptedFixed(repo);
  await makeDriver(repo, defineConfig({}), state, new AuditLogger(auditDir(repo))).run();
  const idx = await new AgentLessonsStore(repo).snapshot();
  expect(idx.entries).toHaveLength(0);
});
