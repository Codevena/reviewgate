import { spawnSync } from "node:child_process";
import type { ProviderId } from "./registry.ts";

// CLI providers resolve via a `--version` binary probe; openrouter has NO binary
// (it is an API-key check). claude-code runs the `claude` CLI.
export const PROVIDER_BIN: Record<ProviderId, string | null> = {
  codex: "codex",
  gemini: "gemini",
  "claude-code": "claude",
  opencode: "opencode",
  openrouter: null,
};

export interface AvailabilityDeps {
  env?: Record<string, string | undefined>;
  probeBin?: (bin: string) => boolean;
}

function defaultProbeBin(bin: string): boolean {
  try {
    return spawnSync(bin, ["--version"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
}

// Whether a provider can actually run. For openrouter: the configured key env var
// (apiKeyEnv, default OPENROUTER_API_KEY) must be set. For CLI providers: the
// binary must respond to `--version`. Dependencies are injected for testability.
export function isProviderAvailable(
  id: ProviderId,
  apiKeyEnv: string | undefined,
  deps: AvailabilityDeps = {},
): boolean {
  const env = deps.env ?? (process.env as Record<string, string | undefined>);
  const probe = deps.probeBin ?? defaultProbeBin;
  if (id === "openrouter") return Boolean(env[apiKeyEnv ?? "OPENROUTER_API_KEY"]);
  const bin = PROVIDER_BIN[id];
  return bin ? probe(bin) : false;
}
