// src/utils/safe-read.ts
//
// Shared symlink-safe, realpath-contained file read. Extracted from the audited
// plan-refs / collaborators readers (codex + claude DoD, 2026-06-04) so EVERY hot-path
// reader that ingests repo files as trusted reviewer context uses the same hardened
// path instead of a bespoke (and often symlink-following) readFileSync.
//
// Threat: an agent-under-review controls the working tree and can plant a symlink
// (e.g. `.reviewgate/personas/security.md` -> `~/.ssh/id_rsa`, or a changed source
// file -> `~/.aws/credentials`). A naive existsSync/statSync/readFileSync FOLLOWS that
// symlink and the gate host process (outside the reviewer sandbox) would leak the
// target's bytes into the network-reachable reviewer prompt.
//
// Guarantees (matching plan-refs.ts / collaborators.ts):
//   1. realpath containment — the resolved target must stay inside the repo realpath;
//      rejects an intermediate-dir-symlink escape.
//   2. lstat no-follow — rejects a final-component symlink/dir/special before opening.
//   3. open(O_NOFOLLOW) + fstat + read on the SAME fd — closes the realpath-check->read
//      TOCTOU (a swapped-in final-component symlink fails the open instead of following).
//   4. size guard BEFORE read — never load a file larger than maxBytes into memory.
//   5. binary guard — never return content containing a NUL byte.
//
// ACCEPTED residual: a narrow intermediate-directory-symlink TOCTOU remains (openSync
// follows intermediate components; fully closing it needs per-component openat /
// RESOLVE_BENEATH, not portable in Bun/Node). Immaterial at our threat model (the
// attacker already has working-tree write access), matching plan-refs + git.ts.

import {
  constants,
  type PathLike,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, sep } from "node:path";

/**
 * Securely read a repo-relative (or repo-absolute) file's content, or null.
 *
 * Returns null (never throws) on: containment violation, final-component symlink,
 * missing/permission/ELOOP, oversize (> maxBytes), or binary content. The caller
 * treats null as "skip this file" — fail-open at the per-file level by design (a
 * single unreadable file must never crash the gate), but fail-CLOSED on the leak
 * (the symlink target is refused, not read).
 *
 * @param repoRoot  repo root (absolute)
 * @param rel       repo-relative path (forward or native slashes) OR an absolute
 *                  path that must already live under repoRoot
 * @param maxBytes  hard size cap; a file at or below this is read, larger is refused
 * @param repoReal  optional pre-resolved realpath(repoRoot) — pass it when reading
 *                  many files in a loop to avoid re-resolving per call
 */
export function safeReadContained(
  repoRoot: string,
  rel: string,
  maxBytes: number,
  repoReal?: string,
): string | null {
  const buf = safeReadContainedBytes(repoRoot, rel, maxBytes, repoReal);
  if (buf === null) return null;
  const content = buf.toString("utf8");
  return content.includes("\0") ? null : content; // 5. binary guard (text variant)
}

/**
 * RAW-BYTES variant of safeReadContained — same containment/no-follow/size
 * guards, but returns the untouched Buffer and applies NO binary/NUL guard.
 * Use for content HASHING (adversarial review 2026-07-03): hashing the utf8
 * DECODE collapses every invalid byte sequence to U+FFFD, so two different byte
 * contents could hash identically and defeat a byte-identity check.
 */
export function safeReadContainedBytes(
  repoRoot: string,
  rel: string,
  maxBytes: number,
  repoReal?: string,
): Buffer | null {
  let root: string;
  try {
    root = repoReal ?? realpathSync(repoRoot);
  } catch {
    return null; // repo root itself unresolvable → refuse
  }
  const abs = isAbsolute(rel) ? rel : join(repoRoot, rel);
  // 1. realpath containment — resolved target must equal or be under the repo realpath.
  try {
    const rp = realpathSync(abs);
    if (!(rp === root || rp.startsWith(root + sep))) return null;
  } catch {
    return null;
  }
  // 2. lstat no-follow — reject a final-component symlink/dir/special before opening.
  try {
    if (!lstatSync(abs).isFile()) return null;
  } catch {
    return null;
  }
  // 3. open(O_NOFOLLOW) — atomically refuses a final-component symlink (ELOOP).
  let fd: number;
  try {
    fd = openSync(abs as PathLike, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null; // ELOOP (swapped-in symlink) / ENOENT / EACCES → skip
  }
  try {
    const fst = fstatSync(fd);
    if (!fst.isFile()) return null; // defensive: opened inode must be a regular file
    if (fst.size > maxBytes) return null; // 4. size guard — never over-read
    return readFileSync(fd); // SAME inode — no path re-resolution; raw bytes
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}
