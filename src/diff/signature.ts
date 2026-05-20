// src/diff/signature.ts
import { createHash } from "node:crypto";
import type { FindingCategory } from "../schemas/finding.ts";

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
  return raw.toLowerCase().replace(/-+/g, "-");
}

function lineBucket(lineStart: number, bucketSize: number): number {
  return Math.floor((lineStart - 1) / bucketSize) * bucketSize;
}

export function computeSignature(input: SignatureInput): string {
  const symbolName = input.symbolName ?? "";
  let bucketedOffset: number;
  if (input.symbolName && input.symbolStartLine !== undefined) {
    const offset = Math.max(0, input.lineStart - input.symbolStartLine);
    bucketedOffset = Math.floor(offset / 5) * 5;
  } else {
    bucketedOffset = lineBucket(input.lineStart, 10);
  }
  const parts = [
    input.file,
    normalizeRuleId(input.ruleId),
    input.category,
    symbolName,
    String(bucketedOffset),
  ];
  return createHash("sha256").update(parts.join("|")).digest("hex");
}
