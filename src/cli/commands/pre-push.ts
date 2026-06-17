import { existsSync } from "node:fs";
import { defaultConfigPath, loadConfig } from "../../config/loader.ts";
import { evaluatePrePush } from "../../core/pre-push-check.ts";
import { StateStore } from "../../core/state-store.ts";
import type { ReviewgateState } from "../../schemas/state.ts";
import { stateJsonPath } from "../../utils/paths.ts";

// Rec #3 (deep half) — the `reviewgate pre-push` git-hook entry point. WARN-ONLY by design: it
// prints an advisory to stderr and ALWAYS exits 0, so it can never block a legitimate push (the
// Stop-hook already gates the turn; a local git hook is bypassable anyway, so the hard guarantee
// belongs in CI). It only surfaces "the commit being pushed has no recorded clean Reviewgate
// PASS — not deploy-ready", closing the field-report gap where a clean turn-end pass was pushed
// before a deep review ran.

export interface PrePushInput {
  repoRoot: string;
  /** Raw git pre-push stdin: "<local ref> <local oid> <remote ref> <remote oid>" per line. */
  stdinRaw: string;
}

const ALL_ZERO = /^0+$/;

/** Extract the non-deletion local tip oids git hands the pre-push hook on stdin. */
export function parsePushedShas(stdinRaw: string): string[] {
  const shas = new Set<string>();
  for (const line of stdinRaw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const localOid = trimmed.split(/\s+/)[1]; // field 2 = local sha being pushed
    if (localOid && !ALL_ZERO.test(localOid)) shas.add(localOid);
  }
  return [...shas];
}

/**
 * Evaluate the pre-push gate. Returns stderr text + an exit code that is ALWAYS 0 (warn-only).
 * Fully fail-safe: any config/state read error degrades to "no recorded review" (a warning),
 * never an exception that could break the user's push.
 */
export async function runPrePush(
  input: PrePushInput,
): Promise<{ stderr: string; exitCode: number }> {
  // Config (best-effort): if it can't be read, fall back to defaults (loadConfig(null)).
  let enabled = true;
  try {
    const cfgPath = defaultConfigPath(input.repoRoot);
    const config = await loadConfig(existsSync(cfgPath) ? cfgPath : null);
    enabled = config.loop.prePushWarn !== false;
  } catch {
    enabled = true; // default-on; a broken config must not silence the safety nudge
  }
  if (!enabled) return { stderr: "", exitCode: 0 };

  const pushedShas = parsePushedShas(input.stdinRaw);

  // State (best-effort): absent/unreadable → null → evaluated as "no recorded review".
  let state: ReviewgateState | null = null;
  try {
    if (existsSync(stateJsonPath(input.repoRoot))) {
      state = await new StateStore(input.repoRoot).load();
    }
  } catch {
    state = null;
  }

  const verdict = evaluatePrePush({ pushedShas, state });
  if (verdict.ok) return { stderr: "", exitCode: 0 };

  const stderr = [
    `⚠ Reviewgate pre-push: ${verdict.reason}.`,
    "  This push is NOT confirmed deploy-ready by Reviewgate. If you have push-to-deploy",
    "  (e.g. Coolify/Vercel auto-deploy on main), let the gate finish a clean review of this",
    "  exact commit first, or rely on a CI check. This is advisory only — the push proceeds.",
    "  (disable: set `loop.prePushWarn: false` in reviewgate.config.ts)",
    "",
  ].join("\n");
  return { stderr, exitCode: 0 };
}
