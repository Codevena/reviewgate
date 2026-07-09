// src/core/lore/store.ts — load + parse .reviewgate/lore/*.md. Pure parsing:
// anchor resolution/classification lives in staleness.ts (needs the repo walk).
// Fail-safe contract: loadLore NEVER throws; broken files land in `invalid`.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { LORE_MIN_BODY_CHARS, type LoreEntry, LoreEntrySchema } from "../../schemas/lore.ts";

export interface LoreEntryParsed extends LoreEntry {
  body: string;
  file: string; // repo-relative path
}

export function loreDir(repoRoot: string): string {
  return join(repoRoot, ".reviewgate", "lore");
}

// Minimal frontmatter parser: leading `---\n … \n---\n`, YAML subset — only
// `key: value` scalars and `key:\n  - item` string lists (all the schema
// needs). Anything fancier is a parse error → the entry is invalid, which is
// the safe direction.
function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } | null {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const data: Record<string, unknown> = {};
  let listKey: string | null = null;
  for (const line of (m[1] ?? "").split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && listKey) {
      (data[listKey] as string[]).push(stripQuotes(item[1] ?? ""));
      continue;
    }
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!kv) return null; // unknown shape → invalid
    const [, key, value] = kv;
    if (value === "" || value === undefined) {
      listKey = key as string;
      data[key as string] = [];
    } else {
      listKey = null;
      data[key as string] = stripQuotes(value);
    }
  }
  return { data, body: m[2] ?? "" };
}

function stripQuotes(s: string): string {
  const t = s.trim();
  return (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))
    ? t.slice(1, -1)
    : t;
}

export function parseLoreFile(
  raw: string,
  slug: string,
): { entry: LoreEntryParsed } | { error: string } {
  const fm = parseFrontmatter(raw);
  if (!fm) return { error: "missing or malformed frontmatter" };
  const parsed = LoreEntrySchema.safeParse(fm.data);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "invalid frontmatter" };
  if (parsed.data.id !== slug) return { error: `id '${parsed.data.id}' != file slug '${slug}'` };
  const body = fm.body.trim();
  if (body.length < LORE_MIN_BODY_CHARS) {
    return {
      error: `body too short (<${LORE_MIN_BODY_CHARS} chars) — a lore entry must carry the WHY`,
    };
  }
  return { entry: { ...parsed.data, body, file: `.reviewgate/lore/${slug}.md` } };
}

export function loadLore(repoRoot: string): {
  entries: LoreEntryParsed[];
  invalid: { file: string; error: string }[];
} {
  const dir = loreDir(repoRoot);
  const entries: LoreEntryParsed[] = [];
  const invalid: { file: string; error: string }[] = [];
  if (!existsSync(dir)) return { entries, invalid };
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".md"));
  } catch {
    return { entries, invalid }; // unreadable dir → no lore, never a throw
  }
  for (const name of names.sort()) {
    const rel = `.reviewgate/lore/${name}`;
    try {
      const raw = readFileSync(join(dir, name), "utf8");
      const r = parseLoreFile(raw, basename(name, ".md"));
      if ("error" in r) invalid.push({ file: rel, error: r.error });
      else entries.push(r.entry);
    } catch (err) {
      invalid.push({ file: rel, error: `unreadable: ${(err as Error).message}` });
    }
  }
  return { entries, invalid };
}
