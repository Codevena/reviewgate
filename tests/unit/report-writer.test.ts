// tests/unit/report-writer.test.ts
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReportWriter } from '../../src/core/report-writer.ts';
import type { PendingReport } from '../../src/schemas/pending-report.ts';

const baseReport: PendingReport = {
  schema: 'reviewgate.pending.v1',
  run_id: 'r1',
  iter: 1,
  max_iter: 3,
  verdict: 'FAIL',
  counts: { critical: 1, warn: 1, info: 0 },
  reviewers: [
    { id: 'codex', provider: 'codex', model: 'gpt-5.4', persona: 'security', status: 'ok', cost_usd: 0, duration_ms: 1234 },
  ],
  findings: [
    {
      id: 'F-001',
      signature: 'sig1',
      severity: 'CRITICAL',
      category: 'security',
      rule_id: 'sql-injection',
      file: 'src/db.ts',
      line_start: 42,
      line_end: 42,
      message: 'unsanitized SQL',
      details: 'building SQL from string concat',
      reviewer: { provider: 'codex', model: 'gpt-5.4', persona: 'security' },
      confidence: 0.9,
      consensus: 'singleton',
    },
  ],
  cost_usd_total: 0,
  duration_ms_total: 1234,
  generated_at: '2026-05-20T14:32:11Z',
  git: { sha: 'abc1234', branch: 'main', dirty_files: ['src/db.ts'] },
};

describe('ReportWriter', () => {
  it('writes pending.md and pending.json side by side', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rg-rep-'));
    const w = new ReportWriter(dir);
    await w.write(baseReport);
    const md = readFileSync(join(dir, '.reviewgate', 'pending.md'), 'utf8');
    const json = JSON.parse(readFileSync(join(dir, '.reviewgate', 'pending.json'), 'utf8'));
    expect(md).toContain('FAIL');
    expect(md).toContain('F-001');
    expect(md).toContain('src/db.ts:42');
    expect(json.run_id).toBe('r1');
    expect(json.findings[0].id).toBe('F-001');
  });

  it('writes ESCALATION.md when verdict=ESCALATE', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rg-rep-'));
    const w = new ReportWriter(dir);
    await w.writeEscalation({
      runId: 'r1',
      iter: 3,
      maxIter: 3,
      reasonCode: 'max-iterations',
      summary: 'Hit max iterations without convergence.',
      perIter: [
        { iter: 1, verdict: 'FAIL', crit: 2, warn: 3, costUsd: 0.22, findings: 5 },
        { iter: 2, verdict: 'FAIL', crit: 1, warn: 3, costUsd: 0.18, findings: 4 },
        { iter: 3, verdict: 'FAIL', crit: 1, warn: 2, costUsd: 0.15, findings: 3 },
      ],
      topFindings: baseReport.findings,
      triggeredAt: '2026-05-20T14:35:00Z',
    });
    const md = readFileSync(join(dir, '.reviewgate', 'ESCALATION.md'), 'utf8');
    expect(md).toContain('max-iterations');
    expect(md).toContain('r1');
    expect(md).toContain('F-001');
  });
});
