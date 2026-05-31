// src/cli/hook-stdin.ts
// Read the Claude Code hook payload from stdin for `reviewgate gate`. The real
// hooks (Stop/PostToolUse/SessionStart) ALWAYS pipe a JSON payload, so stdin is a
// pipe (non-TTY) with a definite EOF. But when a human runs `reviewgate gate
// --hook reset` (or any hook) directly in a terminal, stdin is an interactive TTY
// that never sends EOF — `Bun.stdin.text()` would block forever, so the command
// appears to "do nothing" (it is actually hung). On a TTY there is no piped hook
// payload to read, so return "" immediately and let the gate proceed.
export async function readHookStdin(opts?: {
  isTTY?: boolean;
  read?: () => Promise<string>;
}): Promise<string> {
  const isTTY = opts?.isTTY ?? Boolean(process.stdin.isTTY);
  if (isTTY) return "";
  const read = opts?.read ?? (() => Bun.stdin.text());
  try {
    return await read();
  } catch {
    return "";
  }
}
