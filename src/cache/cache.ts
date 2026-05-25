// src/cache/cache.ts
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface CacheKeyInput {
  diff: string;
  configHash: string;
  providerVersions: string;
  reviewgateVersion: string;
  schemaVersion: string;
}

export function computeCacheKey(input: CacheKeyInput): string {
  return createHash("sha256")
    .update(
      [
        input.diff,
        input.configHash,
        input.providerVersions,
        input.reviewgateVersion,
        input.schemaVersion,
      ].join("|"),
    )
    .digest("hex");
}

export interface CachedReview {
  verdict: "PASS" | "SOFT-PASS" | "FAIL";
  counts: { critical: number; warn: number; info: number };
}

function reviewCachePath(repoRoot: string, key: string): string {
  return join(repoRoot, ".reviewgate", "cache", "reviews", `${key}.json`);
}

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function getCachedReview(
  repoRoot: string,
  key: string,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<CachedReview | null> {
  const p = reviewCachePath(repoRoot, key);
  if (!existsSync(p)) return null;
  try {
    const o = JSON.parse(readFileSync(p, "utf8")) as { ts: number; review: CachedReview };
    if (Date.now() - o.ts > ttlMs) return null;
    return o.review;
  } catch {
    return null;
  }
}

export async function putCachedReview(
  repoRoot: string,
  key: string,
  review: CachedReview,
): Promise<void> {
  const p = reviewCachePath(repoRoot, key);
  mkdirSync(join(repoRoot, ".reviewgate", "cache", "reviews"), { recursive: true });
  writeFileSync(p, JSON.stringify({ ts: Date.now(), review }), { mode: 0o600 });
}
