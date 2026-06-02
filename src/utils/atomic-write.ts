import { renameSync, writeFileSync } from "node:fs";

/**
 * Write a file atomically: write to a sibling `.tmp` then rename over the target.
 * `rename(2)` is atomic on POSIX, so a concurrent reader (or a crash) never
 * observes a half-written / truncated file — it sees either the old content or
 * the complete new content. Use for small state files read by other processes
 * (e.g. `dirty.flag`, which the gate parses as JSON and treats a parse failure
 * as a hard signal). Mirrors the tmp+rename pattern in `StateStore`.
 */
export function writeFileAtomic(path: string, data: string, opts?: { mode?: number }): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data, opts ?? {});
  renameSync(tmp, path);
}
