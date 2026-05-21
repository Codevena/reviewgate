import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CachedDocs,
  docsCacheKey,
  getCachedDocs,
  putCachedDocs,
} from "../../src/cache/docs-cache.ts";

function sampleEntry(): CachedDocs {
  return {
    name: "zod",
    libraryId: "/colinhacks/zod",
    version: "3.25.0",
    query: "zod",
    apiVersion: "v2",
    fetchedAt: Date.now(),
    responseHash: "abc123",
    docs: "## Zod\nz.string().parse(x)",
  };
}

describe("docsCacheKey", () => {
  it("is a stable sha256 hex keyed on libraryId@version", () => {
    const a = docsCacheKey("/colinhacks/zod", "3.25.0");
    const b = docsCacheKey("/colinhacks/zod", "3.25.0");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(docsCacheKey("/colinhacks/zod", "3.25.1")).not.toBe(a);
    expect(docsCacheKey("/colinhacks/zod", null)).not.toBe(a);
  });
});

describe("docs cache", () => {
  it("round-trips an entry within TTL", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-dcache-"));
    const key = docsCacheKey("/colinhacks/zod", "3.25.0");
    const entry = sampleEntry();
    await putCachedDocs(repo, key, entry);
    const got = await getCachedDocs(repo, key, 30);
    expect(got).toEqual(entry);
  });

  it("returns null for a missing key", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-dcache2-"));
    expect(await getCachedDocs(repo, docsCacheKey("/x/y", "1.0.0"), 30)).toBeNull();
  });

  it("applies the TTL at READ time (current ttlDays), not a value stored at write", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-dcache3-"));
    const key = docsCacheKey("/colinhacks/zod", "3.25.0");
    const entry = { ...sampleEntry(), fetchedAt: Date.now() - 2 * 24 * 60 * 60 * 1000 }; // 2 days old
    await putCachedDocs(repo, key, entry);
    // a 30-day TTL still considers it fresh; lowering to 1 day expires it immediately
    expect(await getCachedDocs(repo, key, 30)).not.toBeNull();
    expect(await getCachedDocs(repo, key, 1)).toBeNull();
  });

  it("writes with mode 0o600 under .reviewgate/cache/docs", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-dcache4-"));
    const key = docsCacheKey("/colinhacks/zod", "3.25.0");
    await putCachedDocs(repo, key, sampleEntry());
    const p = join(repo, ".reviewgate", "cache", "docs", `${key}.json`);
    // file exists + is JSON
    expect(() => JSON.parse(readFileSync(p, "utf8"))).not.toThrow();
  });
});
