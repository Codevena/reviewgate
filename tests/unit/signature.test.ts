// tests/unit/signature.test.ts
import { describe, expect, it } from 'bun:test';
import { computeSignature } from '../../src/diff/signature.ts';

describe('computeSignature', () => {
  it('produces a 64-char sha256 hex string', () => {
    const sig = computeSignature({
      file: 'src/auth.ts',
      ruleId: 'sql-injection',
      category: 'security',
      lineStart: 42,
      lineEnd: 42,
    });
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable across small line shifts in the same 10-line bucket', () => {
    const a = computeSignature({ file: 'a.ts', ruleId: 'r', category: 'security', lineStart: 41, lineEnd: 41 });
    const b = computeSignature({ file: 'a.ts', ruleId: 'r', category: 'security', lineStart: 49, lineEnd: 49 });
    expect(a).toBe(b);
  });

  it('changes across bucket boundaries', () => {
    const a = computeSignature({ file: 'a.ts', ruleId: 'r', category: 'security', lineStart: 39, lineEnd: 39 });
    const b = computeSignature({ file: 'a.ts', ruleId: 'r', category: 'security', lineStart: 41, lineEnd: 41 });
    expect(a).not.toBe(b);
  });

  it('normalizes rule_id (lowercase, hyphen-collapse)', () => {
    const a = computeSignature({ file: 'a.ts', ruleId: 'SQL-Injection', category: 'security', lineStart: 10, lineEnd: 10 });
    const b = computeSignature({ file: 'a.ts', ruleId: 'sql---injection', category: 'security', lineStart: 10, lineEnd: 10 });
    expect(a).toBe(b);
  });

  it('changes when file changes', () => {
    const a = computeSignature({ file: 'a.ts', ruleId: 'r', category: 'security', lineStart: 10, lineEnd: 10 });
    const b = computeSignature({ file: 'b.ts', ruleId: 'r', category: 'security', lineStart: 10, lineEnd: 10 });
    expect(a).not.toBe(b);
  });
});
