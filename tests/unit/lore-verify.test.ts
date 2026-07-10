// tests/unit/lore-verify.test.ts
import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

  it("(f) a slug with a path-traversal shape is rejected before any read/write, no throw", () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-lore-verify-f-"));
    // Fresh tmpdir — no .reviewgate/ exists yet. If the guard were absent, a
    // traversal slug joined into loreDir()/`${slug}.md` could resolve outside
    // the repo; the assertion below confirms the call neither throws nor
    // creates anything under the repo as a side effect of the attempt.

    const result = verifyLoreEntry(repo, "../../../etc/passwd", new Date(2026, 6, 10));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error?.toLowerCase()).toContain("invalid slug");
    expect(existsSync(join(repo, ".reviewgate"))).toBe(false);
  });

  it("(g) a slug with disallowed characters (uppercase, underscore, empty) is rejected", () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-lore-verify-g-"));
    for (const slug of ["Has-Upper", "has_underscore", "", "-leading-hyphen"]) {
      const result = verifyLoreEntry(repo, slug, new Date(2026, 6, 10));
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error?.toLowerCase()).toContain("invalid slug");
    }
  });

  it("(h) a read error other than ENOENT is reported as 'unreadable', not 'not found'", () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-lore-verify-h-"));
    const dir = join(repo, ".reviewgate", "lore");
    mkdirSync(dir, { recursive: true });
    // A directory named "<slug>.md" makes readFileSync fail with EISDIR, not
    // ENOENT — the file "exists" (in the sense the path resolves to something)
    // but can't be read as a file. This must NOT be reported as "not found".
    mkdirSync(join(dir, "a-dir-not-a-file.md"));

    const result = verifyLoreEntry(repo, "a-dir-not-a-file", new Date(2026, 6, 10));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error?.toLowerCase()).toContain("unreadable");
    expect(result.error?.toLowerCase()).not.toContain("not found");
  });

  it("(i) body lines that look like frontmatter fields are left byte-for-byte intact — only the real frontmatter is rewritten", () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-lore-verify-i-"));
    writeFileSync(join(repo, "target.ts"), "export const z = 3;\n");
    const correctTree = computeVerifiedTree(repo, ["target.ts"]);

    const decoyBody = [
      "This body explains the WHY behind this anchor, well over forty chars long.",
      "",
      'verified_tree: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"',
      "verified_at: 1999-01-01",
      "Those two decoy lines must never be rewritten — they are BODY, not frontmatter.",
    ].join("\n");

    const dir = join(repo, ".reviewgate", "lore");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "confinement.md");
    writeFileSync(
      path,
      [
        "---",
        "schema: reviewgate.lore.v1",
        "id: confinement",
        "status: draft",
        "anchors:",
        "  - target.ts",
        "verified_at: 2020-01-01",
        `verified_tree: "${"0".repeat(64)}"`,
        "tags: []",
        "---",
        decoyBody,
        "",
      ].join("\n"),
    );

    const result = verifyLoreEntry(repo, "confinement", new Date(2026, 6, 10));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.newTree).toBe(correctTree);

    const after = readFileSync(path, "utf8");
    // The real frontmatter WAS rewritten with the new hash / date.
    expect(after).toContain(`verified_tree: "${correctTree}"`);
    expect(after).toContain("verified_at: 2026-07-10");
    // The decoy lines inside the BODY are untouched — still the placeholder
    // hash and the 1999 date, not the recomputed values.
    expect(after).toContain(
      'verified_tree: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"',
    );
    expect(after).toContain("verified_at: 1999-01-01");
    // And the body is present verbatim after the closing frontmatter fence.
    expect(after.endsWith(`---\n${decoyBody}\n`)).toBe(true);

    // MUTATION-PROVEN: swapping verify.ts's capture-group assignment —
    // `const frontmatter = m[2]; const body = m[1];` instead of the correct
    // `m[1]`/`m[2]` — makes the `.replace(/^verified_tree:.../m, ...)` calls
    // run over the BODY text instead of the frontmatter. That rewrites this
    // test's decoy lines (turning them into the new hash/date) while leaving
    // the real frontmatter's placeholder "000...0" hash untouched, which
    // flips both the "decoy lines untouched" assertions and the "real
    // frontmatter was rewritten" assertion above to fail — verified by
    // applying that exact swap to src/core/lore/verify.ts, confirming this
    // test goes red, then reverting (git diff confirmed clean revert).
  });
});
