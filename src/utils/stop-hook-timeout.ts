// src/utils/stop-hook-timeout.ts
//
// Reads the INSTALLED Stop-hook timeout (seconds) for the reviewgate gate. The
// loop-driver clamps its self-deadline to this so the fail-open invariant
// (budgets.ts: setup + runTimeoutMs + settle < OS Stop-hook timeout) is
// SELF-ENFORCING: a binary upgrade that raises the default loop.runTimeoutMs
// (720s→1800s, 2026-07-09) must not push the deadline past a pre-upgrade 900s
// hook timeout — the OS would kill the hook mid-review (non-blocking) and the
// turn would end UN-reviewed, silently, every retry.
//
// S4: a repo can now also be gated by USER-scoped hooks (~/.claude/settings.json)
// with no repo-local hook at all. Reading only the checkout would return null
// there, leaving the deadline unclamped against whatever the global hook carries.
//
// Returns null when unknown (no settings file / unparseable / gate hook or its
// timeout absent) — the caller then trusts the configured deadline unchanged.
// Parsing mirrors doctor's hookTimeoutCheck (which additionally inspects the
// SessionStart hook); keep the two hook-locating predicates in sync.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  findManagedHook,
  repoClaudeStopGateActive,
  userClaudeSettingsPath,
  userCommand,
} from "../hosts/user-hooks.ts";

function positiveTimeout(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

// Deliberately TOLERANT about the command spelling, unlike the stand-down predicate.
// The two answer different questions: the stand-down asks "will OUR hook fire?" and must
// be exact, because a foreign command that merely mentions the path must never silence
// the user-scoped gate. This asks "what wall-clock will the OS enforce?", where the bad
// outcome is losing the clamp entirely — an older `init` that wrote a different command
// spelling would otherwise run UNCLAMPED against a real OS timeout, which is precisely
// the silent mid-review kill this module exists to prevent.
// It deliberately does NOT require the shim to exist: that is the "who is firing?"
// question, and answering it here would mean returning null — no clamp at all — for a
// configuration that plainly states a timeout.
function repoGateTimeout(repoRoot: string): number | null {
  const settingsPath = join(repoRoot, ".claude", "settings.json");
  if (!existsSync(settingsPath)) return null;
  let settings: {
    hooks?: Record<string, Array<{ hooks?: Array<{ command?: string; timeout?: number }> }>>;
  };
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    return null; // unreadable/corrupt settings must never break the gate
  }
  const stop = (settings.hooks?.Stop ?? [])
    .flatMap((g) => g.hooks ?? [])
    .find((h) => h.command?.includes(".reviewgate/bin/gate"));
  return positiveTimeout(stop?.timeout);
}

function userGateTimeout(home: string): number | null {
  return positiveTimeout(
    findManagedHook(userClaudeSettingsPath(home), "Stop", userCommand(home, "gate"))?.timeout,
  );
}

// `home` defaults to the real one, so callers that do not thread it (LoopDriver) read this
// machine's user settings. That is correct in production and harmless in tests today
// because the clamp takes the SMALLEST applicable timeout and the user-scope default
// (2400s) is the largest value in play — but a test asserting an exact clamp should pass
// an explicit home rather than rely on that.
export function installedGateStopTimeoutS(
  repoRoot: string,
  home: string = homedir(),
): number | null {
  // The repo hook alone applies exactly when the user shim provably stands down — same
  // predicate the shim queries, so the two cannot disagree about who is running.
  if (repoClaudeStopGateActive(repoRoot)) return repoGateTimeout(repoRoot);
  // Otherwise the user hook runs. A legacy-spelled repo hook may run ALONGSIDE it (it
  // fires, but did not make the user shim stand down), so clamp to the tightest deadline
  // any firing hook imposes rather than picking one and hoping.
  const candidates = [repoGateTimeout(repoRoot), userGateTimeout(home)].filter(
    (t): t is number => t !== null,
  );
  return candidates.length > 0 ? Math.min(...candidates) : null;
}
