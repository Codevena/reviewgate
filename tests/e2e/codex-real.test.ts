// tests/e2e/codex-real.test.ts
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, cpSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../../src/cli/commands/init.ts';
import { runGate } from '../../src/cli/commands/gate.ts';

const E2E = process.env['REVIEWGATE_E2E'] === '1';

(E2E ? describe : describe.skip)('e2e with real codex', () => {
  it('finds the timing-unsafe compare bug', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'rg-e2e-'));
    cpSync(join(process.cwd(), 'tests/e2e/fixtures/repo-with-bug'), repo, { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: repo });
    spawnSync('git', ['add', '.'], { cwd: repo });
    spawnSync('git', ['-c', 'user.email=e@e', '-c', 'user.name=e', 'commit', '-q', '-m', 'init'], { cwd: repo });
    writeFileSync(join(repo, 'foo.ts'), readFileSync(join(repo, 'foo.ts'), 'utf8') + '\n// edit\n');

    await runInit({ repoRoot: repo, mode: 'agent-loop' });
    await runGate({
      repoRoot: repo,
      hook: 'trigger',
      hookStdinRaw: JSON.stringify({ tool: { name: 'Edit', path: 'foo.ts' } }),
    });
    const stop = await runGate({ repoRoot: repo, hook: 'stop', hookStdinRaw: '{}' });
    expect(stop.exitCode).toBe(0);
    const decision = stop.stdout ? JSON.parse(stop.stdout) : { decision: 'allow' };
    expect(['block', 'allow']).toContain(decision.decision ?? 'allow');
    expect(existsSync(join(repo, '.reviewgate', 'pending.md'))).toBe(true);
    const md = readFileSync(join(repo, '.reviewgate', 'pending.md'), 'utf8');
    // The exact rule_id depends on Codex's wording; assert by content keyword.
    expect(md.toLowerCase()).toMatch(/timing|compare|=={2}/);
  });
});
