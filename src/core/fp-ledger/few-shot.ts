import type { FpLedgerEntry } from "../../schemas/fp-ledger.ts";

const DEFAULT_BUDGET_BYTES = 1500;
const HEADER =
  "Known false positives in this repo — maintainers have confirmed these are NOT real issues. Do NOT re-report them:";

// Render the changed-file-matching subset of the active/sticky FP snapshot as a
// trusted preamble block. Pure: the orchestrator decides placement. Empty when
// nothing matches so the caller can skip the section entirely.
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

  const lines: string[] = [];
  // Count the header against the budget so it bounds the WHOLE injected block,
  // not just the list body.
  let used = Buffer.byteLength(`${HEADER}\n`, "utf8");
  let dropped = 0;
  for (const e of matches) {
    const line = `- ${e.file}: rule "${e.rule_id}" (${e.category})${e.symbol ? ` in ${e.symbol}` : ""}`;
    const cost = Buffer.byteLength(`${line}\n`, "utf8");
    if (used + cost > budget && lines.length > 0) {
      dropped = matches.length - lines.length;
      break;
    }
    lines.push(line);
    used += cost;
  }
  const tail = dropped > 0 ? `\n(+${dropped} more)` : "";
  return `${HEADER}\n${lines.join("\n")}${tail}`;
}
