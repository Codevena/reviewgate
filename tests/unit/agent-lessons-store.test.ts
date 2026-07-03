import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentLessonsStore } from "../../src/core/agent-lessons/store.ts";
import { agentLessonsPath, learningsDir } from "../../src/utils/paths.ts";

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "rg-al-store-"));
}
const meta = {
  category: "correctness" as const,
  rule_id: "missing-additionalproperties",
  message: "add it",
  file: "a.ts",
};

test("records an occurrence and creates AL-001", async () => {
  const repo = tmpRepo();
  const store = new AgentLessonsStore(repo);
  await store.recordOccurrence(
    meta,
    { run_id: "s:0:1", session_id: "s", signature: "sig1" },
    "2026-07-03T00:00:00.000Z",
  );
  const idx = await store.snapshot();
  expect(idx.entries).toHaveLength(1);
  expect(idx.entries[0]?.id).toBe("AL-001");
  expect(idx.entries[0]?.occurrences).toHaveLength(1);
});

test("is idempotent on (run_id, signature)", async () => {
  const repo = tmpRepo();
  const store = new AgentLessonsStore(repo);
  await store.recordOccurrence(
    meta,
    { run_id: "s:0:1", session_id: "s", signature: "sig1" },
    "2026-07-03T00:00:00.000Z",
  );
  await store.recordOccurrence(
    meta,
    { run_id: "s:0:1", session_id: "s", signature: "sig1" },
    "2026-07-03T00:01:00.000Z",
  );
  const idx = await store.snapshot();
  expect(idx.entries[0]?.occurrences).toHaveLength(1); // no double-count
});

test("distinct signatures under the same key accumulate", async () => {
  const repo = tmpRepo();
  const store = new AgentLessonsStore(repo);
  await store.recordOccurrence(
    meta,
    { run_id: "s:0:1", session_id: "s", signature: "sig1" },
    "2026-07-03T00:00:00.000Z",
  );
  await store.recordOccurrence(
    meta,
    { run_id: "s:0:2", session_id: "s", signature: "sig2" },
    "2026-07-03T00:00:00.000Z",
  );
  const idx = await store.snapshot();
  expect(idx.entries).toHaveLength(1);
  expect(idx.entries[0]?.occurrences).toHaveLength(2);
});

test("decayPass drops stale occurrences and empty entries", async () => {
  const repo = tmpRepo();
  const store = new AgentLessonsStore(repo);
  await store.recordOccurrence(
    meta,
    { run_id: "s:0:1", session_id: "s", signature: "sig1" },
    "2026-01-01T00:00:00.000Z",
  );
  await store.decayPass("2026-07-03T00:00:00.000Z", 90);
  const idx = await store.snapshot();
  expect(idx.entries).toHaveLength(0);
});

test("a corrupt store is backed up and recovers empty", async () => {
  const repo = tmpRepo();
  mkdirSync(learningsDir(repo), { recursive: true });
  writeFileSync(agentLessonsPath(repo), "{ not json");
  const store = new AgentLessonsStore(repo);
  const idx = await store.snapshot();
  expect(idx.entries).toHaveLength(0);
  expect(existsSync(agentLessonsPath(repo))).toBe(false); // renamed to .corrupt.*
});

test("a read-only snapshot does NOT back up a corrupt store", async () => {
  const repo = tmpRepo();
  mkdirSync(learningsDir(repo), { recursive: true });
  writeFileSync(agentLessonsPath(repo), "{ not json");
  const idx = await new AgentLessonsStore(repo).snapshot({ backupCorrupt: false });
  expect(idx.entries).toHaveLength(0);
  expect(existsSync(agentLessonsPath(repo))).toBe(true); // untouched — no rename (pure read)
});
