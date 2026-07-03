import { expect, test } from "bun:test";
import { defineConfig } from "../../src/config/define-config.ts";
import { normalizeRuleId } from "../../src/diff/signature.ts";
import {
  type AgentLessonsIndex,
  AgentLessonsIndexSchema,
} from "../../src/schemas/agent-lessons.ts";
import { agentLessonsLockPath, agentLessonsPath } from "../../src/utils/paths.ts";

test("agent-lessons index round-trips", () => {
  const idx: AgentLessonsIndex = {
    schema: "reviewgate.agentlessons.v1",
    seq: 1,
    entries: [
      {
        id: "AL-001",
        key: "abc",
        category: "correctness",
        rule_id: "missing-additionalproperties",
        occurrences: [
          {
            run_id: "s:0:1",
            session_id: "s",
            signature: "sig1",
            file: "a.ts",
            ts: "2026-07-03T00:00:00.000Z",
          },
        ],
        exemplar_message: "add additionalProperties:false",
        first_seen_at: "2026-07-03T00:00:00.000Z",
        last_seen_at: "2026-07-03T00:00:00.000Z",
      },
    ],
  };
  expect(AgentLessonsIndexSchema.parse(idx)).toEqual(idx);
});

test("paths live under learnings/", () => {
  expect(agentLessonsPath("/repo")).toBe("/repo/.reviewgate/learnings/agent-lessons.json");
  expect(agentLessonsLockPath("/repo")).toBe("/repo/.reviewgate/learnings/.agent-lessons.lock");
});

test("normalizeRuleId is exported and canonicalizes", () => {
  expect(normalizeRuleId("Missing AdditionalProperties")).toBe(
    normalizeRuleId("missing-additionalproperties"),
  );
});

test("phases.agentLessons defaults to null (off)", () => {
  const cfg = defineConfig({});
  expect(cfg.phases.agentLessons ?? null).toBeNull();
});

test("phases.agentLessons fills inner defaults when enabled", () => {
  const cfg = defineConfig({ phases: { agentLessons: { enabled: true } } as never });
  expect(cfg.phases.agentLessons).toMatchObject({
    enabled: true,
    minRecurrence: 3,
    topK: 5,
    maxInjectChars: 1500,
    ttlDays: 90,
  });
});
