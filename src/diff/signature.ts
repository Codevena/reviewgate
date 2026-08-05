// src/diff/signature.ts
import { createHash } from "node:crypto";
import type { FindingCategory } from "../schemas/finding.ts";

export interface SignatureInput {
  file: string;
  ruleId: string;
  category: FindingCategory;
  lineStart: number;
  // The range END is intentionally NOT a signature ingredient: dedup/stuck-detection
  // buckets a finding by its bucketed `lineStart` (or symbol offset) only, so two
  // findings in the same bucket — e.g. [10,12] vs [10,40] — deliberately collapse to
  // one signature regardless of how far they each extend. lineEnd is accepted (so
  // callers can pass a Finding's full range without reshaping) but never read; keep
  // it optional to make that "does-not-affect-identity" contract explicit.
  lineEnd?: number;
  // Reserved for M3 when tree-sitter lands.
  symbolName?: string;
  symbolStartLine?: number;
}

// rule_id is LLM-authored, so the SAME underlying issue gets phrased differently
// across runs ("command-injection-via-execsync" vs "command-injection-execsync").
// That drift used to change the signature → it broke stuck-detection (identical-
// signature based) and FP-ledger re-matching. We normalize to a drift-tolerant
// canonical form: lowercase → tokenize on any non-alphanumeric → drop connector /
// generic-noise words → dedupe → SORT (order-insensitive) → rejoin. So phrasing
// variants of one rule collapse, while genuinely different rules stay distinct.
const RULE_ID_NOISE = new Set([
  // connectors / fillers the model sprinkles in inconsistently
  "via",
  "with",
  "using",
  "of",
  "in",
  "on",
  "to",
  "for",
  "the",
  "a",
  "an",
  "and",
  "or",
  "from",
  "by",
  "due",
  // generic severity/finding nouns appended inconsistently
  "risk",
  "issue",
  "vuln",
  "vulnerability",
  "warning",
  "error",
  "bug",
  "problem",
  "potential",
  "possible",
  "unsafe",
  "insecure",
]);

export function normalizeRuleId(raw: string): string {
  const tokens = raw
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && !RULE_ID_NOISE.has(t));
  const canonical = [...new Set(tokens)].sort().join("-");
  // Fallback: if every token was noise (degenerate rule_id), keep a stable
  // lowercased form rather than collapsing every such rule to one empty signature.
  return canonical.length > 0 ? canonical : raw.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

// Light suffix folding on top of the noise-filtered tokeniser: reviewers phrase the
// same concept as `pipe`/`piped` and `defang`/`defanged`, which normalizeRuleId's
// exact token-set equality treats as different rules. Strip one inflection, then a
// trailing `e`, so both sides land on the same stem (`pip`, `defang`). Deliberately
// cruder than a real stemmer — it only has to make paraphrases of one rule collide,
// and it emits stems rather than words (`delet`, `spac`), which is expected output.
function foldSuffix(token: string): string {
  let s = token;
  for (const suf of ["ing", "ed", "s"]) {
    if (s.length - suf.length >= 3 && s.endsWith(suf) && !s.endsWith("ss")) {
      s = s.slice(0, -suf.length);
      break;
    }
  }
  return s.length > 3 && s.endsWith("e") ? s.slice(0, -1) : s;
}

/** Canonical token SET for a rule_id: the normalizeRuleId tokeniser and its
 *  RULE_ID_NOISE filter, plus suffix folding. Used for semantic FP clustering
 *  (`computeFpSemanticClusters`); deliberately NOT part of computeSignature,
 *  whose identity must stay exact. */
export function canonicalRuleTokens(raw: string): Set<string> {
  const out = new Set<string>();
  for (const t of raw.toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length === 0 || RULE_ID_NOISE.has(t)) continue;
    out.add(foldSuffix(t));
  }
  return out;
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
