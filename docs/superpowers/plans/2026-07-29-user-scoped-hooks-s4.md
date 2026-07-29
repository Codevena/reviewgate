# S4 — User-scoped Hooks (`init --user`): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `reviewgate init --user` installs Claude Code hooks in `~/.claude/settings.json` plus shims in `~/.reviewgate/bin/`, so the gate exists in repos nobody ran `init` in — standing down silently where repo-local hooks already fire, failing OPEN when the binary is unresolvable, and never running unclamped against an unknown OS hook timeout.

**Architecture:** The repo-local install path already merges rather than overwrites, identifies its own entries by the `".reviewgate/bin/"` command marker, and refuses+backs-up malformed hook files. S4 reuses all of that by extracting the path-keyed core of `src/hosts/hooks.ts` into two helpers and adding a thin user-scope module on top; the only behavioural change outside install/shims/doctor is a fallback in `installedGateStopTimeoutS`. `gate.ts` is not touched — S2/S3 already deliver what the user-scoped case needs.

**Tech Stack:** Bun, TypeScript, zod, `bun test`, bash (shim templates). No new dependencies.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-29-user-scoped-hooks-s4-design.md` (normative). Parent slice: `docs/superpowers/specs/2026-07-17-arming-consent-design.md` §S4.
- **Claude Code only.** No Codex-host user-level hooks — its support is unverified (spec §4).
- **Never write to the real `~/.claude/settings.json` from tests.** Every test passes a temp `home`. A broken global Stop hook breaks every Claude Code session on this machine, including the one running the tests.
- **Merge, never overwrite.** `~/.claude/settings.json` is the user's global config for every project. An earlier audit logged "init wipes settings" as a HIGH finding; re-introducing it at global scope would be strictly worse.
- **The user shim must never print to stdout** except to pass the gate's own output through. stdout is the decision channel, and per the hook protocol a Stop hook cannot express "allow" — so anything Reviewgate prints there can only ever *add* a block.
- **ONE predicate, implemented in TypeScript, shared by all three consumers.** The
  stand-down, the Stop-timeout selection and `doctor` must agree exactly; two independent
  formulations drift, and a drift in either direction re-opens a silent fail-open
  (plan-gate round 2, CRITICAL #1/#2). A raw `grep` over `.claude/settings.json` is NOT
  acceptable evidence: the marker can appear in a PostToolUse entry, an env value or any
  unrelated setting, producing a FALSE stand-down. The shim therefore asks the binary
  (`reviewgate hooks repo-gate-active`, exit 0 = a repo-local Claude Stop gate will fire)
  instead of parsing JSON in bash. When the binary is unresolvable the shim is already in
  its fail-open branch, so nothing is lost.
- **The stand-down requires POSITIVE evidence; any doubt means RUN.** Standing down when nothing else fires is a silent fail-open (the turn ends un-reviewed); running twice merely costs a lock wait and reviewer quota. `.reviewgate/bin/` shims are written **host-independently** (`src/cli/commands/init.ts:271`, before any host document is installed), so an executable `.reviewgate/bin/gate` proves nothing about Claude Code — a `reviewgate init --host codex` repo has that shim and NO Claude hook at all. The evidence required is the repo's `.claude/settings.json` naming a Reviewgate Stop command **and** the shim being executable. (Plan-gate round 1, CRITICAL #3.)
- **The user shim must never emit `continue:false`.** It is the one field documented to take precedence over another hook's decision, and a globally installed hook must not do that to tools it knows nothing about. (`formatAllowStopJson` in `src/hooks/handlers.ts:363` still contains that pattern but has zero callers — do not call it, do not copy it, and do not delete it here either; unrelated cleanup.)
- **Fail direction is INVERTED versus repo-local.** `bin-templates/gate.sh` fails CLOSED on an unresolvable binary; the user shim must fail OPEN with a stderr warning (spec §3.2, arming spec §4).
- Runtime is Bun: `bun test`, `bunx tsc --noEmit`, `bun run lint` (biome) must all be clean.
- Never `git add -A` in this repo (stages `.reviewgate/` runtime state). Stage explicit paths.
- Commits carry no `Co-Authored-By` line. Do not push; Markus decides that separately.

---

## File Structure

- **Modify `src/hosts/hooks.ts`** — extract the path-keyed core (`readHookDocumentAt`, `installHookDocumentAt`, `stripManagedEntries`) and keep today's `readHookDocument`/`installHostHookDocument`/`hooksInstalled` as thin wrappers. Pure refactor, no behaviour change: the existing tests are the proof.
- **Create `src/hosts/user-hooks.ts`** — user-scope paths, the desired hook document, install and remove. Separate file because its inputs are a `home` rather than a `repoRoot`, and mixing the two invites passing the wrong one.
- **Create `bin-templates/user-{gate,trigger,reset}.sh`** — the three user shims.
- **Modify `src/cli/commands/init.ts` + `src/cli/index.ts`** — `--user` and `--user --remove`.
- **Modify `src/utils/stop-hook-timeout.ts`** — fall back to the user settings file.
- **Modify `src/cli/commands/doctor.ts`** — user-scope checks; make `worktreeGatedCheck` honest about a worktree gated only by user-scoped hooks.
- **Tests:** `tests/unit/user-hooks-install.test.ts`, `tests/unit/user-shim-behavior.test.ts`, `tests/unit/stop-hook-timeout-user-fallback.test.ts`, plus extensions to the existing doctor tests.

---

### Task 0: Shared shim plumbing (must land FIRST)

**Files:**
- Modify: `src/cli/commands/init.ts:61-71` (`writeShims`) and `:247-260` (template-dir resolution)
- Modify: `scripts/build-npm-packages.ts:122`, `scripts/verify-publish.ts:65`
- Test: the existing init/packaging tests are the regression proof; add one quoting case

**Why this task exists (plan-gate round 1, CRITICAL #1 + #2):** the first draft of Task 2
resolved templates via `new URL("../../bin-templates/…", import.meta.url)` and substituted
the binary path with a raw `replaceAll`. Both are wrong against this codebase:

- `init.ts:247-260` deliberately probes **three** locations —
  `dirname(process.execPath)/bin-templates` first — because a compiled Bun binary does
  **not** embed `bin-templates`; `build-npm-packages.ts:113-123` copies them next to the
  executable. An `import.meta.url` base works under `bun run dev` and fails in every
  shipped binary.
- `init.ts:68` renders the baked path through `shSingleQuote` precisely because
  `process.execPath` can contain shell metacharacters that would otherwise EXECUTE at hook
  time (the comment at `:18-26` says so). A raw substitution reintroduces that hole.
- `build-npm-packages.ts:122` and `verify-publish.ts:65` hard-code the four existing
  template names, so new templates would silently not ship — and `verify-publish` would
  not notice.

**Interfaces:**
- Produces: `export function resolveTemplateDir(): string` and a generalised
  `export function writeShims(binDir: string, tplDir: string, bakedBin: string, shims?: Array<{ template: string; dest: string }>): void` — both consumed by Task 2.

- [ ] **Step 1: Extract the template-dir resolver**

Lift `init.ts:247-260`'s candidate list verbatim into an exported function, and call it from
`runInit`. Keep the comment — it is the record of why three candidates exist.

```ts
export function resolveTemplateDir(): string {
  const here = fileURLToPath(import.meta.url);
  const candidates = [
    join(dirname(process.execPath), "bin-templates"),
    join(here, "..", "..", "..", "..", "bin-templates"),
    join(process.cwd(), "bin-templates"),
  ];
  const tplDir = candidates.find((c) => existsSync(c));
  if (!tplDir) throw new Error(`bin-templates not found in: ${candidates.join(", ")}`);
  return tplDir;
}
```

- [ ] **Step 2: Generalise `writeShims` without changing its default behaviour**

```ts
const REPO_SHIMS = [
  { template: "trigger", dest: "trigger" },
  { template: "gate", dest: "gate" },
  { template: "reset", dest: "reset" },
  { template: "pre-push", dest: "pre-push" },
];

