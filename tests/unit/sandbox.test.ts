import { describe, expect, it } from 'bun:test';
import { buildSandboxProfile } from '../../src/sandbox/profile-builder.ts';

describe('buildSandboxProfile', () => {
  it('produces strict profile for codex with credential path allowed', () => {
    const p = buildSandboxProfile({
      providerId: 'codex',
      mode: 'strict',
      workingDir: '/repo',
      findingsPath: '/repo/.reviewgate/findings/codex.md',
      tmpDir: '/tmp/rg-run-1',
    });
    expect(p.fs.readDeny).toContain('~/.ssh');
    expect(p.fs.readAllow).toContain('/repo');
    expect(p.fs.readAllow).toContain('/tmp/rg-run-1');
    expect(p.fs.readAllow.some((path) => path.includes('.codex'))).toBe(true);
    expect(p.fs.readAllow.some((path) => path.includes('.claude'))).toBe(false);
    expect(p.fs.writeAllow).toEqual(['/repo/.reviewgate/findings/codex.md', '/tmp/rg-run-1']);
    expect(p.net.allow).toContain('api.openai.com');
    expect(p.net.allow).not.toContain('api.anthropic.com');
  });

  it('off mode returns sandboxRequested=false', () => {
    const p = buildSandboxProfile({
      providerId: 'codex',
      mode: 'off',
      workingDir: '/repo',
      findingsPath: '/repo/x.md',
      tmpDir: '/tmp/x',
    });
    expect(p.sandboxRequested).toBe(false);
  });
});
