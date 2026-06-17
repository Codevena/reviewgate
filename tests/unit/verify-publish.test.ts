import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyDist } from "../../scripts/verify-publish.ts";

describe("verifyDist (prepublishOnly guard)", () => {
  it("FAILS on an empty dist (the npm-publish-empty-dist bug)", () => {
    const root = mkdtempSync(join(tmpdir(), "rg-vp-"));
    const r = verifyDist(root);
    expect(r.ok).toBe(false);
    expect(r.missing).toContain("dist/reviewgate");
  });

  it("passes when binary + grammars + hook templates are all present", () => {
    const root = mkdtempSync(join(tmpdir(), "rg-vp-"));
    mkdirSync(join(root, "dist/grammars"), { recursive: true });
    mkdirSync(join(root, "dist/bin-templates"), { recursive: true });
    writeFileSync(join(root, "dist/reviewgate"), "");
    writeFileSync(join(root, "dist/grammars/web-tree-sitter.wasm"), "");
    for (const sh of ["gate.sh", "trigger.sh", "reset.sh", "pre-push.sh"]) {
      writeFileSync(join(root, `dist/bin-templates/${sh}`), "");
    }
    expect(verifyDist(root).ok).toBe(true);
  });

  it("reports a missing grammar (dead symbol-graph in the shipped binary)", () => {
    const root = mkdtempSync(join(tmpdir(), "rg-vp-"));
    mkdirSync(join(root, "dist/bin-templates"), { recursive: true });
    writeFileSync(join(root, "dist/reviewgate"), "");
    for (const sh of ["gate.sh", "trigger.sh", "reset.sh", "pre-push.sh"]) {
      writeFileSync(join(root, `dist/bin-templates/${sh}`), "");
    }
    const r = verifyDist(root);
    expect(r.ok).toBe(false);
    expect(r.missing).toContain("dist/grammars/web-tree-sitter.wasm");
  });
});
