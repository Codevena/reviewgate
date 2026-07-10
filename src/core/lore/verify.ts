// src/core/lore/verify.ts — recompute a lore entry's verified_tree/verified_at
// and write them back into the entry file. Closes the authoring gap where the
// hash otherwise had to be hand-computed via `bun -e`. Pure/synchronous, like
// the rest of src/core/lore/ — no network, no async.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../../utils/atomic-write.ts";
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

// Same shape as LoreEntrySchema's `id` field (schemas/lore.ts: lowercase
// alphanumerics + hyphens, no `/`). Not re-exported as a bare RegExp there, so
// inlined here — kept in sync deliberately, same as FRONTMATTER_RE above.
const LORE_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

export function verifyLoreEntry(repoRoot: string, slug: string, now: Date): VerifyResult {
  // Defense-in-depth against path traversal / out-of-dir reads: reject any
  // slug that doesn't already look like a lore id BEFORE it's joined into a
  // path or read. Not currently exploitable on its own — a `../x` slug still
  // fails parseLoreFile's `id !== slug` check below, since the id regex
  // forbids `/` — but a caller of this function shouldn't have to rely on
  // that downstream check to stay safe.
  if (!LORE_SLUG_RE.test(slug)) {
    return {
      ok: false,
      slug,
      error: "invalid slug (a lore id is lowercase alphanumerics + hyphens)",
    };
  }

  const filePath = join(loreDir(repoRoot), `${slug}.md`);
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: false, slug, error: "not found" };
    return { ok: false, slug, error: `unreadable: ${(err as Error).message}` };
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
  try {
    writeFileAtomic(filePath, `---\n${newFrontmatter}\n---\n${body}`);
  } catch (err) {
    return { ok: false, slug, error: `write failed: ${(err as Error).message}` };
  }

  return { ok: true, slug, oldTree, newTree, changed: oldTree !== newTree, verifiedAt };
}
