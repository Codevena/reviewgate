import { describe, expect, it } from "bun:test";
import { safeApiFetch } from "../../src/research/safe-api-fetch.ts";

describe("safeApiFetch", () => {
  it("GETs an allowlisted host with query params + Bearer, returns parsed JSON", async () => {
    let seenUrl = "";
    let seenAuth = "";
    const fetchImpl = (async (url: string, init: { headers: Record<string, string> }) => {
      seenUrl = url;
      seenAuth = init.headers.Authorization ?? "";
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const out = await safeApiFetch("https://context7.com/api/v2/libs/search", {
      allowHost: "context7.com",
      query: { libraryName: "next" },
      apiKey: "k",
      timeoutMs: 5000,
      maxBytes: 1_000_000,
      fetchImpl,
      resolve: async () => ["93.184.216.34"], // public IP stub
    });
    expect(seenUrl).toBe("https://context7.com/api/v2/libs/search?libraryName=next");
    expect(seenAuth).toBe("Bearer k");
    expect(out).toEqual({ ok: true });
  });

  it("omits the Authorization header when no apiKey is given (keyless)", async () => {
    let seenAuth: string | undefined = "unset";
    const fetchImpl = (async (_url: string, init: { headers: Record<string, string> }) => {
      seenAuth = init.headers.Authorization;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    await safeApiFetch("https://context7.com/api/v2/context", {
      allowHost: "context7.com",
      timeoutMs: 5000,
      fetchImpl,
      resolve: async () => ["93.184.216.34"],
    });
    expect(seenAuth).toBeUndefined();
  });

  it("rejects a non-allowlisted host", async () => {
    await expect(
      safeApiFetch("https://evil.com/api", { allowHost: "context7.com", timeoutMs: 100 }),
    ).rejects.toThrow();
  });

  it("rejects a host that resolves to a private IP (SSRF)", async () => {
    await expect(
      safeApiFetch("https://context7.com/api", {
        allowHost: "context7.com",
        timeoutMs: 100,
        resolve: async () => ["127.0.0.1"],
      }),
    ).rejects.toThrow();
  });

  it("rejects when the host resolves to no addresses", async () => {
    await expect(
      safeApiFetch("https://context7.com/api", {
        allowHost: "context7.com",
        timeoutMs: 100,
        resolve: async () => [],
      }),
    ).rejects.toThrow();
  });

  it("rejects non-HTTPS", async () => {
    await expect(
      safeApiFetch("http://context7.com/api", { allowHost: "context7.com", timeoutMs: 100 }),
    ).rejects.toThrow();
  });

  it("rejects a non-2xx HTTP status", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 404 })) as unknown as typeof fetch;
    await expect(
      safeApiFetch("https://context7.com/api", {
        allowHost: "context7.com",
        timeoutMs: 100,
        fetchImpl,
        resolve: async () => ["93.184.216.34"],
      }),
    ).rejects.toThrow();
  });

  it("rejects a non-JSON content-type", async () => {
    const fetchImpl = (async () =>
      new Response("<html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch;
    await expect(
      safeApiFetch("https://context7.com/api", {
        allowHost: "context7.com",
        timeoutMs: 100,
        fetchImpl,
        resolve: async () => ["93.184.216.34"],
      }),
    ).rejects.toThrow();
  });

  it("rejects (does not truncate) a body whose declared content-length exceeds maxBytes", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json", "content-length": "5000" },
      })) as unknown as typeof fetch;
    await expect(
      safeApiFetch("https://context7.com/api", {
        allowHost: "context7.com",
        timeoutMs: 100,
        maxBytes: 100,
        fetchImpl,
        resolve: async () => ["93.184.216.34"],
      }),
    ).rejects.toThrow();
  });

  it("rejects (does not truncate→parse-fail) an actual body larger than maxBytes", async () => {
    // big VALID json with no content-length header → must be rejected on actual size,
    // never sliced (slicing would corrupt the JSON into a parse error instead).
    const big = JSON.stringify({ data: "x".repeat(2000) });
    const fetchImpl = (async () =>
      new Response(big, {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    await expect(
      safeApiFetch("https://context7.com/api", {
        allowHost: "context7.com",
        timeoutMs: 100,
        maxBytes: 100,
        fetchImpl,
        resolve: async () => ["93.184.216.34"],
      }),
    ).rejects.toThrow();
  });

  it("does NOT follow HTTP redirects (redirect: manual → 3xx is not ok)", async () => {
    const fetchImpl = (async () =>
      new Response(null, {
        status: 301,
        headers: { location: "https://context7.com/elsewhere" },
      })) as unknown as typeof fetch;
    await expect(
      safeApiFetch("https://context7.com/api", {
        allowHost: "context7.com",
        timeoutMs: 100,
        fetchImpl,
        resolve: async () => ["93.184.216.34"],
      }),
    ).rejects.toThrow();
  });
});
