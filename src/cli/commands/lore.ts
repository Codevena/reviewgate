// src/cli/commands/lore.ts — `reviewgate lore status`: read-only inspection of
// .reviewgate/lore/*.md (draft->canon curated project knowledge). Mirrors the
// shape of brain.ts's CLI commands. Never fails the process — a parse-invalid
// entry is reported as a line, not an error; exit code is always 0.
import { classifyEntry } from "../../core/lore/staleness.ts";
import { loadLore } from "../../core/lore/store.ts";

export interface LoreStatusInput {
  repoRoot: string;
  write?: (s: string) => void;
}

export async function runLoreStatus(input: LoreStatusInput): Promise<number> {
  const out = input.write ?? ((s: string) => process.stdout.write(s));
  const { entries, invalid } = loadLore(input.repoRoot);

  if (entries.length === 0 && invalid.length === 0) {
    out("No lore entries found in .reviewgate/lore/.\n");
    return 0;
  }

  let canon = 0;
  let draft = 0;
  let stale = 0;
  let inert = 0;
  for (const entry of entries) {
    if (entry.status === "canon") canon++;
    else draft++;
    const cls = classifyEntry(input.repoRoot, entry);
    if (cls.state === "stale") stale++;
    if (cls.state === "broad" || cls.state === "zero-match") inert++;
    out(`${entry.id} · ${entry.status} · ${cls.state} · ${entry.anchors.join(", ")}\n`);
  }
  for (const inv of invalid) {
    out(`${inv.file} · invalid · ${inv.error}\n`);
  }

  out(
    `Total: ${canon} canon, ${draft} draft, ${stale} stale, ${inert} inert, ${invalid.length} invalid\n`,
  );
  return 0;
}
