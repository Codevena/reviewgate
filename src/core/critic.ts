// src/core/critic.ts
import type { Finding } from "../schemas/finding.ts";

export interface CriticVerdict {
  verdict: "keep" | "likely_fp";
  reason?: string;
}

export const CRITIC_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdicts"],
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["signature", "verdict"],
        properties: {
          signature: { type: "string" },
          verdict: { type: "string", enum: ["keep", "likely_fp"] },
          reason: { type: "string" },
        },
      },
    },
  },
} as const;

export function buildCriticPrompt(findings: Finding[]): string {
  const list = findings
    .map(
      (f) =>
        `- signature=${f.signature} [${f.severity}/${f.category}] ${f.file}:${f.line_start} ${f.message}`,
    )
    .join("\n");
  return [
    "You are an adversarial false-positive filter. For each finding below decide",
    "whether to KEEP it (a real issue) or mark it likely_fp (probably a false",
    "positive: stylistic, speculative, or out of scope). You may ONLY demote, never",
    "invent new findings. Output ONLY JSON matching the schema: ",
    '{"verdicts":[{"signature":"<sig>","verdict":"keep|likely_fp","reason":"..."}]}',
    "",
    "Findings:",
    list,
  ].join("\n");
}

export function parseCriticOutput(text: string): Map<string, CriticVerdict> {
  const map = new Map<string, CriticVerdict>();
  let parsed: { verdicts?: Array<{ signature?: string; verdict?: string; reason?: string }> };
  try {
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    parsed = JSON.parse(
      first >= 0 && last > first ? text.slice(first, last + 1) : text,
    ) as typeof parsed;
  } catch {
    return map;
  }
  for (const v of parsed.verdicts ?? []) {
    if (typeof v.signature === "string" && (v.verdict === "keep" || v.verdict === "likely_fp")) {
      map.set(v.signature, { verdict: v.verdict, ...(v.reason ? { reason: v.reason } : {}) });
    }
  }
  return map;
}
