import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchLibraryDocs } from "../../src/research/context7.ts";

function stubFetch(map: Record<string, unknown>): typeof fetch {
  return (async (url: string) => {
    const key = Object.keys(map).find((k) => url.includes(k));
    return new Response(JSON.stringify(key ? map[key] : {}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

const baseOpts = (repo: string, fetchImpl: typeof fetch) => ({
  repoRoot: repo,
  host: "context7.com",
  apiKeyEnv: "C7_UNSET_ENV",
  timeoutMs: 5000,
  ttlDays: 30,
  perLibBytes: 2500,
  fetchImpl,
  resolve: async () => ["93.184.216.34"],
});

describe("fetchLibraryDocs", () => {
  it("searches then fetches context, returns rendered docs + per-lib outcomes", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-c7-"));
    const fetchImpl = stubFetch({
      "/v2/libs/search": { results: [{ id: "/colinhacks/zod", title: "Zod" }] },
      "/v2/context": {
        codeSnippets: [{ codeTitle: "parse", codeList: [{ code: "z.string().parse(x)" }] }],
        infoSnippets: [{ content: "Zod v3 schema." }],
      },
    });
    const res = await fetchLibraryDocs(
      [{ name: "zod", version: "3.25.0", fromFiles: ["a.ts"] }],
      baseOpts(repo, fetchImpl),
    );
    expect(res.libs[0]?.name).toBe("zod");
    expect(res.libs[0]?.outcome).toBe("fetched");
    expect(res.libs[0]?.text).toContain("z.string().parse");
    expect(res.text).toContain("Zod");
    // corpus digest entry for the behavior-hash
    expect(res.corpus[0]?.libraryId).toBe("/colinhacks/zod");
    expect(res.corpus[0]?.version).toBe("3.25.0");
    expect(res.corpus[0]?.responseHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("skips a lib with no search match (records skipped, never throws)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-c7-2-"));
    const fetchImpl = stubFetch({ "/v2/libs/search": { results: [] } });
    const res = await fetchLibraryDocs(
      [{ name: "nope", version: null, fromFiles: ["a.ts"] }],
      baseOpts(repo, fetchImpl),
    );
    expect(res.libs[0]?.outcome).toBe("skipped:no-match");
    expect(res.text).toBe("");
    expect(res.corpus).toEqual([]);
  });

  it("skips a lib when the network throws (best-effort, never throws)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-c7-3-"));
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const res = await fetchLibraryDocs(
      [{ name: "zod", version: "3.0.0", fromFiles: ["a.ts"] }],
      baseOpts(repo, fetchImpl),
    );
    expect(res.libs[0]?.outcome.startsWith("skipped:")).toBe(true);
    expect(res.text).toBe("");
  });

  it("returns cache-hit on the second call without a context fetch", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-c7-4-"));
    let contextCalls = 0;
    const fetchImpl = (async (url: string) => {
      let body: unknown = {};
      if (url.includes("/v2/libs/search")) body = { results: [{ id: "/colinhacks/zod" }] };
      else if (url.includes("/v2/context")) {
        contextCalls++;
        body = { infoSnippets: [{ content: "Zod docs." }] };
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const libs = [{ name: "zod", version: "3.25.0", fromFiles: ["a.ts"] }];
    const first = await fetchLibraryDocs(libs, baseOpts(repo, fetchImpl));
    expect(first.libs[0]?.outcome).toBe("fetched");
    const second = await fetchLibraryDocs(libs, baseOpts(repo, fetchImpl));
    expect(second.libs[0]?.outcome).toBe("cache-hit");
    expect(contextCalls).toBe(1); // context fetched once, served from cache the 2nd time
    expect(second.corpus[0]?.responseHash).toBe(first.corpus[0]?.responseHash);
  });

  it("marks truncated when a lib's docs exceed perLibBytes", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-c7-5-"));
    const big = "x".repeat(5000);
    const fetchImpl = stubFetch({
      "/v2/libs/search": { results: [{ id: "/big/lib" }] },
      "/v2/context": { infoSnippets: [{ content: big }] },
    });
    const res = await fetchLibraryDocs([{ name: "biglib", version: null, fromFiles: ["a.ts"] }], {
      ...baseOpts(repo, fetchImpl),
      perLibBytes: 100,
    });
    expect(res.libs[0]?.outcome).toBe("truncated");
    expect(res.libs[0]?.text.length).toBeLessThanOrEqual(100);
  });

  it("respects maxLibs (caps the number of libs processed)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-c7-6-"));
    const fetchImpl = stubFetch({
      "/v2/libs/search": { results: [{ id: "/x/y" }] },
      "/v2/context": { infoSnippets: [{ content: "doc" }] },
    });
    const res = await fetchLibraryDocs(
      [
        { name: "a", version: null, fromFiles: ["f.ts"] },
        { name: "b", version: null, fromFiles: ["f.ts"] },
        { name: "c", version: null, fromFiles: ["f.ts"] },
      ],
      { ...baseOpts(repo, fetchImpl), maxLibs: 2 },
    );
    expect(res.libs).toHaveLength(2);
  });
});
