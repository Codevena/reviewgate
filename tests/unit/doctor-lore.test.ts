// tests/unit/doctor-lore.test.ts
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loreCheck } from "../../src/cli/commands/doctor.ts";
import { defineConfig } from "../../src/config/define-config.ts";
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

function writeInvalidLoreFile(repo: string, name: string, raw: string) {
  const dir = join(repo, ".reviewgate", "lore");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), raw);
}

describe("loreCheck", () => {
  it("returns null when phases.lore is null (default off)", () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-lore-off-"));
    expect(loreCheck(repo, defineConfig({}))).toBeNull();
  });

  it("ok with canon/draft/stale/inert counts for a healthy lore dir", () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-lore-healthy-"));
    writeFileSync(join(repo, "target.ts"), "export const x = 1;\n");
    const okTree = computeVerifiedTree(repo, ["target.ts"]);

    writeLoreEntry(repo, "canon-ok", {
      status: "canon",
      anchors: ["target.ts"],
      verifiedTree: okTree,
    });
    writeLoreEntry(repo, "draft-ok", {
      status: "draft",
      anchors: ["target.ts"],
      verifiedTree: okTree,
    });
    writeLoreEntry(repo, "draft-stale", {
      status: "draft",
      anchors: ["target.ts"],
      verifiedTree: "0".repeat(64),
    });

    const cfg = defineConfig({ phases: { lore: { enabled: true } } } as Parameters<
      typeof defineConfig
    >[0]);
    const c = loreCheck(repo, cfg);
    expect(c).not.toBeNull();
    expect(c?.status).toBe("ok");
    expect(c?.detail).toContain("1 canon");
    expect(c?.detail).toContain("2 draft");
    expect(c?.detail).toContain("1 stale");
    expect(c?.detail).toContain("0 inert");
  });

  it("warns and names the file when a lore file fails to parse", () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-lore-invalid-"));
    writeFileSync(join(repo, "target.ts"), "export const x = 1;\n");
    const okTree = computeVerifiedTree(repo, ["target.ts"]);
    writeLoreEntry(repo, "canon-ok", {
      status: "canon",
      anchors: ["target.ts"],
      verifiedTree: okTree,
    });
    writeInvalidLoreFile(repo, "broken.md", "not frontmatter at all\n");

    const cfg = defineConfig({ phases: { lore: { enabled: true } } } as Parameters<
      typeof defineConfig
    >[0]);
    const c = loreCheck(repo, cfg);
    expect(c).not.toBeNull();
    expect(c?.status).toBe("warn");
    expect(c?.detail).toContain(".reviewgate/lore/broken.md");
  });

  it("warns and names the entry when an anchor matches zero files", () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-lore-zero-"));
    writeLoreEntry(repo, "ghost-entry", {
      anchors: ["does/not/exist.ts"],
      verifiedTree: "0".repeat(64),
    });

    const cfg = defineConfig({ phases: { lore: { enabled: true } } } as Parameters<
      typeof defineConfig
    >[0]);
    const c = loreCheck(repo, cfg);
    expect(c).not.toBeNull();
    expect(c?.status).toBe("warn");
    expect(c?.detail).toContain("ghost-entry");
    expect(c?.detail.toLowerCase()).toContain("zero");
  });

  it("warns and names the entry when its anchor is too broad (>200 files)", () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-lore-broad-"));
    const dir = join(repo, "broad");
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 205; i++) {
      writeFileSync(join(dir, `f${i}.txt`), "x");
    }
    writeLoreEntry(repo, "broad-entry", {
      anchors: ["broad/**/*.txt"],
      verifiedTree: "0".repeat(64),
    });

    const cfg = defineConfig({ phases: { lore: { enabled: true } } } as Parameters<
      typeof defineConfig
    >[0]);
    const c = loreCheck(repo, cfg);
    expect(c).not.toBeNull();
    expect(c?.status).toBe("warn");
    expect(c?.detail).toContain("broad-entry");
    expect(c?.detail.toLowerCase()).toContain("broad");
  });
});
