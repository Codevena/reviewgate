// src/providers/review-output.ts
import { normalizeRepoPath } from "../diff/repo-path.ts";
import { computeSignature } from "../diff/signature.ts";
import {
  type Finding,
  FindingCategory,
  FindingSchema,
  SeverityCoerced,
} from "../schemas/finding.ts";
import { safeJsonParse } from "../utils/safe-json.ts";

export const REVIEW_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  // Strict structured-output mode (codex/OpenAI) requires EVERY property key to
  // appear in `required`; optionality is expressed via a nullable type below
  // (memory_proposals: ["array","null"]), never by omission.
  required: ["verdict", "findings", "memory_proposals"],
  properties: {
    verdict: { type: "string", enum: ["PASS", "FAIL"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "severity",
          "category",
          "rule_id",
          "file",
          "line",
          "line_end",
          "message",
          "details",
          "confidence",
          "evidence_line",
        ],
        properties: {
          severity: { type: "string", enum: ["CRITICAL", "WARN", "INFO"] },
          category: {
            type: "string",
            enum: [
              "security",
              "correctness",
              "quality",
              "architecture",
              "performance",
              "testing",
              "docs",
            ],
          },
          rule_id: { type: "string" },
          file: { type: "string" },
          line: { type: "integer" },
          // The issue's START line. `line_end` is the optional END line for a
          // multi-line issue (nullable per strict-mode: express optional via a
          // nullable type, never by omission). null/absent → single-line (= line).
          line_end: { type: ["integer", "null"] },
          message: { type: "string" },
          details: { type: "string" },
          confidence: { type: "number" },
          // S4 (field report 2026-06-23): the exact source line the finding relies on, verbatim, or
          // null if the deciding line/artifact was not provided to the reviewer. RENDER-ONLY: a
          // deterministic cross-check (fact-check.ts) badges a CLEAR mismatch vs the working-tree
          // line; it never changes severity. Nullable per strict-mode (express optional via type).
          evidence_line: { type: ["string", "null"] },
        },
      },
    },
    // OPTIONAL repo-knowledge proposals. Listed here (with the parent object's
    // additionalProperties:false) so OpenRouter's strict json_schema mode does
    // NOT silently strip them. Mirrors RawProposal. Evidence's reviewer_id/run_id
    // are deliberately omitted: the orchestrator stamps the emitting adapter's
    // identity and discards any LLM-supplied provider signal (anti-collusion).
    memory_proposals: {
      type: ["array", "null"],
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "scope", "title", "body", "confidence", "tags", "evidence"],
        properties: {
          type: {
            type: "string",
            enum: ["convention", "anti-pattern", "external-knowledge", "disagreement"],
          },
          scope: { type: "string" },
          title: { type: "string" },
          body: { type: "string" },
          confidence: { type: "number" },
          tags: { type: "array", items: { type: "string" } },
          evidence: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              // Strict mode: all property keys required; optional ones nullable.
              required: ["kind", "source_url", "snippet", "from_diff"],
              properties: {
                kind: { type: "string" },
                source_url: { type: ["string", "null"] },
                snippet: { type: ["string", "null"] },
                from_diff: {
                  type: ["object", "null"],
                  additionalProperties: false,
                  required: ["file", "line_start", "line_end"],
                  properties: {
                    file: { type: "string" },
                    line_start: { type: "integer" },
                    line_end: { type: "integer" },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
} as const;

export interface ReviewFinding {
  severity: "CRITICAL" | "WARN" | "INFO";
  category: string;
  rule_id: string;
  file: string;
  line: number;
  line_end?: number | null;
  message: string;
  details: string;
  confidence: number;
  evidence_line?: string | null;
}

// Reviewer-submitted (pre-enrichment) proposal shape. Mirrors MemoryProposalSchema
// but is kept loose here so review-output.ts has no dep on brain schemas.
export interface RawProposal {
  type: string;
  scope: string;
  title: string;
  body: string;
  confidence: number;
  tags: string[];
  evidence: Array<{
    kind: string;
    source_url?: string;
    snippet?: string;
    // A reviewer MAY cite which reviewer(s) corroborated an observation. When
    // present this is preserved (enabling the cross-provider quorum); when absent
    // the orchestrator stamps the emitting reviewer's id (collapsing to a single
    // provider — the anti-collusion default).
    reviewer_id?: string;
    from_diff?: { file: string; line_start: number; line_end: number };
  }>;
}

export interface ReviewOutput {
  verdict: "PASS" | "FAIL";
  findings: ReviewFinding[];
  memory_proposals?: RawProposal[];
}

// Rebuild each evidence item keeping only non-null optional fields. The strict
// schema marks source_url/snippet/from_diff as nullable, so a reviewer may send
// explicit nulls; we drop them so RawProposal stays optional-not-nullable.
function normalizeProposals(proposals: RawProposal[]): RawProposal[] {
  return (
    proposals
      // A reviewer can emit a non-object proposal element (e.g. `[null]`); dotting
      // into it (`p.evidence`) would throw a TypeError in this fail-closed module,
      // so drop non-objects before normalizing. (F-4a)
      .filter((p): p is RawProposal => p != null && typeof p === "object")
      .map((p) => ({
        ...p,
        evidence: Array.isArray(p.evidence)
          ? p.evidence
              // Likewise an evidence element may be null/non-object — skip it
              // rather than dereference `e.kind` and crash. (F-4a)
              .filter(
                (e): e is RawProposal["evidence"][number] => e != null && typeof e === "object",
              )
              .map((e) => {
                const cleaned: RawProposal["evidence"][number] = { kind: e.kind };
                if (e.source_url != null) cleaned.source_url = e.source_url;
                if (e.snippet != null) cleaned.snippet = e.snippet;
                if (e.reviewer_id != null) cleaned.reviewer_id = e.reviewer_id;
                if (e.from_diff != null) cleaned.from_diff = e.from_diff;
                return cleaned;
              })
          : [],
      }))
  );
}

export function parseReviewOutput(text: string): ReviewOutput | null {
  const tryParse = (s: string): ReviewOutput | null => {
    const parsed = safeJsonParse(s);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const o = parsed as Record<string, unknown>;
      if (Array.isArray(o.findings)) {
        // memory_proposals is nullable in the schema (strict mode), so codex may
        // emit `null` or null-valued optional evidence fields. Normalize null →
        // absent so the RawProposal contract (optional, not nullable) holds and
        // the Brain curator never sees a null where it expects undefined.
        const mp = Array.isArray(o.memory_proposals)
          ? normalizeProposals(o.memory_proposals as RawProposal[])
          : undefined;
        return {
          verdict: o.verdict === "PASS" ? "PASS" : "FAIL",
          findings: o.findings as ReviewFinding[],
          ...(mp !== undefined ? { memory_proposals: mp } : {}),
        };
      }
    }
    return null;
  };
  const direct = tryParse(text.trim());
  if (direct) return direct;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    const f = tryParse(fence[1].trim());
    if (f) return f;
  }
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) {
    const sliced = tryParse(text.slice(first, last + 1));
    if (sliced) return sliced;
  }
  return null;
}

