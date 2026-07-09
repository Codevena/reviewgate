import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "../../utils/atomic-write.ts";

// POSIX single-quote escaping for the binary path interpolated into the shim's
// `RG_BIN='<here>'`. The path comes from process.execPath, which can sit at an
// install/checkout location containing shell metacharacters (`"`, backtick,
// `$(…)`); a raw substitution into a quoted assignment would let that path
// EXECUTE at hook time. Single-quoting disables all shell expansion — the only
// character needing escaping is the single quote itself (' -> '\'').
export function shSingleQuote(value: string): string {
  return value.replace(/'/g, "'\\''");
}

// Ephemeral package-manager caches: a binary here is GC-able, so a baked path into it
// can later vanish and make the Stop gate fail closed. We still bake it (it works now)
// but warn. Covers npx, npm cacache, pnpm/yarn/bun `dlx`, and any OS-temp extraction.
const EPHEMERAL_BIN_MARKERS = ["/_npx/", "/_cacache/", "/dlx-", "/.bun/install/cache/", "/bunx-"];
const TEMP_ROOTS = [
  "/tmp/",
  "/private/tmp/",
  "/private/var/folders/",
  "/var/folders/",
  "/var/tmp/",
];
function isEphemeralBinPath(p: string): boolean {
  return EPHEMERAL_BIN_MARKERS.some((m) => p.includes(m)) || TEMP_ROOTS.some((r) => p.includes(r));
}

// Decide what absolute binary path to bake into the hook shims, given the path of the
// binary that ran `init`. The launcher SPAWNS the compiled binary, so under an npm
// install process.execPath is the platform binary (basename "reviewgate"), not node —
// the same regex that gates the curl|sh and dev cases handles npm with no extra branch.
export function resolveBakedBin(execPath: string): { bakedBin: string; warning: string | null } {
  if (!/reviewgate/i.test(basename(execPath))) return { bakedBin: "", warning: null };
  if (isEphemeralBinPath(execPath)) {
    return {
      bakedBin: execPath,
      warning:
        "the reviewgate binary is in an ephemeral cache (npx/dlx/temp) and may be garbage-collected, " +
        "which would make the Stop gate fail closed. For a durable gate, install it with " +
        "`npm i -g reviewgate` (or as a project devDependency) and re-run `reviewgate init`.",
    };
  }
  return { bakedBin: execPath, warning: null };
}

// Render the 4 hook shims with the baked path. Extracted from runInit so a stale→new
// re-bake (e.g. user moves from curl|sh to npm) is unit-testable; each call fully
// overwrites the shim, so the previous RG_BIN can never linger.
export function writeShims(binDir: string, tplDir: string, bakedBin: string): void {
  for (const name of ["trigger", "gate", "reset", "pre-push"]) {
    const tpl = readFileSync(join(tplDir, `${name}.sh`), "utf8");
    const dst = join(binDir, name);
    writeFileSync(dst, tpl.split("__REVIEWGATE_BIN__").join(shSingleQuote(bakedBin)));
    chmodSync(dst, 0o755);
  }
}

const HOOKS_TEMPLATE = {
  PostToolUse: [
    {
      matcher: "Edit|Write|MultiEdit|NotebookEdit",
      hooks: [
        {
          type: "command",
          // Quote the path: CLAUDE_PROJECT_DIR may contain spaces, and an unquoted
          // ${CLAUDE_PROJECT_DIR}/... word-splits in the shell and fails the hook.
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
          // 120s setup + 1800s runTimeoutMs + 30s settle = 1950s < 2400s
          // (fail-open invariant, config/budgets.ts). Raise/lower together
          // with loop.runTimeoutMs.
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
          // Bounded: `reset` is fast + local, but a missing timeout lets a wedged
          // reset stall session start indefinitely. 30s is generous headroom.
          timeout: 30,
        },
      ],
    },
  ],
};

// Patterns are UN-ANCHORED (leading `**/`) so they also cover NESTED .reviewgate/
// dirs (e.g. backend/.reviewgate/) — a root-anchored `.reviewgate/...` would only match
// the repo-root copy and leak nested runtime state into commits (field report 2026-06-21).
// Cassettes use the CONTENTS-form `**/.reviewgate/cassettes/*` (NOT the dir-form), because
// a trailing-slash dir-exclude excludes the directory NODE and git then cannot re-include a
// child of an excluded dir — so the golden re-include would silently fail. The contents-form
// + `!**/.reviewgate/cassettes/golden/` keeps golden cassettes trackable at root AND nested.
// The committed brain memory (brain.json/brain.md) lives INSIDE .reviewgate/brain/ and must
// stay trackable, so only the brain RUNTIME subdirs are ignored, never the brain/ dir itself.
const GITIGNORE_LINES = [
  "# Reviewgate (auto-added; edit reviewgate.config.ts to override)",
  "# Un-anchored (**/) so nested .reviewgate/ dirs (e.g. backend/.reviewgate/) are covered too.",
  "**/.reviewgate/audit/",
  "**/.reviewgate/cassettes/*",
  "!**/.reviewgate/cassettes/golden/",
  "**/.reviewgate/reports/",
  "**/.reviewgate/pending.*",
  "**/.reviewgate/plan-review.*",
  "**/.reviewgate/decisions/",
  "**/.reviewgate/state.json",
  "**/.reviewgate/research.md",
  "**/.reviewgate/dirty.flag",
  "**/.reviewgate/sessions/",
  "**/.reviewgate/ESCALATION.md",
  "**/.reviewgate/.lock",
  "**/.reviewgate/cache/",
  "**/.reviewgate/learnings/",
  "**/.reviewgate/reputation.json",
  "**/.reviewgate/quota-cooldowns.json",
  "**/.reviewgate/brain/proposals/",
  "**/.reviewgate/brain/snapshots/",
  "# Antigravity CLI (agy) working-tree artifact",
  ".antigravitycli",
];

// The exact prior root-anchored Reviewgate strings (pre-2026-06-21). The .gitignore writer is
// append-only, so a repo init'd before P9 keeps these; the stale `.reviewgate/cassettes/`
// dir-exclude in particular would re-break ROOT golden tracking under the new patterns. The
// writer strips any of these (plus the current managed set) before re-appending the new block,
// so an upgrade is clean + idempotent and never leaves a conflicting stale line.
const OLD_GITIGNORE_LINES = [
  "# Reviewgate (auto-added; edit reviewgate.config.ts to override)",
  ".reviewgate/audit/",
  ".reviewgate/cassettes/",
  "!.reviewgate/cassettes/golden/",
  ".reviewgate/reports/",
  ".reviewgate/pending.*",
  ".reviewgate/decisions/",
  ".reviewgate/state.json",
  ".reviewgate/research.md",
  ".reviewgate/dirty.flag",
  ".reviewgate/ESCALATION.md",
  ".reviewgate/.lock",
  ".reviewgate/cache/",
  ".reviewgate/brain/proposals/",
  ".reviewgate/brain/snapshots/",
];

export interface InitInput {
  repoRoot: string;
  mode: "agent-loop";
}

const GIT_HOOK_MARKER = "Reviewgate-managed git pre-push hook";

// Install a WARN-ONLY git pre-push hook that delegates to .reviewgate/bin/pre-push. Conservative
// by design: only into a real `.git/hooks` directory (skips worktrees/submodules where `.git`
// is a file, and bare/absent repos), and NEVER clobbers a foreign existing pre-push hook — it
// only overwrites a previously Reviewgate-managed one (idempotent update). The hook itself can
// never block a push (the shim is `|| true; exit 0`). Returns a status note for the init output.
export function installGitPrePushHook(
  repoRoot: string,
  shimPath: string,
): { installed: boolean; note: string } {
  const gitDir = join(repoRoot, ".git");
  let isDir = false;
  try {
    isDir = statSync(gitDir).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    return {
      installed: false,
      note: "skipped the git pre-push hook (no plain .git/ directory — worktree/submodule or non-git). Add it manually for push-time warnings.",
    };
  }
  const hooksDir = join(gitDir, "hooks");
  if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, "pre-push");
  if (existsSync(hookPath)) {
    let existing = "";
    try {
      existing = readFileSync(hookPath, "utf8");
    } catch {
      existing = "";
    }
    if (!existing.includes(GIT_HOOK_MARKER)) {
      return {
        installed: false,
        note: `left your existing .git/hooks/pre-push untouched. To enable the warn-only push check, append:  '${shimPath}' "$@"`,
      };
    }
  }
  const body = [
    "#!/usr/bin/env bash",
    `# ${GIT_HOOK_MARKER} (warn-only). Do not edit by hand.`,
    `SHIM='${shSingleQuote(shimPath)}'`,
    '[ -x "$SHIM" ] && "$SHIM" "$@"',
    "exit 0",
    "",
  ].join("\n");
  writeFileSync(hookPath, body);
  chmodSync(hookPath, 0o755);
  return { installed: true, note: `installed warn-only git pre-push hook → ${hookPath}` };
}

