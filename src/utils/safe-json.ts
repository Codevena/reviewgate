// src/utils/safe-json.ts
//
// The fail-closed boundary for parsing UNTRUSTED text — reviewer/critic/judge CLI
// output and any LLM-produced JSON. The recurring bug class this exists to kill:
// `JSON.parse(x) as T` followed by `value.field`, where `x` is "null" / "42" /
// "[..]" (all VALID JSON that parse to non-objects) or truncated/garbage output —
// the property access then throws an uncaught TypeError that crashes the gate
// process, which Claude Code treats as a non-blocking Stop hook → the turn ends
// UN-reviewed (fail-OPEN), the exact failure mode the gate exists to prevent.
//
// Every parse of untrusted text MUST go through here (enforced by a structural
// test for src/providers + src/core/critic). Internal/trusted state files
// (state.json, config, pending.json) are a separate concern and may parse directly.
import type { ZodType } from "zod";

/**
 * Parse JSON that may be hostile. NEVER throws. Returns `undefined` on any
 * malformed/truncated/empty input. The result is `unknown` — the caller must
 * narrow it (or use `parseUntrusted` with a schema), so a "null"/primitive
 * payload can never be dotted into blindly.
 */
export function safeJsonParse(raw: string): unknown {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Parse + zod-validate untrusted text in one fail-closed step. Returns the
 * validated, typed value, or `null` on ANY failure (malformed JSON OR a shape
 * the schema rejects). Never throws. This is the preferred boundary helper: the
 * only way to get a non-null result is a fully schema-valid payload.
 */
export function parseUntrusted<T>(raw: string, schema: ZodType<T>): T | null {
  const parsed = safeJsonParse(raw);
  if (parsed === undefined) return null;
  const res = schema.safeParse(parsed);
  return res.success ? res.data : null;
}
