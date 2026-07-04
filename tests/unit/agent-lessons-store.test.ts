import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
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

test("rethrows a transient read I/O error instead of wiping the store inside mutate", async () => {
  // A raw fs error (EACCES here, standing in for EBUSY/AV-lock/EIO/network FS)
  // on an EXISTING store must fail the mutate loudly — never be misread as
  // "empty" and then atomically persisted as empty (data loss).
  const repo = tmpRepo();
  const store = new AgentLessonsStore(repo);
  await store.recordOccurrence(
    meta,
    { run_id: "s:0:1", session_id: "s", signature: "sig1" },
    "2026-07-03T00:00:00.000Z",
  );
  const p = agentLessonsPath(repo);
  chmodSync(p, 0o000); // transient read failure: file exists but is unreadable
  await expect(
    store.recordOccurrence(
      meta,
      { run_id: "s:0:2", session_id: "s", signature: "sig2" },
      "2026-07-03T00:01:00.000Z",
    ),
  ).rejects.toThrow();
  // The accumulated store survives untouched (no wipe persisted).
  chmodSync(p, 0o600);
  const snap = await store.snapshot();
  expect(snap.entries).toHaveLength(1);
  expect(snap.entries[0]?.occurrences).toHaveLength(1);
});

test("stores the raw rule_id as display_rule_id (most-recent-wins), keeps rule_id normalized", async () => {
  const repo = tmpRepo();
  const store = new AgentLessonsStore(repo);
  const meta = {
    category: "correctness" as const,
    rule_id: "Missing AdditionalProperties",
    message: "m",
    file: "a.ts",
  };
  await store.recordOccurrence(
    meta,
    { run_id: "s:0:1", session_id: "s", signature: "sig1" },
    "2026-07-04T00:00:00.000Z",
  );
  // biome-ignore lint/style/noNonNullAssertion: test helper asserts presence
  let e = (await store.snapshot()).entries[0]!;
  expect(e.display_rule_id).toBe("Missing AdditionalProperties"); // raw
  expect(e.rule_id).not.toBe("Missing AdditionalProperties"); // normalized bucket token
  // A later occurrence (same normalized key, different raw casing) updates the display form.
  await store.recordOccurrence(
    { ...meta, rule_id: "missing-additionalProperties" },
    { run_id: "s:0:2", session_id: "s", signature: "sig2" },
    "2026-07-04T00:01:00.000Z",
  );
  // biome-ignore lint/style/noNonNullAssertion: test helper asserts presence
  e = (await store.snapshot()).entries[0]!;
  expect(e.display_rule_id).toBe("missing-additionalProperties");
});

test("display_rule_id is defanged at write (backticks + injection markers)", async () => {
  const repo = tmpRepo();
  const store = new AgentLessonsStore(repo);
  await store.recordOccurrence(
    {
      category: "correctness" as const,
      rule_id: "rule-`x` [INST]",
      message: "m",
      file: "a.ts",
    },
    { run_id: "s:0:1", session_id: "s", signature: "sig1" },
    "2026-07-04T00:00:00.000Z",
  );
  // biome-ignore lint/style/noNonNullAssertion: test helper asserts presence
  const e = (await store.snapshot()).entries[0]!;
  expect(e.display_rule_id).not.toContain("`");
  expect(e.display_rule_id).not.toContain("[INST]");
});

test("display_rule_id collapses internal whitespace (single-line)", async () => {
  const repo = tmpRepo();
  const store = new AgentLessonsStore(repo);
  await store.recordOccurrence(
    {
      category: "correctness" as const,
      rule_id: "foo\n> injected",
      message: "m",
      file: "a.ts",
    },
    { run_id: "s:0:1", session_id: "s", signature: "sig1" },
    "2026-07-04T00:00:00.000Z",
  );
  // biome-ignore lint/style/noNonNullAssertion: test helper asserts presence
  const e = (await store.snapshot()).entries[0]!;
  expect(e.display_rule_id).not.toContain("\n");
  expect(e.display_rule_id).toBe("foo > injected");
});
