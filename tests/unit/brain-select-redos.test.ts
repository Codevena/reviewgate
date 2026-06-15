// tests/unit/brain-select-redos.test.ts
//
// Finding 1: file_globs are attacker-influenceable (they come from reviewer-
// proposed brain entries) and are fed to minimatch AS THE PATTERN. minimatch
// compiles a pattern into a RegExp that can backtrack catastrophically on
// crafted inputs, hanging the synchronous main review path. selectBrainEntries
// must bound the glob length / count and skip pathological patterns so the hot
// path always returns quickly.
import { describe, expect, it } from "bun:test";
import { selectBrainEntries } from "../../src/core/brain/select.ts";
import type { BrainEntry } from "../../src/schemas/brain.ts";

const base: Omit<BrainEntry, "id" | "type" | "title" | "body" | "tags" | "file_globs"> = {
  scope: "this-repo",
  status: "active",
  referenced_count: 1,
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

describe("selectBrainEntries — ReDoS / CPU-DoS bound on attacker globs", () => {
  it("returns quickly on a pathological glob pattern (no catastrophic backtracking)", () => {
    // A long run of stars + extglob groups is the classic catastrophic-backtracking
    // shape. Against a long non-matching file this can hang minimatch for seconds.
    // The bound must skip the pattern and return promptly.
    const evil = `${"*".repeat(60)}${"+(a)".repeat(40)}.ts`;
    const longFile = `${"a".repeat(2000)}.bin`;
    const entries = [mk({ id: "B-evil", file_globs: [evil] })];

    const start = performance.now();
    const sel = selectBrainEntries(entries, {
      tags: [],
      changedFiles: [longFile],
      categories: [],
      maxTokens: 9999,
    });
    const elapsedMs = performance.now() - start;

    // Pathological pattern is skipped → no match, and it returns fast.
    expect(sel).toEqual([]);
    expect(elapsedMs).toBeLessThan(500);
  });

  it("rejects an over-length glob (cap) so it can never reach minimatch", () => {
    const entries = [mk({ id: "B-long", file_globs: [`${"a/".repeat(300)}*.ts`] })];
    const sel = selectBrainEntries(entries, {
      tags: [],
      changedFiles: ["src/x.ts"],
      categories: [],
      maxTokens: 9999,
    });
    expect(sel).toEqual([]); // over-length glob skipped, not matched
  });

  it("bounds the number of globs evaluated per entry", () => {
    // Hundreds of (individually cheap) globs on one entry must not dominate; only
    // the first MAX_GLOBS_PER_ENTRY are considered. A real matching glob placed
    // PAST the cap is intentionally not evaluated.
    const globs = Array.from({ length: 500 }, () => "nomatch/*.ts");
    globs.push("src/cart.ts"); // index 500, past the 64 cap → ignored
    const entries = [mk({ id: "B-many", file_globs: globs })];
    const start = performance.now();
    const sel = selectBrainEntries(entries, {
      tags: [],
      changedFiles: ["src/cart.ts"],
      categories: [],
      maxTokens: 9999,
    });
    const elapsedMs = performance.now() - start;
    expect(sel).toEqual([]); // matching glob is past the cap
    expect(elapsedMs).toBeLessThan(500);
  });

  it("still matches a normal, safe glob", () => {
    const entries = [mk({ id: "B-ok", file_globs: ["src/**/*.ts"] })];
    const sel = selectBrainEntries(entries, {
      tags: [],
      changedFiles: ["src/cart/index.ts"],
      categories: [],
      maxTokens: 9999,
    });
    expect(sel.map((e) => e.id)).toEqual(["B-ok"]);
  });
});
