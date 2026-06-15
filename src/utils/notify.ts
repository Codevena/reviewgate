// src/utils/notify.ts
import { type SpawnSyncOptions, spawnSync } from "node:child_process";
import { platform } from "node:os";

export type SpawnLike = (cmd: string, args: string[], opts?: SpawnSyncOptions) => unknown;

// Build the platform-native desktop-notification command. Returns null on an
// unsupported platform (caller no-ops). Body/title are passed as argv (no shell),
// so no escaping/injection concerns.
export function notifyCommand(
  title: string,
  body: string,
  plat: NodeJS.Platform = platform(),
): { cmd: string; args: string[] } | null {
  if (plat === "darwin") {
    // AppleScript display notification. Quote-escape for the -e script string.
    const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return {
      cmd: "osascript",
      args: ["-e", `display notification "${esc(body)}" with title "${esc(title)}"`],
    };
  }
  if (plat === "linux") {
    return { cmd: "notify-send", args: [title, body] };
  }
  return null;
}

// Hard wall on the notifier subprocess. A desktop notification fires AFTER the
// gate's verdict, so a hung osascript/notify-send (e.g. a stuck Notification
// Center, a wedged D-Bus) would block the Stop hook from returning and DROP the
// block decision → fail-open. Notifications are best-effort, so we kill the
// notifier well before that matters. spawnSync `timeout` SIGTERMs the child and
// returns; we ignore the (killed) result.
const NOTIFY_TIMEOUT_MS = 3_000;

// Fire a desktop notification. Best-effort: never throws, swallows any failure
// (e.g. osascript/notify-send missing). spawnImpl is injectable for tests.
export function notifyDesktop(title: string, body: string, spawnImpl: SpawnLike = spawnSync): void {
  const c = notifyCommand(title, body);
  if (!c) return;
  try {
    spawnImpl(c.cmd, c.args, { stdio: "ignore", timeout: NOTIFY_TIMEOUT_MS });
  } catch {
    // notifications are advisory — never let one break the gate
  }
}
