// src/diff/signature.ts
import { createHash } from 'node:crypto';
import type { FindingCategory } from '../schemas/finding.ts';

export interface SignatureInput {
  file: string;
  ruleId: string;
  category: FindingCategory;
  lineStart: number;
  lineEnd: number;
  // Reserved for M3 when tree-sitter lands.
  symbolName?: string;
  symbolStartLine?: number;
}

function normalizeRuleId(raw: string): string {
  return raw.toLowerCase().replace(/-+/g, '-');
}

function lineBucket(lineStart: number, bucketSize: number): number {
  return Math.floor((lineStart - 1) / bucketSize) * bucketSize;
}

export function computeSignature(input: SignatureInput): string {
  const symbolName = input.symbolName ?? '';
  const offset = input.symbolName && input.symbolStartLine !== undefined
    ? Math.max(0, input.lineStart - input.symbolStartLine)
    : 0;
  // No tree-sitter context in M1: bucket size 10 (per spec §5.5).
  const bucketedOffset = input.symbolName ? offset : lineBucket(input.lineStart, 10);
  const parts = [
    input.file,
    normalizeRuleId(input.ruleId),
    input.category,
    symbolName,
    String(bucketedOffset),
  ];
  return createHash('sha256').update(parts.join('|')).digest('hex');
}
