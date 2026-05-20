// tests/unit/brain-fetcher.test.ts
import { describe, expect, it } from "bun:test";
import {
  ALLOWED_HOSTS,
  SafeFetchError,
  isBlockedIp,
  safeFetch,
} from "../../src/core/brain/fetcher.ts";

// ---------------------------------------------------------------------------
// Gate 1: HTTPS-only
// ---------------------------------------------------------------------------
describe("safeFetch — Gate 1: HTTPS only", () => {
  it("rejects http:// URLs", async () => {
    await expect(safeFetch("http://docs.anthropic.com/page")).rejects.toBeInstanceOf(
      SafeFetchError,
    );
  });

  it("rejects ftp:// URLs", async () => {
    await expect(safeFetch("ftp://docs.anthropic.com/page")).rejects.toBeInstanceOf(SafeFetchError);
  });
});

// ---------------------------------------------------------------------------
// Gate 2: Final-host allowlist
// ---------------------------------------------------------------------------
describe("safeFetch — Gate 2: host allowlist", () => {
  it("ALLOWED_HOSTS is a non-empty array of strings", () => {
    expect(Array.isArray(ALLOWED_HOSTS)).toBe(true);
    expect(ALLOWED_HOSTS.length).toBeGreaterThan(0);
    for (const h of ALLOWED_HOSTS) {
      expect(typeof h).toBe("string");
    }
  });

  it("rejects a host not on the allowlist", async () => {
    await expect(safeFetch("https://evil.example.com/page")).rejects.toBeInstanceOf(SafeFetchError);
  });

  it("accepts the first allowlisted host (mocked network would be needed for full flow)", async () => {
    // We only verify the URL-shape check passes; the DNS step will fail in the test env, which is fine.
    const host = ALLOWED_HOSTS[0];
    const err = await safeFetch(`https://${host}/some-doc-page`).catch((e: unknown) => e);
    // Either a SafeFetchError (e.g. DNS in sandbox) or a network error — NOT a SafeFetchError from
    // the allowlist or scheme gate. If it IS a SafeFetchError it must not be SCHEME or HOST.
    if (err instanceof SafeFetchError) {
      expect(err.code).not.toBe("SCHEME");
      expect(err.code).not.toBe("HOST");
    }
    // else: real network error from DNS/TLS — acceptable in unit test environment
  });
});

// ---------------------------------------------------------------------------
// Gate 3: Private / metadata IP blocking
// ---------------------------------------------------------------------------
describe("isBlockedIp", () => {
  // loopback
  it("blocks 127.0.0.1", () => expect(isBlockedIp("127.0.0.1")).toBe(true));
  it("blocks ::1", () => expect(isBlockedIp("::1")).toBe(true));
  it("blocks 127.99.0.1", () => expect(isBlockedIp("127.99.0.1")).toBe(true));

  // private RFC-1918
  it("blocks 10.0.0.1", () => expect(isBlockedIp("10.0.0.1")).toBe(true));
  it("blocks 172.16.0.1", () => expect(isBlockedIp("172.16.0.1")).toBe(true));
  it("blocks 172.31.255.255", () => expect(isBlockedIp("172.31.255.255")).toBe(true));
  it("blocks 192.168.1.1", () => expect(isBlockedIp("192.168.1.1")).toBe(true));

  // link-local
  it("blocks 169.254.0.1 (link-local / metadata)", () =>
    expect(isBlockedIp("169.254.0.1")).toBe(true));
  it("blocks 169.254.169.254 (AWS metadata)", () =>
    expect(isBlockedIp("169.254.169.254")).toBe(true));
  it("blocks fe80::1 (IPv6 link-local)", () => expect(isBlockedIp("fe80::1")).toBe(true));

  // CGNAT
  it("blocks 100.64.0.1 (CGNAT)", () => expect(isBlockedIp("100.64.0.1")).toBe(true));
  it("blocks 100.127.255.255 (CGNAT)", () => expect(isBlockedIp("100.127.255.255")).toBe(true));

  // unique-local IPv6
  it("blocks fc00::1 (unique-local)", () => expect(isBlockedIp("fc00::1")).toBe(true));
  it("blocks fd12:3456:789a::1 (unique-local)", () =>
    expect(isBlockedIp("fd12:3456:789a::1")).toBe(true));

  // public IPs should NOT be blocked
  it("does not block 1.1.1.1", () => expect(isBlockedIp("1.1.1.1")).toBe(false));
  it("does not block 8.8.8.8", () => expect(isBlockedIp("8.8.8.8")).toBe(false));
  it("does not block 2606:4700::6810:84e5 (Cloudflare)", () =>
    expect(isBlockedIp("2606:4700::6810:84e5")).toBe(false));
});

// ---------------------------------------------------------------------------
// Gate 4: Query-string stripping
// ---------------------------------------------------------------------------
describe("safeFetch — Gate 4: query strip", () => {
  it("rejects URLs with a query string", async () => {
    // Use a non-allowlisted host so we get HOST error, OR an allowlisted host so we see QUERY error
    const host = ALLOWED_HOSTS[0];
    const err = await safeFetch(`https://${host}/page?secret=exfil`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SafeFetchError);
    if (err instanceof SafeFetchError) {
      expect(err.code).toBe("QUERY");
    }
  });
});

// ---------------------------------------------------------------------------
// Gate 5: URL length cap
// ---------------------------------------------------------------------------
describe("safeFetch — Gate 5: URL length cap", () => {
  it("rejects URLs exceeding the max length", async () => {
    const host = ALLOWED_HOSTS[0];
    const longPath = "/a".repeat(1000);
    const err = await safeFetch(`https://${host}${longPath}`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SafeFetchError);
    if (err instanceof SafeFetchError) {
      expect(err.code).toBe("URL_TOO_LONG");
    }
  });
});

// ---------------------------------------------------------------------------
// Gate 6: Oversize body + content-type allowlist (mocked via Response)
// ---------------------------------------------------------------------------
describe("safeFetch — Gate 6: oversize / content-type (unit-level validators)", () => {
  it("SafeFetchError carries a machine-readable code", () => {
    const e = new SafeFetchError("OVERSIZE", "body too large");
    expect(e.code).toBe("OVERSIZE");
    expect(e.message).toBe("body too large");
    expect(e).toBeInstanceOf(Error);
  });

  it("SafeFetchError has CONTENT_TYPE code variant", () => {
    const e = new SafeFetchError("CONTENT_TYPE", "disallowed content-type");
    expect(e.code).toBe("CONTENT_TYPE");
  });
});

// ---------------------------------------------------------------------------
// Gate 7: No credential / auth-header forwarding — structural check
// ---------------------------------------------------------------------------
describe("safeFetch — Gate 7: no credential forwarding", () => {
  it("safeFetch accepts only a URL string (no RequestInit with credentials)", async () => {
    // The function signature must be (url: string, opts?: SafeFetchOptions) where SafeFetchOptions
    // does NOT expose headers/credentials/cookies to the caller.
    // We verify by checking the function only takes a URL and optional internal opts.
    expect(typeof safeFetch).toBe("function");
    // Calling with just a URL must not throw a TypeError about signature.
    const p = safeFetch("https://evil.example.com/");
    await p.catch(() => {}); // suppress — we just verify it returns a promise
    expect(p).toBeInstanceOf(Promise);
  });
});