export function writeShims(
  binDir: string,
  tplDir: string,
  bakedBin: string,
  shims: Array<{ template: string; dest: string }> = REPO_SHIMS,
): void {
  for (const { template, dest } of shims) {
    const tpl = readFileSync(join(tplDir, `${template}.sh`), "utf8");
    const out = join(binDir, dest);
    writeFileSync(out, tpl.split("__REVIEWGATE_BIN__").join(shSingleQuote(bakedBin)));
    chmodSync(out, 0o755);
  }
}
```

- [ ] **Step 3: (moved to Task 3 — see note)**

**Moved to Task 3 Step 3b, discovered while implementing Task 0.** Extending the packaging
lists here would name `user-*.sh` files that do not exist until Task 3, so every build and
`verify-publish` run in between would fail on missing templates. The list update has to land
in the same task as the templates themselves. What must happen there is unchanged: extend
`scripts/build-npm-packages.ts:122`, `scripts/verify-publish.ts:65` **and**
`tests/unit/verify-publish.test.ts:44` (a third hard-coded list, plan-gate round 2 INFO) —
all three together, or a template ships unverified.

- [ ] **Step 4: Add the quoting regression test**

```ts
test("writeShims single-quotes a baked path containing a quote", () => {
  const binDir = mkdtempSync(join(tmpdir(), "rg-shim-quote-"));
  writeShims(binDir, resolveTemplateDir(), "/opt/we're/reviewgate");
  const gate = readFileSync(join(binDir, "gate"), "utf8");
  // POSIX single-quote escaping: ' -> '\''. A raw substitution would terminate the
  // quoted assignment and let the rest of the path execute at hook time.
  expect(gate).toContain(`RG_BIN='/opt/we'\\''re/reviewgate'`);
});
```

- [ ] **Step 5: Prove nothing else changed**

Run: `bun test tests/unit tests/integration` → same pass count as before plus the new test,
0 fail. The default parameter means every existing `writeShims` call is untouched.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/init.ts scripts/build-npm-packages.ts scripts/verify-publish.ts tests/unit
git commit -m "refactor(init): reusable template resolution and shim rendering (S4 prep)"
```

---

### Task 1: Extract the path-keyed hook-document core

**Files:**
- Modify: `src/hosts/hooks.ts:168-250`
- Test: the existing hook/init tests are the regression proof (no new test file)

**Interfaces:**
- Produces: `export function readHookDocumentAt(path: string, product: string): HookDocument`, `export function installHookDocumentAt(path: string, document: HookDocument, desired: HookEvents): string`, `export function stripManagedEntries(document: HookDocument): HookDocument`, and `export type { HookDocument, HookEvents }` — all consumed by Task 2.

**Why first:** Task 2 needs exactly the merge semantics that already exist and are already tested. Copying them into a second module would fork the "preserve foreign entries" logic, which is the part that must not drift.

- [ ] **Step 1: Record the current behaviour**

Run: `bun test tests/unit -t "hook"` and note the pass count. This is the baseline the refactor must not change.

- [ ] **Step 2: Extract, keeping the old signatures as wrappers**

In `src/hosts/hooks.ts`, generalise the three functions. `invalidHookFile` takes a product label instead of an `AgentHost` so the user scope can say "Claude Code" without pretending to be a repo host:

```ts
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

// Merge, never replace: foreign entries survive untouched and Reviewgate's own
// (identified by the ".reviewgate/bin/" command marker) are rewritten. This is the
// invariant an earlier audit's "init wipes settings" HIGH finding is about.
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

// Remove every Reviewgate-managed entry, dropping events that end up empty.
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

export type { HookDocument, HookEvents };
```

Then make the existing exports wrappers:

```ts
export function readHookDocument(repoRoot: string, host: AgentHost): HookDocument {
  return readHookDocumentAt(hookConfigPath(repoRoot, host), host === "claude" ? "Claude Code" : "Codex");
}

export function installHostHookDocument(
  repoRoot: string,
  host: AgentHost,
  document: HookDocument,
): string {
  return installHookDocumentAt(hookConfigPath(repoRoot, host), document, desiredHooks(repoRoot, host));
}
```

- [ ] **Step 3: Prove the refactor changed nothing**

Run: `bun test tests/unit tests/integration`
Expected: the same pass count as Step 1, 0 fail. A refactor that needs a test edit is not a refactor — if an assertion has to change, stop and report it.

- [ ] **Step 4: Commit**

```bash
git add src/hosts/hooks.ts
git commit -m "refactor(hosts): extract the path-keyed hook-document core"
```

---

### Task 2: User-scope install and remove

**Files:**
- Create: `src/hosts/user-hooks.ts`
- Test: `tests/unit/user-hooks-install.test.ts` (create)

**Interfaces:**
- Consumes: `readHookDocumentAt`, `installHookDocumentAt`, `stripManagedEntries`, `HookDocument`, `HookEvents` (Task 1).
- Produces (all SYNCHRONOUS): `userClaudeSettingsPath(home)`, `userShimDir(home)`, `userShimPath(home, shim)`, `installUserHooks(home, binPath, tplDir)`, `removeUserHooks(home)`, `userHooksInstalled(home)`, `userStopGateInstalled(home)`, `repoClaudeStopGateActive(repoRoot)` — consumed by Tasks 3, 4 and 5. `tplDir` is the CALLER's responsibility (`resolveTemplateDir()` from Task 0), so a compiled binary resolves templates the same way `init` does.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/user-hooks-install.test.ts
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTemplateDir } from "../../src/cli/commands/init.ts";
import {
  installUserHooks,
  removeUserHooks,
  userClaudeSettingsPath,
  userHooksInstalled,
  userShimPath,
} from "../../src/hosts/user-hooks.ts";

// A TEMP home, always. Touching the real ~/.claude/settings.json would rewrite the
// global hook config of every Claude Code session on this machine.
function home(): string {
  return mkdtempSync(join(tmpdir(), "rg-userhooks-"));
}

const FOREIGN = {
  hooks: {
    Stop: [{ hooks: [{ type: "command", command: "/usr/local/bin/my-linter", timeout: 10 }] }],
    PreToolUse: [{ hooks: [{ type: "command", command: "/usr/local/bin/audit", timeout: 5 }] }],
  },
  someUnrelatedSetting: { keepMe: true },
};

const BIN = "/opt/reviewgate/bin/reviewgate";
const TPL = resolveTemplateDir();

