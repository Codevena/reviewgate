// src/cache/docs-cache.ts
//
// TTL'd cache for Context7 library docs (M6). Sibling of the review cache
// (src/cache/cache.ts), under .reviewgate/cache/docs/<key>.json. Keyed on
// hash(libraryId@version). Version-pinned docs are largely stable, but Context7
// re-indexes/corrects, so entries carry a TTL (ttlDays) + a responseHash rather
// than living forever.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface CachedDocs {
  name: string;
  libraryId: string;
  version: string | null;
  query: string;
  apiVersion: string;
  /** epoch ms of the fetch; TTL is measured from here on read. */
  fetchedAt: number;
  /** sha256 of the raw Context7 response — feeds the review behavior-hash. */
  responseHash: string;
  /** rendered docs text. */
  docs: string;
}

export function docsCacheKey(libraryId: string, version: string | null): string {
  return createHash("sha256")
    .update(`${libraryId}@${version ?? ""}`)
    .digest("hex");
}

function docsCacheDir(repoRoot: string): string {
  return join(repoRoot, ".reviewgate", "cache", "docs");
}

function docsCachePath(repoRoot: string, key: string): string {
  return join(docsCacheDir(repoRoot), `${key}.json`);
}

// TTL is a READ-TIME policy: freshness is judged against the CURRENT `ttlDays`
// (from config) using the entry's `fetchedAt`, NOT a value frozen at write time.
// This way lowering ttlDays (or wanting fresher docs) takes effect immediately
// on existing entries instead of waiting out a stale stored TTL.
export async function getCachedDocs(
  repoRoot: string,
  key: string,
  ttlDays: number,
): Promise<CachedDocs | null> {
  const p = docsCachePath(repoRoot, key);
  if (!existsSync(p)) return null;
  try {
    const o = JSON.parse(readFileSync(p, "utf8")) as { entry: CachedDocs };
    const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
    if (Date.now() - o.entry.fetchedAt > ttlMs) return null;
    return o.entry;
  } catch {
    return null;
  }
}

export async function putCachedDocs(
  repoRoot: string,
  key: string,
  entry: CachedDocs,
): Promise<void> {
  const dir = docsCacheDir(repoRoot);
  mkdirSync(dir, { recursive: true });
  const p = docsCachePath(repoRoot, key);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ entry }), { mode: 0o600 });
  renameSync(tmp, p);
}
