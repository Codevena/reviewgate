import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../utils/atomic-write.ts";

export type AgentHost = "claude" | "codex";
export type AgentHostSelection = AgentHost | "both";

interface HookCommand {
  type: "command";
  command: string;
  timeout: number;
  async?: boolean;
  statusMessage?: string;
}

interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
}

export type HookEvents = Record<string, HookGroup[]>;
export type HookDocument = Record<string, unknown> & { hooks?: Record<string, unknown[]> };

const MANAGED_COMMAND_MARKER = ".reviewgate/bin/";

export function hostsForSelection(selection: AgentHostSelection): AgentHost[] {
  return selection === "both" ? ["claude", "codex"] : [selection];
}

export function hookConfigPath(repoRoot: string, host: AgentHost): string {
  return host === "claude"
    ? join(repoRoot, ".claude", "settings.json")
    : join(repoRoot, ".codex", "hooks.json");
}

function shellSingleQuote(value: string): string {
  return value.replace(/'/g, "'\\''");
}

// Codex may start from a repository subdirectory. Resolve the git root first,
// with the init-time absolute root as a safe fallback for non-git projects. The
// Stop command has its own inline fail-closed branch for the one failure that
// happens before the shared gate shim can start (missing/unreachable shim).
function codexShimCommand(repoRoot: string, shim: "trigger" | "gate" | "reset"): string {
  const fallbackRoot = shellSingleQuote(repoRoot);
  const root = `ROOT="$(git rev-parse --show-toplevel 2>/dev/null || printf '%s' '${fallbackRoot}')"`;
  const executable = `"$ROOT/.reviewgate/bin/${shim}"`;
  if (shim === "gate") {
    const block = JSON.stringify({
      decision: "block",
      reason:
        "Reviewgate's Codex Stop gate could not start because the repository hook shim is missing or unreachable. Failing CLOSED so unreviewed changes are not silently allowed. Re-run `reviewgate init --hooks-only --host codex`, then `reviewgate doctor`.",
    });
    return `${root}; if [ -x ${executable} ] && cd "$ROOT"; then REVIEWGATE_AGENT_HOST=codex ${executable}; else printf '%s\\n' '${shellSingleQuote(block)}'; fi`;
  }
  return `${root}; if [ -x ${executable} ] && cd "$ROOT"; then REVIEWGATE_AGENT_HOST=codex ${executable}; fi`;
}

function claudeHooks(): HookEvents {
  return {
    PostToolUse: [
      {
        matcher: "Edit|Write|MultiEdit|NotebookEdit",
        hooks: [
          {
            type: "command",
            command: '"${CLAUDE_PROJECT_DIR}/.reviewgate/bin/trigger"',
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
        hooks: [
          {
            type: "command",
            command: '"${CLAUDE_PROJECT_DIR}/.reviewgate/bin/gate"',
            timeout: 2400,
          },
        ],
      },
    ],
    SessionStart: [
      {
        hooks: [
          {
            type: "command",
            command: '"${CLAUDE_PROJECT_DIR}/.reviewgate/bin/reset"',
            timeout: 30,
          },
        ],
      },
    ],
  };
}

function codexHooks(repoRoot: string): HookEvents {
  return {
    // Codex reports apply_patch as the canonical tool name, while Edit and Write
    // are supported matcher aliases. Bash covers simple shell mutations. The
    // working-tree and control-plane fingerprints remain the backstop for the
    // documented incomplete unified_exec interception.
    PostToolUse: [
      {
        matcher: "Bash|apply_patch|Edit|Write",
        hooks: [
          {
            type: "command",
            command: codexShimCommand(repoRoot, "trigger"),
            timeout: 5,
            // Codex currently skips async command hooks, so this must remain
            // synchronous. The trigger only writes a small atomic flag.
            statusMessage: "Reviewgate: tracking changes",
          },
        ],
      },
    ],
    Stop: [
      {
        hooks: [
          {
            type: "command",
            command: codexShimCommand(repoRoot, "gate"),
            timeout: 2400,
            statusMessage: "Reviewgate: reviewing the change set",
          },
        ],
      },
    ],
    SessionStart: [
      {
        matcher: "startup|resume|clear|compact",
        hooks: [
          {
            type: "command",
            command: codexShimCommand(repoRoot, "reset"),
            timeout: 30,
            statusMessage: "Reviewgate: preparing session state",
          },
        ],
      },
    ],
  };
}

function desiredHooks(repoRoot: string, host: AgentHost): HookEvents {
  return host === "claude" ? claudeHooks() : codexHooks(repoRoot);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function managedEntry(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.hooks)) return false;
  return value.hooks.some(
    (hook) =>
      isRecord(hook) &&
      typeof hook.command === "string" &&
      hook.command.includes(MANAGED_COMMAND_MARKER),
  );
}

function withoutManagedCommands(value: unknown): unknown | null {
  if (!isRecord(value) || !Array.isArray(value.hooks)) return value;
  const hooks = value.hooks.filter(
    (hook) =>
      !(
        isRecord(hook) &&
        typeof hook.command === "string" &&
        hook.command.includes(MANAGED_COMMAND_MARKER)
      ),
  );
  if (hooks.length === 0) return null;
  return hooks.length === value.hooks.length ? value : { ...value, hooks };
}

function productLabel(host: AgentHost): string {
  return host === "claude" ? "Claude Code" : "Codex";
}

function invalidHookFile(path: string, product: string, detail: string): never {
  const backupPath = `${path}.bak`;
  try {
    renameSync(path, backupPath);
  } catch {
    /* best effort; refusing to write is the important invariant */
  }
  throw new Error(
    `Reviewgate init aborted: ${path} exists but is not a valid ${product} hook document (${detail}). It has been backed up to ${backupPath} so nothing is lost. Fix or restore it, then re-run \`reviewgate init\`. Reviewgate refuses to overwrite foreign hooks or settings.`,
  );
}

// Path-keyed core. Extracted so the S4 user-scope installer can reuse the exact same
// validate/merge semantics against ~/.claude/settings.json instead of forking them —
// the "preserve foreign entries" behaviour below is the part that must never drift
// (an earlier audit logged "init wipes settings" as a HIGH finding).
export function readHookDocumentAt(path: string, product: string): HookDocument {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    invalidHookFile(path, product, err instanceof Error ? err.message : String(err));
  }
  if (!isRecord(parsed)) invalidHookFile(path, product, "top-level JSON value must be an object");
  if (parsed.hooks !== undefined && parsed.hooks !== null && !isRecord(parsed.hooks)) {
    invalidHookFile(path, product, "hooks must be an object");
  }
  const hooks = isRecord(parsed.hooks) ? parsed.hooks : {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) invalidHookFile(path, product, `hooks.${event} must be an array`);
  }
  return parsed as HookDocument;
}

