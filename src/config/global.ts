import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  type DeepPartial,
  type ReviewgateConfig,
  deepMerge,
  defineConfig,
} from "./define-config.ts";
import { parseConfigSource } from "./import-config.ts";

export function resolveGlobalConfigPath(
  env: Record<string, string | undefined>,
  home: string,
): string | null {
  const xdg = env.XDG_CONFIG_HOME;
  const base =
    xdg && isAbsolute(xdg) ? xdg : home && isAbsolute(home) ? join(home, ".config") : null;
  if (!base) return null;
  return join(base, "reviewgate", "reviewgate.config.ts");
}

export interface ConfigLayerSnapshot {
  path: string | null;
  source: string | null;
  sourceHash: string;
  partial: DeepPartial<ReviewgateConfig> | null;
}

export interface EffectiveConfigSnapshot {
  config: ReviewgateConfig;
  project: ConfigLayerSnapshot;
  global: ConfigLayerSnapshot;
  sourceFingerprint: string;
  hasCustomSource: boolean;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function layerSourceHash(path: string | null, source: string | null): string {
  // An absent layer is semantically identical regardless of which conventional
  // path was probed (e.g. init without HOME vs. the Stop hook with HOME). Do not
  // create a source-only policy event merely because the absent path string differs.
  return source === null ? sha256("absent") : sha256(`present\0${path ?? ""}\0${source}`);
}

function readLayerSource(path: string | null): {
  path: string | null;
  source: string | null;
  sourceHash: string;
} {
  if (!path || !existsSync(path))
    return { path, source: null, sourceHash: layerSourceHash(path, null) };
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`Failed to read Reviewgate config at ${path}: ${(err as Error).message}`);
  }
  return { path, source, sourceHash: layerSourceHash(path, source) };
}

function readLayer(path: string | null): ConfigLayerSnapshot {
  const layer = readLayerSource(path);
  if (layer.source === null) return { ...layer, partial: null };
  const source = layer.source;
  const parsed = parseConfigSource(source, path ?? "reviewgate.config.ts");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Reviewgate config at ${path} must default-export a plain object.`);
  }
  return {
    path,
    source,
    sourceHash: layer.sourceHash,
    partial: parsed as DeepPartial<ReviewgateConfig>,
  };
}

export interface EffectiveConfigInput {
  cwd: string;
  env?: Record<string, string | undefined>;
  home?: string;
}

// Raw-byte fingerprint used by the control plane even when parsing fails. This
// lets an invalid current config be identified as a distinct pending candidate
// while the gate continues reviewing code under the last-known-good snapshot.
export function inspectConfigSources(input: EffectiveConfigInput): {
  sourceFingerprint: string;
  hasCustomSource: boolean;
} {
  const env = input.env ?? (process.env as Record<string, string | undefined>);
  const home = input.home ?? "";
  const global = readLayerSource(resolveGlobalConfigPath(env, home));
  const project = readLayerSource(resolve(input.cwd, "reviewgate.config.ts"));
  return {
    sourceFingerprint: sha256(`${global.sourceHash}\0${project.sourceHash}`),
    hasCustomSource: global.source !== null || project.source !== null,
  };
}

function describeConfigError(err: unknown): string {
  if (err && typeof err === "object" && "issues" in err) {
    const issues = (err as { issues: Array<{ path?: Array<string | number>; message: string }> })
      .issues;
    return issues
      .map((i) => `${i.path && i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`)
      .join("; ");
  }
  return String((err as { message?: string })?.message ?? err);
}

// Effective config = defaults <- global <- project. A PRESENT invalid layer is a
// control-plane failure and MUST throw. Falling back to defaults can silently
// disable strict sandboxing, deterministic checks or reviewers and mint a green
// verdict under a weaker policy.
export async function loadEffectiveConfigSnapshot(
  input: EffectiveConfigInput,
): Promise<EffectiveConfigSnapshot> {
  const env = input.env ?? (process.env as Record<string, string | undefined>);
  const home = input.home ?? "";
  const global = readLayer(resolveGlobalConfigPath(env, home));
  const project = readLayer(resolve(input.cwd, "reviewgate.config.ts"));
  const merged = deepMerge(
    (global.partial ?? {}) as ReviewgateConfig,
    (project.partial ?? {}) as DeepPartial<ReviewgateConfig>,
  );
  let config: ReviewgateConfig;
  try {
    config = defineConfig(merged as Parameters<typeof defineConfig>[0]);
  } catch (err) {
    throw new Error(`Invalid Reviewgate configuration: ${describeConfigError(err)}`);
  }
  return {
    config,
    project,
    global,
    sourceFingerprint: sha256(`${global.sourceHash}\0${project.sourceHash}`),
    hasCustomSource: global.source !== null || project.source !== null,
  };
}

export async function loadEffectiveConfig(input: EffectiveConfigInput): Promise<ReviewgateConfig> {
  return (await loadEffectiveConfigSnapshot(input)).config;
}
