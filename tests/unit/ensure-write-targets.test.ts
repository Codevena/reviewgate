// tests/unit/ensure-write-targets.test.ts
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureWriteTargets } from "../../src/utils/spawn.ts";

describe("ensureWriteTargets", () => {
  it("creates a missing file target (with parent) and a missing dir target", () => {
    const root = mkdtempSync(join(tmpdir(), "rg-ewt-"));
    const file = join(root, "nested/findings.md");
    const dir = join(root, "run-tmp");
    ensureWriteTargets([
      { path: file, kind: "file", createIfMissing: true },
      { path: dir, kind: "dir", createIfMissing: true },
    ]);
    expect(statSync(file).isFile()).toBe(true);
    expect(statSync(dir).isDirectory()).toBe(true);
  });

  it("never fabricates a createIfMissing:false target (own-cred dir)", () => {
    const root = mkdtempSync(join(tmpdir(), "rg-ewt2-"));
    const cred = join(root, ".codex");
    ensureWriteTargets([{ path: cred, kind: "dir", createIfMissing: false }]);
    expect(existsSync(cred)).toBe(false);
  });

  it("leaves an existing path untouched (an existing FILE passed as a dir target does NOT crash)", () => {
    const root = mkdtempSync(join(tmpdir(), "rg-ewt3-"));
    const f = join(root, "already.txt");
    writeFileSync(f, "keep");
    ensureWriteTargets([{ path: f, kind: "dir", createIfMissing: true }]); // mismatched kind, but exists → no-op
    expect(statSync(f).isFile()).toBe(true);
    expect(readFileSync(f, "utf8")).toBe("keep");
  });
});
