import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defaultConfig } from "./defaults.ts";
import { ConfigSchema, type ReviewgateConfig, defineConfig } from "./define-config.ts";
import { importConfigDefault } from "./import-config.ts";

type PartialConfig = Parameters<typeof defineConfig>[0];

export async function loadConfig(path: string | null): Promise<ReviewgateConfig> {
  if (!path) return ConfigSchema.parse(defaultConfig);
  const abs = resolve(path);
  if (!existsSync(abs)) {
    throw new Error(`Config file not found: ${abs}`);
  }
  // Read + data-parsed fresh on every call; config source is never executed.
  const def = await importConfigDefault(abs);
  if (!def || typeof def !== "object" || Array.isArray(def)) {
    throw new Error(`Config file ${abs} must export a default config object.`);
  }
  // The default export is treated as a PARTIAL config and deep-merged over the
  // defaults, then validated. This means a user's reviewgate.config.ts can be a
  // plain literal object. Executable TypeScript constructs are rejected by the
  // parser before this merge; defineConfig performs the schema validation.
  return defineConfig(def as PartialConfig);
}

export function defaultConfigPath(cwd: string): string {
  return resolve(cwd, "reviewgate.config.ts");
}
