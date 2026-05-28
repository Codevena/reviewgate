import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOKS_TEMPLATE = {
  PostToolUse: [
    {
      matcher: "Edit|Write|MultiEdit|NotebookEdit",
      hooks: [
        {
          type: "command",
          command: "${CLAUDE_PROJECT_DIR}/.reviewgate/bin/trigger",
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
          command: "${CLAUDE_PROJECT_DIR}/.reviewgate/bin/gate",
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
          command: "${CLAUDE_PROJECT_DIR}/.reviewgate/bin/reset",
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
];

export interface InitInput {
  repoRoot: string;
  mode: "agent-loop";
}

export async function runInit(input: InitInput): Promise<void> {
  if (input.mode !== "agent-loop") throw new Error("M1 only supports --mode=agent-loop");

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

  for (const name of ["trigger", "gate", "reset"]) {
    const src = join(tplDir, `${name}.sh`);
    const dst = join(binDir, name);
    copyFileSync(src, dst);
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
    } catch {
      settings = {};
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
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

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
      '    codex: { enabled: true, auth: "oauth", model: "gpt-5.4", timeoutMs: 300_000 },',
      "    // openrouter powers the brain's embeddings below (and can also be a",
      "    // reviewer). Needs OPENROUTER_API_KEY in your environment.",
      '    openrouter: { enabled: true, auth: "openrouter", model: "deepseek/deepseek-v4-pro", apiKeyEnv: "OPENROUTER_API_KEY", timeoutMs: 300_000 },',
      '    // gemini: { enabled: true, auth: "oauth", model: "gemini-3-flash-preview", timeoutMs: 300_000 },',
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
}
