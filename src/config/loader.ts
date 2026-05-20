import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defaultConfig } from "./defaults.ts";
import { ConfigSchema, type ReviewgateConfig } from "./define-config.ts";

export async function loadConfig(path: string | null): Promise<ReviewgateConfig> {
  if (!path) return ConfigSchema.parse(defaultConfig);
  const abs = resolve(path);
  if (!existsSync(abs)) {
    throw new Error(`Config file not found: ${abs}`);
  }
  const mod = (await import(abs)) as { default?: ReviewgateConfig };
  if (!mod.default) {
    throw new Error(`Config file ${abs} must export a default config from defineConfig().`);
  }
  // The default export is already schema-validated by defineConfig, but re-validate
  // here defensively (handles malformed JS that bypasses the helper).
  return ConfigSchema.parse(mod.default);
}

export function defaultConfigPath(cwd: string): string {
  return resolve(cwd, "reviewgate.config.ts");
}
