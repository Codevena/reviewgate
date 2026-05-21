import type { FpLedgerEntry } from "../../schemas/fp-ledger.ts";

const DEFAULT_BUDGET_BYTES = 1500;
const FIELD_MAX = 120;
const HEADER =
  "Known false positives in this repo — maintainers have confirmed these are NOT real issues. Do NOT re-report them:";

// Control chars (incl. newlines, NUL) — kept as an escaped class so this source
// file never contains literal control bytes (which would make git treat it as
// binary). biome-ignore: stripping control chars is the entire purpose.
// biome-ignore lint/suspicious/noControlCharactersInRegex: defanging control chars is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

// Defang a ledger field before it enters TRUSTED reviewer context. The values
// (file, rule_id, symbol) originate from prior reviewer findings on untrusted
// diffs, so a crafted rule_id/path could carry newlines or instruction text and
// break out of the line into injected prompt directives. Strip control chars to
// spaces, collapse whitespace, trim, and truncate — the content stays visible
// (defanged) on a single bounded line.
function clean(s: string): string {
  const stripped = s.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  return stripped.length > FIELD_MAX ? `${stripped.slice(0, FIELD_MAX)}…` : stripped;
}

// Render the changed-file-matching subset of the active/sticky FP snapshot as a
// trusted preamble block. Pure: the orchestrator decides placement. Empty when
// nothing matches so the caller can skip the section entirely. The returned
// string is STRICTLY ≤ budgetBytes: each field is bounded by clean(), the tail
// is reserved up-front, and no line is emitted past the budget.
export function buildFpFewShot(input: {
  active: Map<string, FpLedgerEntry>;
  changedFiles: string[];
  budgetBytes?: number;
}): string {
  const budget = input.budgetBytes ?? DEFAULT_BUDGET_BYTES;
  const changed = new Set(input.changedFiles);
  const matches = [...input.active.values()]
    .filter((e) => changed.has(e.file))
    // deterministic order: file then rule then signature
    .sort(
      (a, b) =>
        a.file.localeCompare(b.file) ||
        a.rule_id.localeCompare(b.rule_id) ||
        a.signature.localeCompare(b.signature),
    );
  if (matches.length === 0) return "";

  // Reserve room for the worst-case tail so the final string never exceeds budget.
  const maxTail = Buffer.byteLength(`\n(+${matches.length} more)`, "utf8");
  const lines: string[] = [];
  let used = Buffer.byteLength(HEADER, "utf8");
  for (const e of matches) {
    const line = `\n- ${clean(e.file)}: rule "${clean(e.rule_id)}" (${e.category})${
      e.symbol ? ` in ${clean(e.symbol)}` : ""
    }`;
    const cost = Buffer.byteLength(line, "utf8");
    if (used + cost + maxTail > budget) break;
    lines.push(line);
    used += cost;
  }
  const dropped = matches.length - lines.length;
  const tail = dropped > 0 ? `\n(+${dropped} more)` : "";
  return `${HEADER}${lines.join("")}${tail}`;
}
