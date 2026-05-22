import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../src/config/defaults.ts";
import { ConfigSchema, defineConfig } from "../../src/config/define-config.ts";
import { loadConfig } from "../../src/config/loader.ts";

function writeConfig(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-config-"));
  const f = join(dir, "reviewgate.config.ts");
  writeFileSync(f, content);
  return f;
}

describe("loadConfig", () => {
  it("returns defaults when no config file given", async () => {
    const cfg = await loadConfig(null);
    expect(cfg.loop.maxIterations).toBe(defaultConfig.loop.maxIterations);
    expect(cfg.providers.codex.enabled).toBe(true);
  });

  it("merges user-defined values on top of defaults", async () => {
    const file = writeConfig(`
      import { defineConfig } from '${process.cwd()}/src/config/define-config.ts';
      export default defineConfig({
        loop: { maxIterations: 5 },
      });
    `);
    const cfg = await loadConfig(file);
    expect(cfg.loop.maxIterations).toBe(5);
    // unchanged values remain
    expect(cfg.loop.costCapUsd).toBe(defaultConfig.loop.costCapUsd);
  });

  it("rejects invalid config (schema violation)", async () => {
    const file = writeConfig(`
      import { defineConfig } from '${process.cwd()}/src/config/define-config.ts';
      export default defineConfig({
        loop: { maxIterations: -1 },
      });
    `);
    await expect(loadConfig(file)).rejects.toThrow();
  });

  it("accepts a multi-reviewer panel with gemini + claude + openrouter", () => {
    const cfg = defineConfig({
      providers: {
        gemini: { enabled: true, auth: "oauth", model: "gemini-3-pro", timeoutMs: 300_000 },
        "claude-code": {
          enabled: true,
          auth: "oauth",
          model: "claude-sonnet-4-6",
          timeoutMs: 300_000,
        },
        openrouter: {
          enabled: true,
          auth: "openrouter",
          apiKeyEnv: "OPENROUTER_API_KEY",
          model: "google/gemini-3.5-flash",
          timeoutMs: 300_000,
        },
      },
      phases: {
        review: {
          reviewers: [
            { provider: "codex", persona: "security" },
            { provider: "gemini", persona: "architecture" },
            { provider: "claude-code", persona: "adversarial" },
            { provider: "openrouter", persona: "security" },
          ],
        },
        critic: { provider: "gemini", model: "gemini-3-flash", persona: "fp-filter" },
      },
    });
    expect(cfg.phases.review.reviewers.length).toBe(4);
    expect(cfg.providers.gemini?.enabled).toBe(true);
    expect(cfg.phases.critic?.provider).toBe("gemini");
  });

  it("rejects an unknown provider in reviewers", () => {
    expect(() =>
      defineConfig({
        phases: { review: { reviewers: [{ provider: "bogus" as never, persona: "x" }] } },
      }),
    ).toThrow();
  });

  it("defaults critic to null and keeps codex as the sole default reviewer", () => {
    const cfg = defineConfig({});
    expect(cfg.phases.critic).toBeNull();
    expect(cfg.phases.review.reviewers).toEqual([{ provider: "codex", persona: "security" }]);
  });
});

describe("weeklyReport config", () => {
  it("defaults weeklyReport to null (off)", () => {
    const parsed = ConfigSchema.parse(defaultConfig);
    expect(parsed.weeklyReport ?? null).toBeNull();
  });

  it("accepts weeklyReport.autoSnapshot", () => {
    const parsed = ConfigSchema.parse({ ...defaultConfig, weeklyReport: { autoSnapshot: true } });
    expect(parsed.weeklyReport?.autoSnapshot).toBe(true);
  });
});
