// tests/unit/brain-store.test.ts
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
