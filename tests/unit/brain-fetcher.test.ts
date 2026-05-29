// tests/unit/brain-fetcher.test.ts
import { describe, expect, it } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type SafeFetchOpts,
  isBlockedIp,
  pinnedFetch,
  pinnedLookup,
  safeFetch,
} from "../../src/core/brain/fetcher.ts";

const allow = ["docs.example.com"];

const okFetch = (async () =>
  new Response("hello docs", {
    status: 200,
    headers: { "content-type": "text/html" },
  })) as unknown as typeof fetch;

function opts(over: Partial<SafeFetchOpts> = {}): SafeFetchOpts {
  return {
    allow,
    fetchImpl: okFetch,
    resolve: async () => ["93.184.216.34"],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Gate 1: HTTPS-only
// ---------------------------------------------------------------------------
describe("safeFetch — Gate 1: HTTPS only", () => {
  it("rejects http:// URLs (never throws)", async () => {
    const r = await safeFetch("http://docs.example.com/x", opts());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("non-https");
  });

  it("rejects ftp:// URLs", async () => {
    const r = await safeFetch("ftp://docs.example.com/x", opts());
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Gate 5: DNS rebinding / TOCTOU pin (F-026)
// ---------------------------------------------------------------------------
describe("safeFetch — Gate 5: connection is pinned to the checked IP (F-026)", () => {
  it("pinnedLookup returns the checked IP regardless of the hostname the client resolves", () => {
    // The whole TOCTOU/DNS-rebinding defense: the IP the gate checked MUST be the
    // IP the connection uses. pinnedLookup forces every connect-time resolution to
    // the pinned IP, so an attacker who flips DNS to 169.254.169.254 between the
    // check and the connect cannot rebind the connection.
    const lookup = pinnedLookup("93.184.216.34");
    let captured: { err: unknown; addrs: unknown } | undefined;
    lookup("evil-rebind.example.com", {}, (err: unknown, addrs: unknown) => {
      captured = { err, addrs };
    });
    expect(captured?.err).toBeNull();
    expect(captured?.addrs).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  it("pins IPv6 addresses with family 6", () => {
    const lookup = pinnedLookup("2606:2800:220:1:248:1893:25c8:1946");
    let addrs: unknown;
    lookup("h", {}, (_e: unknown, a: unknown) => {
      addrs = a;
    });
    expect(addrs).toEqual([{ address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }]);
  });

  it("pinnedFetch REALLY connects to the pinned IP, ignoring the URL hostname (live local server)", async () => {
    // The definitive test: stand up a real loopback HTTP server, then ask
    // pinnedFetch for a URL whose hostname does NOT resolve to it, pinned to
    // 127.0.0.1. If the pin is honored (node:http(s) `lookup` is honored on Bun),
    // the request reaches our server. A no-op pin (the earlier undici/dispatcher
    // approach, silently ignored on Bun) would instead try real DNS for the bogus
    // host and fail — which is exactly the regression this guards against.
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("pinned-hit");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      const ctrl = new AbortController();
      const resp = await pinnedFetch(new URL(`http://nonexistent.invalid:${port}/`), "127.0.0.1", {
        headers: {},
        signal: ctrl.signal,
        maxBytes: 1_000_000,
      });
      expect(resp.status).toBe(200);
      expect(await resp.text()).toBe("pinned-hit");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("pinnedFetch always settles (rejects, never hangs) when aborted after connect, pre-response", async () => {
    // Bun 1.3.14 does not emit 'error' on req.destroy() once the connection is
    // established but no response has arrived — only 'close'. Without a close-guard
    // the Promise hangs forever and safeFetch's await never returns (contract
    // violation). The connection establishes to a real server that never responds;
    // aborting must reject promptly. (If this regressed, the test would TIME OUT.)
    const server = createServer(() => {
      /* accept the request, never send a response */
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      const ctrl = new AbortController();
      const p = pinnedFetch(new URL(`http://127.0.0.1:${port}/`), "127.0.0.1", {
        headers: {},
        signal: ctrl.signal,
        maxBytes: 1000,
      });
      setTimeout(() => ctrl.abort(), 150);
      await expect(p).rejects.toThrow();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("pinnedFetch stops buffering past maxBytes (does not read a huge body whole)", async () => {
    // A multi-megabyte body arrives in many TCP chunks; the cap must stop reading
    // early rather than buffer the whole thing (DoS guard). The returned body is
    // just past the cap so downstream still denies "body too large".
    const big = "x".repeat(5_000_000);
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(big);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      const resp = await pinnedFetch(new URL(`http://h.invalid:${port}/`), "127.0.0.1", {
        headers: {},
        signal: new AbortController().signal,
        maxBytes: 1000,
      });
      const body = await resp.text();
      expect(body.length).toBeGreaterThan(1000); // just over the cap → downstream denies
      expect(body.length).toBeLessThan(big.length); // but NOT the whole 5 MB body
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

// ---------------------------------------------------------------------------
// Gate 2: host allowlist (injected, not hardcoded)
// ---------------------------------------------------------------------------
describe("safeFetch — Gate 2: host allowlist", () => {
  it("rejects a host not on the injected allowlist", async () => {
    const r = await safeFetch("https://evil.com/x", opts());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("host not allowlisted");
  });
});

// ---------------------------------------------------------------------------
// Gate 5: IP blocking (incl. IPv4-mapped IPv6, 0.0.0.0, reserved)
// ---------------------------------------------------------------------------
describe("isBlockedIp", () => {
  // loopback / private / link-local / metadata / CGNAT (existing coverage)
  it("blocks 127.0.0.1", () => expect(isBlockedIp("127.0.0.1")).toBe(true));
  it("blocks ::1", () => expect(isBlockedIp("::1")).toBe(true));
  it("blocks 127.99.0.1", () => expect(isBlockedIp("127.99.0.1")).toBe(true));
  it("blocks 10.0.0.1", () => expect(isBlockedIp("10.0.0.1")).toBe(true));
  it("blocks 172.16.0.1", () => expect(isBlockedIp("172.16.0.1")).toBe(true));
  it("blocks 172.31.255.255", () => expect(isBlockedIp("172.31.255.255")).toBe(true));
  it("blocks 192.168.1.1", () => expect(isBlockedIp("192.168.1.1")).toBe(true));
  it("blocks 169.254.0.1 (link-local)", () => expect(isBlockedIp("169.254.0.1")).toBe(true));
  it("blocks 169.254.169.254 (AWS metadata)", () =>
    expect(isBlockedIp("169.254.169.254")).toBe(true));
  it("blocks fe80::1 (IPv6 link-local)", () => expect(isBlockedIp("fe80::1")).toBe(true));
  it("blocks 100.64.0.1 (CGNAT)", () => expect(isBlockedIp("100.64.0.1")).toBe(true));
  it("blocks 100.127.255.255 (CGNAT)", () => expect(isBlockedIp("100.127.255.255")).toBe(true));
  it("blocks fc00::1 (unique-local)", () => expect(isBlockedIp("fc00::1")).toBe(true));
  it("blocks fd12:3456:789a::1 (unique-local)", () =>
    expect(isBlockedIp("fd12:3456:789a::1")).toBe(true));

  // NEW: IPv4-mapped IPv6 bypass
  it("blocks ::ffff:127.0.0.1 (mapped loopback)", () =>
    expect(isBlockedIp("::ffff:127.0.0.1")).toBe(true));
  it("blocks ::ffff:10.0.0.1 (mapped private)", () =>
    expect(isBlockedIp("::ffff:10.0.0.1")).toBe(true));
  it("blocks ::FFFF:169.254.169.254 (mapped metadata, case-insensitive)", () =>
    expect(isBlockedIp("::FFFF:169.254.169.254")).toBe(true));
  it("blocks a mapped PUBLIC ip routed through v4 rules but still public → false", () =>
    expect(isBlockedIp("::ffff:8.8.8.8")).toBe(false));

  // NEW: hex-form IPv4-mapped IPv6 bypass (::ffff:HHHH:HHHH)
  it("blocks ::ffff:7f00:1 (hex mapped loopback 127.0.0.1)", () =>
    expect(isBlockedIp("::ffff:7f00:1")).toBe(true));
  it("blocks ::ffff:c0a8:101 (hex mapped 192.168.1.1)", () =>
    expect(isBlockedIp("::ffff:c0a8:101")).toBe(true));
  it("blocks ::ffff:a00:1 (hex mapped 10.0.0.1)", () =>
    expect(isBlockedIp("::ffff:a00:1")).toBe(true));
  it("blocks ::ffff:6440:101 (hex mapped 100.64.1.1 CGNAT)", () =>
    expect(isBlockedIp("::ffff:6440:101")).toBe(true));
  it("blocks ::FFFF:7F00:1 (uppercase hex mapped loopback)", () =>
    expect(isBlockedIp("::FFFF:7F00:1")).toBe(true));
  it("blocks ::ffff:7f00:0001 (leading-zero hex group)", () =>
    expect(isBlockedIp("::ffff:7f00:0001")).toBe(true));
  it("blocks 0:0:0:0:0:ffff:7f00:1 (uncompressed hex mapped loopback)", () =>
    expect(isBlockedIp("0:0:0:0:0:ffff:7f00:1")).toBe(true));
  it("does not block ::ffff:808:808 (hex mapped public 8.8.8.8)", () =>
    expect(isBlockedIp("::ffff:808:808")).toBe(false));

  // NEW: IPv4-compatible (deprecated ::a.b.c.d / ::HHHH:HHHH)
  it("blocks ::127.0.0.1 (compat dotted loopback)", () =>
    expect(isBlockedIp("::127.0.0.1")).toBe(true));
  it("blocks ::7f00:1 (compat hex loopback)", () => expect(isBlockedIp("::7f00:1")).toBe(true));
  it("blocks ::c0a8:101 (compat hex 192.168.1.1)", () =>
    expect(isBlockedIp("::c0a8:101")).toBe(true));

  // NEW: 0.0.0.0/8 + reserved 240/4 + broadcast
  it("blocks 0.0.0.0 (this-host)", () => expect(isBlockedIp("0.0.0.0")).toBe(true));
  it("blocks 0.1.2.3 (0.0.0.0/8)", () => expect(isBlockedIp("0.1.2.3")).toBe(true));
  it("blocks 255.255.255.255 (broadcast)", () => expect(isBlockedIp("255.255.255.255")).toBe(true));
  it("blocks 240.0.0.1 (reserved 240/4)", () => expect(isBlockedIp("240.0.0.1")).toBe(true));

  // public IPs should NOT be blocked
  it("does not block 1.1.1.1", () => expect(isBlockedIp("1.1.1.1")).toBe(false));
  it("does not block 8.8.8.8", () => expect(isBlockedIp("8.8.8.8")).toBe(false));
  it("does not block 2606:4700::6810:84e5 (Cloudflare)", () =>
    expect(isBlockedIp("2606:4700::6810:84e5")).toBe(false));
});

describe("safeFetch — Gate 5: DNS resolves to a blocked IP", () => {
  it("denies for private/metadata/mapped IPs", async () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.5",
      "169.254.169.254",
      "192.168.1.1",
      "::1",
      "::ffff:127.0.0.1",
      "0.0.0.0",
    ]) {
      const r = await safeFetch("https://docs.example.com/x", opts({ resolve: async () => [ip] }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("resolves to blocked ip");
    }
  });
});

// ---------------------------------------------------------------------------
// Gate 3 + 4: query strip + length cap, happy path returns sha256
// ---------------------------------------------------------------------------
describe("safeFetch — happy path", () => {
  it("strips query, fetches an allowed public host, returns sha256", async () => {
    const r = await safeFetch("https://docs.example.com/page?leak=secret", opts());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.finalUrl).toBe("https://docs.example.com/page"); // query stripped
      expect(r.sha256).toHaveLength(64);
      expect(r.body).toContain("hello docs");
      expect(r.log.decision).toBe("allow");
      expect(r.log.resolved_ip).toBe("93.184.216.34");
    }
  });

  it("rejects an over-length URL", async () => {
    const r = await safeFetch(`https://docs.example.com/${"a".repeat(600)}`, opts());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("url too long");
  });

  it("strips embedded user:pass@ credentials and never forwards them", async () => {
    let requested = "";
    const spy = (async (url: string | URL) => {
      requested = String(url);
      return new Response("hello docs", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as unknown as typeof fetch;
    const r = await safeFetch(
      "https://attacker:secret@docs.example.com/page",
      opts({ fetchImpl: spy }),
    );
    expect(r.ok).toBe(true);
    // Credentials must not appear in the fetched URL or the final URL.
    expect(requested).not.toContain("attacker");
    expect(requested).not.toContain("secret");
    expect(requested).not.toContain("@");
    expect(requested).toBe("https://docs.example.com/page");
    if (r.ok) {
      expect(r.finalUrl).toBe("https://docs.example.com/page");
      expect(r.log.url).not.toContain("secret");
    }
  });
});

// ---------------------------------------------------------------------------
// Gate 7: oversize / disallowed content-type
// ---------------------------------------------------------------------------
describe("safeFetch — Gate 7: body limits + content-type", () => {
  it("rejects an oversize body", async () => {
    const big = (async () =>
      new Response("x".repeat(10_000), {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch;
    const r = await safeFetch(
      "https://docs.example.com/x",
      opts({ fetchImpl: big, maxBytes: 1000 }),
    );
    expect(r.ok).toBe(false);
  });

  it("rejects a disallowed content-type", async () => {
    const xml = (async () =>
      new Response("<x/>", {
        status: 200,
        headers: { "content-type": "application/xml" },
      })) as unknown as typeof fetch;
    const r = await safeFetch("https://docs.example.com/x", opts({ fetchImpl: xml }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("content-type");
  });
});

// ---------------------------------------------------------------------------
// Gate 6: redirects
// ---------------------------------------------------------------------------
describe("safeFetch — Gate 6: redirects", () => {
  const redirectTo = (location: string): typeof fetch =>
    (async () =>
      new Response(null, {
        status: 302,
        headers: { location },
      })) as unknown as typeof fetch;

  it("denies any 3xx by default (maxRedirects=0)", async () => {
    const r = await safeFetch(
      "https://docs.example.com/x",
      opts({ fetchImpl: redirectTo("https://docs.example.com/y") }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("too many redirects");
  });

  it("denies too-many-redirects when the chain exceeds maxRedirects", async () => {
    // Always 302 → never reaches a final response: with maxRedirects=1 the
    // second hop is refused.
    const r = await safeFetch(
      "https://docs.example.com/a",
      opts({ fetchImpl: redirectTo("https://docs.example.com/b"), maxRedirects: 1 }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("too many redirects");
  });

  it("denies a redirect to a non-allowlisted host", async () => {
    const r = await safeFetch(
      "https://docs.example.com/x",
      opts({ fetchImpl: redirectTo("https://evil.com/x"), maxRedirects: 3 }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("redirect blocked");
  });

  it("denies a redirect whose host resolves to a private IP", async () => {
    // Allowlist a second host; the redirect target is allowlisted but its DNS
    // resolves to a private IP → must be re-checked and denied.
    const fetchImpl = (async (url: string | URL) => {
      const s = String(url);
      if (s === "https://docs.example.com/x") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://inner.example/x" },
        });
      }
      return new Response("ok", { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const r = await safeFetch("https://docs.example.com/x", {
      allow: ["docs.example.com", "inner.example"],
      fetchImpl,
      maxRedirects: 3,
      resolve: async (h) => (h === "inner.example" ? ["10.0.0.5"] : ["93.184.216.34"]),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("resolves to blocked ip");
  });

  it("follows one allowed redirect to a public host when maxRedirects permits", async () => {
    const fetchImpl = (async (url: string | URL) => {
      const s = String(url);
      if (s === "https://docs.example.com/x") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://inner.example/final" },
        });
      }
      return new Response("final body", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as unknown as typeof fetch;
    const r = await safeFetch("https://docs.example.com/x", {
      allow: ["docs.example.com", "inner.example"],
      fetchImpl,
      maxRedirects: 3,
      resolve: async () => ["93.184.216.34"],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.finalUrl).toBe("https://inner.example/final");
      expect(r.body).toContain("final body");
    }
  });
});
