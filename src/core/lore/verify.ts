// src/core/lore/verify.ts — recompute a lore entry's verified_tree/verified_at
// and write them back into the entry file. Closes the authoring gap where the
// hash otherwise had to be hand-computed via `bun -e`. Pure/synchronous, like
// the rest of src/core/lore/ — no network, no async.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyEntry, computeVerifiedTree } from "./staleness.ts";
import { loreDir, parseLoreFile } from "./store.ts";

export interface VerifyResult {
  ok: boolean;
  slug: string;
  error?: string;
  oldTree?: string;
  newTree?: string;
  changed?: boolean;
  verifiedAt?: string;
}

// LOCAL calendar date as YYYY-MM-DD (NOT UTC) — mirrors loop-driver.ts's
// localDateString / the lore daily-reminder-cap convention: local-timezone,
// no UTC conversion (single-machine semantics), never toISOString().
function localDate(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// Same frontmatter-boundary shape as store.ts's parseFrontmatter regex — kept
// in sync deliberately (a lore file's frontmatter format is one schema).
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

export function verifyLoreEntry(repoRoot: string, slug: string, now: Date): VerifyResult {
  const filePath = join(loreDir(repoRoot), `${slug}.md`);
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return { ok: false, slug, error: "not found" };
  }

  const parsed = parseLoreFile(raw, slug);
  if ("error" in parsed) {
    return { ok: false, slug, error: parsed.error };
  }
  const entry = parsed.entry;

  const cls = classifyEntry(repoRoot, entry);
  if (cls.state === "zero-match") {
    return {
      ok: false,
      slug,
      error: "anchors match zero files — fix the anchors before verifying (nothing to hash)",
    };
  }
  if (cls.state === "broad") {
    return {
      ok: false,
      slug,
      error: "anchors match >200 files (inert) — narrow them before verifying",
    };
  }

  const oldTree = entry.verified_tree;
  const newTree = computeVerifiedTree(repoRoot, cls.files);
  const verifiedAt = localDate(now);

  const m = raw.match(FRONTMATTER_RE);
  if (!m) {
    // Unreachable in practice — parseLoreFile already succeeded above, which
    // requires this same shape — but never write blind on a mismatch.
    return { ok: false, slug, error: "missing or malformed frontmatter" };
  }
  const frontmatter = m[1] ?? "";
  const body = m[2] ?? "";
  const newFrontmatter = frontmatter
    .replace(/^verified_tree:.*$/m, `verified_tree: "${newTree}"`)
    .replace(/^verified_at:.*$/m, `verified_at: ${verifiedAt}`);
  writeFileSync(filePath, `---\n${newFrontmatter}\n---\n${body}`);

  return { ok: true, slug, oldTree, newTree, changed: oldTree !== newTree, verifiedAt };
}
