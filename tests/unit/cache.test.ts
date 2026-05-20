// tests/unit/cache.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
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
});
