import {
  constants,
  accessSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { writeShims } from "../cli/commands/init.ts";
import { writeFileAtomic } from "../utils/atomic-write.ts";
import { managedHookPath } from "../utils/paths.ts";
import {
  type HookDocument,
  type HookEvents,
  installHookDocumentAt,
  readHookDocumentAt,
  stripManagedEntries,
} from "./hooks.ts";

export type UserShim = "gate" | "trigger" | "reset";
export type HookEventName = "Stop" | "PostToolUse" | "SessionStart";

// The shims live under ~/.reviewgate/bin/ ON PURPOSE: that path contains the
// ".reviewgate/bin/" managed-command marker, so the existing merge, detection and removal
// logic in hooks.ts recognises user-scoped entries with no change — and
// installedGateStopTimeoutS's Stop-hook predicate matches them too.
export function userShimDir(home: string): string {
  return join(home, ".reviewgate", "bin");
}

export function userShimPath(home: string, shim: UserShim): string {
  return join(userShimDir(home), shim);
}

export function userClaudeSettingsPath(home: string): string {
  return join(home, ".claude", "settings.json");
}

// The EXACT commands each installer emits. Single source of truth: the installer writes
// these and the locator matches them, so the two cannot drift into a loose text rule —
// a command such as `echo .reviewgate/bin/gate` merely CONTAINS the marker and must not
// count as evidence that our hook will fire.
export const REPO_CLAUDE_COMMANDS: Record<HookEventName, string> = {
  Stop: '"${CLAUDE_PROJECT_DIR}/.reviewgate/bin/gate"',
  PostToolUse: '"${CLAUDE_PROJECT_DIR}/.reviewgate/bin/trigger"',
  SessionStart: '"${CLAUDE_PROJECT_DIR}/.reviewgate/bin/reset"',
};

const EVENT_SHIM: Record<HookEventName, UserShim> = {
  Stop: "gate",
  PostToolUse: "trigger",
  SessionStart: "reset",
};

export function userCommand(home: string, shim: UserShim): string {
  return `"${userShimPath(home, shim)}"`;
}

function hookEntriesFor(
  settingsPath: string,
  event: HookEventName,
): Array<{ command: string; timeout?: number }> {
  if (!existsSync(settingsPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      hooks?: Record<string, Array<{ hooks?: Array<{ command?: string; timeout?: number }> }>>;
    };
    return (parsed.hooks?.[event] ?? [])
      .flatMap((g) => g.hooks ?? [])
      .filter((h): h is { command: string; timeout?: number } => typeof h.command === "string");
  } catch {
    return []; // unreadable settings must never be read as evidence
  }
}

// A regular file carrying the execute bit. `existsSync` is not enough: a directory or a
// non-executable leftover cannot fire, and treating it as active would silence the
// user-scoped hook while nothing else runs.
function isRunnableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Returns the MATCHING hook entry, so activity and timeout are always read off the same
// entry rather than off two independently-found ones.
export function findManagedHook(
  settingsPath: string,
  event: HookEventName,
  command: string,
): { command: string; timeout?: number } | null {
  return hookEntriesFor(settingsPath, event).find((h) => h.command === command) ?? null;
}

// Will a repo-local CLAUDE hook for `event` actually fire in this checkout? This is the
// single predicate behind the shims' stand-down (via `hooks repo-hook-active`), the
// Stop-timeout selection and doctor. Restating it anywhere else re-opens the fail-open it
// exists to close.
export function repoClaudeHookActive(repoRoot: string, event: HookEventName): boolean {
  const shim = join(repoRoot, ".reviewgate", "bin", EVENT_SHIM[event]);
  return (
    isRunnableFile(shim) &&
    findManagedHook(
      join(repoRoot, ".claude", "settings.json"),
      event,
      REPO_CLAUDE_COMMANDS[event],
    ) !== null
  );
}

export function repoClaudeStopGateActive(repoRoot: string): boolean {
  // managedHookPath is the same ".reviewgate/bin/gate" the Stop mapping resolves to;
  // referencing it keeps this in step with the arming probe's notion of a managed hook.
  return isRunnableFile(managedHookPath(repoRoot)) && repoClaudeHookActive(repoRoot, "Stop");
}

// Positive evidence that a USER-scoped Stop gate will run: the Stop command must target
// THIS home's gate shim (not a stale path from an older install) and that shim must be
// runnable. `userHooksInstalled` stays the broader install-health signal (any managed
// entry in any event) and must NOT be used to answer "is this gated?".
export function userStopGateInstalled(home: string): boolean {
  return (
    isRunnableFile(userShimPath(home, "gate")) &&
    findManagedHook(userClaudeSettingsPath(home), "Stop", userCommand(home, "gate")) !== null
  );
}

// Commands come from userCommand(), the same helper the locator matches on, so the
// emitted string and the expected string can never drift.
function userHooks(home: string): HookEvents {
  return {
    PostToolUse: [
      {
        matcher: "Edit|Write|MultiEdit|NotebookEdit",
        hooks: [
          {
            type: "command",
            command: userCommand(home, "trigger"),
            timeout: 5,
            async: true,
            statusMessage: "Reviewgate: analyzing…",
          },
        ],
      },
    ],
    Stop: [
      {
        matcher: "*",
        hooks: [{ type: "command", command: userCommand(home, "gate"), timeout: 2400 }],
      },
    ],
    SessionStart: [
      {
        hooks: [{ type: "command", command: userCommand(home, "reset"), timeout: 30 }],
      },
    ],
  };
}

export function installUserHooks(home: string, binPath: string, tplDir: string): string {
  // Read (and validate) BEFORE writing anything, so a malformed settings file aborts the
  // install with nothing half-done.
  const document = readHookDocumentAt(userClaudeSettingsPath(home), "Claude Code");
  // Reuse init's writeShims: it renders the baked path through shSingleQuote, which is
  // what stops a binary path containing a quote from executing at hook time. tplDir is
  // resolved by the CALLER (resolveTemplateDir), because a compiled binary does not embed
  // bin-templates.
  mkdirSync(userShimDir(home), { recursive: true });
  writeShims(userShimDir(home), tplDir, binPath, [
    { template: "user-gate", dest: "gate" },
    { template: "user-trigger", dest: "trigger" },
    { template: "user-reset", dest: "reset" },
  ]);
  return installHookDocumentAt(userClaudeSettingsPath(home), document, userHooks(home));
}

export function removeUserHooks(home: string): void {
  const path = userClaudeSettingsPath(home);
  if (existsSync(path)) {
    const stripped: HookDocument = stripManagedEntries(readHookDocumentAt(path, "Claude Code"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileAtomic(path, `${JSON.stringify(stripped, null, 2)}\n`);
  }
  rmSync(userShimDir(home), { recursive: true, force: true });
}

export function userHooksInstalled(home: string): boolean {
  const path = userClaudeSettingsPath(home);
  if (!existsSync(path)) return false;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
    };
    return Object.values(parsed.hooks ?? {}).some((groups) =>
      (Array.isArray(groups) ? groups : []).some((entry) =>
        (entry.hooks ?? []).some((h) => h.command?.includes(".reviewgate/bin/")),
      ),
    );
  } catch {
    return false;
  }
}
