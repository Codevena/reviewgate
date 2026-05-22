// src/stats/report-file.ts
import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Writes `content` to `path` atomically via a unique temp file.
//  - exclusive:false → renameSync (atomic overwrite). Always returns true.
//  - exclusive:true  → linkSync+unlink (atomic create-if-absent). Returns false
//    (no-op) if the final file already exists; never overwrites a concurrent writer.
// Never leaves a partial final file: rename/link are atomic; the temp is removed
// in a finally.
export function writeReportFile(
  path: string,
  content: string,
  opts: { exclusive: boolean },
): boolean {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });

  if (opts.exclusive && existsSync(path)) return false;

  const tmp = join(dir, `.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, content, { mode: 0o600 });
    if (opts.exclusive) {
      try {
        linkSync(tmp, path);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw err;
      }
    }
    renameSync(tmp, path);
    return true;
  } finally {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* best-effort temp cleanup */
    }
  }
}