export interface MapContext {
  provider: string;
  model: string;
  persona: string;
  workingDir: string;
}

// S2: reviewer-phrased category synonyms → the strict 7-value enum. Mirrors
// SeverityCoerced's philosophy but at the mapping edge (BEFORE computeSignature —
// the signature hashes the category, so coercion must precede it). Unknown
// values pass through UNCHANGED so FindingSchema.safeParse still rejects them:
// silently bucketing garbage into "quality" would hide a malformed reviewer.
const CATEGORY_SYNONYMS: Record<string, FindingCategory> = {
  vulnerability: "security",
  vuln: "security",
  "security-issue": "security",
  sec: "security",
  bug: "correctness",
  logic: "correctness",
  defect: "correctness",
  "correctness-issue": "correctness",
  maintainability: "quality",
  style: "quality",
  "code-quality": "quality",
  cleanliness: "quality",
  perf: "performance",
  test: "testing",
  tests: "testing",
  coverage: "testing",
  doc: "docs",
  documentation: "docs",
};

export function coerceCategory(v: unknown): string | unknown {
  if (typeof v !== "string") return v;
  const key = v.trim().toLowerCase();
  if ((FindingCategory.options as readonly string[]).includes(key)) return key;
  return CATEGORY_SYNONYMS[key] ?? v;
}

// S2: the result of mapping a reviewer's raw JSON into Findings, PLUS how much of
// the reviewer's own report died along the way. A candidate is "dropped" when it
// fails the typeof guard OR FindingSchema.safeParse — either way the reviewer's
// opinion on it is lost, and mappingLooksLossy uses these counts to decide
// whether the mapped result may still be trusted as a clean review.
export interface MappedReview {
  findings: Finding[];
  droppedCount: number;
  droppedBlockingCount: number;
}

