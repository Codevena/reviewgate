// src/research/collaborators.ts
//
// N5: collect the source of FIRST-PARTY (relative-import) collaborators that a
// changed file depends on but which were NOT themselves changed. Injected as trusted
// reference context so a reviewer can VERIFY a premise about an unchanged file (e.g.
// "Card is/ isn't a flex container", defined in card.tsx) instead of guessing from the
// diff. 1-hop only (YAGNI); byte-budgeted so a fan-out can't blow the prompt;
// fail-open (any resolution/read error skips that file, never crashes the gate).

import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { specifiersFromFile } from "./imports.ts";

export interface CollaboratorSource {
  /** repo-relative path, forward slashes */
  path: string;
  content: string;
}

export interface CollaboratorOptions {
  /** total byte cap across all injected collaborators (default 6000) */
  maxBytes?: number | undefined;
  /** hard cap on how many collaborator files to inject (default 10) */
  maxFiles?: number | undefined;
  signal?: AbortSignal | undefined;
}

const DEFAULT_MAX_BYTES = 6000;
const DEFAULT_MAX_FILES = 10;

// Extension candidates for an extensionless relative import, then index files.
const RESOLVE_EXTS = ["", ".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".css", ".scss"];
const INDEX_FILES = ["index.ts", "index.tsx", "index.js", "index.jsx"];

/** Repo-relative, forward-slashed, leading-./ stripped. */
function toRepoRel(p: string): string {
  return normalize(p).split("\\").join("/").replace(/^\.\//, "");
}

function isFile(abs: string): boolean {
  try {
    return existsSync(abs) && statSync(abs).isFile();
  } catch {
    return false;
  }
}

/** Resolve a relative import specifier to an existing repo file path, or null. */
function resolveRelative(repoRoot: string, importerFile: string, spec: string): string | null {
  const target = toRepoRel(join(dirname(importerFile), spec));
  if (target.startsWith("..")) return null; // escaped the repo root → not first-party
  for (const ext of RESOLVE_EXTS) {
    const cand = toRepoRel(target + ext);
    if (isFile(join(repoRoot, cand))) return cand;
  }
  for (const idx of INDEX_FILES) {
    const cand = toRepoRel(join(target, idx));
    if (isFile(join(repoRoot, cand))) return cand;
  }
  return null;
}

/**
 * Securely read a resolved collaborator's content, or null. Mirrors the audited
 * plan-refs read so an in-repo symlink can never inject out-of-repo source as trusted
 * reviewer context (codex + claude DoD, 2026-06-04):
 *   1. realpath containment — rejects an intermediate-dir-symlink escape;
 *   2. lstat no-follow — rejects a final-component symlink/dir/special before opening;
 *   3. open(O_NOFOLLOW) + fstat + read on the SAME fd — closes the realpath-check→read
 *      TOCTOU (a swapped-in final-component symlink fails the open instead of following).
 * ACCEPTED residual: a narrow intermediate-directory-symlink TOCTOU remains (openSync
 * follows intermediate components; fully closing it needs per-component openat /
 * RESOLVE_BENEATH, not portable in Bun/Node) — immaterial at our threat model (the
 * attacker already has working-tree write access), matching plan-refs + git.ts.
 */
function safeReadContained(
  repoRoot: string,
  repoReal: string,
  rel: string,
  maxBytes: number,
): string | null {
  const abs = join(repoRoot, rel);
  try {
    const rp = realpathSync(abs);
    if (!(rp === repoReal || rp.startsWith(repoReal + sep))) return null;
  } catch {
    return null;
  }
  try {
    if (!lstatSync(abs).isFile()) return null; // final-component symlink/dir/special → skip
  } catch {
    return null;
  }
  let fd: number;
  try {
    fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null; // ELOOP (swapped-in symlink) / ENOENT / EACCES → skip
  }
  try {
    const fst = fstatSync(fd);
    if (!fst.isFile()) return null; // defensive: opened inode must be a regular file
    if (fst.size > maxBytes) return null; // never read a file larger than the whole budget
    const content = readFileSync(fd, "utf8"); // SAME inode — no path re-resolution
    return content.includes("\0") ? null : content; // binary guard — don't inject binary
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

export async function collectCollaboratorSources(
  repoRoot: string,
  changedFiles: string[],
  opts: CollaboratorOptions = {},
): Promise<CollaboratorSource[]> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const changed = new Set(changedFiles.map(toRepoRel));
  const found = new Map<string, string>(); // resolved path → content (deduped)
  // Realpath of the repo root, used to reject symlinked collaborators that resolve
  // outside the repo. Fall back to the literal root if it can't be resolved.
  let repoReal: string;
  try {
    repoReal = realpathSync(repoRoot);
  } catch {
    repoReal = repoRoot;
  }

  for (const file of changedFiles) {
    if (opts.signal?.aborted) break;
    const rel = toRepoRel(file);
    let specs: string[];
    try {
      specs = await specifiersFromFile(repoRoot, rel);
    } catch {
      continue; // fail-open per importing file
    }
    for (const spec of specs) {
      if (!spec.startsWith(".")) continue; // relative first-party imports only
      const resolved = resolveRelative(repoRoot, rel, spec);
      if (!resolved) continue;
      if (changed.has(resolved)) continue; // already provided as changed-file context
      if (found.has(resolved)) continue;
      const content = safeReadContained(repoRoot, repoReal, resolved, maxBytes);
      if (content !== null) found.set(resolved, content);
    }
  }

  // Byte budget: smallest-first so the count of injected collaborators is maximized
  // (the LARGEST files are the ones dropped when the budget is tight).
  const sorted = [...found.entries()]
    .map(([path, content]) => ({ path, content }))
    .sort((a, b) => a.content.length - b.content.length);
  const out: CollaboratorSource[] = [];
  let used = 0;
  for (const c of sorted) {
    if (out.length >= maxFiles) break;
    const size = Buffer.byteLength(c.content, "utf8");
    if (used + size > maxBytes) continue; // too big for the remaining budget; try smaller ones
    out.push(c);
    used += size;
  }
  // Deterministic output order (stable behavior-hash + prompt) — by path.
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
