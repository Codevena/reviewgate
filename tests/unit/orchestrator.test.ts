// tests/unit/orchestrator.test.ts
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator } from '../../src/core/orchestrator.ts';
import { CodexAdapter } from '../../src/providers/codex.ts';
import { defaultConfig } from '../../src/config/defaults.ts';

const FAKE_CODEX = join(process.cwd(), 'tests/fixtures/fake-codex.sh');

function fakeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rg-orch-'));
  writeFileSync(join(dir, 'foo.ts'), 'function compare(a, b) { return a === b; }');
  return dir;
}

describe('Orchestrator', () => {
  it('runs one iteration end-to-end against a fake codex and writes pending.md', async () => {
    const repo = fakeRepo();
    const orch = new Orchestrator({
      repoRoot: repo,
      config: defaultConfig,
      providers: { codex: new CodexAdapter({ binPath: FAKE_CODEX }) },
      sandboxMode: 'off',
      hostTier: 'opus',
      diff: '--- a/foo.ts\n+++ b/foo.ts\n@@ -1,1 +1,1 @@\n-function compare(a, b) { return a == b; }\n+function compare(a, b) { return a === b; }\n',
      reasonOnFailEnabled: true,
    });
    const result = await orch.runIteration({ runId: '01HXQTEST', iter: 1 });
    expect(result.verdict).toMatch(/PASS|SOFT-PASS|FAIL/);
    expect(existsSync(join(repo, '.reviewgate', 'pending.md'))).toBe(true);
    expect(existsSync(join(repo, '.reviewgate', 'pending.json'))).toBe(true);
  });
});
