// tests/unit/cache.test.ts
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeCacheKey, getCachedReview, putCachedReview } from "../../src/cache/cache.ts";

describe("cache", () => {
  it("computeCacheKey changes when any input changes", () => {
    const base = {
      diff: "d",
      configHash: "c",
      providerVersions: "p",
      reviewgateVersion: "0.1",
      schemaVersion: "v1",
    };
    const k1 = computeCacheKey(base);
    expect(k1).toMatch(/^[0-9a-f]{64}$/);
    expect(computeCacheKey({ ...base, diff: "d2" })).not.toBe(k1);
    expect(computeCacheKey({ ...base, configHash: "c2" })).not.toBe(k1);
    expect(computeCacheKey({ ...base, providerVersions: "p2" })).not.toBe(k1);
    // G0: the schemaVersion participates in the key, so bumping it (…v1 → …v2) invalidates
    // ALL pre-G0 entries — incl. a stale clean PASS produced under the old per-finding semantics.
    expect(computeCacheKey({ ...base, schemaVersion: "v2" })).not.toBe(k1);
    expect(computeCacheKey({ ...base, reviewgateVersion: "0.2" })).not.toBe(k1);
  });
  it("round-trips a cached review verdict", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-cache-"));
    const key = computeCacheKey({
      diff: "d",
      configHash: "c",
      providerVersions: "p",
      reviewgateVersion: "0.1",
      schemaVersion: "v1",
    });
    expect(await getCachedReview(repo, key)).toBeNull();
    await putCachedReview(repo, key, {
      verdict: "PASS",
      counts: { critical: 0, warn: 0, info: 0 },
    });
    const got = await getCachedReview(repo, key);
    expect(got?.verdict).toBe("PASS");
  });
  it("getCachedReview honours a caller-supplied TTL (expires before the 7-day default)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-cache-ttl-"));
    const key = "k-ttl";
    mkdirSync(join(repo, ".reviewgate", "cache", "reviews"), { recursive: true });
    // Written 3 days ago.
    const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
    writeFileSync(
      join(repo, ".reviewgate", "cache", "reviews", `${key}.json`),
      JSON.stringify({
        ts: threeDaysAgo,
        review: { verdict: "PASS", counts: { critical: 0, warn: 0, info: 0 } },
      }),
    );
    // 1-day TTL → expired.
    expect(await getCachedReview(repo, key, 1 * 24 * 60 * 60 * 1000)).toBeNull();
    // 7-day TTL → still valid.
    expect(await getCachedReview(repo, key, 7 * 24 * 60 * 60 * 1000)).not.toBeNull();
  });
});
