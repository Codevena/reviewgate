// src/cli/commands/lore.ts — `reviewgate lore status` (read-only inspection)
// and `reviewgate lore verify` (recompute + write back verified_tree/
// verified_at). Mirrors the shape of brain.ts's CLI commands.
import { classifyEntry } from "../../core/lore/staleness.ts";
import { loadLore } from "../../core/lore/store.ts";
import { verifyLoreEntry } from "../../core/lore/verify.ts";

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

export interface LoreVerifyInput {
  repoRoot: string;
  slugs?: string[];
  all?: boolean;
  write?: (s: string) => void;
}

// `reviewgate lore verify <slug> [<slug>...]` / `--all`. Unlike `status`, this
// WRITES (it recomputes + persists verified_tree/verified_at), so it must
// signal failure: exit 1 when any requested entry couldn't be verified
// (not found / zero-match / broad) — a write command that silently no-ops on
// error is worse than one that never ran.
export async function runLoreVerify(input: LoreVerifyInput): Promise<number> {
  const out = input.write ?? ((s: string) => process.stdout.write(s));

  // `--all` must also surface unparseable lore files (loadLore's `invalid`
  // bucket), not just the entries that parsed cleanly — otherwise a broken
  // .reviewgate/lore/*.md is silently skipped and `--all` reports a false-clean
  // exit 0. Named-slug mode is unaffected: `invalid` stays empty there.
  let slugs: string[];
  let invalid: { file: string; error: string }[] = [];
  if (input.all) {
    const loaded = loadLore(input.repoRoot);
    slugs = loaded.entries.map((e) => e.id);
    invalid = loaded.invalid;
  } else {
    slugs = input.slugs ?? [];
  }

  if (slugs.length === 0 && invalid.length === 0) {
    out("no lore entries\n");
    return 0;
  }

  let anyError = false;
  const now = new Date();
  for (const slug of slugs) {
    const result = verifyLoreEntry(input.repoRoot, slug, now);
    if (!result.ok) {
      anyError = true;
      out(`${slug} · ERROR · ${result.error}\n`);
      continue;
    }
    if (result.changed) {
      const oldShort = (result.oldTree ?? "").slice(0, 8);
      const newShort = (result.newTree ?? "").slice(0, 8);
      out(`${slug} · updated · ${oldShort}…→${newShort}… · ${result.verifiedAt}\n`);
    } else {
      out(`${slug} · already fresh · ${result.verifiedAt}\n`);
    }
  }
  // Invalid (unparseable) files are reported but never written to — there's
  // nothing safe to recompute against a file that didn't parse.
  for (const inv of invalid) {
    anyError = true;
    out(`${inv.file} · ERROR · ${inv.error}\n`);
  }
  return anyError ? 1 : 0;
}
