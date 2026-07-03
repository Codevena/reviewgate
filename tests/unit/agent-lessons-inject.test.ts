import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSessionStartInjection } from "../../src/core/agent-lessons/inject.ts";
import { AgentLessonsStore } from "../../src/core/agent-lessons/store.ts";
import { agentLessonsPath, learningsDir } from "../../src/utils/paths.ts";

const CFG = { enabled: true, minRecurrence: 3, topK: 5, maxInjectChars: 1500, ttlDays: 90 };
function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "rg-al-inject-"));
}

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

test("emits hookSpecificOutput JSON on startup", async () => {
  const repo = tmpRepo();
  await seedThrice(repo);
  const out = await buildSessionStartInjection({ repoRoot: repo, cfg: CFG, source: "startup" });
  const parsed = JSON.parse(out);
  expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
  expect(parsed.hookSpecificOutput.additionalContext).toContain('rule "rule"');
});

test("emits nothing on clear/compact, when disabled, or below threshold", async () => {
  const repo = tmpRepo();
  await seedThrice(repo);
  expect(await buildSessionStartInjection({ repoRoot: repo, cfg: CFG, source: "clear" })).toBe("");
  expect(await buildSessionStartInjection({ repoRoot: repo, cfg: CFG, source: "compact" })).toBe(
    "",
  );
  expect(await buildSessionStartInjection({ repoRoot: repo, cfg: null, source: "startup" })).toBe(
    "",
  );
  expect(
    await buildSessionStartInjection({
      repoRoot: repo,
      cfg: { ...CFG, minRecurrence: 99 },
      source: "startup",
    }),
  ).toBe("");
});

test("fails safe to '' on a corrupt store, and does not mutate it", async () => {
  const repo = tmpRepo();
  mkdirSync(learningsDir(repo), { recursive: true });
  writeFileSync(agentLessonsPath(repo), "{ not json");
  expect(await buildSessionStartInjection({ repoRoot: repo, cfg: CFG, source: "startup" })).toBe(
    "",
  );
  expect(existsSync(agentLessonsPath(repo))).toBe(true); // pure read — corrupt file untouched
});

test("respects maxInjectChars (never exceeds the cap)", async () => {
  const repo = tmpRepo();
  const store = new AgentLessonsStore(repo);

  // Seed lesson A: 4 occurrences (higher rank) — category "correctness", rule_id "rule-a"
  for (let i = 0; i < 4; i++) {
    await store.recordOccurrence(
      {
        category: "correctness" as const,
        rule_id: "rule-a",
        message: "add it",
        file: `fa${i}.ts`,
      },
      { run_id: `s:0:a${i}`, session_id: "s", signature: `sia${i}` },
      "2026-07-03T00:00:00.000Z",
    );
  }

  // Seed lesson B: 3 occurrences (lower rank) — category "security", rule_id "rule-b"
  for (let i = 0; i < 3; i++) {
    await store.recordOccurrence(
      {
        category: "security" as const,
        rule_id: "rule-b",
        message: "fix it",
        file: `fb${i}.ts`,
      },
      { run_id: `s:0:b${i}`, session_id: "s", signature: `sib${i}` },
      "2026-07-03T00:00:00.000Z",
    );
  }

  // Set maxInjectChars=344: header + both lessons = 345 chars, so one line is trimmed.
  // Expected: output is non-empty, contains high-ranked lesson A (correctness),
  // does not contain low-ranked lesson B (security).
  const out = await buildSessionStartInjection({
    repoRoot: repo,
    cfg: { ...CFG, maxInjectChars: 344 },
    source: "startup",
  });
  expect(out).not.toBe("");
  const ctx = JSON.parse(out).hookSpecificOutput.additionalContext as string;
  expect(ctx.length).toBeLessThanOrEqual(344);
  expect(ctx).toContain("[correctness]");
  expect(ctx).not.toContain("[security]");
});
