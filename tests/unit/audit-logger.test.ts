// tests/unit/audit-logger.test.ts
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLogger } from '../../src/audit/logger.ts';
import { verifyChain } from '../../src/audit/verifier.ts';

function tmp() { return mkdtempSync(join(tmpdir(), 'rg-audit-')); }

describe('AuditLogger', () => {
  it('appends events with sha256 hash chain', async () => {
    const dir = tmp();
    const log = new AuditLogger(dir);
    await log.append({ event: 'session.start', run_id: 'r1', iter: 0, trigger: 'session-start' });
    await log.append({ event: 'run.start', run_id: 'r1', iter: 1, trigger: 'stop-hook' });
    await log.append({ event: 'reviewer.complete', run_id: 'r1', iter: 1, trigger: 'stop-hook' });
    const path = log.currentFilePath();
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines.length).toBe(3);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0].prev_event_hash).toBe('');
    expect(parsed[1].prev_event_hash).toBe(parsed[0].this_event_hash);
    expect(parsed[2].prev_event_hash).toBe(parsed[1].this_event_hash);
  });

  it('verifyChain returns ok=true on a freshly written chain', async () => {
    const dir = tmp();
    const log = new AuditLogger(dir);
    await log.append({ event: 'session.start', run_id: 'r1', iter: 0, trigger: 'session-start' });
    await log.append({ event: 'session.end', run_id: 'r1', iter: 0, trigger: 'session-start' });
    const v = await verifyChain(log.currentFilePath());
    expect(v.ok).toBe(true);
    expect(v.brokenAtLine).toBeNull();
  });

  it('verifyChain detects tampering', async () => {
    const dir = tmp();
    const log = new AuditLogger(dir);
    await log.append({ event: 'session.start', run_id: 'r1', iter: 0, trigger: 'session-start' });
    await log.append({ event: 'reviewer.complete', run_id: 'r1', iter: 1, trigger: 'stop-hook' });
    const path = log.currentFilePath();
    const { readFileSync, writeFileSync } = await import('node:fs');
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    const obj = JSON.parse(lines[0] as string);
    obj.iter = 999; // tamper but recompute nothing
    lines[0] = JSON.stringify(obj);
    writeFileSync(path, `${lines.join('\n')}\n`);
    const v = await verifyChain(path);
    expect(v.ok).toBe(false);
    expect(v.brokenAtLine).toBe(2);
  });
});
