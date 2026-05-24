// src/providers/review-output.ts
import { normalizeRepoPath } from "../diff/repo-path.ts";
import { computeSignature } from "../diff/signature.ts";
import { type Finding, type FindingCategory, FindingSchema } from "../schemas/finding.ts";

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
          "message",
          "details",
          "confidence",
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
          message: { type: "string" },
          details: { type: "string" },
          confidence: { type: "number" },
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
  message: string;
  details: string;
  confidence: number;
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
  return proposals.map((p) => ({
    ...p,
    evidence: Array.isArray(p.evidence)
      ? p.evidence.map((e) => {
          const cleaned: RawProposal["evidence"][number] = { kind: e.kind };
          if (e.source_url != null) cleaned.source_url = e.source_url;
          if (e.snippet != null) cleaned.snippet = e.snippet;
          if (e.reviewer_id != null) cleaned.reviewer_id = e.reviewer_id;
          if (e.from_diff != null) cleaned.from_diff = e.from_diff;
          return cleaned;
        })
      : [],
  }));
}

export function parseReviewOutput(text: string): ReviewOutput | null {
  const tryParse = (s: string): ReviewOutput | null => {
    try {
      const o = JSON.parse(s) as Record<string, unknown>;
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
    } catch {
      // fall through
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

export function mapReviewOutputToFindings(out: ReviewOutput, ctx: MapContext): Finding[] {
  const result: Finding[] = [];
  let n = 0;
  for (const cf of out.findings) {
    if (
      typeof cf?.severity !== "string" ||
      typeof cf?.category !== "string" ||
      typeof cf?.file !== "string" ||
      typeof cf?.line !== "number" ||
      typeof cf?.message !== "string"
    ) {
      continue;
    }
    n += 1;
    // Canonicalize to repo-relative posix so the finding's file + signature match
    // the diff's changed-range keys (otherwise diff-scoping mis-fires on "./x").
    const file = normalizeRepoPath(cf.file, ctx.workingDir);
    const line = Math.max(1, Math.trunc(cf.line));
    const candidate = {
      id: `F-${String(n).padStart(3, "0")}`,
      signature: computeSignature({
        file,
        ruleId: cf.rule_id ?? cf.severity,
        category: cf.category as FindingCategory,
        lineStart: line,
        lineEnd: line,
      }),
      severity: cf.severity,
      category: cf.category,
      rule_id: cf.rule_id && cf.rule_id.length > 0 ? cf.rule_id : "unspecified",
      file,
      line_start: line,
      line_end: line,
      message: cf.message.slice(0, 200),
      details: (cf.details ?? cf.message).slice(0, 2000),
      reviewer: { provider: ctx.provider, model: ctx.model, persona: ctx.persona },
      confidence: typeof cf.confidence === "number" ? Math.min(1, Math.max(0, cf.confidence)) : 0.7,
      consensus: "singleton" as const,
    };
    const parsed = FindingSchema.safeParse(candidate);
    if (parsed.success) result.push(parsed.data);
  }
  return result;
}
