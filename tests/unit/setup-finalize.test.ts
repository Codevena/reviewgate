import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalizeSetup, setupTip } from "../../src/cli/commands/setup.ts";
import { buildQuickPreset } from "../../src/cli/setup/build-config.ts";
import type { defineConfig } from "../../src/config/define-config.ts";

describe("setupTip", () => {
  it("returns the tip only in a TTY", () => {
    expect(setupTip(true)).toContain("reviewgate setup");
    expect(setupTip(false)).toBeNull();
  });
});

describe("finalizeSetup", () => {
  it("--print returns text and writes NOTHING", () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-fin-"));
    const target = join(dir, "reviewgate.config.ts");
    const partial = buildQuickPreset({ openrouterKeyPresent: false });
    const r = finalizeSetup({ partial, targetPath: target, print: true });
    expect(r.text).toContain("export default {");
    expect(existsSync(target)).toBe(false);
    expect(r.wrotePath).toBeNull();
  });

  it("writes the file and backs up an existing one", () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-fin-"));
    const target = join(dir, "reviewgate.config.ts");
    writeFileSync(target, "export default { /* old */ };");
    const partial = buildQuickPreset({ openrouterKeyPresent: false });
    const r = finalizeSetup({ partial, targetPath: target, print: false });
    expect(r.wrotePath).toBe(target);
    expect(existsSync(`${target}.bak`)).toBe(true);
    expect(readFileSync(`${target}.bak`, "utf8")).toContain("old");
    expect(readFileSync(target, "utf8")).toContain("export default {");
  });

  it("rejects an invalid partial (validation guard) without writing", () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-fin-"));
    const target = join(dir, "reviewgate.config.ts");
    const bad = { phases: { review: { reviewers: [] } } } as Parameters<typeof defineConfig>[0];
    expect(() => finalizeSetup({ partial: bad, targetPath: target, print: false })).toThrow();
    expect(existsSync(target)).toBe(false);
  });
});
