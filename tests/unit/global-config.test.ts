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

  it("a malformed present project config fails closed", async () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "reviewgate.config.ts"), "this is not valid typescript $$$");
    await expect(loadEffectiveConfig({ cwd, env: {}, home: tmp() })).rejects.toThrow();
  });

  it("reflects an OVERWRITTEN config on a same-process reload (no ESM-cache staleness)", async () => {
    // `reviewgate setup` writes the config then reloads it (doctor). A naive
    // import() caches by path → the reload would see the OLD config. We must read
    // the current content fresh.
    const cwd = tmp();
    const p = join(cwd, "reviewgate.config.ts");
    writeFileSync(p, "export default { notify: { desktop: false } };");
    const first = await loadEffectiveConfig({ cwd, env: {}, home: tmp() });
    expect(first.notify.desktop).toBe(false);
    writeFileSync(p, "export default { notify: { desktop: true } };");
    const second = await loadEffectiveConfig({ cwd, env: {}, home: tmp() });
    expect(second.notify.desktop).toBe(true); // fresh read, not the cached first load
  });

  it("blocks when a present config has invalid syntax", async () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "reviewgate.config.ts"), "export default { oops:: }};; not valid");
    await expect(loadEffectiveConfig({ cwd, env: {}, home: tmp() })).rejects.toThrow(
      /reviewgate\.config\.ts/i,
    );
  });

  it("a schema-invalid present config blocks and names the offending field", async () => {
    const cwd = tmp();
    writeFileSync(
      join(cwd, "reviewgate.config.ts"),
      'export default { providers: { codex: { timeoutMs: "not-a-number" } } };',
    );
    await expect(loadEffectiveConfig({ cwd, env: {}, home: tmp() })).rejects.toThrow(/timeoutMs/);
  });

  it("never partially salvages an invalid config; the whole present policy blocks", async () => {
    const cwd = tmp();
    writeFileSync(
      join(cwd, "reviewgate.config.ts"),
      'export default { sandbox: { mode: "strict" }, loop: { maxIterations: "3" } };',
    );
    await expect(loadEffectiveConfig({ cwd, env: {}, home: tmp() })).rejects.toThrow(
      /loop\.maxIterations/,
    );
  });
});
