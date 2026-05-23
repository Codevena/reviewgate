import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../src/config/defaults.ts";
import { defineConfig } from "../../src/config/define-config.ts";
import { diffFromDefaults } from "../../src/config/diff-defaults.ts";
import { loadConfig } from "../../src/config/loader.ts";
import { serializeConfig } from "../../src/config/serialize.ts";

describe("diffFromDefaults", () => {
  it("returns an empty object when the config equals the defaults", () => {
    expect(diffFromDefaults(defineConfig({}))).toEqual({});
  });

  it("emits a default-on feature being disabled (fpLedger -> {enabled:false})", () => {
    const cfg = defineConfig({ phases: { fpLedger: { enabled: true } } });
    const off = defineConfig({ phases: { fpLedger: { enabled: false } } });
    expect(diffFromDefaults(off)).toEqual({ phases: { fpLedger: { enabled: false } } });
    expect(diffFromDefaults(cfg)).toEqual({ phases: { fpLedger: { enabled: true } } });
  });

  it("omits nullable features left at their default null (critic/brain)", () => {
    const d = diffFromDefaults(defineConfig({}));
    expect("critic" in (d.phases ?? {})).toBe(false);
    expect("brain" in (d.phases ?? {})).toBe(false);
  });

  it("re-emits the WHOLE reviewers array when any element differs", () => {
    const cfg = defineConfig({
      phases: {
        review: {
          reviewers: [
            { provider: "codex", persona: "security" },
            { provider: "gemini", persona: "architecture" },
          ],
        },
      },
    } as Parameters<typeof defineConfig>[0]);
    const d = diffFromDefaults(cfg);
    expect(d.phases?.review?.reviewers).toHaveLength(2);
  });
});

describe("serializeConfig + round-trip", () => {
  function roundTrip(cfg: ReturnType<typeof defineConfig>) {
    const partial = diffFromDefaults(cfg);
    const text = serializeConfig(partial as Record<string, unknown>);
    expect(text.startsWith("//")).toBe(true);
    expect(text).toContain("export default {");
    expect(text).not.toContain("defineConfig");
    const dir = mkdtempSync(join(tmpdir(), "rg-cfg-"));
    const file = join(dir, "reviewgate.config.ts");
    writeFileSync(file, text);
    return loadConfig(file);
  }

  it("round-trips a brain+reviewers config back to the same effective config", async () => {
    const cfg = defineConfig({
      phases: {
        review: {
          reviewers: [
            { provider: "codex", persona: "security" },
            { provider: "openrouter", persona: "adversarial" },
          ],
        },
        fpLedger: { enabled: true },
        brain: {
          enabled: true,
          embeddings: {
            provider: "openrouter",
            model: "baai/bge-base-en-v1.5",
            apiKeyEnv: "OPENROUTER_API_KEY",
          },
          curator: { provider: "codex", persona: "fp-filter" },
        },
      },
      providers: { openrouter: { enabled: true } },
    } as Parameters<typeof defineConfig>[0]);
    const reloaded = await roundTrip(cfg);
    expect(reloaded).toEqual(cfg);
  });

  it("round-trips the bare defaults to an empty `export default {}`", async () => {
    const reloaded = await roundTrip(defineConfig({}));
    expect(reloaded).toEqual(defineConfig({}));
  });
});
