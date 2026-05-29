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

// Locate the real `{"verdicts":[...]}` payload inside arbitrary model output.
// A naive first-`{`..last-`}` slice fails when the model wraps its JSON in prose
// that itself contains braces (e.g. `Here is the result {note}: {"verdicts":...}`):
// the slice spans from the stray `{note}` to the final `}`, producing invalid JSON
// so JSON.parse throws and the critic silently no-ops. Instead we (1) try a direct
// parse, then (2) scan every `{`, walk forward with a string-aware brace counter to
// find each balanced object, and return the FIRST one that parses and carries a
// `verdicts` array. Returns `undefined` when nothing parseable is found (caller
// yields zero demotions — demote-only/fail-open).
function extractCriticPayload(text: string): unknown {
  const direct = tryParse(text);
  if (direct !== undefined) return direct;
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    const end = matchingBrace(text, start);
    if (end < 0) continue;
    const candidate = tryParse(text.slice(start, end + 1));
    if (
      candidate &&
      typeof candidate === "object" &&
      Array.isArray((candidate as { verdicts?: unknown }).verdicts)
    ) {
      return candidate;
    }
  }
  return undefined;
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

// Index of the `}` that closes the `{` at `open`, or -1 if unbalanced. String-aware
// so braces inside JSON string values (e.g. a reason of "has {braces} inside") and
// escaped quotes don't throw off the depth count.
function matchingBrace(text: string, open: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function parseCriticOutput(text: string): Map<string, CriticVerdict> {
  const map = new Map<string, CriticVerdict>();
  const parsed = extractCriticPayload(text);
  if (parsed === undefined) return map;
  // Guard the whole payload AND `.verdicts`: JSON.parse("null") / "42" / "[..]"
  // succeed (valid JSON, no throw) but `parsed.verdicts` on a null/primitive/array
  // throws an uncaught TypeError that would crash the gate process (fail-OPEN).
  // The critic is demote-only/fail-open, so any malformed payload must yield zero
  // demotions, never an exception. Input is untrusted reviewer-LLM output —
  // exactly the threat model the gate exists to contain.
  const verdicts =
    parsed &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { verdicts?: unknown }).verdicts)
      ? (parsed as { verdicts: Array<{ signature?: string; verdict?: string; reason?: string }> })
          .verdicts
      : [];
  for (const v of verdicts) {
    // Guard each element: a null/primitive element (e.g. [null, 42]) would throw
    // on `.signature` access — same uncaught-TypeError fail-OPEN crash as a
    // non-array `verdicts`. Skip anything that isn't an object.
    if (!v || typeof v !== "object") continue;
    if (typeof v.signature === "string" && (v.verdict === "keep" || v.verdict === "likely_fp")) {
      map.set(v.signature, { verdict: v.verdict, ...(v.reason ? { reason: v.reason } : {}) });
    }
  }
  return map;
}
