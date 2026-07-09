// src/utils/stop-hook-timeout.ts
//
// Reads the INSTALLED Stop-hook timeout (seconds) for the reviewgate gate from
// the checkout's .claude/settings.json. The loop-driver clamps its self-deadline
// to this so the fail-open invariant (budgets.ts: setup + runTimeoutMs + settle
// < OS Stop-hook timeout) is SELF-ENFORCING: a binary upgrade that raises the
// default loop.runTimeoutMs (720s→1800s, 2026-07-09) must not push the deadline
// past a pre-upgrade 900s hook timeout — the OS would kill the hook mid-review
// (non-blocking) and the turn would end UN-reviewed, silently, every retry.
//
// Returns null when unknown (no settings file / unparseable / gate hook or its
// timeout absent) — the caller then trusts the configured deadline unchanged.
// Parsing mirrors doctor's hookTimeoutCheck (which additionally inspects the
// SessionStart hook); keep the two hook-locating predicates in sync.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function installedGateStopTimeoutS(repoRoot: string): number | null {
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
  const t = stop?.timeout;
  return typeof t === "number" && Number.isFinite(t) && t > 0 ? t : null;
}
