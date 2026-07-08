import { spawnSync } from "node:child_process";
import type { ProviderId } from "./registry.ts";

// CLI providers resolve via a `--version` binary probe; openrouter has NO binary
// (it is an API-key check). claude-code runs the `claude` CLI.
export const PROVIDER_BIN: Record<ProviderId, string | null> = {
  codex: "codex",
  gemini: "agy",
  "claude-code": "claude",
  opencode: "opencode",
  openrouter: null,
  ollama: null,
};

export interface AvailabilityDeps {
  env?: Record<string, string | undefined>;
  probeBin?: (bin: string) => boolean;
}

function defaultProbeBin(bin: string): boolean {
  try {
    // A bounded probe on the failover critical path: a hung/wedged CLI must not
    // stall provider selection. `--version` should return near-instantly; cap it
    // so a misbehaving binary is treated as unavailable rather than blocking the
    // gate. timeout → status null (≠ 0) → unavailable; killSignal frees the child.
    return (
      spawnSync(bin, ["--version"], {
        encoding: "utf8",
        timeout: 5_000,
        killSignal: "SIGKILL",
      }).status === 0
    );
  } catch {
    return false;
  }
}

// Env vars that carry a SECRET (provider API keys/tokens, cloud creds, generic
// auth material). A reviewer subprocess inherits the host environment, which on a
// dev box routinely holds OTHER providers' keys — so a Gemini/opencode review
// would otherwise see the user's OpenAI/Anthropic/AWS/etc. secrets. We drop every
// secret-shaped var EXCEPT the ones the calling provider legitimately needs for
// its OWN auth (passed via `keepKeys`). Non-secret config (PATH, HOME, XDG_*,
// proxies, locale, NODE_*, the provider's own non-secret settings) is preserved
// so the reviewer is not broken — this is a denylist of secrets, not a tight
// allowlist of the whole environment.
const SECRET_KEY_PATTERNS: RegExp[] = [
  /API[_-]?KEY/i,
  /ACCESS[_-]?KEY/i,
  /SECRET/i,
  /(^|_)TOKEN($|_)/i,
  /PASSWORD/i,
  /PASSWD/i,
  /CREDENTIAL/i,
  /\bAUTH\b/i,
  /SESSION[_-]?KEY/i,
  /PRIVATE[_-]?KEY/i,
];

function looksSecret(name: string): boolean {
  return SECRET_KEY_PATTERNS.some((re) => re.test(name));
}

/**
 * Build a scrubbed environment for a reviewer subprocess: a shallow copy of
 * `source` with foreign secrets removed. Keys whose NAME looks like a secret
 * (API key / token / password / cloud credential) are dropped unless explicitly
 * listed in `keepKeys` (the provider's own auth var, e.g. the adapter's
 * apiKeyEnv). The provider then re-injects only its own key under the canonical
 * name the CLI expects. Caller-tunable so each adapter keeps exactly what it needs.
 */
export function scrubReviewerEnv(
  source: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  keepKeys: readonly string[] = [],
): Record<string, string> {
  const keep = new Set(keepKeys.filter(Boolean));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue;
    if (looksSecret(k) && !keep.has(k)) continue;
    out[k] = v;
  }
  return out;
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
  if (id === "ollama") return Boolean(env[apiKeyEnv ?? "OLLAMA_API_KEY"]);
  const bin = PROVIDER_BIN[id];
  return bin ? probe(bin) : false;
}
