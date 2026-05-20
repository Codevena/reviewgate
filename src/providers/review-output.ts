// src/providers/review-output.ts
import { isAbsolute, relative } from "node:path";
import { computeSignature } from "../diff/signature.ts";
import { type Finding, type FindingCategory, FindingSchema } from "../schemas/finding.ts";

export const REVIEW_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "findings"],
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

export interface ReviewOutput {
  verdict: "PASS" | "FAIL";
  findings: ReviewFinding[];
}

export function parseReviewOutput(text: string): ReviewOutput | null {
  const tryParse = (s: string): ReviewOutput | null => {
    try {
      const o = JSON.parse(s) as Partial<ReviewOutput>;
      if (Array.isArray(o.findings)) {
        return {
          verdict: o.verdict === "PASS" ? "PASS" : "FAIL",
          findings: o.findings as ReviewFinding[],
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
    const file = isAbsolute(cf.file) ? relative(ctx.workingDir, cf.file) || cf.file : cf.file;
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
