// tests/unit/lore-verify-cli.test.ts
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLoreVerify } from "../../src/cli/commands/lore.ts";
import { computeVerifiedTree } from "../../src/core/lore/staleness.ts";

function loreEntryFile(
  id: string,
  opts: { status?: "draft" | "canon"; anchors: string[]; verifiedTree: string },
): string {
  return [
    "---",
    "schema: reviewgate.lore.v1",
    `id: ${id}`,
    `status: ${opts.status ?? "draft"}`,
    "anchors:",
    ...opts.anchors.map((a) => `  - ${a}`),
    "verified_at: 2020-01-01",
    `verified_tree: "${opts.verifiedTree}"`,
    "tags: []",
    "---",
    "This is the body explaining WHY this anchor exists — well over forty chars total.",
    "",
  ].join("\n");
}

function writeLoreEntry(
  repo: string,
  id: string,
  opts: { status?: "draft" | "canon"; anchors: string[]; verifiedTree: string },
): string {
  const dir = join(repo, ".reviewgate", "lore");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.md`);
  writeFileSync(path, loreEntryFile(id, opts));
  return path;
}

describe("runLoreVerify", () => {
  it("verifies a stale entry named by slug, writes it back, prints 'updated', exit 0", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-lore-verify-cli-"));
    writeFileSync(join(repo, "target.ts"), "export const x = 1;\n");
    const correctTree = computeVerifiedTree(repo, ["target.ts"]);
    const path = writeLoreEntry(repo, "stale-one", {
      anchors: ["target.ts"],
      verifiedTree: "0".repeat(64),
    });

    const lines: string[] = [];
    const code = await runLoreVerify({
      repoRoot: repo,
      slugs: ["stale-one"],
      write: (s) => lines.push(s),
    });

    expect(code).toBe(0);
    const out = lines.join("");
    expect(out).toContain("stale-one · updated ·");
    expect(out).toContain(`${"0".repeat(64)}`.slice(0, 8));
    const after = readFileSync(path, "utf8");
    expect(after).toContain(`verified_tree: "${correctTree}"`);
  });

  it("exits 1 and prints ERROR when a requested slug does not exist", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-lore-verify-cli-err-"));

    const lines: string[] = [];
    const code = await runLoreVerify({
      repoRoot: repo,
      slugs: ["does-not-exist"],
      write: (s) => lines.push(s),
    });

    expect(code).toBe(1);
    const out = lines.join("");
    expect(out).toContain("does-not-exist · ERROR ·");
  });

  it("--all verifies every entry under .reviewgate/lore/, exit 0 when all ok", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-lore-verify-cli-all-"));
    writeFileSync(join(repo, "a.ts"), "a");
    writeFileSync(join(repo, "b.ts"), "b");
    const treeA = computeVerifiedTree(repo, ["a.ts"]);
    writeLoreEntry(repo, "entry-a", { anchors: ["a.ts"], verifiedTree: treeA });
    writeLoreEntry(repo, "entry-b", { anchors: ["b.ts"], verifiedTree: "0".repeat(64) });

    const lines: string[] = [];
    const code = await runLoreVerify({ repoRoot: repo, all: true, write: (s) => lines.push(s) });

    expect(code).toBe(0);
    const out = lines.join("");
    expect(out).toContain("entry-a · already fresh ·");
    expect(out).toContain("entry-b · updated ·");
  });

  it("--all with zero lore entries prints 'no lore entries' and exits 0", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-lore-verify-cli-empty-"));

    const lines: string[] = [];
    const code = await runLoreVerify({ repoRoot: repo, all: true, write: (s) => lines.push(s) });

    expect(code).toBe(0);
    expect(lines.join("").toLowerCase()).toContain("no lore entries");
  });

  it("--all ignores positional slugs when both are given", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-lore-verify-cli-both-"));
    writeFileSync(join(repo, "a.ts"), "a");
    const treeA = computeVerifiedTree(repo, ["a.ts"]);
    writeLoreEntry(repo, "entry-a", { anchors: ["a.ts"], verifiedTree: treeA });

    const lines: string[] = [];
    const code = await runLoreVerify({
      repoRoot: repo,
      all: true,
      slugs: ["does-not-exist"],
      write: (s) => lines.push(s),
    });

    expect(code).toBe(0);
    const out = lines.join("");
    expect(out).not.toContain("does-not-exist");
    expect(out).toContain("entry-a · already fresh ·");
  });
});
