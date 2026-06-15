import { renameSync, rmSync, writeFileSync } from "node:fs";

// Monotonic per-process counter: combined with the pid it makes each temp name
// unique even for two writes issued in the same millisecond by this process.
let tmpCounter = 0;

/**
 * Write a file atomically: write to a UNIQUE sibling temp file then rename over
 * the target. `rename(2)` is atomic on POSIX, so a concurrent reader (or a crash)
 * never observes a half-written / truncated file — it sees either the old content
 * or the complete new content. Use for small state files read by other processes
 * (e.g. `dirty.flag`, which the gate parses as JSON and treats a parse failure
 * as a hard signal). Mirrors the tmp+rename pattern in `StateStore`.
 *
 * The temp name is per-write unique (`.<pid>.<counter>.<rand>.tmp`) so two
 * concurrent writers to the SAME target never share one scratch file — a shared
 * fixed `.tmp` let a second writer overwrite/rename the first's in-flight buffer
 * and spuriously fail CLOSED (e.g. the gate writing `dirty.flag` while the
 * deferred-flag writer races). Each writer owns its own temp and renames it over
 * the target last-writer-wins, atomically.
 */
export function writeFileAtomic(path: string, data: string, opts?: { mode?: number }): void {
  const unique = `${process.pid}.${tmpCounter++}.${Math.random().toString(36).slice(2, 10)}`;
  const tmp = `${path}.${unique}.tmp`;
  try {
    writeFileSync(tmp, data, opts ?? {});
    renameSync(tmp, path);
  } catch (err) {
    // On any failure, don't leave our private scratch file behind (the rename
    // never happened, so nothing else references it). Best-effort cleanup.
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw err;
  }
}
