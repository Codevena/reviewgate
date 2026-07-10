// tests/unit/lore-status-cli.test.ts
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLoreStatus } from "../../src/cli/commands/lore.ts";
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
    "verified_at: 2026-07-09T00:00:00Z",
    `verified_tree: ${opts.verifiedTree}`,
    "---",
    "This is the body explaining WHY this anchor exists — well over forty chars.",
    "",
  ].join("\n");
}

function writeLoreEntry(
  repo: string,
  id: string,
  opts: { status?: "draft" | "canon"; anchors: string[]; verifiedTree: string },
) {
  const dir = join(repo, ".reviewgate", "lore");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.md`), loreEntryFile(id, opts));
}

describe("runLoreStatus", () => {
  it("prints a clean 'no lore entries' line for an empty lore dir, exit 0", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-lore-cli-empty-"));
    const lines: string[] = [];
    const code = await runLoreStatus({ repoRoot: repo, write: (s) => lines.push(s) });
    expect(code).toBe(0);
    const out = lines.join("");
    expect(out.toLowerCase()).toContain("no lore entries");
  });

  it("prints one verbatim-state line per entry + an invalid line + correct totals, exit 0", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-lore-cli-mixed-"));
    writeFileSync(join(repo, "target.ts"), "export const x = 1;\n");
    const okTree = computeVerifiedTree(repo, ["target.ts"]);

    writeLoreEntry(repo, "canon-ok", {
      status: "canon",
      anchors: ["target.ts"],
      verifiedTree: okTree,
    });
    writeLoreEntry(repo, "draft-stale", {
      status: "draft",
      anchors: ["target.ts"],
      verifiedTree: "0".repeat(64),
    });
    writeLoreEntry(repo, "draft-zero", {
      status: "draft",
      anchors: ["does/not/exist.ts"],
      verifiedTree: "0".repeat(64),
    });
    const broadDir = join(repo, "broad");
    mkdirSync(broadDir, { recursive: true });
    for (let i = 0; i < 205; i++) writeFileSync(join(broadDir, `f${i}.txt`), "x");
    writeLoreEntry(repo, "draft-broad", {
      status: "draft",
      anchors: ["broad/**/*.txt"],
      verifiedTree: "0".repeat(64),
    });
    const loreDir = join(repo, ".reviewgate", "lore");
    writeFileSync(join(loreDir, "broken.md"), "not frontmatter at all\n");

    const lines: string[] = [];
    const code = await runLoreStatus({ repoRoot: repo, write: (s) => lines.push(s) });
    expect(code).toBe(0); // read-only: exit 0 even with an invalid entry present

    const out = lines.join("");
    expect(out).toContain("canon-ok · canon · ok · target.ts");
    expect(out).toContain("draft-stale · draft · stale · target.ts");
    expect(out).toContain("draft-zero · draft · zero-match · does/not/exist.ts");
    expect(out).toContain("draft-broad · draft · broad · broad/**/*.txt");
    expect(out).toContain(".reviewgate/lore/broken.md");
    expect(out.toLowerCase()).toContain("invalid");

    // Totals: 1 canon, 3 draft, 1 stale, 2 inert (broad+zero-match), 1 invalid.
    const totalsLine = lines.find((l) => /canon/.test(l) && /draft/.test(l) && /stale/.test(l));
    expect(totalsLine).toBeDefined();
    expect(totalsLine).toContain("1 canon");
    expect(totalsLine).toContain("3 draft");
    expect(totalsLine).toContain("1 stale");
    expect(totalsLine).toContain("2 inert");
    expect(totalsLine).toContain("1 invalid");
  });
});
