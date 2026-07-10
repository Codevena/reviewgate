// tests/unit/lore-verify.test.ts
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeVerifiedTree } from "../../src/core/lore/staleness.ts";
import { verifyLoreEntry } from "../../src/core/lore/verify.ts";

function loreEntryFile(
  id: string,
  opts: {
    status?: "draft" | "canon";
    anchors: string[];
    verifiedTree: string;
    verifiedAt?: string;
    body?: string;
  },
): string {
  return [
    "---",
    "schema: reviewgate.lore.v1",
    `id: ${id}`,
    `status: ${opts.status ?? "draft"}`,
    "anchors:",
    ...opts.anchors.map((a) => `  - ${a}`),
    `verified_at: ${opts.verifiedAt ?? "2020-01-01"}`,
    `verified_tree: "${opts.verifiedTree}"`,
    "tags: []",
    "---",
    opts.body ??
      "This is the body explaining WHY this anchor exists — well over forty chars total.",
    "",
  ].join("\n");
}

function writeLoreEntry(
  repo: string,
  id: string,
  opts: {
    status?: "draft" | "canon";
    anchors: string[];
    verifiedTree: string;
    verifiedAt?: string;
    body?: string;
  },
): string {
  const dir = join(repo, ".reviewgate", "lore");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.md`);
  writeFileSync(path, loreEntryFile(id, opts));
  return path;
}

describe("verifyLoreEntry", () => {
  it("(a) recomputes a wrong verified_tree, writes it back, preserves body + other frontmatter", () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-lore-verify-a-"));
    writeFileSync(join(repo, "target.ts"), "export const x = 1;\n");
    const correctTree = computeVerifiedTree(repo, ["target.ts"]);
    const path = writeLoreEntry(repo, "wrong-tree", {
      status: "canon",
      anchors: ["target.ts"],
      verifiedTree: "0".repeat(64),
      verifiedAt: "2020-01-01",
      body: "This body explains the WHY behind this fact, well over forty characters long.",
    });
    const before = readFileSync(path, "utf8");

    const now = new Date(2026, 6, 10); // local: 2026-07-10 (month is 0-indexed)
    const result = verifyLoreEntry(repo, "wrong-tree", now);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.oldTree).toBe("0".repeat(64));
    expect(result.newTree).toBe(correctTree);
    expect(result.verifiedAt).toBe("2026-07-10");

    const after = readFileSync(path, "utf8");
    expect(after).toContain(`verified_tree: "${correctTree}"`);
    expect(after).toContain("verified_at: 2026-07-10");

    // Body + every other frontmatter field preserved byte-for-byte, line for line.
    const beforeLines = before.split("\n");
    const afterLines = after.split("\n");
    expect(afterLines.length).toBe(beforeLines.length);
    for (let i = 0; i < beforeLines.length; i++) {
      const bl = beforeLines[i] ?? "";
      if (bl.startsWith("verified_tree:") || bl.startsWith("verified_at:")) continue;
      expect(afterLines[i]).toBe(bl);
    }
  });

  it("(b) an already-correct entry: changed:false, but verified_at still refreshed to today", () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-lore-verify-b-"));
    writeFileSync(join(repo, "target.ts"), "export const y = 2;\n");
    const correctTree = computeVerifiedTree(repo, ["target.ts"]);
    writeLoreEntry(repo, "already-ok", {
      status: "canon",
      anchors: ["target.ts"],
      verifiedTree: correctTree,
      verifiedAt: "2020-01-01",
    });

    const now = new Date(2026, 6, 10);
    const result = verifyLoreEntry(repo, "already-ok", now);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(false);
    expect(result.oldTree).toBe(correctTree);
    expect(result.newTree).toBe(correctTree);
    expect(result.verifiedAt).toBe("2026-07-10");

    const path = join(repo, ".reviewgate", "lore", "already-ok.md");
    const after = readFileSync(path, "utf8");
    expect(after).toContain("verified_at: 2026-07-10");
  });

  it("(c) zero-match anchors: ok:false, error mentions zero, file left unchanged", () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-lore-verify-c-"));
    const path = writeLoreEntry(repo, "zero-anchor", {
      anchors: ["does/not/exist.ts"],
      verifiedTree: "0".repeat(64),
    });
    const before = readFileSync(path);

    const result = verifyLoreEntry(repo, "zero-anchor", new Date(2026, 6, 10));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error?.toLowerCase()).toContain("zero");

    const after = readFileSync(path);
    expect(after.equals(before)).toBe(true);
  });

  it("(d) broad anchors (>200 files): ok:false, file left unchanged", () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-lore-verify-d-"));
    const broadDir = join(repo, "broad");
    mkdirSync(broadDir, { recursive: true });
    for (let i = 0; i < 205; i++) writeFileSync(join(broadDir, `f${i}.txt`), "x");
    const path = writeLoreEntry(repo, "broad-anchor", {
      anchors: ["broad/**/*.txt"],
      verifiedTree: "0".repeat(64),
    });
    const before = readFileSync(path);

    const result = verifyLoreEntry(repo, "broad-anchor", new Date(2026, 6, 10));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error?.toLowerCase()).toContain("200");

    const after = readFileSync(path);
    expect(after.equals(before)).toBe(true);
  });

  it("(e) missing slug: ok:false with a 'not found' error", () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-lore-verify-e-"));
    const result = verifyLoreEntry(repo, "does-not-exist", new Date(2026, 6, 10));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error?.toLowerCase()).toContain("not found");
  });
});
