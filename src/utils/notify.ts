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

// Fire a desktop notification. Best-effort: never throws, swallows any failure
// (e.g. osascript/notify-send missing). spawnImpl is injectable for tests.
export function notifyDesktop(title: string, body: string, spawnImpl: SpawnLike = spawnSync): void {
  const c = notifyCommand(title, body);
  if (!c) return;
  try {
    spawnImpl(c.cmd, c.args, { stdio: "ignore" });
  } catch {
    // notifications are advisory — never let one break the gate
  }
}
