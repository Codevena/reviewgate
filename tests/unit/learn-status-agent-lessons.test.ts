// tests/unit/learn-status-agent-lessons.test.ts
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __test } from "../../src/cli/commands/learn-status.ts";
import { AgentLessonsStore } from "../../src/core/agent-lessons/store.ts";

test("learn-status report includes surfaced agent lessons", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rg-al-ls-"));
  const store = new AgentLessonsStore(repo);
  const meta = { category: "correctness" as const, rule_id: "rule-a", message: "m", file: "a.ts" };
  for (let i = 0; i < 3; i++)
    await store.recordOccurrence(
      { ...meta, file: `f${i}.ts` },
      { run_id: `s:0:${i}`, session_id: "s", signature: `sig${i}` },
      "2026-07-03T00:00:00.000Z",
    );
  const r = await __test.buildReport({ repoRoot: repo, now: "2026-07-03T12:00:00.000Z" });
  expect(r.agent_lessons.total_entries).toBe(1);
  // biome-ignore lint/style/noNonNullAssertion: test asserts presence
  expect(r.agent_lessons.surfaced[0]!.count).toBe(3);
  expect(__test.renderText(r)).toContain("Agent lessons");
});
