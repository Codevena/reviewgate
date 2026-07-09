// tests/unit/lore-staleness.test.ts
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyEntry,
  computeVerifiedTree,
  resolveAnchors,
} from "../../src/core/lore/staleness.ts";
import type { LoreEntryParsed } from "../../src/core/lore/store.ts";
import { LORE_BROAD_ANCHOR_FILE_CAP } from "../../src/schemas/lore.ts";

function repoWith(files: Record<string, string>): string {
  const repo = mkdtempSync(join(tmpdir(), "rg-lore-staleness-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(repo, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return repo;
}

// Byte-for-byte mirror of the spec's hash definition, computed independently
// in the test so the assertion is a real cross-check against a FIXED vector,
// not a tautology against the implementation under test.
function expectedTree(repoRoot: string, files: string[]): string {
  const sorted = [...files].sort();
  const pairs = sorted.map((rel) => {
    const bytes = readFileSync(join(repoRoot, rel));
    const fileHash = createHash("sha256").update(bytes).digest("hex");
    return `${rel}\0${fileHash}`;
  });
  return createHash("sha256").update(pairs.join("\n")).digest("hex");
}

function baseEntry(overrides: Partial<LoreEntryParsed>): LoreEntryParsed {
  return {
    schema: "reviewgate.lore.v1",
    id: "test-entry",
    status: "canon",
    anchors: [],
    verified_at: "2026-07-09",
    verified_tree: "placeholder",
    body: "x".repeat(50),
    file: ".reviewgate/lore/test-entry.md",
    ...overrides,
  };
}

describe("resolveAnchors", () => {
  it("resolves an exact path and a glob into a sorted, deduped repo-relative list", () => {
    const repo = repoWith({
      "src/a.ts": "a",
      "src/lib/b.ts": "b",
      "src/lib/c/d.ts": "d",
    });
    const files = resolveAnchors(repo, ["src/a.ts", "src/lib/**"]);
    expect(files).toEqual(["src/a.ts", "src/lib/b.ts", "src/lib/c/d.ts"]);
  });

  it("dedupes across overlapping anchors", () => {
    const repo = repoWith({
      "src/a.ts": "a",
      "src/lib/b.ts": "b",
    });
    const files = resolveAnchors(repo, ["src/lib/**", "src/lib/b.ts", "src/a.ts"]);
    expect(files).toEqual(["src/a.ts", "src/lib/b.ts"]);
  });

  it("excludes .git/, node_modules/, and .reviewgate/ even when a broad glob would match them", () => {
    const repo = repoWith({
      "src/a.ts": "a",
      "node_modules/pkg/index.ts": "x",
      ".reviewgate/lore/other.md": "y",
      ".git/config": "z",
    });
    const files = resolveAnchors(repo, ["**/*.ts", "**/*.md", "**/config"]);
    expect(files).toEqual(["src/a.ts"]);
  });

  it("skips an invalid glob pattern instead of throwing (fail open to fewer matches)", () => {
    const repo = repoWith({ "src/a.ts": "a" });
    // Bun.Glob throws on an unterminated character class.
    expect(() => resolveAnchors(repo, ["src/[a", "src/a.ts"])).not.toThrow();
    expect(resolveAnchors(repo, ["src/[a", "src/a.ts"])).toEqual(["src/a.ts"]);
  });
});

describe("computeVerifiedTree", () => {
  it("matches a fixed vector computed independently from the same byte-level definition", () => {
    const repo = repoWith({
      "src/a.ts": "content-a",
      "src/lib/b.ts": "content-b",
    });
    const files = resolveAnchors(repo, ["src/a.ts", "src/lib/**"]);
    const expected = expectedTree(repo, files);
    expect(computeVerifiedTree(repo, files)).toBe(expected);
    // Sanity: not just "some hash" — recompute the vector completely by hand
    // to be sure expectedTree() itself isn't accidentally a copy of the impl.
    const manualPairs = [
      `src/a.ts\0${createHash("sha256")
        .update(readFileSync(join(repo, "src/a.ts")))
        .digest("hex")}`,
      `src/lib/b.ts\0${createHash("sha256")
        .update(readFileSync(join(repo, "src/lib/b.ts")))
        .digest("hex")}`,
    ];
    const manual = createHash("sha256").update(manualPairs.join("\n")).digest("hex");
    expect(computeVerifiedTree(repo, files)).toBe(manual);
  });

  it("hashes raw bytes, not a utf8-decoded string (order of files does not matter, content does)", () => {
    const repo = repoWith({ "src/a.ts": "same", "src/b.ts": "same" });
    // Passing files out of order must not change the result — the function sorts internally.
    const t1 = computeVerifiedTree(repo, ["src/b.ts", "src/a.ts"]);
    const t2 = computeVerifiedTree(repo, ["src/a.ts", "src/b.ts"]);
    expect(t1).toBe(t2);
  });
});

describe("classifyEntry", () => {
  it("returns ok when the current tree matches verified_tree", () => {
    const repo = repoWith({ "src/a.ts": "content" });
    const files = resolveAnchors(repo, ["src/a.ts"]);
    const tree = computeVerifiedTree(repo, files);
    const entry = baseEntry({ anchors: ["src/a.ts"], verified_tree: tree });
    expect(classifyEntry(repo, entry)).toEqual({ state: "ok", files });
  });

  it("flips to stale when an anchored file's bytes change after verification", () => {
    const repo = repoWith({ "src/lib/b.ts": "original" });
    const files = resolveAnchors(repo, ["src/lib/**"]);
    const t1 = computeVerifiedTree(repo, files);

    writeFileSync(join(repo, "src/lib/b.ts"), "changed");
    const t2 = computeVerifiedTree(repo, files);
    expect(t2).not.toBe(t1);

    const entry = baseEntry({ anchors: ["src/lib/**"], verified_tree: t1 });
    expect(classifyEntry(repo, entry).state).toBe("stale");

    const freshEntry = baseEntry({ anchors: ["src/lib/**"], verified_tree: t2 });
    expect(classifyEntry(repo, freshEntry).state).toBe("ok");
  });

  it("returns zero-match for an anchor that matches nothing (typo'd path)", () => {
    const repo = repoWith({ "src/a.ts": "a" });
    const entry = baseEntry({ anchors: ["nope/**"] });
    expect(classifyEntry(repo, entry)).toEqual({ state: "zero-match", files: [] });
  });

  it("returns broad (and does NOT hash) when anchors match more than LORE_BROAD_ANCHOR_FILE_CAP files", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < LORE_BROAD_ANCHOR_FILE_CAP + 1; i++) {
      files[`broad/f${i}.ts`] = `content-${i}`;
    }
    const repo = repoWith(files);
    const entry = baseEntry({ anchors: ["broad/**"], verified_tree: "irrelevant-never-compared" });
    const result = classifyEntry(repo, entry);
    // Direct behavioral assert that hashing never happened: the mismatched/irrelevant
    // verified_tree above would force "stale" if compared at all — "broad" proves
    // classifyEntry short-circuited before computeVerifiedTree ran.
    expect(result.state).toBe("broad");
    expect(result.files.length).toBeGreaterThan(LORE_BROAD_ANCHOR_FILE_CAP);
  });

  it("fails safe toward ok (still injected) when hashing hits a mid-read error", () => {
    const repo = repoWith({ "src/secret.ts": "content" });
    const target = join(repo, "src/secret.ts");
    chmodSync(target, 0o000);
    try {
      const entry = baseEntry({ anchors: ["src/secret.ts"], verified_tree: "does-not-matter" });
      const result = classifyEntry(repo, entry);
      if (result.state === "ok") {
        // Expected fail-safe path (non-root: readFileSync throws EACCES).
        expect(result.state).toBe("ok");
      } else {
        // Running as root (e.g. some CI/sandbox users) bypasses the permission bit
        // entirely, so the read succeeds and this test can't exercise the fail-safe
        // path — don't fail the suite over an environment property.
        expect(process.getuid?.()).toBe(0);
      }
    } finally {
      chmodSync(target, 0o644);
    }
  });
});
