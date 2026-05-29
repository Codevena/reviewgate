import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  type DeepPartial,
  type ReviewgateConfig,
  deepMerge,
  defineConfig,
} from "./define-config.ts";
import { importConfigDefault } from "./import-config.ts";

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

// Reads a config file's RAW default-export partial (NOT through defineConfig). A
// missing file yields null silently (that layer just isn't present). A file that
// EXISTS but fails to import (syntax/runtime error) or doesn't export an object is
// dropped too — but NOT silently: we warn, because a quietly-ignored config the
// user actually wrote is the failure mode this tool exists to prevent. Imported
// FRESH (importConfigDefault) so a same-process overwrite isn't served stale.
async function readRawPartial(path: string | null): Promise<DeepPartial<ReviewgateConfig> | null> {
  if (!path || !existsSync(path)) return null;
  try {
    const def = await importConfigDefault(resolve(path));
    if (def && typeof def === "object") {
      return def as DeepPartial<ReviewgateConfig>;
    }
    console.warn(
      `[reviewgate] config at ${path} has no default-export object — ignoring it (using defaults/lower layers).`,
    );
  } catch (err) {
    console.warn(
      `[reviewgate] failed to load config at ${path} — ignoring it (using defaults/lower layers). ${(err as Error).message}`,
    );
  }
  return null;
}

export interface EffectiveConfigInput {
  cwd: string;
  env?: Record<string, string | undefined>;
  home?: string;
}

// Effective config = defaults <- global <- project. Validated once at the end.
export async function loadEffectiveConfig(input: EffectiveConfigInput): Promise<ReviewgateConfig> {
  const env = input.env ?? (process.env as Record<string, string | undefined>);
  const home = input.home ?? ""; // empty/non-absolute => no global layer (resolveGlobalConfigPath returns null)
  const globalPath = resolveGlobalConfigPath(env, home);
  const globalPartial = await readRawPartial(globalPath);
  const projectPartial = await readRawPartial(join(input.cwd, "reviewgate.config.ts"));
  // Merge the two partials (project wins). Base is cast to the full type so the
  // generic resolves to <ReviewgateConfig>; the result is re-validated by defineConfig
  // (which also re-merges over defaults), so the cast is structural only.
  const merged = deepMerge(
    (globalPartial ?? {}) as ReviewgateConfig,
    (projectPartial ?? {}) as DeepPartial<ReviewgateConfig>,
  );
  try {
    return defineConfig(merged as Parameters<typeof defineConfig>[0]);
  } catch (err) {
    // A merged config that fails validation degrades to defaults (gate stays
    // functional) — but NOT silently: a quietly-ignored config is exactly the
    // failure mode this tool exists to prevent. Surface the offending field(s).
    //
    // Salvage a deliberately FAIL-CLOSED sandbox.mode: one unrelated typo must not
    // silently downgrade isolation to the unisolated "off" default (a real security
    // regression hidden behind a single warn line). "strict"/"permissive" both
    // fail closed, so preserving them is always at least as safe as defaults (F-047).
    const rawMode = (merged as { sandbox?: { mode?: unknown } }).sandbox?.mode;
    const salvage = rawMode === "strict" || rawMode === "permissive";
    console.warn(
      `[reviewgate] invalid config ignored — using defaults instead${
        salvage ? ` (preserved fail-closed sandbox.mode="${rawMode}")` : ""
      }. ${describeConfigError(err)}`,
    );
    return defineConfig(salvage ? { sandbox: { mode: rawMode } } : {});
  }
}

// Format a config-validation failure for the warning. ZodError carries an
// `issues[]` with a `path` + `message` per violation; anything else stringifies.
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
