import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "../../src/config/define-config.ts";
import { loadEffectiveConfig, resolveGlobalConfigPath } from "../../src/config/global.ts";

function tmp() {
  return mkdtempSync(join(tmpdir(), "rg-glob-"));
}

describe("resolveGlobalConfigPath", () => {
  it("prefers XDG_CONFIG_HOME", () => {
    expect(resolveGlobalConfigPath({ XDG_CONFIG_HOME: "/x" }, "/home/u")).toBe(
      "/x/reviewgate/reviewgate.config.ts",
    );
  });
  it("falls back to <home>/.config", () => {
    expect(resolveGlobalConfigPath({}, "/home/u")).toBe(
      "/home/u/.config/reviewgate/reviewgate.config.ts",
    );
  });
  it("ignores a non-absolute XDG_CONFIG_HOME and falls back to home", () => {
    expect(resolveGlobalConfigPath({ XDG_CONFIG_HOME: "relative/path" }, "/home/u")).toBe(
      "/home/u/.config/reviewgate/reviewgate.config.ts",
    );
  });
  it("returns null when neither XDG_CONFIG_HOME nor a usable home is available", () => {
    expect(resolveGlobalConfigPath({}, "")).toBeNull();
    expect(resolveGlobalConfigPath({}, "relative/path")).toBeNull();
  });
});

describe("loadEffectiveConfig", () => {
  it("no global, no project => byte-identical to defaults", async () => {
    const cwd = tmp();
    const cfg = await loadEffectiveConfig({ cwd, env: {}, home: tmp() });
    expect(cfg).toEqual(defineConfig({}));
  });

  it("project overrides defaults", async () => {
    const cwd = tmp();
    writeFileSync(
      join(cwd, "reviewgate.config.ts"),
      "export default { phases: { fpLedger: { enabled: true } } };",
    );
    const cfg = await loadEffectiveConfig({ cwd, env: {}, home: tmp() });
    expect(cfg.phases.fpLedger).toEqual({ enabled: true });
  });

  it("project beats global; global beats defaults; reviewers array REPLACES", async () => {
    const home = tmp();
    const gdir = join(home, ".config", "reviewgate");
    mkdirSync(gdir, { recursive: true });
    writeFileSync(
      join(gdir, "reviewgate.config.ts"),
      'export default { notify: { desktop: true }, phases: { review: { reviewers: [{ provider: "gemini", persona: "security" }] } } };',
    );
    const cwd = tmp();
    writeFileSync(
      join(cwd, "reviewgate.config.ts"),
      'export default { phases: { review: { reviewers: [{ provider: "codex", persona: "adversarial" }] } } };',
    );
    const cfg = await loadEffectiveConfig({ cwd, env: {}, home });
    expect(cfg.notify.desktop).toBe(true); // from global (defaults=false)
    expect(cfg.phases.review.reviewers).toEqual([{ provider: "codex", persona: "adversarial" }]); // project replaces
  });

  it("a malformed project config degrades to the lower layers (no throw)", async () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "reviewgate.config.ts"), "this is not valid typescript $$$");
    const cfg = await loadEffectiveConfig({ cwd, env: {}, home: tmp() });
    expect(cfg).toEqual(defineConfig({}));
  });

  it("a schema-INVALID config warns (with the offending field) before degrading", async () => {
    // Imports fine (valid TS object) but violates the schema → defineConfig throws.
    // The silent fallback this tool exists to prevent must NOT happen quietly:
    // we degrade to defaults AND surface a console.warn naming the bad path.
    const cwd = tmp();
    writeFileSync(
      join(cwd, "reviewgate.config.ts"),
      'export default { providers: { codex: { timeoutMs: "not-a-number" } } };',
    );
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => warnings.push(a.map(String).join(" "));
    try {
      const cfg = await loadEffectiveConfig({ cwd, env: {}, home: tmp() });
      expect(cfg).toEqual(defineConfig({}));
    } finally {
      console.warn = orig;
    }
    const joined = warnings.join("\n");
    expect(joined.toLowerCase()).toContain("reviewgate");
    // The zod error must point at the actual offending field, not be opaque.
    expect(joined).toContain("timeoutMs");
  });
});