export function mapReviewOutputToFindingsCounted(out: ReviewOutput, ctx: MapContext): MappedReview {
  const result: Finding[] = [];
  let n = 0;
  let dropped = 0;
  let droppedBlocking = 0;

  // A dropped candidate counts as BLOCKING when its raw severity coerces to
  // CRITICAL/WARN, OR when it can't be parsed at all — an unparseable severity
  // is potentially blocking, so fail toward lossy rather than assume advisory.
  const recordDrop = (cf: ReviewFinding): void => {
    dropped += 1;
    const sev = SeverityCoerced.safeParse(cf?.severity);
    if (!sev.success || sev.data === "CRITICAL" || sev.data === "WARN") {
      droppedBlocking += 1;
    }
  };

  for (const cf of out.findings) {
    if (
      typeof cf?.severity !== "string" ||
      typeof cf?.category !== "string" ||
      typeof cf?.file !== "string" ||
      typeof cf?.line !== "number" ||
      typeof cf?.message !== "string"
    ) {
      // A reported candidate that never even reached safeParse is just as lost
      // as one that failed it (round-9 I1) — count it the same way.
      recordDrop(cf);
      continue;
    }
    n += 1;
    // S2: coerce reviewer-phrased category synonyms BEFORE computeSignature (the
    // signature hashes the category) and before use in the persisted field.
    // Unknown categories pass through unchanged so safeParse still rejects them.
    const category = coerceCategory(cf.category);
    // Canonicalize to repo-relative posix so the finding's file + signature match
    // the diff's changed-range keys (otherwise diff-scoping mis-fires on "./x").
    const file = normalizeRepoPath(cf.file, ctx.workingDir);
    const line = Math.max(1, Math.trunc(cf.line));
    // Optional multi-line range: honour line_end only when it's a valid integer
    // at or after the start (a reviewer that sends null/absent/garbage/backwards
    // → single-line, the back-compatible default).
    const lineEnd =
      typeof cf.line_end === "number" && Number.isFinite(cf.line_end)
        ? Math.max(line, Math.trunc(cf.line_end))
        : line;
    // Normalize rule_id ONCE and use the SAME value as the signature ingredient
    // and the persisted field. Never derive the signature from severity: a
    // severity flip on a rule_id-less finding must not change its identity
    // (signatures key cross-iteration dedup, cycleRejected suppression, the §4.3
    // claimedFixed pin, FP-ledger rematching and stuck-detection), and the
    // orchestrator's applySymbolSignatures recomputes from f.rule_id — so both
    // sides must hash the same ingredient (F-07).
    const ruleId = cf.rule_id && cf.rule_id.length > 0 ? cf.rule_id : "unspecified";
    const candidate = {
      id: `F-${String(n).padStart(3, "0")}`,
      signature: computeSignature({
        file,
        ruleId,
        category: category as FindingCategory,
        lineStart: line,
        lineEnd,
      }),
      severity: cf.severity,
      category,
      rule_id: ruleId,
      file,
      line_start: line,
      line_end: lineEnd,
      message: cf.message.slice(0, 200),
      // `??` only falls back on null/undefined, so a present-but-non-string
      // `details` (number/object/array from a malformed reviewer payload) would
      // reach `.slice` and throw a TypeError in this fail-closed module. Require a
      // real string before using it; otherwise fall back to the (already string-
      // guarded) message. (F-4b)
      details: (typeof cf.details === "string" ? cf.details : cf.message).slice(0, 2000),
      reviewer: { provider: ctx.provider, model: ctx.model, persona: ctx.persona },
      confidence: typeof cf.confidence === "number" ? Math.min(1, Math.max(0, cf.confidence)) : 0.7,
      consensus: "singleton" as const,
      // S4: carry the reviewer's self-quoted evidence line (capped) when it sent a real string;
      // a null/absent/non-string value is simply omitted (back-compat — no badge, full-strength gate).
      ...(typeof cf.evidence_line === "string" && cf.evidence_line.length > 0
        ? { evidence_line: cf.evidence_line.slice(0, 500) }
        : {}),
    };
    const parsed = FindingSchema.safeParse(candidate);
    if (parsed.success) {
      result.push(parsed.data);
    } else {
      recordDrop(cf);
    }
  }
  return { findings: result, droppedCount: dropped, droppedBlockingCount: droppedBlocking };
}

// Back-compat thin wrapper: all current callers that only need the findings
// array keep compiling unchanged. codex/openrouter enforce the category enum
// via strict output schema, so they never need the drop counts.
export function mapReviewOutputToFindings(out: ReviewOutput, ctx: MapContext): Finding[] {
  return mapReviewOutputToFindingsCounted(out, ctx).findings;
}

// S2: does the mapped result under-represent what the reviewer actually
// reported badly enough that it must NOT be trusted as a clean review? Returns
// a human-readable reason, or null when the mapping is safe to treat at face
// value. Order matters: a dropped BLOCKING-severity candidate poisons the
// result regardless of what survived or what the reviewer's own verdict says —
// a PASS payload carrying a malformed CRITICAL must not sail through on the
// strength of a surviving INFO (round-7 W1 / round-10 W1 priority).
export function mappingLooksLossy(out: ReviewOutput, mapped: MappedReview): string | null {
  if (mapped.droppedBlockingCount > 0) {
    return `${mapped.droppedBlockingCount} blocking-severity finding(s) died in schema mapping`;
  }
  const reported = out.findings.length;
  if (reported > 0 && mapped.findings.length === 0) {
    return `reviewer reported ${reported} finding(s) but 0 survived schema mapping`;
  }
  if (out.verdict === "FAIL" && !mapped.findings.some((f) => f.severity !== "INFO")) {
    return "reviewer verdict FAIL but no blocking finding survived schema mapping";
  }
  return null;
}
