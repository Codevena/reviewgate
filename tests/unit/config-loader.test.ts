import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config/loader.ts';
import { defaultConfig } from '../../src/config/defaults.ts';

function writeConfig(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'rg-config-'));
  const f = join(dir, 'reviewgate.config.ts');
  writeFileSync(f, content);
  return f;
}

describe('loadConfig', () => {
  it('returns defaults when no config file given', async () => {
    const cfg = await loadConfig(null);
    expect(cfg.loop.maxIterations).toBe(defaultConfig.loop.maxIterations);
    expect(cfg.providers.codex.enabled).toBe(true);
  });

  it('merges user-defined values on top of defaults', async () => {
    const file = writeConfig(`
      import { defineConfig } from '${process.cwd()}/src/config/define-config.ts';
      export default defineConfig({
        loop: { maxIterations: 5 },
      });
    `);
    const cfg = await loadConfig(file);
    expect(cfg.loop.maxIterations).toBe(5);
    // unchanged values remain
    expect(cfg.loop.costCapUsd).toBe(defaultConfig.loop.costCapUsd);
  });

  it('rejects invalid config (schema violation)', async () => {
    const file = writeConfig(`
      import { defineConfig } from '${process.cwd()}/src/config/define-config.ts';
      export default defineConfig({
        loop: { maxIterations: -1 },
      });
    `);
    await expect(loadConfig(file)).rejects.toThrow();
  });
});
