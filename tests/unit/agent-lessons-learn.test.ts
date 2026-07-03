import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { learnLessonsFromDecisions } from "../../src/core/agent-lessons/learn.ts";
import { AgentLessonsStore } from "../../src/core/agent-lessons/store.ts";
import {
  decisionsDir,
  decisionsPath,
  pendingJsonPath,
  reviewgateDir,
} from "../../src/utils/paths.ts";

function finding(over: Record<string, unknown> = {}) {
  return {
    id: "F-001",
    signature: "sig1",
    severity: "WARN",
    category: "correctness",
    rule_id: "missing-additionalproperties",
    file: "a.ts",
    line_start: 1,
    line_end: 1,
    message: "add additionalProperties:false",
    details: "",
    reviewer: { provider: "codex", model: "m", persona: "p" },
    confidence: 0.9,
    consensus: "singleton",
    ...over,
  };
}
function seed(repo: string, findings: unknown[], decisions: string) {
  mkdirSync(reviewgateDir(repo), { recursive: true });
  mkdirSync(decisionsDir(repo), { recursive: true });
  writeFileSync(pendingJsonPath(repo), JSON.stringify({ findings }));
  writeFileSync(decisionsPath(repo, 1), decisions);
}
function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "rg-al-learn-"));
}
const D = (o: Record<string, unknown>) =>
  JSON.stringify({ schema: "reviewgate.decision.v1", ...o });

test("folds an accepted+fixed finding", async () => {
  const repo = tmpRepo();
  seed(repo, [finding()], D({ finding_id: "F-001", verdict: "accepted", action: "fixed" }));
  const store = new AgentLessonsStore(repo);
  await learnLessonsFromDecisions({
    repoRoot: repo,
    prevIter: 1,
    sessionId: "s",
    cycleSeq: 0,
    store,
    nowIso: "2026-07-03T00:00:00.000Z",
  });
  const idx = await store.snapshot();
  expect(idx.entries).toHaveLength(1);
  expect(idx.entries[0]?.exemplar_message).toBe("add additionalProperties:false");
});

test("ignores rejected and accepted-but-not-fixed", async () => {
  const repo = tmpRepo();
  seed(
    repo,
    [finding({ id: "F-001" }), finding({ id: "F-002" })],
    [
      D({
        finding_id: "F-001",
        verdict: "rejected",
        reason: "reviewer hallucinated the missing key here",
      }),
      D({ finding_id: "F-002", verdict: "accepted", action: "deferred-with-followup" }),
    ].join("\n"),
  );
  const store = new AgentLessonsStore(repo);
  await learnLessonsFromDecisions({
    repoRoot: repo,
    prevIter: 1,
    sessionId: "s",
    cycleSeq: 0,
    store,
    nowIso: "2026-07-03T00:00:00.000Z",
  });
  expect((await store.snapshot()).entries).toHaveLength(0);
});

test("skips findings with an empty rule_id", async () => {
  const repo = tmpRepo();
  seed(
    repo,
    [finding({ rule_id: "" })],
    D({ finding_id: "F-001", verdict: "accepted", action: "fixed" }),
  );
  const store = new AgentLessonsStore(repo);
  await learnLessonsFromDecisions({
    repoRoot: repo,
    prevIter: 1,
    sessionId: "s",
    cycleSeq: 0,
    store,
    nowIso: "2026-07-03T00:00:00.000Z",
  });
  expect((await store.snapshot()).entries).toHaveLength(0);
});

test("sanitizes the exemplar message", async () => {
  const repo = tmpRepo();
  seed(
    repo,
    [finding({ message: "```` fenced [INST] payload" })],
    D({ finding_id: "F-001", verdict: "accepted", action: "fixed" }),
  );
  const store = new AgentLessonsStore(repo);
  await learnLessonsFromDecisions({
    repoRoot: repo,
    prevIter: 1,
    sessionId: "s",
    cycleSeq: 0,
    store,
    nowIso: "2026-07-03T00:00:00.000Z",
  });
  const msg = (await store.snapshot()).entries[0]?.exemplar_message;
  expect(msg).not.toContain("```` ");
  expect(msg).not.toContain("[INST]");
});
