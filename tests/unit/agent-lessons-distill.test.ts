import { expect, test } from "bun:test";
import { renderLesson, surfacedLessons } from "../../src/core/agent-lessons/distill.ts";
import type { AgentLessonsIndex } from "../../src/schemas/agent-lessons.ts";

function entry(id: string, rule: string, occ: Array<{ s: string; f: string; ts: string }>) {
  return {
    id,
    key: id,
    category: "correctness" as const,
    rule_id: rule,
    occurrences: occ.map((o, i) => ({
      run_id: `${o.s}:0:${i}`,
      session_id: o.s,
      signature: `${id}-${i}`,
      file: o.f,
      ts: o.ts,
    })),
    exemplar_message: `msg-${rule}`,
    // biome-ignore lint/style/noNonNullAssertion: test helper asserts presence
    first_seen_at: occ[0]!.ts,
    // biome-ignore lint/style/noNonNullAssertion: test helper asserts presence
    last_seen_at: occ[occ.length - 1]!.ts,
  };
}
const idx: AgentLessonsIndex = {
  schema: "reviewgate.agentlessons.v1",
  entries: [
    entry("AL-001", "rule-a", [
      { s: "s1", f: "a.ts", ts: "2026-07-01T00:00:00.000Z" },
      { s: "s2", f: "b.ts", ts: "2026-07-02T00:00:00.000Z" },
      { s: "s2", f: "a.ts", ts: "2026-07-03T00:00:00.000Z" },
    ]),
    entry("AL-002", "rule-b", [{ s: "s1", f: "c.ts", ts: "2026-07-01T00:00:00.000Z" }]),
  ],
};

test("surfaces only entries at or above minRecurrence, ranked by count", () => {
  const s = surfacedLessons(idx, 3);
  expect(s).toHaveLength(1);
  // biome-ignore lint/style/noNonNullAssertion: test asserts presence
  expect(s[0]!.entry.id).toBe("AL-001");
  // biome-ignore lint/style/noNonNullAssertion: test asserts presence
  expect(s[0]!.count).toBe(3);
  // biome-ignore lint/style/noNonNullAssertion: test asserts presence
  expect(s[0]!.sessions).toBe(2);
  // biome-ignore lint/style/noNonNullAssertion: test asserts presence
  expect(s[0]!.files).toBe(2);
});

test("renderLesson is a deterministic imperative one-liner", () => {
  // biome-ignore lint/style/noNonNullAssertion: test asserts presence
  const s = surfacedLessons(idx, 3)[0]!;
  expect(renderLesson(s)).toBe(
    '- [correctness] rule "rule-a" - caught 3x in this repo (2 files, 2 sessions). Last: "msg-rule-a". Check for this before ending your turn.',
  );
});
