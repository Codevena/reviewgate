import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS_TEMPLATE = {
  PostToolUse: [
    {
      matcher: 'Edit|Write|MultiEdit|NotebookEdit',
      hooks: [
        {
          type: 'command',
          command: '${CLAUDE_PROJECT_DIR}/.reviewgate/bin/trigger',
          timeout: 5,
          async: true,
          statusMessage: 'Reviewgate: analyzing…',
        },
      ],
    },
  ],
  Stop: [
    {
      matcher: '*',
      hooks: [
        {
          type: 'command',
          command: '${CLAUDE_PROJECT_DIR}/.reviewgate/bin/gate',
          timeout: 900,
        },
      ],
    },
  ],
  SessionStart: [
    {
      hooks: [
        {
          type: 'command',
          command: '${CLAUDE_PROJECT_DIR}/.reviewgate/bin/reset',
        },
      ],
    },
  ],
};

const GITIGNORE_LINES = [
  '# Reviewgate (auto-added; edit reviewgate.config.ts to override)',
  '.reviewgate/audit/',
  '.reviewgate/cassettes/',
  '!.reviewgate/cassettes/golden/',
  '.reviewgate/reports/',
  '.reviewgate/pending.*',
  '.reviewgate/decisions/',
  '.reviewgate/state.json',
  '.reviewgate/research.md',
  '.reviewgate/dirty.flag',
  '.reviewgate/ESCALATION.md',
  '.reviewgate/.lock',
  '.reviewgate/cache/',
];

export interface InitInput {
  repoRoot: string;
  mode: 'agent-loop';
}

export async function runInit(input: InitInput): Promise<void> {
  if (input.mode !== 'agent-loop') throw new Error('M1 only supports --mode=agent-loop');

  // 1. Create .reviewgate/bin/ and copy templates
  const binDir = join(input.repoRoot, '.reviewgate', 'bin');
  if (!existsSync(binDir)) mkdirSync(binDir, { recursive: true });
  const here = fileURLToPath(import.meta.url);
  // The bin-templates ship alongside the binary; resolve relative to the package root.
  // When running via `bun run dev`, ../../.. lands at the repo root; when compiled,
  // bun build --compile bundles bin-templates as resources under {assetsDir}.
  const candidates = [
    join(here, '..', '..', '..', '..', 'bin-templates'),
    join(process.cwd(), 'bin-templates'),
  ];
  const tplDir = candidates.find((c) => existsSync(c));
  if (!tplDir) throw new Error(`bin-templates not found in: ${candidates.join(', ')}`);

  for (const name of ['trigger', 'gate', 'reset']) {
    const src = join(tplDir, `${name}.sh`);
    const dst = join(binDir, name);
    copyFileSync(src, dst);
    chmodSync(dst, 0o755);
  }

  // 2. Merge hooks into .claude/settings.json
  const settingsDir = join(input.repoRoot, '.claude');
  if (!existsSync(settingsDir)) mkdirSync(settingsDir, { recursive: true });
  const settingsPath = join(settingsDir, 'settings.json');
  let settings: { hooks?: Record<string, unknown[]> } = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as typeof settings;
    } catch {
      settings = {};
    }
  }
  settings.hooks = settings.hooks ?? {};
  for (const event of ['PostToolUse', 'Stop', 'SessionStart'] as const) {
    const desired = HOOKS_TEMPLATE[event];
    const existing = (settings.hooks[event] ?? []) as Array<{ hooks?: Array<{ command?: string }> }>;
    const filtered = existing.filter((entry) => {
      const cmds = entry.hooks ?? [];
      return !cmds.some((c) => typeof c.command === 'string' && c.command.includes('.reviewgate/bin/'));
    });
    settings.hooks[event] = [...filtered, ...desired];
  }
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  // 3. Append .gitignore (idempotent: skip lines that already exist verbatim)
  const giPath = join(input.repoRoot, '.gitignore');
  const existingGi = existsSync(giPath) ? readFileSync(giPath, 'utf8') : '';
  const existingLines = new Set(existingGi.split('\n').map((l) => l.trim()));
  const toAppend = GITIGNORE_LINES.filter((l) => !existingLines.has(l.trim()));
  if (toAppend.length > 0) {
    const sep = existingGi.length > 0 && !existingGi.endsWith('\n') ? '\n' : '';
    writeFileSync(giPath, existingGi + sep + toAppend.join('\n') + '\n');
  }

  // 4. Write a starter reviewgate.config.ts if none exists
  const cfgPath = join(input.repoRoot, 'reviewgate.config.ts');
  if (!existsSync(cfgPath)) {
    writeFileSync(
      cfgPath,
      `import { defineConfig } from 'reviewgate';\n\nexport default defineConfig({\n  // M1 defaults are fine for most users; see docs for the full schema.\n});\n`,
    );
  }
}
