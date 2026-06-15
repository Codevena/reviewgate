// src/cli/hook-stdin.ts
import { withTimeout } from "../utils/with-timeout.ts";

// Read the Claude Code hook payload from stdin for `reviewgate gate`. The real
// hooks (Stop/PostToolUse/SessionStart) ALWAYS pipe a JSON payload, so stdin is a
// pipe (non-TTY) with a definite EOF. But when a human runs `reviewgate gate
// --hook reset` (or any hook) directly in a terminal, stdin is an interactive TTY
// that never sends EOF — `Bun.stdin.text()` would block forever, so the command
// appears to "do nothing" (it is actually hung). On a TTY there is no piped hook
// payload to read, so return "" immediately and let the gate proceed.
//
// Even on a non-TTY pipe the read is BOUNDED (READ_TIMEOUT_MS): a pipe that is
// connected but never sends EOF (a wedged parent, a kept-open fd) would otherwise
// hang the gate BEFORE any review budget runs, until the OS Stop-hook timeout kills
// the process with empty stdout = fail-OPEN. The actual diff comes from dirty.flag
// on disk, NOT stdin (stdin only carries stop_hook_active / session.model hints), so
// on timeout we return what we have (almost always "") and let the gate PROCEED —
// it still runs the real review and fails CLOSED if anything is wrong. A timeout
// must never silently end the turn.
const READ_TIMEOUT_MS = 5_000;

export async function readHookStdin(opts?: {
  isTTY?: boolean;
  read?: () => Promise<string>;
  timeoutMs?: number;
}): Promise<string> {
  const isTTY = opts?.isTTY ?? Boolean(process.stdin.isTTY);
  if (isTTY) return "";
  const read = opts?.read ?? (() => Bun.stdin.text());
  const timeoutMs = opts?.timeoutMs ?? READ_TIMEOUT_MS;
  try {
    return await withTimeout(read(), timeoutMs, "hook-stdin-read");
  } catch {
    // Read error OR timeout → proceed with no payload; the gate runs regardless
    // (the diff is on disk) and fails closed. Returning "" is NOT "allow".
    return "";
  }
}
