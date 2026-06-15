import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withTimeout } from "../utils/with-timeout.ts";

// Hard cap on dynamically importing a user config module. The config is loaded on
// the gate's HOT PATH (Stop hook); a config with a hung top-level await (a network
// call, a wedged sync fs read) would otherwise hang the import forever, stalling
// the gate until the OS Stop-hook timeout kills it with empty stdout = fail-OPEN.
// On timeout we REJECT so callers (loader.ts / global.ts) hit their existing
// try/catch → fall back to defaults with a logged warning rather than hang. Bun
// evaluates a config module's top-level code during import(), so this bounds it.
const IMPORT_TIMEOUT_MS = 10_000;

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
export async function importConfigDefault(
  absPath: string,
  opts?: { timeoutMs?: number },
): Promise<unknown> {
  const content = readFileSync(absPath, "utf8");
  const dir = mkdtempSync(join(tmpdir(), "rg-cfgload-"));
  // Everything after mkdtempSync is in try/finally, so a failed writeFileSync
  // (ENOSPC/EIO/perm) can't leak the temp dir — and neither can a timeout/throw
  // from the import (the finally still runs, cleaning up the temp dir).
  try {
    const tmp = join(dir, "config.ts");
    writeFileSync(tmp, content);
    // A throwing config (syntax/runtime error) rejects here; a hanging one (top-
    // level await that never settles) is bounded by withTimeout. Either way the
    // caller's try/catch decides the fallback — the gate never hangs on a config.
    const mod = (await withTimeout(
      import(tmp),
      opts?.timeoutMs ?? IMPORT_TIMEOUT_MS,
      `config-import (${absPath})`,
    )) as { default?: unknown };
    return mod.default;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
