// tests/unit/brain-store.test.ts
import { describe, expect, it } from "bun:test";
import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BrainStore } from "../../src/core/brain/store.ts";
import type { BrainEntry } from "../../src/schemas/brain.ts";
import { brainJsonPath, brainMdPath } from "../../src/utils/paths.ts";

function entry(over: Partial<BrainEntry> = {}): BrainEntry {
  return {
    id: "B-001",
    type: "convention",
    scope: "this-repo",
    title: "t",
    body: "b",
    tags: ["x"],
    file_globs: ["src/*.ts"],
    status: "candidate",
    referenced_count: 1,
    referencing_reviewers: [],
    confidence: 0.9,
    embedding: null,
    evidence: [{ kind: "reviewer-finding", run_id: "r1", reviewer_id: "codex" }],
    created_at: "2026-05-21T00:00:00Z",
    source_run_id: "r1",
    ...over,
  };
}

describe("BrainStore", () => {
  it("starts empty, adds an entry atomically, and renders brain.md", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-brain-"));
    const store = new BrainStore(repo);
    expect((await store.snapshot()).entries).toEqual([]);
    await store.add(entry());
    const snap = await store.snapshot();
    expect(snap.entries.map((e) => e.id)).toEqual(["B-001"]);
    expect(existsSync(brainJsonPath(repo))).toBe(true);
    expect(readFileSync(brainMdPath(repo), "utf8")).toContain("B-001");
  });

  it("revoke removes an entry and snapshot() is immutable across mutations", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-brain2-"));
    const store = new BrainStore(repo);
    await store.add(entry({ id: "B-001" }));
    const pinned = await store.snapshot();
    await store.add(entry({ id: "B-002" }));
    expect(pinned.entries.map((e) => e.id)).toEqual(["B-001"]); // pinned snapshot unchanged
    expect(await store.revoke("B-001")).toBe(true);
    expect((await store.snapshot()).entries.map((e) => e.id)).toEqual(["B-002"]);
  });

  it("nextId increments based on existing entries", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-brain3-"));
    const store = new BrainStore(repo);
    await store.add(entry({ id: await store.nextId() }));
    expect(await store.nextId()).toBe("B-002");
  });

  it("rethrows a transient read I/O error instead of wiping brain.json inside mutate (F-22)", async () => {
    // A raw fs error (EACCES, standing in for EBUSY/AV-lock/EIO) on an EXISTING
    // brain.json must fail the mutate loudly — never be misread as "empty" and
    // then atomically persisted as an empty index (data loss).
    const repo = mkdtempSync(join(tmpdir(), "rg-brain-io-"));
    const store = new BrainStore(repo);
    await store.add(entry({ id: "B-001" }));
    const p = brainJsonPath(repo);
    chmodSync(p, 0o000); // transient read failure: file exists but is unreadable
    await expect(store.add(entry({ id: "B-002" }))).rejects.toThrow();
    chmodSync(p, 0o600);
    expect((await store.snapshot()).entries.map((e) => e.id)).toEqual(["B-001"]); // no wipe
  });

  it("recovers from genuine content corruption with a .corrupt backup (F-22)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-brain-corrupt-"));
    const p = brainJsonPath(repo);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "{not json");
    const store = new BrainStore(repo);
    expect((await store.snapshot()).entries).toHaveLength(0);
    expect(readdirSync(dirname(p)).some((f) => f.includes(".corrupt."))).toBe(true);
    // Usable again after recovery.
    await store.add(entry());
    expect((await store.snapshot()).entries).toHaveLength(1);
  });
});
