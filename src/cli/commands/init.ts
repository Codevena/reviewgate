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

// POSIX single-quote escaping for the binary path interpolated into the shim's
// `RG_BIN='<here>'`. The path comes from process.execPath, which can sit at an
// install/checkout location containing shell metacharacters (`"`, backtick,
// `$(…)`); a raw substitution into a quoted assignment would let that path
// EXECUTE at hook time. Single-quoting disables all shell expansion — the only
// character needing escaping is the single quote itself (' -> '\'').
export function shSingleQuote(value: string): string {
  return value.replace(/'/g, "'\\''");
}
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "../../utils/atomic-write.ts";

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
          timeout: 900,
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

const GITIGNORE_LINES = [
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
  "# Antigravity CLI (agy) working-tree artifact",
  ".antigravitycli",
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
  const bakedBin = /reviewgate/i.test(basename(process.execPath)) ? process.execPath : "";
  for (const name of ["trigger", "gate", "reset", "pre-push"]) {
    const src = join(tplDir, `${name}.sh`);
    const dst = join(binDir, name);
    const tpl = readFileSync(src, "utf8");
    // Shell-escape: the shim assigns RG_BIN='<this>' — see shSingleQuote.
    writeFileSync(dst, tpl.split("__REVIEWGATE_BIN__").join(shSingleQuote(bakedBin)));
    chmodSync(dst, 0o755);
  }

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

  // 3. Append .gitignore (idempotent: skip lines that already exist verbatim)
  const giPath = join(input.repoRoot, ".gitignore");
  const existingGi = existsSync(giPath) ? readFileSync(giPath, "utf8") : "";
  const existingLines = new Set(existingGi.split("\n").map((l) => l.trim()));
  const toAppend = GITIGNORE_LINES.filter((l) => !existingLines.has(l.trim()));
  if (toAppend.length > 0) {
    const sep = existingGi.length > 0 && !existingGi.endsWith("\n") ? "\n" : "";
    writeFileSync(giPath, `${existingGi + sep + toAppend.join("\n")}\n`);
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
      "        // gate auto-re-runs this review on gemini, then claude-code (both",
      "        // OAuth/$0), then openrouter (paid, last resort). Each runs only if",
      "        // available. Reorder/trim to taste.",
      '        { provider: "codex", persona: "security", fallback: ["gemini", "claude-code", "openrouter"] },',
      '        // { provider: "openrouter", persona: "security" },',
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
