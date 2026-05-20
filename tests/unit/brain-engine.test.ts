// tests/unit/brain-engine.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrainEngine } from "../../src/core/brain/engine.ts";
import { BrainStore } from "../../src/core/brain/store.ts";

describe("BrainEngine", () => {
  it("pins a snapshot and renders [Source: …]-annotated injection text", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-be-"));
    const store = new BrainStore(repo);
    await store.add({
      id: "B-001",
      type: "convention",
      scope: "this-repo",
      title: "cart null-guards",
      body: "Promise.all null-guard intentional.",
      tags: ["cart"],
      file_globs: ["src/cart.ts"],
      status: "active",
      referenced_count: 3,
      referencing_reviewers: [],
      confidence: 0.9,
      embedding: null,
      evidence: [{ kind: "reviewer-finding", run_id: "r", reviewer_id: "codex" }],
      created_at: "2026-05-21T00:00:00Z",
      source_run_id: "r",
    });
    const engine = new BrainEngine(store, { maxTokens: 1500 });
    await engine.pin(); // snapshot pinned at run start
    const text = engine.inject({ tags: ["cart"], changedFiles: ["src/cart.ts"], categories: [] });
    expect(text).toContain("cart null-guards");
    expect(text).toContain("[Source: B-001");
  });

  it("returns empty string when nothing matches", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-be2-"));
    const engine = new BrainEngine(new BrainStore(repo), { maxTokens: 1500 });
    await engine.pin();
    expect(engine.inject({ tags: ["none"], changedFiles: [], categories: [] })).toBe("");
  });
});
