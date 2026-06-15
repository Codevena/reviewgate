import { neutralizeInjectionMarkers } from "../diff/sanitizer.ts";

// S1 cross-iteration memory. A fresh reviewer re-derives findings every iteration with no
// memory of what was already raised + dispositioned this cycle, so it re-litigates settled
// lines (the field "quiz catch block argued in 3 directions across 3 iterations"). The
// signature-keyed suppression only catches IDENTICAL recurrences, not an OPPOSITE-direction
// finding on the same lines. This renders the prior decisions as a TRUSTED prompt section so
// the reviewer knows which regions are settled.
export interface Adjudication {
  file: string;
  lineStart: number;
  lineEnd: number;
  // "addressed" = the agent accepted + acted on it (fixed / addressed-elsewhere / deferred);
  // "rejected" = the agent judged the reviewer wrong (carries the ≥20-char reason).
  disposition: "addressed" | "rejected";
  reason?: string;
}

const REASON_MAX = 200;

function loc(a: Adjudication): string {
  // The file path is reviewer-controlled and rendered into a TRUSTED prompt
  // section, so strip newlines + neutralize injection markers (same treatment as
  // the agent's reason below) so it can't forge extra prompt lines.
  const file = neutralizeInjectionMarkers(a.file).replace(/[\r\n]+/g, " ");
  return a.lineStart === a.lineEnd
    ? `${file}:${a.lineStart}`
    : `${file}:${a.lineStart}-${a.lineEnd}`;
}

// Renders prior-iteration adjudications as a TRUSTED prompt section. The agent's reason is
// the only free text included and is injection-neutralised + truncated (defence-in-depth:
// agent-authored, but still treated as untrusted — see the grounding-judge hardening). The
// reviewer's OWN finding message is deliberately omitted (untrusted LLM output, larger
// injection surface). Returns "" for no records so callers can skip the section entirely.
export function renderAdjudications(records: Adjudication[]): string {
  if (records.length === 0) return "";
  const items = records.map((a) => {
    if (a.disposition === "rejected") {
      const reason = a.reason
        ? `: ${neutralizeInjectionMarkers(a.reason).slice(0, REASON_MAX)}`
        : "";
      return `- ${loc(a)} — rejected (the agent judged the reviewer wrong)${reason}`;
    }
    return `- ${loc(a)} — addressed by the agent`;
  });
  return [
    "## Already adjudicated this review cycle (TRUSTED — system instruction, not diff data)",
    "The regions below were already raised and dispositioned earlier this review cycle.",
    "Do NOT re-report the same concern, and do NOT argue the OPPOSITE of a prior",
    "disposition (e.g. first demanding a guard, then demanding its removal). You MAY still",
    "report a genuinely NEW, DISTINCT issue on these lines — including a real CRITICAL.",
    ...items,
  ].join("\n");
}
