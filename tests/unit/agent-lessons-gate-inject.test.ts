// tests/unit/agent-lessons-gate-inject.test.ts
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGate } from "../../src/cli/commands/gate.ts";
import { defineConfig } from "../../src/config/define-config.ts";
import { AgentLessonsStore } from "../../src/core/agent-lessons/store.ts";

async function seedThrice(repo: string): Promise<void> {
  const store = new AgentLessonsStore(repo);
  const meta = {
    category: "correctness" as const,
    rule_id: "rule-a",
    message: "add it",
    file: "a.ts",
  };
  for (let i = 0; i < 3; i++)
    await store.recordOccurrence(
      { ...meta, file: `f${i}.ts` },
      { run_id: `s:0:${i}`, session_id: "s", signature: `sig${i}` },
      "2026-07-03T00:00:00.000Z",
    );
}

// Real, fully-resolved configs (no partial cast) so cfg.audit.retentionDays and every
// other field the reset branch touches are present — the enabled one via defineConfig,
// the off one via the default (agentLessons === null).
const enabledCfg = async () =>
  defineConfig({ phases: { agentLessons: { enabled: true } } as never });
const offCfg = async () => defineConfig({}); // fully resolved, agentLessons === null (off)

test("reset hook injects lessons on startup when enabled", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rg-al-gate-"));
  await seedThrice(repo);
  const res = await runGate({
    repoRoot: repo,
    hook: "reset",
    hookStdinRaw: JSON.stringify({ source: "startup", session_id: "s" }),
    loadConfigFn: enabledCfg,
  });
  expect(res.exitCode).toBe(0);
  expect(JSON.parse(res.stdout).hookSpecificOutput.hookEventName).toBe("SessionStart");
});

test("reset hook stays silent on clear/compact even when enabled", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rg-al-gate-clear-"));
  await seedThrice(repo);
  for (const source of ["clear", "compact"]) {
    const res = await runGate({
      repoRoot: repo,
      hook: "reset",
      hookStdinRaw: JSON.stringify({ source, session_id: "s" }),
      loadConfigFn: enabledCfg,
    });
    expect(res.stdout).toBe("");
  }
});

test("reset hook stays silent when agentLessons is off (default)", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rg-al-gate-off-"));
  await seedThrice(repo);
  const res = await runGate({
    repoRoot: repo,
    hook: "reset",
    hookStdinRaw: JSON.stringify({ source: "startup", session_id: "s" }),
    loadConfigFn: offCfg,
  });
  expect(res.stdout).toBe("");
});
