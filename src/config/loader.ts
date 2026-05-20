import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defaultConfig } from "./defaults.ts";
import { ConfigSchema, type ReviewgateConfig, defineConfig } from "./define-config.ts";

type PartialConfig = Parameters<typeof defineConfig>[0];

export async function loadConfig(path: string | null): Promise<ReviewgateConfig> {
  if (!path) return ConfigSchema.parse(defaultConfig);
  const abs = resolve(path);
  if (!existsSync(abs)) {
    throw new Error(`Config file not found: ${abs}`);
  }
  const mod = (await import(abs)) as { default?: unknown };
  if (!mod.default || typeof mod.default !== "object") {
    throw new Error(`Config file ${abs} must export a default config object.`);
  }
  // The default export is treated as a PARTIAL config and deep-merged over the
  // defaults, then validated. This means a user's reviewgate.config.ts can be a
  // plain object (no `import { defineConfig } from "reviewgate"` — that bare
  // package isn't installed in the target project and would fail to resolve,
  // silently dropping the user's config). Calling defineConfig again on a value
  // that already went through it is idempotent.
  return defineConfig(mod.default as PartialConfig);
}

export function defaultConfigPath(cwd: string): string {
  return resolve(cwd, "reviewgate.config.ts");
}