describe("user-scoped hook install", () => {
  test("installs Stop/PostToolUse/SessionStart fully wired, plus the shims", () => {
    const h = home();
    installUserHooks(h, BIN, TPL);
    const doc = JSON.parse(readFileSync(userClaudeSettingsPath(h), "utf8"));
    expect(Object.keys(doc.hooks).sort()).toEqual(["PostToolUse", "SessionStart", "Stop"]);
    // Assert each event is really wired, not merely present: an empty or mis-pointed
    // group would otherwise pass (plan-gate round 1, INFO).
    const stop = doc.hooks.Stop[0].hooks[0];
    expect(stop.command).toContain("/.reviewgate/bin/gate");
    expect(stop.timeout).toBe(2400);
    const post = doc.hooks.PostToolUse[0];
    expect(post.matcher).toBe("Edit|Write|MultiEdit|NotebookEdit");
    expect(post.hooks[0].command).toContain("/.reviewgate/bin/trigger");
    expect(post.hooks[0].timeout).toBe(5);
    expect(post.hooks[0].async).toBe(true);
    const start = doc.hooks.SessionStart[0].hooks[0];
    expect(start.command).toContain("/.reviewgate/bin/reset");
    expect(start.timeout).toBe(30);
    for (const shim of ["gate", "trigger", "reset"] as const) {
      expect(existsSync(userShimPath(h, shim))).toBe(true);
      // The binary path is baked in, exactly as the repo-local shims do it.
      expect(readFileSync(userShimPath(h, shim), "utf8")).toContain(BIN);
    }
    expect(userHooksInstalled(h)).toBe(true);
  });

  test("PRESERVES foreign entries and unrelated settings", () => {
    const h = home();
    mkdirSync(join(h, ".claude"), { recursive: true });
    writeFileSync(userClaudeSettingsPath(h), JSON.stringify(FOREIGN, null, 2));
    installUserHooks(h, BIN, TPL);
    const doc = JSON.parse(readFileSync(userClaudeSettingsPath(h), "utf8"));
    expect(doc.someUnrelatedSetting).toEqual({ keepMe: true });
    expect(doc.hooks.PreToolUse).toEqual(FOREIGN.hooks.PreToolUse);
    // The user's own Stop hook survives ALONGSIDE Reviewgate's.
    const stopCommands = doc.hooks.Stop.flatMap((g: { hooks: { command: string }[] }) =>
      g.hooks.map((x) => x.command),
    );
    expect(stopCommands).toContain("/usr/local/bin/my-linter");
    expect(stopCommands.some((c: string) => c.includes(".reviewgate/bin/gate"))).toBe(true);
  });

  test("re-running is idempotent (the refresh path)", () => {
    const h = home();
    installUserHooks(h, BIN, TPL);
    const first = readFileSync(userClaudeSettingsPath(h), "utf8");
    installUserHooks(h, BIN, TPL);
    expect(readFileSync(userClaudeSettingsPath(h), "utf8")).toBe(first);
  });

  test("--remove restores the document to its pre-install shape", () => {
    const h = home();
    mkdirSync(join(h, ".claude"), { recursive: true });
    writeFileSync(userClaudeSettingsPath(h), JSON.stringify(FOREIGN, null, 2));
    installUserHooks(h, BIN, TPL);
    removeUserHooks(h);
    const doc = JSON.parse(readFileSync(userClaudeSettingsPath(h), "utf8"));
    expect(doc.someUnrelatedSetting).toEqual({ keepMe: true });
    expect(doc.hooks).toEqual(FOREIGN.hooks);
    expect(existsSync(userShimPath(h, "gate"))).toBe(false);
    expect(userHooksInstalled(h)).toBe(false);
  });

  test("refuses to overwrite a malformed settings file and backs it up", () => {
    const h = home();
    mkdirSync(join(h, ".claude"), { recursive: true });
    writeFileSync(userClaudeSettingsPath(h), "{ not json");
    expect(() => installUserHooks(h, BIN, TPL)).toThrow(/refuses to overwrite/);
    expect(existsSync(`${userClaudeSettingsPath(h)}.bak`)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/user-hooks-install.test.ts`
Expected: FAIL — `src/hosts/user-hooks.ts` does not exist.

- [ ] **Step 3: Write the implementation**

```ts
// src/hosts/user-hooks.ts
import {
  accessSync,
  constants,
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

// The shims live under ~/.reviewgate/bin/ ON PURPOSE: that path contains the
// ".reviewgate/bin/" managed-command marker, so the existing merge, detection and
// removal logic recognises user-scoped entries with no change — and
// installedGateStopTimeoutS's Stop-hook predicate matches them too (Task 4).
export function userShimDir(home: string): string {
  return join(home, ".reviewgate", "bin");
}

export function userShimPath(home: string, shim: UserShim): string {
  return join(userShimDir(home), shim);
}

export function userClaudeSettingsPath(home: string): string {
  return join(home, ".claude", "settings.json");
}

// Mirrors the repo-local events and timeouts (src/hosts/hooks.ts). The Stop timeout
// must satisfy the fail-open invariant: 120s setup + loop.runTimeoutMs + 30s settle
// < this value (budgets.ts). Task 4 makes the loop clamp itself to it.
// Commands come from userCommand(), the same helper the locator matches on, so the
// emitted string and the expected string can never drift (plan-gate round 3, CRITICAL #1).
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
  // Read (and validate) BEFORE writing anything, so a malformed settings file aborts
  // the install with nothing half-done.
  const document = readHookDocumentAt(userClaudeSettingsPath(home), "Claude Code");
  // REUSE init's writeShims: it renders the baked path through shSingleQuote, which is
  // what stops a binary path containing a quote or shell metacharacter from executing at
  // hook time (init.ts:18-26, 64-71). A local `replaceAll` would silently drop that.
  // tplDir is resolved by the CALLER via resolveTemplateDir() — a compiled Bun binary
  // does not embed bin-templates, so `import.meta.url` is not a usable base
  // (plan-gate round 1, CRITICAL #1 and #2).
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
    writeFileAtomic(path, JSON.stringify(stripped, null, 2));
  }
  rmSync(userShimDir(home), { recursive: true, force: true });
}

// THE shared predicate (plan-gate round 2, CRITICAL #1/#2/#3). Structural, not a text
// match: the Stop event must name THIS repo's managed gate command, and that shim must be
// EXECUTABLE — `existsSync` is not enough, a non-executable shim cannot fire. Exposed to
// the shim via `reviewgate hooks repo-gate-active` and reused by the Stop-timeout
// selection, so the two can never drift apart.
export type HookEventName = "Stop" | "PostToolUse" | "SessionStart";

// The exact commands each installer emits. Single source of truth: the installer writes
// these and the locator matches them, so the two cannot drift into a loose text rule.
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

// A regular file with the execute bit — a directory or a dangling entry cannot fire.
function isRunnableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Generic activity query behind `reviewgate hooks repo-hook-active --event <E>`
// (plan-gate round 3, CRITICAL #3): Stop->gate, PostToolUse->trigger, SessionStart->reset.
export function repoClaudeHookActive(repoRoot: string, event: HookEventName): boolean {
  const shim = join(repoRoot, ".reviewgate", "bin", EVENT_SHIM[event]);
  return (
    isRunnableFile(shim) &&
    findManagedHook(join(repoRoot, ".claude", "settings.json"), event, REPO_CLAUDE_COMMANDS[event]) !==
      null
  );
}

// EXACT command matching, not `includes` (plan-gate round 3, CRITICAL #1): a Stop command
// such as `echo .reviewgate/bin/gate` contains the marker but is not our hook, and with a
// substring rule a competing entry could also supply the wrong timeout. Both installers
// therefore export the literal they emit, and the locator returns the MATCHING hook so
// activity and timeout are always read off the same entry.
export function findManagedHook(
  settingsPath: string,
  event: HookEventName,
  command: string,
): { command: string; timeout?: number } | null {
  return hookEntriesFor(settingsPath, event).find((h) => h.command === command) ?? null;
}

export function repoClaudeStopGateActive(repoRoot: string): boolean {
  return (
    isRunnableFile(managedHookPath(repoRoot)) &&
    findManagedHook(
      join(repoRoot, ".claude", "settings.json"),
      "Stop",
      REPO_CLAUDE_COMMANDS.Stop,
    ) !== null
  );
}

// Positive evidence that a USER-scoped Stop gate will run: the Stop command must target
// THIS home's gate shim (not a stale path from an older install), and that shim must be
// executable. `userHooksInstalled` stays the broader install-health signal (any managed
// entry in any event) and must NOT be used to answer "is this gated?".
export function userStopGateInstalled(home: string): boolean {
  return (
    isRunnableFile(userShimPath(home, "gate")) &&
    findManagedHook(userClaudeSettingsPath(home), "Stop", userCommand(home, "gate")) !== null
  );
}

export function userHooksInstalled(home: string): boolean {
  const path = userClaudeSettingsPath(home);
  if (!existsSync(path)) return false;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { hooks?: Record<string, unknown[]> };
    return Object.values(parsed.hooks ?? {}).some(
      (groups) =>
        Array.isArray(groups) &&
        groups.some(
          (entry) =>
            typeof entry === "object" &&
            entry !== null &&
            Array.isArray((entry as { hooks?: unknown[] }).hooks) &&
            (entry as { hooks: { command?: string }[] }).hooks.some((h) =>
              h.command?.includes(".reviewgate/bin/"),
            ),
        ),
    );
  } catch {
    return false;
  }
}
```

Note for the implementer: the `--remove` test asserts `doc.hooks` equals the ORIGINAL foreign hooks object. If `stripManagedEntries` leaves an empty `Stop: []` behind, that assertion fails — which is why it drops emptied events. Do not "fix" the test.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/user-hooks-install.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 4b: Test the predicate directly, not only through the shim**

The shim tests use a fake binary, so they prove the shim *uses* the query — not that the
query is right. `repoClaudeStopGateActive` and `userStopGateInstalled` therefore need their
own cases in this file: a codex-only repo (shared shim, no Claude settings) → false; a
settings document naming the gate only under **PostToolUse** → false; an unrelated setting
whose value merely contains `.reviewgate/bin/gate` → false; a non-executable shim → false;
for the user twin, a Stop command pointing at a **stale** shim path → false; and the fully
wired shapes → true. These are the cases the round-2 review showed a raw text match would
get wrong.

- [ ] **Step 5: Mutation-check the merge guarantee**

In a **copy** (`cp -r . /tmp/mut-s4-t2`, never in place): make `installHookDocumentAt` write `next[event] = [...wanted]` (dropping `preserved`). The "PRESERVES foreign entries" test must go RED. Then restore and make `stripManagedEntries` keep emptied events (`next[event] = kept` unconditionally) — the `--remove` test must go RED. Discard the copy; `git diff` unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/hosts/user-hooks.ts tests/unit/user-hooks-install.test.ts
git commit -m "feat(hosts): user-scoped Claude Code hook install/remove (S4)"
```

---

### Task 3: The three user shims

**Files:**
- Create: `bin-templates/user-gate.sh`, `bin-templates/user-trigger.sh`, `bin-templates/user-reset.sh`
- Test: `tests/unit/user-shim-behavior.test.ts` (create)

**Interfaces:**
- Consumes: `installUserHooks`, `userShimPath` (Task 2).
- Produces: nothing importable — the deliverable is the scripts' runtime behaviour.

**Why this is its own task:** these scripts are the only place where the fail direction is inverted, and they are the part a reviewer must be able to reject on its own.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/user-shim-behavior.test.ts
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTemplateDir } from "../../src/cli/commands/init.ts";
import { installHostHookDocument, readHookDocument } from "../../src/hosts/hooks.ts";
import { installUserHooks, userShimPath } from "../../src/hosts/user-hooks.ts";

function home(): string {
  return mkdtempSync(join(tmpdir(), "rg-usershim-"));
}

async function repo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "rg-usershim-repo-"));
  await Bun.$`git -C ${dir} init -q`.quiet();
  await Bun.$`git -C ${dir} -c user.email=t@t -c user.name=t commit -q --allow-empty -m i`.quiet();
  return dir;
}

