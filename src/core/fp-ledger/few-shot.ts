import type { FpLedgerEntry } from "../../schemas/fp-ledger.ts";

const DEFAULT_BUDGET_BYTES = 1500;
const FIELD_MAX = 120;
const HEADER =
  "Known false positives in this repo — maintainers have confirmed these are NOT real issues. Do NOT re-report them:";

// Disallowed = anything OUTSIDE the safe identifier/path charset. A negated
// allowlist deliberately contains NO literal control bytes, so this source file
// stays text (a literal control class would make git treat it as binary).
const DISALLOWED = /[^A-Za-z0-9._/-]+/g;

// Defang a ledger field before it enters TRUSTED reviewer context. The values
// (file, rule_id, symbol) originate from prior reviewer findings on UNTRUSTED
// diffs, so a crafted value could carry newlines, quotes, or instruction prose
// and read as a directive once injected into the trusted preamble. These fields
// are identifiers/paths, so reduce them to a safe charset (deleting everything
// else collapses any prose into a single non-instruction token) and truncate.
function clean(s: string): string {
  const safe = s.replace(DISALLOWED, "");
  return safe.length > FIELD_MAX ? `${safe.slice(0, FIELD_MAX)}…` : safe;
}

// Render the changed-file-matching subset of the active/sticky FP snapshot as a
// trusted preamble block. Pure: the orchestrator decides placement. Returns ""
// when nothing matches OR when not even one entry fits the budget (a contentless
// header is worse than nothing — the reactive aggregator demote still catches
// the FP). The result is STRICTLY ≤ budgetBytes: each field is bounded by
// clean(), and the worst-case tail is reserved before any line is added.
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
  // No example fit → emit nothing rather than a misleading header-only block.
  if (lines.length === 0) return "";
  const dropped = matches.length - lines.length;
  const tail = dropped > 0 ? `\n(+${dropped} more)` : "";
  return `${HEADER}${lines.join("")}${tail}`;
}