// True when the Reviewgate hooks are actually wired into .claude/settings.json
// (detected by a hook command pointing at .reviewgate/bin/). `setup` writes only
// the config; the gate is not armed until `init` installs these hooks — so setup
// uses this to offer arming the gate at the end.
export function hooksInstalled(repoRoot: string): boolean {
  const settingsPath = join(repoRoot, ".claude", "settings.json");
  if (!existsSync(settingsPath)) return false;
  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
    };
    const groups = settings.hooks ? Object.values(settings.hooks) : [];
    return groups.some((entries) =>
      (entries ?? []).some((e) =>
        (e.hooks ?? []).some(
          (c) => typeof c.command === "string" && c.command.includes(".reviewgate/bin/"),
        ),
      ),
    );
  } catch {
    return false;
  }
}

export async function runInit(
  input: InitInput,
): Promise<{ bakedBin: string; prePushHook: { installed: boolean; note: string } }> {
  if (input.mode !== "agent-loop") {
    throw new Error(`invalid --mode "${input.mode}": the only supported value is "agent-loop"`);
  }

  // 1. Create .reviewgate/bin/ and copy templates
  const binDir = join(input.repoRoot, ".reviewgate", "bin");
  if (!existsSync(binDir)) mkdirSync(binDir, { recursive: true });
  const here = fileURLToPath(import.meta.url);
  // Resolve bin-templates across all run modes:
  //  - `bun run dev`: ../../../../bin-templates lands at the repo root.
  //  - compiled binary: `bun build --compile` does NOT bundle them, so the build
  //    copies them to dist/bin-templates next to the executable → resolve via
  //    dirname(process.execPath).
  //  - running from the repo root: process.cwd()/bin-templates.
  const candidates = [
    join(dirname(process.execPath), "bin-templates"),
    join(here, "..", "..", "..", "..", "bin-templates"),
    join(process.cwd(), "bin-templates"),
  ];
  const tplDir = candidates.find((c) => existsSync(c));
  if (!tplDir) throw new Error(`bin-templates not found in: ${candidates.join(", ")}`);

  // Bake the absolute path of the binary that ran `init` into each shim, so the
  // hooks work even when `reviewgate` is NOT on the (non-login) PATH the Claude
  // Code hook process inherits — the previous bare `exec reviewgate …` exited 127
  // with empty stdout, which Claude Code reads as "allow stop" (a silent no-op
  // gate). Only bake a real reviewgate binary: under `bun run dev` execPath is the
  // bun runtime, not a usable `reviewgate`, so leave it empty and let the shim
  // fall back to PATH (and, for the gate, FAIL CLOSED if nothing resolves).
  const { bakedBin, warning: bakedWarning } = resolveBakedBin(process.execPath);
  if (bakedWarning) console.error(`reviewgate init: WARNING — ${bakedWarning}`);
  writeShims(binDir, tplDir, bakedBin);

  // 2. Merge hooks into .claude/settings.json
  const settingsDir = join(input.repoRoot, ".claude");
  if (!existsSync(settingsDir)) mkdirSync(settingsDir, { recursive: true });
  const settingsPath = join(settingsDir, "settings.json");
  let settings: { hooks?: Record<string, unknown[]> } = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8")) as typeof settings;
    } catch (err) {
      // The file exists but is not valid JSON (a JSONC comment, a trailing comma,
      // a half-saved file). Re-using `settings = {}` here and then writing it back
      // would SILENTLY DESTROY the user's permissions/env/model/foreign hooks — we
      // only know the 3 Reviewgate hooks, not the rest. Never overwrite: back the
      // unparseable file up so it isn't lost, then ABORT with an actionable message
      // telling the user to fix or remove settings.json and re-run init.
      const backupPath = `${settingsPath}.bak`;
      try {
        renameSync(settingsPath, backupPath);
      } catch {
        /* best-effort: even if the backup move fails we still must not overwrite */
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Reviewgate init aborted: ${settingsPath} exists but is not valid JSON (${msg}). It has been backed up to ${backupPath} so nothing is lost. Fix or remove ${settingsPath} (restore from the .bak after correcting it), then re-run \`reviewgate init\`. Reviewgate refuses to overwrite it because doing so would destroy your other hooks/permissions/env.`,
      );
    }
  }
  settings.hooks = settings.hooks ?? {};
  for (const event of ["PostToolUse", "Stop", "SessionStart"] as const) {
    const desired = HOOKS_TEMPLATE[event];
    const existing = (settings.hooks[event] ?? []) as Array<{
      hooks?: Array<{ command?: string }>;
    }>;
    const filtered = existing.filter((entry) => {
      const cmds = entry.hooks ?? [];
      return !cmds.some(
        (c) => typeof c.command === "string" && c.command.includes(".reviewgate/bin/"),
      );
    });
    settings.hooks[event] = [...filtered, ...desired];
  }
  // Atomic (tmp+rename): an interrupted write can't truncate/corrupt settings.json
  // (which would silently disarm every hook in the project, including foreign ones).
  writeFileAtomic(settingsPath, JSON.stringify(settings, null, 2));

  // 3. Reconcile .gitignore (idempotent migration, not blind append). The prior writer only
  // APPENDED, so a repo init'd before P9 keeps stale root-anchored lines — and the stale
  // `.reviewgate/cassettes/` dir-exclude would re-break ROOT golden tracking under the new
  // un-anchored patterns. Strip every Reviewgate-managed line (the current set + the OLD set),
  // preserving ALL unrelated user lines and their order, then append the fresh managed block.
  // Atomic write (tmp+rename) so an interrupted write can't truncate the user's .gitignore.
  const giPath = join(input.repoRoot, ".gitignore");
  const existingGi = existsSync(giPath) ? readFileSync(giPath, "utf8") : "";
  const managed = new Set([...OLD_GITIGNORE_LINES, ...GITIGNORE_LINES].map((l) => l.trim()));
  const keptLines = existingGi.split("\n").filter((l) => !managed.has(l.trim()));
  const keptBody = keptLines.join("\n").replace(/\n+$/, "");
  const out = `${keptBody ? `${keptBody}\n` : ""}${GITIGNORE_LINES.join("\n")}\n`;
  if (out !== existingGi) {
    writeFileAtomic(giPath, out);
  }

  // 4. Write a starter reviewgate.config.ts if none exists.
  // A PLAIN default-export object (NOT `defineConfig` from a bare "reviewgate"
  // import — that package isn't installed in your project and would fail to
  // resolve, causing Reviewgate to silently fall back to defaults). Reviewgate
  // deep-merges this object over its defaults and validates it.
  const cfgPath = join(input.repoRoot, "reviewgate.config.ts");
  if (!existsSync(cfgPath)) {
    const starter = [
      "// Reviewgate config. A plain object, deep-merged over defaults + validated.",
      "// Uncomment / edit to enable more reviewers. Models & OAuth-vs-OpenRouter",
      "// are entirely your choice. Slugs: https://openrouter.ai/models",
      "export default {",
      "  providers: {",
      '    codex: { enabled: true, auth: "oauth", model: "gpt-5.5", timeoutMs: 300_000 },',
      "    // openrouter powers the brain's embeddings below (and can also be a",
      "    // reviewer). Needs OPENROUTER_API_KEY in your environment.",
      "    // openrouterProvider PINS the upstream — without it OpenRouter routes deepseek/* to",
      "    // an arbitrary (often priciest) upstream. `alibaba` = cheapest full-precision upstream",
      "    // for deepseek-v4-flash; re-pick it if you change the model (alibaba is pricey for -pro).",
      '    openrouter: { enabled: true, auth: "openrouter", model: "deepseek/deepseek-v4-flash", apiKeyEnv: "OPENROUTER_API_KEY", timeoutMs: 300_000, openrouterProvider: { only: ["alibaba"] } },',
      '    // gemini: { enabled: true, auth: "oauth", model: "gemini-3.5-flash", timeoutMs: 300_000 }, // runs the agy CLI; model is informational (agy ignores -m)',
      '    // "claude-code": { enabled: true, auth: "oauth", model: "claude-sonnet-4-6", timeoutMs: 300_000 },',
      "  },",
      "  phases: {",
      "    review: {",
      "      reviewers: [",
      "        // `fallback` = quota-failover chain: if codex hits its usage cap, the",
      "        // gate auto-re-runs this review on gemini, then claude-code — both",
      "        // OAuth/$0. Each runs only if available. Reorder/trim to taste.",
      "        // NOTE: openrouter (deepseek-flash) is deliberately NOT in the failover —",
      "        // it's a low-precision PAID reviewer; it stays enabled below for the brain's",
      "        // embeddings only. Append it to `fallback` only if you want a paid last resort.",
      '        { provider: "codex", persona: "security", fallback: ["gemini", "claude-code"] },',
      "        // 👉 CONSENSUS — the strongest false-positive suppressor: add a 2nd strong,",
      "        //    independent reviewer so a finding BOTH raise is high-confidence and a LONE",
      "        //    one is demotable (and the FP-ledger/reputation machinery, inert on 1",
      "        //    reviewer, starts working). Both OAuth/$0, but uses 2x your subscription",
      '        //    quota per review. Uncomment (then drop "claude-code" from codex\'s fallback',
      "        //    above, since it becomes a primary):",
      '        // { provider: "claude-code", persona: "security", fallback: ["gemini"] },',
      "        // Or add a different-angle reviewer instead (less consensus overlap, more coverage):",
      '        // { provider: "gemini", persona: "architecture" },',
      '        // { provider: "claude-code", persona: "adversarial" },',
      "      ],",
      "    },",
      "    // FP-ledger: learns the finding signatures you reject as false positives",
      "    // and stops re-reporting them. Standalone — no external dependency.",
      "    fpLedger: { enabled: true },",
      "    // Brain: committed per-repo memory. Reviewers read relevant entries and",
      "    // may propose new conventions; the curator (an LLM judge) validates",
      "    // proposals and checks FP-ledger entries against memory. REQUIRES",
      "    // openrouter + OPENROUTER_API_KEY (for embeddings) — remove this block",
      "    // (and openrouter above) to turn the memory features off.",
      "    // Cross-run quorum (default ON, ttlDays=60, maxEntries=5000): proposals",
      "    // that fail ONLY the ≥2-provider quorum are persisted to",
      "    // .reviewgate/brain/candidates.jsonl; a future run from a DIFFERENT",
      "    // provider completes the quorum and the proposal gets promoted — so",
      "    // single-reviewer or low-overlap panels can still build up a brain over",
      "    // time. Override with `crossRunCandidates: { enabled: false }`.",
      "    brain: {",
      "      enabled: true,",
      "      maxPromptTokens: 1500,",
      '      embeddings: { provider: "openrouter", model: "baai/bge-base-en-v1.5", apiKeyEnv: "OPENROUTER_API_KEY" },',
      "      egressAllowlist: [],",
      "      curatorTimeoutMs: 60_000,",
      "      // The LLM judge — a NON-reviewer provider (opencode) for independence.",
      "      // Non-blocking: if opencode isn't installed the judge falls back to its",
      "      // default and `doctor` warns. Switch to codex if you don't run opencode.",
      '      curator: { provider: "opencode", persona: "fp-filter" },',
      "    },",
      "  },",
      "  // weeklyReport: { autoSnapshot: true }, // write .reviewgate/reports/<iso>.md on weekly rollover",
      "};",
      "",
    ].join("\n");
    writeFileSync(cfgPath, starter);
  }

  // 5. Install the warn-only git pre-push hook (Rec #3 deep half), delegating to the
  // .reviewgate/bin/pre-push shim written in step 1. Conservative + no-clobber; never blocks.
  const prePushHook = installGitPrePushHook(input.repoRoot, join(binDir, "pre-push"));

  return { bakedBin, prePushHook };
}
