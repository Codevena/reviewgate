// tests/unit/brain-select.test.ts
import { describe, expect, it } from "bun:test";
import { selectBrainEntries } from "../../src/core/brain/select.ts";
import type { BrainEntry } from "../../src/schemas/brain.ts";

const base: Omit<BrainEntry, "id" | "type" | "title" | "body" | "tags" | "file_globs"> = {
  scope: "this-repo",
  status: "active",
  referenced_count: 3,
  referencing_reviewers: [],
  confidence: 0.9,
  embedding: null,
  evidence: [{ kind: "reviewer-finding", run_id: "r", reviewer_id: "codex" }],
  created_at: "2026-05-21T00:00:00Z",
  source_run_id: "r",
};
const mk = (o: Partial<BrainEntry>): BrainEntry =>
  ({
    ...base,
    id: "B",
    type: "convention",
    title: "t",
    body: "b",
    tags: [],
    file_globs: [],
    ...o,
  }) as BrainEntry;

describe("selectBrainEntries", () => {
  it("matches by tag, glob, or category and excludes stale/archived", () => {
    const entries = [
      mk({ id: "B-1", tags: ["auth"] }),
      mk({ id: "B-2", file_globs: ["src/cart.ts"] }),
      mk({ id: "B-3", type: "anti-pattern", tags: ["nope"] }),
      mk({ id: "B-4", tags: ["auth"], status: "stale" }),
    ];
    const sel = selectBrainEntries(entries, {
      tags: ["auth"],
      changedFiles: ["src/cart.ts"],
      categories: [],
      maxTokens: 9999,
    });
    expect(sel.map((e) => e.id).sort()).toEqual(["B-1", "B-2"]);
  });

  it("orders by priority (convention before anti-pattern) and respects the token budget", () => {
    const entries = [
      mk({ id: "B-ap", type: "anti-pattern", tags: ["t"], body: "x".repeat(40) }),
      mk({ id: "B-cv", type: "convention", tags: ["t"], body: "y".repeat(40) }),
    ];
    const sel = selectBrainEntries(entries, {
      tags: ["t"],
      changedFiles: [],
      categories: [],
      maxTokens: 20,
    });
    expect(sel[0]?.id).toBe("B-cv"); // convention first
    expect(sel.length).toBe(1); // budget cut the second
  });
});
