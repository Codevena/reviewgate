import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Import a config file's default export FRESH, defeating the ESM module cache.
// Bun (like Node) caches dynamic import() by resolved path, so a config file
// OVERWRITTEN in the same process — e.g. `reviewgate setup` writes the config and
// then runs doctor, which reloads it — would otherwise re-read the STALE module.
// Bun rejects `?v=` query-string cache-busting on file paths, and a `data:` URL
// breaks for real-size configs (Bun resolves the whole URI as a specifier →
// NameTooLong). So we copy the file's CURRENT CONTENT to a UNIQUE temp path and
// import that: a never-before-seen path is never cached, so the content is always
// fresh; the temp dir is removed afterwards. Reviewgate configs are plain
// `export default {…}` objects with no relative imports, so importing the copy
// from a different directory is safe.
export async function importConfigDefault(absPath: string): Promise<unknown> {
  const content = readFileSync(absPath, "utf8");
  const dir = mkdtempSync(join(tmpdir(), "rg-cfgload-"));
  // Everything after mkdtempSync is in try/finally, so a failed writeFileSync
  // (ENOSPC/EIO/perm) can't leak the temp dir.
  try {
    const tmp = join(dir, "config.ts");
    writeFileSync(tmp, content);
    const mod = (await import(tmp)) as { default?: unknown };
    return mod.default;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
