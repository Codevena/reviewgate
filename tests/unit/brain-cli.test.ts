// tests/unit/brain-cli.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBrainList, runBrainRevoke } from "../../src/cli/commands/brain.ts";
import { BrainStore } from "../../src/core/brain/store.ts";

describe("brain CLI", () => {
  it("lists entries and revokes one", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-cli-"));
    const store = new BrainStore(repo);
    await store.add({
      id: "B-001",
      type: "convention",
      scope: "this-repo",
      title: "t",
      body: "b",
      tags: [],
      file_globs: [],
      status: "active",
      referenced_count: 1,
      referencing_reviewers: [],
      confidence: 0.9,
      embedding: null,
      evidence: [{ kind: "reviewer-finding", run_id: "r", reviewer_id: "codex" }],
      created_at: "2026-05-21T00:00:00Z",
      source_run_id: "r",
    });
    const lines: string[] = [];
    expect(await runBrainList({ repoRoot: repo, write: (s) => lines.push(s) })).toBe(0);
    expect(lines.join("")).toContain("B-001");
    expect(await runBrainRevoke({ repoRoot: repo, id: "B-001", write: () => {} })).toBe(0);
    expect((await store.snapshot()).entries.length).toBe(0);
  });
});
