// src/providers/complete-helpers.ts
// Shared bits for the CLI adapters' complete() (judge) path.
import { readFileSync } from "node:fs";

/** Read a capture file, returning "" if it is missing/unreadable (best-effort). */
export function readFileSafe(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * Human-readable failure reason for a complete() spawn. A timeout/watchdog kill
 * surfaces exitCode -1 from spawnSafely, which reads as a generic crash — so
 * distinguish those cases explicitly for diagnostics (the judge fails open to its
 * default regardless, but the error message lands in logs).
 */
export function failureReason(res: {
  killedByTimeout: boolean;
  killedByWatchdog: boolean;
  exitCode: number;
}): string {
  if (res.killedByTimeout) return "timeout";
  if (res.killedByWatchdog) return "watchdog-timeout";
  return `exit=${res.exitCode}`;
}
