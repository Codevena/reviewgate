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

  it("rejects (does not hang) when DNS resolution stalls past the timeout", async () => {
    const start = Date.now();
    await expect(
      safeApiFetch("https://context7.com/api", {
        allowHost: "context7.com",
        timeoutMs: 50,
        resolve: () => new Promise<string[]>(() => {}), // never settles
      }),
    ).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(2000); // bounded, not hung
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

  it("pins the connection to the validated IP (no hostname re-resolution / DNS-rebinding TOCTOU)", async () => {
    // F-063: the IP-block check and the actual connection must use the SAME
    // resolution. The default path must connect to the IP that passed isBlockedIp,
    // NOT re-resolve the hostname at connect time. We assert the validated IP is
    // forwarded verbatim to the pin layer (mirroring the brain's pinnedFetch
    // posture) — a plain hostname fetch would never receive a pinnedIp at all.
    let pinnedSeen = "";
    let urlSeen = "";
    const pinnedFetchImpl = (async (u: URL, pinnedIp: string): Promise<Response> => {
      pinnedSeen = pinnedIp;
      urlSeen = u.toString();
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof import("../../src/core/brain/fetcher.ts").pinnedFetch;
    const out = await safeApiFetch("https://context7.com/api/x", {
      allowHost: "context7.com",
      query: { q: "1" },
      apiKey: "tok",
      timeoutMs: 5000,
      resolve: async () => ["93.184.216.34"], // the ONLY validated IP
      pinnedFetchImpl,
    });
    expect(pinnedSeen).toBe("93.184.216.34"); // connect uses the checked IP, not a re-resolve
    expect(urlSeen).toBe("https://context7.com/api/x?q=1"); // host preserved (Host header / SNI)
    expect(out).toEqual({ ok: true });
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