// Run the generated shim exactly as the host would: as a real script, in the repo.
// `env` lets a case neutralise PATH so an installed `reviewgate` cannot be resolved.
async function runShim(shim: string, cwd: string, env: Record<string, string> = {}) {
  const p = Bun.spawn([shim], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  return { code: await p.exited, stdout, stderr };
}

// The shim now asks the binary whether a repo-local Claude Stop gate is active
// (`hooks repo-gate-active`), so the fake must answer that query as well as the gate call.
// `active` decides the query's exit code; `body` is what the real gate invocation does.
function fakeBinary(dir: string, body: string, active = false): string {
  const path = join(dir, "fake-reviewgate");
  writeFileSync(
    path,
    `#!/bin/sh\nif [ "$1" = "hooks" ]; then exit ${active ? 0 : 1}; fi\n${body}\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

// A repo whose CLAUDE hooks are genuinely installed — the settings document AND the
// executable shim. Built with the real installer so the test cannot drift from what
// `init` actually writes.
async function repoWithClaudeHooks(): Promise<string> {
  const r = await repo();
  mkdirSync(join(r, ".reviewgate", "bin"), { recursive: true });
  writeFileSync(join(r, ".reviewgate", "bin", "gate"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(r, ".reviewgate", "bin", "gate"), 0o755);
  installHostHookDocument(r, "claude", readHookDocument(r, "claude"));
  return r;
}

// The gate shim must never resolve a globally installed `reviewgate` from the ambient
// PATH — that would silently defeat the missing-binary case on this machine.
const NO_PATH = { PATH: "/nonexistent-for-tests" };

describe("user-scoped gate shim", () => {
  test("stands down when a repo-local CLAUDE Stop hook is genuinely installed", async () => {
    const h = home();
    const r = await repoWithClaudeHooks();
    const bin = fakeBinary(h, 'echo "{\\"decision\\":\\"block\\"}"; exit 3', true);
    installUserHooks(h, bin, resolveTemplateDir());
    const out = await runShim(userShimPath(h, "gate"), r);
    expect(out.code).toBe(0);
    expect(out.stdout).toBe(""); // the fake's block must NOT appear — the shim never ran it
  });

  test("RUNS when only the shared shim exists but no Claude hook does (codex-only init)", async () => {
    // init writes .reviewgate/bin/ host-independently (init.ts:271), so this shape is
    // what `reviewgate init --host codex` leaves behind. Standing down here would end
    // the turn un-reviewed with nothing else firing. (Plan-gate round 1, CRITICAL #3.)
    const h = home();
    const r = await repo();
    mkdirSync(join(r, ".reviewgate", "bin"), { recursive: true });
    writeFileSync(join(r, ".reviewgate", "bin", "gate"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(r, ".reviewgate", "bin", "gate"), 0o755);
    const bin = fakeBinary(h, 'echo ran; exit 0');
    installUserHooks(h, bin, resolveTemplateDir());
    const out = await runShim(userShimPath(h, "gate"), r);
    expect(out.stdout.trim()).toBe("ran");
  });

  test("RUNS when the Claude hook is configured but its shim is missing", async () => {
    const h = home();
    const r = await repo();
    installHostHookDocument(r, "claude", readHookDocument(r, "claude")); // settings only
    const bin = fakeBinary(h, 'echo ran; exit 0');
    installUserHooks(h, bin, resolveTemplateDir());
    const out = await runShim(userShimPath(h, "gate"), r);
    expect(out.stdout.trim()).toBe("ran");
  });

  test("fails OPEN and warns on STDERR when no binary resolves", async () => {
    const h = home();
    const r = await repo();
    installUserHooks(h, join(h, "does-not-exist"), resolveTemplateDir());
    const out = await runShim(userShimPath(h, "gate"), r, NO_PATH);
    expect(out.code).toBe(0);
    // Load-bearing: stdout is the decision channel, so a failing user-scoped hook must
    // stay OUT of it. The repo-local shim does the opposite on purpose.
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("Reviewgate");
  });

  test("passes the gate's stdout AND its non-zero exit code through", async () => {
    const h = home();
    const r = await repo();
    // A distinctive non-zero code: with `exit 0` here, an implementation that forced
    // every child result to zero would still pass (plan-gate round 1, INFO).
    const bin = fakeBinary(h, 'echo "{\\"decision\\":\\"block\\",\\"reason\\":\\"probe\\"}"; exit 7');
    installUserHooks(h, bin, resolveTemplateDir());
    const out = await runShim(userShimPath(h, "gate"), r);
    expect(out.code).toBe(7);
    expect(JSON.parse(out.stdout).reason).toBe("probe");
  });

  test("runs the gate from the repo ROOT even when invoked in a subdirectory", async () => {
    const h = home();
    const r = await repo();
    const bin = fakeBinary(h, "pwd; exit 0");
    installUserHooks(h, bin, resolveTemplateDir());
    mkdirSync(join(r, "deep", "nested"), { recursive: true });
    const out = await runShim(userShimPath(h, "gate"), join(r, "deep", "nested"));
    // The gate derives repoRoot from process.cwd(); a subdir would review the wrong tree.
    expect(out.stdout).not.toContain("deep/nested");
  });
});

describe("user-scoped trigger and reset shims", () => {
  for (const [shim, hook] of [
    ["trigger", "trigger"],
    ["reset", "reset"],
  ] as const) {
    test(`${shim}: passes --hook ${hook} and stays silent on a missing binary`, async () => {
      const h = home();
      const r = await repo();
      installUserHooks(h, join(h, "does-not-exist"), resolveTemplateDir());
      const out = await runShim(userShimPath(h, shim), r, NO_PATH);
      expect(out.code).toBe(0);
      expect(out.stdout).toBe("");
      // Silent by design: this fires on every tool call / session start in every repo.
      expect(out.stderr).toBe("");
    });

    test(`${shim}: invokes the binary with --hook ${hook}`, async () => {
      const h = home();
      const r = await repo();
      const bin = fakeBinary(h, 'echo "$@"; exit 0');
      installUserHooks(h, bin, resolveTemplateDir());
      const out = await runShim(userShimPath(h, shim), r);
      expect(out.stdout.trim()).toBe(`gate --hook ${hook}`);
    });
  }
});
```

Implementer note on the last assertion: macOS reports `/var/…` and `/private/var/…` for the same path, so compare with that normalisation rather than a raw equality — and if it proves brittle, assert `out.stdout` does NOT contain `/deep/nested` instead, which is the property that actually matters.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/user-shim-behavior.test.ts`
Expected: FAIL — `bin-templates/user-gate.sh` does not exist, so `installUserHooks` throws.

- [ ] **Step 3: Write the shims** — *(landed in Task 2, see note)*

**Moved to Task 2 while implementing:** `installUserHooks` writes the shims, so the three
templates are a dependency of Task 2's own install tests — leaving them here would make
those tests unrunnable. Task 3 keeps what is genuinely its own: the shim BEHAVIOUR tests
(real subprocesses), the mutation checks, and Step 3b's packaging lists. The template
bodies below are the ones that landed.

```sh
#!/usr/bin/env bash
# bin-templates/user-gate.sh
# Reviewgate USER-SCOPED Stop hook driver — keep this script tiny.
# Reviewgate-managed; do not edit by hand.
#
# Two deliberate differences from the repo-local shim (bin-templates/gate.sh):
#
#   1. It STANDS DOWN when this repo has a repo-local CLAUDE Stop hook that will
#      fire for the same event. User and project hooks merge and both run, and they
#      only dedup on an identical command string, so without this the same checkout
#      would run two gates: duplicate gate.lock contention and duplicate reviewer
#      quota. It is a COST guard, not a safety one — a Stop hook cannot express
#      "allow", so a silent exit can never weaken the repo-local verdict.
#
#      The evidence must be POSITIVE and it must be about CLAUDE. `.reviewgate/bin/`
#      shims are written host-independently by `init` (init.ts:271, before any host
#      document), so an executable gate shim also exists after `init --host codex`,
#      where no Claude hook exists at all. Keying the stand-down on the shim alone
#      would silence this hook in such a repo while nothing else fires — the turn
#      would end un-reviewed. Any doubt therefore means RUN.
#   2. It fails OPEN. A user-scoped hook fires in EVERY repo the user opens;
#      blocking every turn everywhere because a binary is missing would make the
#      feature uninstallable. The repo-local shim fails CLOSED on purpose.
#
# stdout is the decision channel: nothing but the gate's own output may go there.
set -u

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || printf '%s' "$PWD")"

RG_BIN='__REVIEWGATE_BIN__'
if [ -z "$RG_BIN" ] || [ ! -x "$RG_BIN" ]; then
  RG_BIN="$(command -v reviewgate 2>/dev/null || true)"
fi

if [ -z "$RG_BIN" ]; then
  printf '%s\n' 'Reviewgate: user-scoped gate SKIPPED — the reviewgate binary is not on PATH and no baked path resolved, so this turn was NOT reviewed. Fix: reinstall the binary, run `reviewgate init --user`, then `reviewgate doctor`.' >&2
  exit 0
fi

# cd BEFORE the query: it answers for process.cwd(), so asking from a subdirectory would
# miss a real repo-local hook and run a duplicate gate (plan-gate round 3, INFO #2).
cd "$ROOT" || exit 0

# Stand down ONLY on positive evidence that a repo-local Claude Stop gate will fire. The
# check is STRUCTURAL and lives in TypeScript — `hooks repo-hook-active --event Stop`
# exits 0 only when the Stop event carries this repo's EXACT managed gate command and that
# shim is a runnable regular file. A bash text match would also accept a PostToolUse entry,
# an unrelated value, or a command that merely mentions the path. A failed or unsupported
# query is never evidence: it means RUN.
if "$RG_BIN" hooks repo-hook-active --event Stop >/dev/null 2>&1; then
  exit 0
fi

"$RG_BIN" gate --hook stop
rc=$?
if [ "$rc" -eq 126 ] || [ "$rc" -eq 127 ]; then
  printf '%s\n' 'Reviewgate: user-scoped gate SKIPPED — resolved a binary but could not run it on this host (wrong architecture / bad interpreter), so this turn was NOT reviewed. Re-run `reviewgate init --user`, then `reviewgate doctor`.' >&2
  exit 0
fi
exit "$rc"
```

`user-trigger.sh` and `user-reset.sh` are the same shape with `--hook trigger` / `--hook reset`, no exit-code translation (neither owns a decision channel) and no stderr warning on a missing binary — a PostToolUse/SessionStart hook fires constantly, and warning there would spam every tool call in every repo:

```sh
#!/usr/bin/env bash
# bin-templates/user-trigger.sh   (user-reset.sh is identical with --hook reset)
# Reviewgate USER-SCOPED PostToolUse driver. Reviewgate-managed; do not edit by hand.
# Silent by design: this fires on every matching tool call in every repo, so a
# warning here would be noise. The Stop shim is where a missing binary is reported.
set -u
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || printf '%s' "$PWD")"
RG_BIN='__REVIEWGATE_BIN__'
if [ -z "$RG_BIN" ] || [ ! -x "$RG_BIN" ]; then
  RG_BIN="$(command -v reviewgate 2>/dev/null || true)"
fi
[ -n "$RG_BIN" ] || exit 0
cd "$ROOT" || exit 0
# Same structural rule as the gate shim, scoped to THIS event (user-reset.sh uses
# --event SessionStart).
"$RG_BIN" hooks repo-hook-active --event PostToolUse >/dev/null 2>&1 && exit 0
"$RG_BIN" gate --hook trigger
exit 0
```

- [ ] **Step 3b: Add the three templates to all THREE packaging lists**

Now that the files exist, extend `scripts/build-npm-packages.ts:122`,
`scripts/verify-publish.ts:65` and `tests/unit/verify-publish.test.ts:44` to include
`user-gate.sh`, `user-trigger.sh`, `user-reset.sh`. All three or none: a template that
ships but is unverified is the same silent gap, and the test fixture must match the
verifier or the existing packaging test fails.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/user-shim-behavior.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation-check both deliberate differences**

In a **copy**:
1. Delete the whole stand-down block from `user-gate.sh` → the stand-down test must go RED (the fake binary's block reaches stdout).
2. Weaken the stand-down to the shim check alone (drop the `grep` on `.claude/settings.json`) → the **codex-only** test must go RED. This is the mutation that matters most: it is the exact fail-open the first plan draft shipped.
3. Weaken it the other way (drop the `-x` shim check, keep the grep) → the "Claude hook configured but shim missing" test must go RED.
4. Replace the missing-binary branch with the repo-local fail-CLOSED body (print the block JSON to stdout) → the fail-OPEN test must go RED.
5. Force `exit 0` after running the child → the non-zero passthrough test must go RED.
Discard the copy; `git diff` unchanged.

- [ ] **Step 6: Commit**

```bash
git add bin-templates/user-gate.sh bin-templates/user-trigger.sh bin-templates/user-reset.sh tests/unit/user-shim-behavior.test.ts
git commit -m "feat(hooks): user-scoped shims — stand down for repo-local, fail open (S4)"
```

---

### Task 4: Clamp the loop to the user-scoped Stop timeout

**Files:**
- Modify: `src/utils/stop-hook-timeout.ts`
- Test: `tests/unit/stop-hook-timeout-user-fallback.test.ts` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces: `installedGateStopTimeoutS(repoRoot, home?)` — an added optional parameter; every existing call site keeps working.

**Why this task exists (the one real gap):** the function reads only the checkout's `.claude/settings.json`. In a repo gated *solely* by user-scoped hooks it returns `null`, so the loop keeps its configured deadline (default `runTimeoutMs` 1800s) while the OS enforces whatever the global hook carries. A global timeout below the invariant (120s setup + `runTimeoutMs` + 30s settle) means the OS kills the hook mid-review: non-blocking, empty stdout, turn ends **un-reviewed, silently, on every retry** — precisely the failure this module was written to prevent.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/stop-hook-timeout-user-fallback.test.ts
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installedGateStopTimeoutS } from "../../src/utils/stop-hook-timeout.ts";

function dir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeSettings(root: string, command: string, timeout: number): void {
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(
    join(root, ".claude", "settings.json"),
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command, timeout }] }] } }),
  );
}

// The repo timeout only counts when the repo-local gate will really fire, so the shim
// has to exist for the repo arm to be eligible at all.
function addRepoShim(repo: string): void {
  mkdirSync(join(repo, ".reviewgate", "bin"), { recursive: true });
  const shim = join(repo, ".reviewgate", "bin", "gate");
  writeFileSync(shim, "#!/bin/sh\n");
  // The predicate requires X_OK on a regular file — an un-chmod'ed fixture would make the
  // positive case fail for the wrong reason (plan-gate round 3, CRITICAL #2).
  chmodSync(shim, 0o755);
}

describe("installedGateStopTimeoutS user-scope fallback", () => {
  test("repo-local hook wins when it will actually fire", () => {
    const repo = dir("rg-tmo-repo-");
    const home = dir("rg-tmo-home-");
    // Exactly the command the installer emits — REPO_CLAUDE_COMMANDS.Stop.
    writeSettings(repo, '"${CLAUDE_PROJECT_DIR}/.reviewgate/bin/gate"', 2400);
    addRepoShim(repo);
    writeSettings(home, `"${join(home, ".reviewgate", "bin", "gate")}"`, 900);
    expect(installedGateStopTimeoutS(repo, home)).toBe(2400);
  });

  test("repo names the gate but its shim is GONE → the user timeout is the live one", () => {
    // The user shim runs in this repo (its stand-down needs the shim too), so clamping to
    // the stale repo timeout would leave the hook that actually fires unclamped
    // (plan-gate round 1, CRITICAL #4).
    const repo = dir("rg-tmo-repo-");
    const home = dir("rg-tmo-home-");
    writeSettings(repo, '"${CLAUDE_PROJECT_DIR}/.reviewgate/bin/gate"', 2400);
    writeSettings(home, `"${join(home, ".reviewgate", "bin", "gate")}"`, 900);
    expect(installedGateStopTimeoutS(repo, home)).toBe(900);
  });

  test("falls back to the user settings when the repo has no reviewgate Stop hook", () => {
    const repo = dir("rg-tmo-repo-");
    const home = dir("rg-tmo-home-");
    writeSettings(home, `"${join(home, ".reviewgate", "bin", "gate")}"`, 900);
    expect(installedGateStopTimeoutS(repo, home)).toBe(900);
  });

  test("a repo settings file WITHOUT a reviewgate hook still falls back", () => {
    const repo = dir("rg-tmo-repo-");
    const home = dir("rg-tmo-home-");
    writeSettings(repo, "/usr/local/bin/my-linter", 30); // foreign Stop hook only
    writeSettings(home, `"${join(home, ".reviewgate", "bin", "gate")}"`, 900);
    expect(installedGateStopTimeoutS(repo, home)).toBe(900);
  });

  test("neither → null (caller keeps its configured deadline)", () => {
    expect(installedGateStopTimeoutS(dir("rg-tmo-repo-"), dir("rg-tmo-home-"))).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/stop-hook-timeout-user-fallback.test.ts`
Expected: FAIL on the two fallback cases and on the stale-repo-timeout case (today they
return `null`, `null` and `2400`). The other two pass already and are guards. Note: the
extra `home` argument does **not** itself cause a failure — Bun does not reject extra
runtime arguments just because the current TypeScript signature has arity one.

- [ ] **Step 3: Write the implementation**

Rewrite `src/utils/stop-hook-timeout.ts`, keeping the existing doc comment and extending it:

```ts
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { repoClaudeStopGateActive } from "../hosts/user-hooks.ts";

function readGateStopTimeout(settingsPath: string): number | null {
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

// The repo timeout counts only when the repo-local Claude gate will ACTUALLY fire. This
// imports the SAME predicate the shim queries rather than restating it — a second
// formulation is what round 2 flagged, and any drift silently reintroduces the unclamped
// mid-review kill (plan-gate round 1 CRITICAL #4, round 2 CRITICAL #2).
// S4: a repo can now be gated by USER-scoped hooks (~/.claude/settings.json) with no
// repo-local hook at all. Reading only the checkout would return null there, leaving the
// loop's deadline unclamped against whatever timeout the global hook carries — the exact
// silent mid-review kill this module exists to prevent. The command predicate itself is
// unchanged: user shims live at ~/.reviewgate/bin/gate and carry the same marker.
export function installedGateStopTimeoutS(repoRoot: string, home: string = homedir()): number | null {
  return (
    (repoClaudeStopGateActive(repoRoot)
      ? readGateStopTimeout(join(repoRoot, ".claude", "settings.json"))
      : null) ?? readGateStopTimeout(join(home, ".claude", "settings.json"))
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/stop-hook-timeout-user-fallback.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Mutation-check the fallback**

In a **copy**: drop the `?? readGateStopTimeout(join(home, …))` arm → both fallback tests
must go RED. Restore, then REVERSE the order (user first) → "repo-local hook wins" must go
RED. Restore, then weaken `repoClaudeStopGateActive` to `existsSync` instead of an
executable check → the non-executable-shim test must go RED. Discard the copy; `git diff` unchanged.

- [ ] **Step 6: Verify no existing caller broke**

Run: `bun test tests/unit tests/integration`
Expected: 0 fail. The added parameter is optional and defaults to `homedir()`, so call sites are untouched — but this machine HAS a real `~/.claude/settings.json`, so a test that previously got `null` may now get a real number. If any test changes behaviour, that is a finding about hidden real-home dependence: report it, and fix by passing an explicit temp `home` in that test rather than by weakening the fallback.

- [ ] **Step 7: Commit**

```bash
git add src/utils/stop-hook-timeout.ts tests/unit/stop-hook-timeout-user-fallback.test.ts
git commit -m "fix(loop): clamp to the user-scoped Stop-hook timeout too (S4)"
```

---

### Task 5: `init --user` / `--user --remove` and `doctor`

**Files:**
- Modify: `src/cli/commands/init.ts`, `src/cli/index.ts`, `src/cli/commands/doctor.ts`
- Test: `tests/unit/user-hooks-install.test.ts` (extend), existing doctor tests (extend)

**Interfaces:**
- Consumes: `installUserHooks`, `removeUserHooks`, `userHooksInstalled`, `userShimPath` (Task 2).
- Produces: the `--user` CLI surface and the doctor checks.

- [ ] **Step 1: Wire the CLI**

`--user` is a distinct mode, not a modifier of the repo install: it must not touch any repo, must not create `.reviewgate/`, and must not arm anything. Route it before the repo-init work in `runInit`, and add `--remove` (only meaningful together with `--user`; reject the combination otherwise with a clear message).

`installUserHooks` is SYNCHRONOUS and takes three arguments, so the call site owns both
resolutions — reuse `init`'s existing ones, do not re-implement them (plan-gate round 2,
CRITICAL #5):

`runInit` returns an OBJECT that `src/cli/index.ts` and `src/cli/commands/setup.ts`
dereference immediately, so user mode must NOT return an exit code from it and must not
widen its type (plan-gate round 3, CRITICAL #4). Put user mode in its own exported
function and route to it from the CLI *before* `runInit` is called:

```ts
// src/cli/commands/init.ts
export function runInitUser(input: { home: string; remove?: boolean }): number {
  if (input.remove) {
    removeUserHooks(input.home);
    return 0;
  }
  const { bakedBin, warning } = resolveBakedBin(process.execPath);
  if (warning) console.error(`reviewgate init: WARNING — ${warning}`);
  installUserHooks(input.home, bakedBin, resolveTemplateDir());
  return 0;
}
```

```ts
// src/cli/index.ts — inside the init command handler, before any repo work
if (args.user) return runInitUser({ home: homedir(), remove: args.remove });
```

Nothing is written into the CWD on either branch, and `runInit`'s signature is untouched.
Reject `--remove` without `--user` with a clear message.

**Also add the query the shims use** (`src/cli/index.ts`): a `hooks repo-hook-active`
subcommand taking `--event <Stop|PostToolUse|SessionStart>`. It exits **0** when
`repoClaudeHookActive(process.cwd(), event)` is true, **1** otherwise, and **2** on a
missing or unrecognised event — never printing anything. All three shims use it (Stop→gate,
PostToolUse→trigger, SessionStart→reset), which is why it is generic rather than
gate-only (plan-gate round 3, CRITICAL #3); the shims treat every non-zero code as "not
active", so an unsupported event can only ever cause a RUN, never a stand-down.

Test all of it directly: exit 0 for each fully wired event, exit 1 for a non-executable
shim, for a foreign command in the right event, and for the right command in the wrong
event; exit 2 for `--event Nope` and for a missing `--event`.

- [ ] **Step 2: Add the doctor checks**

Three checks, all read-only, using `homedir()` in production and an injectable `home` for tests:

1. **user hooks** — installed? (`userHooksInstalled`) → ok/absent (absent is INFO, not a failure: user scope is opt-in).
2. **user shims** — do `~/.reviewgate/bin/{gate,trigger,reset}` exist and is the baked binary path executable? → fail with "re-run `reviewgate init --user`" when installed-but-broken.
3. **user Stop timeout** — satisfies `120 + loop.runTimeoutMs/1000 + 30 < timeout`? Reuse the existing panel-budget sizing logic rather than duplicating the arithmetic.

- [ ] **Step 3: Make `worktreeGatedCheck` honest**

It currently FAILs inside any linked worktree without repo-local hooks. With user-scoped hooks installed, that worktree IS gated. Add that branch — and only that branch:

```ts
  // userStopGateInstalled — NOT userHooksInstalled. The latter is true for ANY managed
  // command in ANY event, so a leftover PostToolUse entry with no Stop gate would make
  // doctor report this worktree as gated while nothing reviews the turn (plan-gate
  // round 1, CRITICAL #5). "Gated" means a Stop gate that can actually run.
  if (userStopGateInstalled(home)) {
    return {
      name: "worktree gating",
      status: "ok",
      detail: "inside a git worktree gated by user-scoped Reviewgate hooks (~/.claude/settings.json)",
    };
  }
```

`userStopGateInstalled` is defined in Task 2 and already requires executable access plus
a Stop command targeting **this home's** shim path, so a stale command from an older
install does not count. Test it with a PostToolUse-only document, a non-executable shim
and a stale command path — all three must report NOT gated.

This is the one place where S3's deliberate "no doctor change" is superseded, and only because S4 makes the claim true. Do NOT extend it to "arming would be inherited" — inheritance without hooks still means nothing fires.

- [ ] **Step 4: Test**

Extend the existing doctor tests with a temp `home`: hooks absent → INFO; hooks installed but shim missing → fail; installed and healthy → ok; and a linked worktree with user hooks → "worktree gating" ok. Add an `init --user` end-to-end case asserting that no `.reviewgate/` is created in the CWD.

- [ ] **Step 5: Run the full suite**

Run: `bun test` — 0 fail.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/init.ts src/cli/index.ts src/cli/commands/doctor.ts tests/unit
git commit -m "feat(cli): reviewgate init --user plus doctor user-scope checks (S4)"
```

---

### Task 6: Docs

**Files:**
- Modify: `README.md`, `docs/AGENTS.md`, `CLAUDE.md`
- Test: none (documentation)

- [ ] **Step 1: README** — document `reviewgate init --user` next to `init`: what it installs, that repo-local hooks win where both exist, that a missing binary skips the gate loudly instead of blocking, and `--user --remove`.
- [ ] **Step 2: `docs/AGENTS.md`** — one paragraph in the unarmed-checkouts section: with user-scoped hooks the gate may fire in repos that were never initialised; there it is still a silent no-op unless the checkout is armed.
- [ ] **Step 3: `CLAUDE.md`** — update the worktree bullet: with `init --user`, hooks now DO exist in a worktree, so S3's inheritance becomes observable. This is the sentence that has been "not built" through S2 and S3; it finally changes.
- [ ] **Step 4: Commit**

```bash
git add README.md docs/AGENTS.md CLAUDE.md
git commit -m "docs: document user-scoped hooks (S4)"
```

---

## Verification (end gate)

- [ ] `bunx tsc --noEmit` — clean
- [ ] `bun run lint` — clean
- [ ] `bun test` — 0 fail (expect ~+17 tests)
- [ ] Every mutation listed in Tasks 2–4 was seen RED in a copy.
- [ ] **Manual, in a TEMP home — never the real one:** `HOME=$(mktemp -d) reviewgate init --user`, then inspect the generated `~/.claude/settings.json` and run the generated `gate` shim inside (a) a repo with repo-local hooks → exit 0, empty stdout; (b) a bare unarmed repo → exit 0, empty stdout (S2 silence).
- [ ] **Only after all of the above**, and only with Markus's explicit go-ahead, install for real on this machine. A broken global Stop hook breaks every Claude Code session at once, so this step is a deliberate decision, not part of the gate.

## Self-review notes

- **Spec coverage:** §3.1 install → Tasks 2+5; §3.2 shim semantics → Task 3; §3.3 timeout clamp → Task 4; §3.4 doctor → Task 5; §3.5 uninstall → Task 2 (`removeUserHooks`) + Task 5 (CLI). §4 out-of-scope items are honoured by omission — no Codex host, no `gate.ts` change, no `formatAllowStopJson` deletion.
- **Deliberate scope call:** Task 1 is a pure refactor with no new tests; its proof is that the existing suite stays green. If it cannot, the extraction is wrong.
- **Residual risk to name for the reviewer:** the user shims are bash, so their behaviour is only covered by executing them (Task 3 does exactly that, as real subprocesses). Anything asserted about them by reading alone is not evidence.

---

## Plan-Gate findings mapping — round 1 (codex, 2026-07-29)

Verdict: **FAIL**, 5 CRITICAL + 8 INFO. Every CRITICAL was verified against source before
acceptance; none were rejected. Two of them (C1, C3) would have shipped real defects — one
in every published binary, one a silent fail-open.

| # | Finding | Verified how | Fix | Task |
|---|---------|--------------|-----|------|
| C1 | Templates resolved via `import.meta.url`, which a compiled Bun binary cannot use; and `build-npm-packages.ts` / `verify-publish.ts` hard-code only the four existing templates, so `init --user` could never work from a published binary | `init.ts:247-260` probes three locations, `dirname(process.execPath)` FIRST; `build-npm-packages.ts:122` + `verify-publish.ts:65` list exactly four names | New **Task 0**: extract `resolveTemplateDir()`, pass `tplDir` in, and add the three user templates to both packaging lists | Task 0, Task 2 |
| C2 | `renderShim` substituted the baked path raw, unlike `writeShims`, so a path containing `'` breaks the shim and can execute at hook time | `init.ts:68` uses `shSingleQuote`; the comment at `:18-26` states the exact hazard | Reuse the generalised `writeShims` instead of a local renderer; add a quoting regression test with an embedded quote | Task 0 Step 4, Task 2 |
| C3 | The stand-down keyed on `.reviewgate/bin/gate` being executable — but `init` writes those shims **host-independently**, so a `--host codex` repo has the shim and NO Claude hook. The user shim would stand down while nothing fires: an un-reviewed turn. The named test only created an orphan shim, so it "proved" the wrong thing | `init.ts:271` calls `writeShims` before any host document is installed | Stand down only on positive evidence — settings naming the gate **and** an executable shim; any doubt means RUN. Positive test uses a real hook-document install; codex-only and orphan-shim cases assert it RUNS | Global Constraints, Task 3 |
| C4 | The timeout lookup used a different predicate from the stand-down: a repo naming a gate whose shim is gone returns the stale repo timeout while the user hook is the one actually running — unclamped until the OS kills it | Same predicate mismatch, `stop-hook-timeout.ts` vs the shim | `repoClaudeGateEffective()` — the repo arm counts only under the identical condition; new stale-repo-timeout test | Task 4 |
| C5 | `userHooksInstalled` matches any managed command in any event, so doctor's worktree branch could report "gated" with only a PostToolUse entry and no Stop gate | Plan's own detector definition | Add `userStopGateInstalled()` requiring a managed **Stop** command plus a runnable gate shim; the worktree branch uses it, install-health keeps the broader one | Task 5 |

INFO items adopted: the passthrough test now uses a distinctive non-zero exit code (it
would otherwise pass an implementation that forces 0); the missing-binary cases run with a
neutralised PATH so an installed `reviewgate` cannot satisfy them; `user-trigger`/
`user-reset` get real subprocess tests; the install test asserts each event's command,
matcher, timeout and async flag rather than just the keys; and Task 4 Step 2's claimed
arity failure was removed — Bun does not reject an extra runtime argument.

INFO items confirmed with no action: Task 1's extraction is behaviour-equivalent
(`withoutManagedCommands`, the `.bak` rename and the full error text are unchanged); user
shim paths do carry the existing `MANAGED_COMMAND_MARKER`; and `installedGateStopTimeoutS`
has exactly one call site (`LoopDriver.run`), which stays source-compatible.

**Round count: 1 of 3.**

## Plan-Gate findings mapping — round 2 delta (codex, 2026-07-29)

Verdict: **FAIL**, 5 CRITICAL + 1 INFO. Three of the five are defects in round 1's own
fixes. All verified; none rejected.

| # | Finding | Fix | Task |
|---|---------|-----|------|
| C1 | Round 1's `grep` over `.claude/settings.json` is not positive evidence: the marker can sit in a PostToolUse entry, an env value or any unrelated setting → FALSE stand-down, i.e. the exact fail-open round 1 set out to close. None of the three new tests covered a wrong-event or unrelated-string match | **Design change:** the predicate moves into TypeScript as `repoClaudeStopGateActive()` — structural (Stop event only) plus an executable-shim check — and the shim asks for it via a new `reviewgate hooks repo-gate-active` query instead of parsing JSON in bash | Global Constraints, Tasks 2, 3, 5 |
| C2 | Round 1's `repoClaudeGateEffective()` was still a SECOND formulation (existsSync + a valid timeout) and so not equivalent to the shim's; it also omitted the `managedHookPath` import, and the test fixture's shim was never `chmod`ed | Task 4 imports the one shared predicate; the fixture is made executable; non-executable and wrong-event regressions added | Task 4 |
| C3 | `userStopGateInstalled` claimed "runnable" but only checked `existsSync`, and accepted any Stop command containing the marker — including one pointing at a stale path | Requires `X_OK` on `userShimPath(home,"gate")` and a Stop command targeting that exact path; PostToolUse-only, non-executable and stale-path cases added | Tasks 2, 5 |
| C4 | The supplied `user-hooks.ts` could not compile: it called `writeShims` without importing it and imported an unused `chmodSync` | Imports corrected (`writeShims`, `resolveTemplateDir`, `managedHookPath`, `accessSync`/`constants`) | Task 2 |
| C5 | The 3-argument synchronous `installUserHooks` contract was not carried through: the Interfaces block still advertised two arguments and Task 5's CLI wiring never resolved or passed `tplDir` | Interfaces updated; Task 5 now shows the explicit synchronous call with `resolveBakedBin` + `resolveTemplateDir`, returning before any repo-local work | Tasks 2, 5 |
| I1 | A THIRD hard-coded template list exists at `tests/unit/verify-publish.test.ts:44`; extending only the two production lists would break it | Added to Task 0 Step 3 | Task 0 |

**Round count: 2 of 3.** Per the plan-gate calibration rule, a third FAIL goes to Markus for
an accept/fix decision per open finding rather than a fourth round.

## Plan-Gate findings mapping — round 3 delta (codex, 2026-07-29)

Verdict: **FAIL**, 4 CRITICAL + 2 INFO. Round limit reached; per the plan-gate calibration
rule Markus decided per finding rather than a fourth round. His decision (2026-07-29):
**fix all six, no fourth review round, then implement** — the remaining defects are all
"the plan's own code does not compile or wire up", which `tsc`/lint/the suite catch in
seconds, whereas each further prose round had been introducing new prose defects.

A correction to the round-2 mapping first: it claimed C2 was fixed. It was not — the import
landed in Task 2's module but Task 4's snippet never imported it, and `addRepoShim()` still
left the fixture non-executable. The mapping over-claimed; this round's reviewer was right
to flag it.

| # | Finding | Fix | Task |
|---|---------|-----|------|
| C1 | The predicate still matched with `includes(...)`, so `echo .reviewgate/bin/gate` would count as evidence and a competing marker entry could supply the wrong timeout | One structural locator, `findManagedHook(settings, event, command)`, matching the **exact** literal each installer emits (`REPO_CLAUDE_COMMANDS`, `userCommand()`), returning the matching hook so activity and timeout are read off the same entry; runnability is now "regular file + X_OK" | Tasks 2, 4, 5 |
| C2 | Task 4 called the shared predicate without importing it, and `addRepoShim()` left the fixture non-executable although the predicate requires `X_OK` | Import added; fixture `chmod`ed 0o755 | Task 4 |
| C3 | The trigger shim emitted `hooks repo-hook-active --event PostToolUse` while only `repo-gate-active` was ever specified — an unsupported command, so the non-Stop shims could never stand down | The query is now generic and fully specified: `--event <Stop\|PostToolUse\|SessionStart>`, exit 0/1/2, event→shim mapping, and its own tests. Shims treat any non-zero as "not active", so an unsupported event can only cause a RUN | Tasks 3, 5 |
| C4 | The `--user` branch returned `0` from `runInit`, whose object result is dereferenced by callers in `index.ts` and `setup.ts` | User mode moved into its own `runInitUser()`; `runInit`'s contract untouched; the CLI routes before calling it | Task 5 |
| I1 | `user-hooks.ts` imported `resolveTemplateDir` without using it | Import removed (`tplDir` is the caller's job) | Task 2 |
| I2 | The shims queried the predicate BEFORE `cd "$ROOT"`, while the query answers for `process.cwd()` — from a subdirectory it would miss a real repo-local hook and run a duplicate gate | Order fixed in all three shims: resolve binary → fail open → `cd "$ROOT"` → query → run | Task 3 |

**Plan-gate summary:** round 1 FAIL (5 CRITICAL) → round 2 FAIL (5 CRITICAL, three of them
defects in round 1's own fixes) → round 3 FAIL (4 CRITICAL, one of them a defect in round
2's fix and one an over-claim in the round-2 mapping) → human decision. Two shipped-defect
classes were caught that no later gate would have: template resolution that works only
under `bun run dev`, and a stand-down that silences the hook in repos where nothing else
fires. Implementation may begin; `tsc`, lint and the suite are the next gate.
