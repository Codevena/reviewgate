// tests/unit/init-bake.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBakedBin, writeShims } from "../../src/cli/commands/init.ts";

const REPO_TPL = join(import.meta.dir, "..", "..", "bin-templates");

describe("resolveBakedBin", () => {
  it("bakes a normal global install path, no warning", () => {
    const p = "/Users/x/.npm-global/lib/node_modules/@codevena/reviewgate-darwin-arm64/reviewgate";
    expect(resolveBakedBin(p)).toEqual({ bakedBin: p, warning: null });
  });

  it("bakes a local project node_modules path, no warning", () => {
    const p = "/Users/x/proj/node_modules/@codevena/reviewgate-darwin-arm64/reviewgate";
    expect(resolveBakedBin(p)).toEqual({ bakedBin: p, warning: null });
  });

  it("bakes the curl|sh install path, no warning", () => {
    const p = "/Users/x/.reviewgate/v0.1.0-alpha.1/reviewgate";
    expect(resolveBakedBin(p)).toEqual({ bakedBin: p, warning: null });
  });

  it("does NOT bake the bun-dev runtime (basename is 'bun')", () => {
    expect(resolveBakedBin("/opt/homebrew/bin/bun")).toEqual({ bakedBin: "", warning: null });
  });

  it.each([
    ["npx", "/Users/x/.npm/_npx/abc123/node_modules/@codevena/reviewgate-darwin-arm64/reviewgate"],
    ["npm cacache", "/Users/x/.npm/_cacache/tmp/xyz/reviewgate"],
    [
      "pnpm dlx",
      "/Users/x/.pnpm-store/v3/tmp/dlx-9876/node_modules/@codevena/reviewgate-linux-x64/reviewgate",
    ],
    ["bun cache", "/Users/x/.bun/install/cache/reviewgate@0.1.0/reviewgate"],
    ["os temp (macOS)", "/private/var/folders/aa/bb/T/xfs-123/reviewgate"],
    ["os temp (/tmp)", "/tmp/yarn--163-0/reviewgate"],
  ])("bakes but WARNS on an ephemeral %s path", (_label, p) => {
    const r = resolveBakedBin(p);
    expect(r.bakedBin).toBe(p);
    expect(r.warning).toContain("ephemeral");
    expect(r.warning).toContain("npm i -g reviewgate");
  });
});

describe("writeShims re-bake (stale path is replaced)", () => {
  it("rewrites RG_BIN from a stale path to the new one on a second run", () => {
    const binDir = mkdtempSync(join(tmpdir(), "rg-shims-"));
    writeShims(binDir, REPO_TPL, "/old/reviewgate");
    expect(readFileSync(join(binDir, "gate"), "utf8")).toContain("RG_BIN='/old/reviewgate'");
    writeShims(binDir, REPO_TPL, "/new/reviewgate");
    const gate = readFileSync(join(binDir, "gate"), "utf8");
    expect(gate).toContain("RG_BIN='/new/reviewgate'");
    expect(gate).not.toContain("/old/reviewgate");
  });
});