export function installHookDocumentAt(
  path: string,
  document: HookDocument,
  desired: HookEvents,
): string {
  const current = isRecord(document.hooks) ? document.hooks : {};
  const next: Record<string, unknown[]> = { ...current };
  for (const [event, wanted] of Object.entries(desired)) {
    const existing = Array.isArray(current[event]) ? current[event] : [];
    const preserved = existing
      .map((entry) => withoutManagedCommands(entry))
      .filter((entry): entry is unknown => entry !== null);
    next[event] = [...preserved, ...wanted];
  }
  const output: HookDocument = { ...document, hooks: next };
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, JSON.stringify(output, null, 2));
  return path;
}

// Remove every Reviewgate-managed entry, dropping events left empty so an uninstall
// restores the document to its pre-install shape rather than leaving `Stop: []` behind.
export function stripManagedEntries(document: HookDocument): HookDocument {
  const current = isRecord(document.hooks) ? document.hooks : {};
  const next: Record<string, unknown[]> = {};
  for (const [event, groups] of Object.entries(current)) {
    const kept = (Array.isArray(groups) ? groups : [])
      .map((entry) => withoutManagedCommands(entry))
      .filter((entry): entry is unknown => entry !== null);
    if (kept.length > 0) next[event] = kept;
  }
  return { ...document, hooks: next };
}

// Read every selected host document before any host document is written. This
// lets a `--host both` install fail without partially updating one host first.
export function readHookDocument(repoRoot: string, host: AgentHost): HookDocument {
  return readHookDocumentAt(hookConfigPath(repoRoot, host), productLabel(host));
}

export function installHostHookDocument(
  repoRoot: string,
  host: AgentHost,
  document: HookDocument,
): string {
  return installHookDocumentAt(
    hookConfigPath(repoRoot, host),
    document,
    desiredHooks(repoRoot, host),
  );
}

export function hooksInstalled(repoRoot: string, host: AgentHost = "claude"): boolean {
  const path = hookConfigPath(repoRoot, host);
  if (!existsSync(path)) return false;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { hooks?: unknown };
    if (!isRecord(parsed.hooks)) return false;
    return Object.values(parsed.hooks).some(
      (groups) => Array.isArray(groups) && groups.some((entry) => managedEntry(entry)),
    );
  } catch {
    return false;
  }
}

export function installedHosts(repoRoot: string): AgentHost[] {
  return (["claude", "codex"] as const).filter((host) => hooksInstalled(repoRoot, host));
}

export function anyHooksInstalled(repoRoot: string): boolean {
  return installedHosts(repoRoot).length > 0;
}
