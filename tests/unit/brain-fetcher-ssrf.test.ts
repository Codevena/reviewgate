// tests/unit/brain-fetcher-ssrf.test.ts
//
// Finding 2: two SSRF gaps in fetcher.ts.
//   (a) safeFetch's DNS resolution was NOT bound by timeoutMs — a stalled
//       resolver could hang past the timeout. The resolve() call is now raced
//       against the shared abort signal so total time respects timeoutMs.
//   (b) NAT64 / hex-form IPv6 embedding a private/metadata IPv4 (e.g.
//       64:ff9b::169.254.169.254, 64:ff9b::c0a8:1) bypassed isBlockedIp — it
//       only handled IPv4-mapped (::ffff:) and IPv4-compatible forms. The
//       embedded-v4 extractor now recognizes the 64:ff9b::/96 well-known prefix.
import { describe, expect, it } from "bun:test";
import { type SafeFetchOpts, isBlockedIp, safeFetch } from "../../src/core/brain/fetcher.ts";

describe("isBlockedIp — NAT64 / embedded-IPv4 forms (Finding 2b)", () => {
  // NAT64 well-known prefix 64:ff9b::/96, dotted suffix.
  it("blocks 64:ff9b::169.254.169.254 (NAT64 embedding AWS metadata, dotted)", () =>
    expect(isBlockedIp("64:ff9b::169.254.169.254")).toBe(true));
  it("blocks 64:ff9b::10.0.0.1 (NAT64 embedding private 10/8, dotted)", () =>
    expect(isBlockedIp("64:ff9b::10.0.0.1")).toBe(true));
  it("blocks 64:ff9b::127.0.0.1 (NAT64 embedding loopback, dotted)", () =>
    expect(isBlockedIp("64:ff9b::127.0.0.1")).toBe(true));

  // NAT64 hex form — the embedded v4 lives in the final 32 bits as hex groups.
  it("blocks 64:ff9b::a9fe:a9fe (NAT64 hex 169.254.169.254 metadata)", () =>
    expect(isBlockedIp("64:ff9b::a9fe:a9fe")).toBe(true));
  it("blocks 64:ff9b::c0a8:1 (NAT64 hex 192.168.0.1 private)", () =>
    expect(isBlockedIp("64:ff9b::c0a8:1")).toBe(true));
  it("blocks 64:ff9b::7f00:1 (NAT64 hex 127.0.0.1 loopback)", () =>
    expect(isBlockedIp("64:ff9b::7f00:1")).toBe(true));
  it("blocks 0064:ff9b:0:0:0:0:a00:1 (uncompressed NAT64 hex 10.0.0.1)", () =>
    expect(isBlockedIp("0064:ff9b:0:0:0:0:a00:1")).toBe(true));
  it("blocks 64:FF9B::A9FE:A9FE (uppercase NAT64 hex metadata)", () =>
    expect(isBlockedIp("64:FF9B::A9FE:A9FE")).toBe(true));

  // The hex form of ::ffff:169.254.169.254 (already mapped path) — guard the
  // metadata host explicitly in hex too.
  it("blocks ::ffff:a9fe:a9fe (hex mapped 169.254.169.254 metadata)", () =>
    expect(isBlockedIp("::ffff:a9fe:a9fe")).toBe(true));

  // A NAT64-embedded PUBLIC v4 should still be allowed (the v4 rules decide).
  it("does not block 64:ff9b::808:808 (NAT64 hex public 8.8.8.8)", () =>
    expect(isBlockedIp("64:ff9b::808:808")).toBe(false));
});

describe("safeFetch — Gate 5 denies NAT64-embedded private/metadata IPs", () => {
  const baseOpts = (resolve: (host: string) => Promise<string[]>): SafeFetchOpts => ({
    allow: ["docs.example.com"],
    fetchImpl: (async () =>
      new Response("x", { status: 200, headers: { "content-type": "text/html" } })) as never,
    resolve,
  });

  it("denies when DNS resolves to a NAT64 address embedding the metadata IP", async () => {
    const r = await safeFetch(
      "https://docs.example.com/x",
      baseOpts(async () => ["64:ff9b::169.254.169.254"]),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("resolves to blocked ip");
  });
});

describe("safeFetch — Finding 2a: DNS resolution respects timeoutMs", () => {
  it("denies with 'timeout' when the resolver stalls past timeoutMs (does not hang)", async () => {
    // A resolver that never settles must not hang safeFetch past its timeout.
    // The DNS lookup is raced against the abort signal, so a stalled resolver
    // yields a prompt 'timeout' deny rather than blocking forever.
    const stalling: SafeFetchOpts["resolve"] = () => new Promise<string[]>(() => {});
    const opts: SafeFetchOpts = {
      allow: ["docs.example.com"],
      fetchImpl: (async () =>
        new Response("x", { status: 200, headers: { "content-type": "text/html" } })) as never,
      resolve: stalling,
      timeoutMs: 100,
    };
    const start = performance.now();
    const r = await safeFetch("https://docs.example.com/x", opts);
    const elapsedMs = performance.now() - start;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("timeout");
    // Returned roughly at the timeout, not hung indefinitely.
    expect(elapsedMs).toBeLessThan(2000);
  });

  it("still resolves the happy path when DNS returns promptly", async () => {
    const opts: SafeFetchOpts = {
      allow: ["docs.example.com"],
      fetchImpl: (async () =>
        new Response("hi", { status: 200, headers: { "content-type": "text/html" } })) as never,
      resolve: async () => ["93.184.216.34"],
      timeoutMs: 1000,
    };
    const r = await safeFetch("https://docs.example.com/x", opts);
    expect(r.ok).toBe(true);
  });
});
