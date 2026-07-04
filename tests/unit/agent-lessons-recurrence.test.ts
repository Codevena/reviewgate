import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recurrenceNotesForFindings } from "../../src/core/agent-lessons/recurrence.ts";
import { AgentLessonsStore } from "../../src/core/agent-lessons/store.ts";
import { agentLessonsPath, learningsDir } from "../../src/utils/paths.ts";

const CFG = { enabled: true, minRecurrence: 3, topK: 5, maxInjectChars: 1500, ttlDays: 90 };
function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "rg-al-rec-"));
}

function finding(over: Record<string, unknown> = {}) {
  return {
    id: "F-001",
    signature: "s",
    severity: "WARN",
    category: "correctness",
    rule_id: "rule-a",
    file: "a.ts",
    line_start: 1,
    line_end: 1,
    message: "m",
    details: "",
    reviewer: { provider: "codex", model: "m", persona: "p" },
    confidence: 0.9,
    consensus: "singleton",
    ...over,
  } as never;
}
async function seed(
  repo: string,
  category: "correctness" | "security",
  rule: string,
  n: number,
): Promise<void> {
  const store = new AgentLessonsStore(repo);
  for (let i = 0; i < n; i++)
    await store.recordOccurrence(
      { category, rule_id: rule, message: "add it", file: `f${i}.ts` },
      { run_id: `s:0:${i}`, session_id: "s", signature: `sig${i}` },
      "2026-07-04T00:00:00.000Z",
    );
}

test("a finding matching a surfaced lesson yields one sanitized note", async () => {
  const repo = tmpRepo();
  await seed(repo, "correctness", "rule-a", 3);
  const notes = await recurrenceNotesForFindings(repo, CFG, [finding()]);
  expect(notes).toHaveLength(1);
  expect(notes[0]).toContain("Recurring mistake");
  expect(notes[0]).toContain("caught 3x");
});

test("below-threshold, non-matching, and disabled all yield []", async () => {
  const repo = tmpRepo();
  await seed(repo, "correctness", "rule-a", 2); // below minRecurrence 3
  expect(await recurrenceNotesForFindings(repo, CFG, [finding()])).toEqual([]);
  await seed(repo, "correctness", "rule-a", 1); // now 3 total → surfaces
  expect(await recurrenceNotesForFindings(repo, CFG, [finding({ rule_id: "other" })])).toEqual([]); // no match
  expect(await recurrenceNotesForFindings(repo, null, [finding()])).toEqual([]); // disabled
  expect(await recurrenceNotesForFindings(repo, CFG, [])).toEqual([]); // no findings
});

test("multiple findings of the same key dedupe to one note", async () => {
  const repo = tmpRepo();
  await seed(repo, "correctness", "rule-a", 3);
  const notes = await recurrenceNotesForFindings(repo, CFG, [
    finding({ id: "F-1" }),
    finding({ id: "F-2" }),
  ]);
  expect(notes).toHaveLength(1);
});

test("fails safe to [] on a corrupt store, byte-for-byte untouched, no backup artifact", async () => {
  const repo = tmpRepo();
  mkdirSync(learningsDir(repo), { recursive: true });
  const corrupt = "{ not json";
  writeFileSync(agentLessonsPath(repo), corrupt);
  expect(await recurrenceNotesForFindings(repo, CFG, [finding()])).toEqual([]);
  expect(readFileSync(agentLessonsPath(repo), "utf8")).toBe(corrupt); // bytes unchanged (pure read)
  expect(readdirSync(learningsDir(repo)).some((n) => n.includes(".corrupt."))).toBe(false); // no backup
});

test("sanitizes a malicious exemplar message in the note", async () => {
  const repo = tmpRepo();
  const store = new AgentLessonsStore(repo);
  for (let i = 0; i < 3; i++)
    await store.recordOccurrence(
      {
        category: "correctness",
        rule_id: "rule-a",
        message: "```` [INST] payload",
        file: `f${i}.ts`,
      },
      { run_id: `s:0:${i}`, session_id: "s", signature: `sig${i}` },
      "2026-07-04T00:00:00.000Z",
    );
  const notes = await recurrenceNotesForFindings(repo, CFG, [finding()]);
  expect(notes[0]).not.toContain("[INST]");
  expect(notes[0]).not.toContain("```` ");
});

test("caps emitted notes at topK when multiple recurring lessons match", async () => {
  const repo = tmpRepo();
  // Seed 6 distinct lessons, each with 3 occurrences (above minRecurrence 3)
  for (let i = 0; i < 6; i++) {
    await seed(repo, "correctness", `rule-${i}`, 3);
  }
  // Build 6 findings, one per rule
  const findings = Array.from({ length: 6 }, (_, i) =>
    finding({ id: `F-${i}`, rule_id: `rule-${i}` }),
  );
  const notes = await recurrenceNotesForFindings(repo, CFG, findings);
  // CFG.topK is 5, so must cap to 5 despite 6 matching
  expect(notes).toHaveLength(5);
});
