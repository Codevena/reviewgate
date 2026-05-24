// src/core/critic.ts
import type { CompleteOptions, ProviderAdapter } from "../providers/adapter-base.ts";
import type { Finding } from "../schemas/finding.ts";

export interface CriticVerdict {
  verdict: "keep" | "likely_fp";
  reason?: string;
}

export interface CriticRunResult {
  map: Map<string, CriticVerdict>;
  info: { provider: string; status: "ran" | "error" | "empty" | "misconfigured"; verdicts: number };
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

// Run the adversarial FP-filter via the adapter's free-form complete() — NOT
// review(). review() imposes REVIEW_OUTPUT_SCHEMA on schema-enforcing providers
// (codex/openrouter), forcing {verdict,findings} so the critic's {verdicts:[...]}
// shape can never be produced → a silent no-op (zero demotions). complete()
// leaves the model free to answer the critic prompt. Demote-only + fail-open:
// any failure yields NO demotions (never blocks the verdict) but is surfaced via
// `info.status` so "no critic" is distinguishable from "critic ran clean".
export async function runCritic(
  adapter: Pick<ProviderAdapter, "complete">,
  provider: string,
  opts: CompleteOptions,
  findings: Finding[],
): Promise<CriticRunResult> {
  if (typeof adapter.complete !== "function") {
    return { map: new Map(), info: { provider, status: "misconfigured", verdicts: 0 } };
  }
  let text: string;
  try {
    text = await adapter.complete(buildCriticPrompt(findings), opts);
  } catch {
    return { map: new Map(), info: { provider, status: "error", verdicts: 0 } };
  }
  const map = parseCriticOutput(text);
  return { map, info: { provider, status: map.size > 0 ? "ran" : "empty", verdicts: map.size } };
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
