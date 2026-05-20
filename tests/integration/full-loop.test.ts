// tests/integration/full-loop.test.ts
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runInit } from '../../src/cli/commands/init.ts';
import { runGate } from '../../src/cli/commands/gate.ts';
import { CodexAdapter } from '../../src/providers/codex.ts';

const FAKE_CODEX = join(process.cwd(), 'tests/fixtures/fake-codex.sh');

function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rg-loop-it-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, 'foo.ts'), 'function compare(a, b) { return a == b; }');
  spawnSync('git', ['add', 'foo.ts'], { cwd: dir });
  spawnSync('git', ['-c', 'user.email=x@x', '-c', 'user.name=x', 'commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

describe('full loop integration', () => {
  it('init → trigger → gate (block) → decisions → gate (pass)', async () => {
    const repo = tmpRepo();
    await runInit({ repoRoot: repo, mode: 'agent-loop' });

    // 1. Simulate PostToolUse: write a dirty.flag.
    const triggerOut = await runGate({
      repoRoot: repo,
      hook: 'trigger',
      hookStdinRaw: JSON.stringify({ tool: { name: 'Edit', path: 'foo.ts' } }),
      providerOverrides: { codex: new CodexAdapter({ binPath: FAKE_CODEX }) },
      sandboxModeOverride: 'off',
    });
    expect(triggerOut.exitCode).toBe(0);

    // 2. First Stop hook: should BLOCK because findings exist and no decisions yet.
    const firstStop = await runGate({
      repoRoot: repo,
      hook: 'stop',
      hookStdinRaw: '{}',
      providerOverrides: { codex: new CodexAdapter({ binPath: FAKE_CODEX }) },
      sandboxModeOverride: 'off',
    });
    expect(firstStop.exitCode).toBe(0);
    const firstDecision = JSON.parse(firstStop.stdout);
    expect(firstDecision.decision).toBe('block');
    expect(existsSync(join(repo, '.reviewgate', 'pending.md'))).toBe(true);

    // 3. Claude "fixes" the issue and writes decisions/1.jsonl (using the F-001 ID
    //    emitted by fake-codex.sh).
    const decisionsDir = join(repo, '.reviewgate', 'decisions');
    spawnSync('mkdir', ['-p', decisionsDir]);
    writeFileSync(
      join(decisionsDir, '1.jsonl'),
      JSON.stringify({
        schema: 'reviewgate.decision.v1',
        finding_id: 'F-001',
        verdict: 'accepted',
        action: 'fixed',
        files_touched: ['foo.ts'],
      }) + '\n',
    );

    // Touch the dirty.flag again to simulate a follow-up edit.
    await runGate({
      repoRoot: repo,
      hook: 'trigger',
      hookStdinRaw: JSON.stringify({ tool: { name: 'Edit', path: 'foo.ts' } }),
      providerOverrides: { codex: new CodexAdapter({ binPath: FAKE_CODEX }) },
      sandboxModeOverride: 'off',
    });

    // 4. Second Stop hook with decisions present: the decisions-gate must
    //    ACCEPT decisions/1.jsonl (which covers finding F-001) and proceed to
    //    run a NEW iteration (iter 2). fake-codex always emits one CRITICAL,
    //    so iter 2 also FAILs and blocks — but the key proof is that the gate
    //    did NOT block on the decisions-check: iteration advanced to 2.
    //    (Regression guard: an earlier bug compared signatures against
    //    finding_id and would have blocked here, leaving iteration at 1.)
    const secondStop = await runGate({
      repoRoot: repo,
      hook: 'stop',
      hookStdinRaw: '{}',
      providerOverrides: { codex: new CodexAdapter({ binPath: FAKE_CODEX }) },
      sandboxModeOverride: 'off',
    });
    expect(secondStop.exitCode).toBe(0);
    const state = JSON.parse(readFileSync(join(repo, '.reviewgate', 'state.json'), 'utf8'));
    expect(state.iteration).toBe(2);
  });
});
