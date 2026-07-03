// src/core/reviewed-snapshot.ts
//
// T1 (field report 2026-07-03): per-file content manifest of the reviewed diff.
// The orchestrator captures it before the cache key is computed (the delta scope
// derived from it is part of the key) so state.reviewed_snapshot records EXACTLY
// the working-tree bytes the panel saw; the delta-scope pass (iteration ≥ 2) and
// the content-identity PASS ledger compare later tree states against it.
//
// Fail-safe contract: EVERY path in the reviewed diff gets an entry — a missing
// key can only mean "not part of the reviewed diff", never "we could not read
// it" (codex plan-gate W1). Consumers must treat hash:null entries conservatively
// (delta-scope keeps them in scope; the PASS ledger never short-circuits on them).
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { normalizeRepoPath } from "../diff/repo-path.ts";
import { safeReadContainedBytes } from "../utils/safe-read.ts";

// Per-file read cap. A source file over this is treated as unreadable (fail-safe:
// it stays in the delta scope and blocks the content-identity short-circuit)
// rather than loaded into gate memory.
export const SNAPSHOT_MAX_FILE_BYTES = 4_000_000;

export interface SnapshotFileEntry {
  status: "present" | "deleted" | "unreadable";
  // sha256 hex of the file's RAW BYTES; null unless status === "present".
  // (Raw bytes, not the utf8 decode — decoding collapses invalid sequences to
  // U+FFFD, which would let two different byte contents hash identically and
  // defeat byte-identity; adversarial review 2026-07-03. Binary files therefore
  // hash normally and participate in delta/content-identity like any other file.)
  hash: string | null;
}

/**
 * T4/R2 (field report 2026-07-03): the delta GATING scope for iteration >= 2.
 *
 * Returns the normalized set of reviewed-diff files that are "live" this
 * iteration: content changed vs the prior reviewed snapshot, new since it,
 * unreadable on either side (hash:null → fail-safe in scope), status changed,
 * or carrying a prior blocking finding (what the agent saw and had to address —
 * includes every claimed-fixed region by construction). A blocking finding
 * OUTSIDE this scope is a fresh nit on content the panel already reviewed and
 * the agent did not touch — the aggregator demotes it to INFO (policy demote,
 * demote-not-drop; security/correctness exempt there).
 *
 * Returns null (pass inert → full scope) when there is no prior snapshot.
 */
export function computeDeltaScope(
  current: Record<string, SnapshotFileEntry>,
  prior: { files: Record<string, SnapshotFileEntry> } | null | undefined,
  priorBlockingFiles: string[],
): Set<string> | null {
  if (!prior) return null;
  const scope = new Set<string>();
  for (const [path, entry] of Object.entries(current)) {
    // Object.hasOwn: a plain-object files record must not resolve "__proto__"/
    // "constructor" keys through the prototype chain.
    const prev = Object.hasOwn(prior.files, path) ? prior.files[path] : undefined;
    if (!prev) {
      scope.add(normalizeRepoPath(path)); // new file since the last reviewed state
      continue;
    }
    // Unreadable on either side → cannot prove "unchanged" → stays in scope.
    if (entry.hash === null || prev.hash === null) {
      scope.add(normalizeRepoPath(path));
      continue;
    }
    if (entry.status !== prev.status || entry.hash !== prev.hash) {
      scope.add(normalizeRepoPath(path));
    }
  }
  for (const f of priorBlockingFiles) scope.add(normalizeRepoPath(f));
  return scope;
}

/**
 * Hash the current working-tree state of `paths` (repo-relative).
 *
 * - regular readable file → { status: "present", hash: sha256(raw bytes) }
 * - path ABSENT from the tree (ENOENT/ENOTDIR only) → { status: "deleted", hash: null }
 * - symlink / dir / oversize / io-error / permission-error → { status: "unreadable", hash: null }
 *
 * Only a positive not-found (ENOENT/ENOTDIR) classifies as "deleted" — every
 * other lstat failure (EACCES, ELOOP, ENAMETOOLONG, …) is "unreadable", because
 * "deleted" entries can satisfy the content-identity check without a hash and an
 * existing-but-unstatable file must never count as identical to a reviewed
 * deletion (adversarial review 2026-07-03). Reads go through
 * safeReadContainedBytes (realpath containment, O_NOFOLLOW, size guard) — a
 * planted symlink is recorded as unreadable, never followed. The returned record
 * is null-prototype so a repo file literally named "__proto__" gets a real own
 * entry instead of hitting the Object.prototype setter (manifest completeness).
 */
export function snapshotReviewedFiles(
  repoRoot: string,
  paths: string[],
): Record<string, SnapshotFileEntry> {
  let repoReal: string | undefined;
  try {
    repoReal = realpathSync(repoRoot);
  } catch {
    repoReal = undefined; // safeReadContainedBytes re-resolves (and refuses) per call
  }
  const out: Record<string, SnapshotFileEntry> = Object.create(null);
  for (const path of paths) {
    let missing = false;
    try {
      lstatSync(join(repoRoot, path));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        missing = true;
      } else {
        out[path] = { status: "unreadable", hash: null };
        continue;
      }
    }
    if (missing) {
      out[path] = { status: "deleted", hash: null };
      continue;
    }
    const bytes = safeReadContainedBytes(repoRoot, path, SNAPSHOT_MAX_FILE_BYTES, repoReal);
    out[path] =
      bytes === null
        ? { status: "unreadable", hash: null }
        : { status: "present", hash: createHash("sha256").update(bytes).digest("hex") };
  }
  return out;
}
