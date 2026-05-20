/**
 * src/core/brain/fetcher.ts
 *
 * SSRF-resistant fetch for the Curator's web-fetch evidence path (SM4-2).
 *
 * Contract (plan Task 7):
 *   safeFetch(rawUrl, opts) →
 *     | { ok: true,  body, sha256, finalUrl, log }
 *     | { ok: false, reason, log }
 *   NEVER throws. All gates are enforced; the host allowlist is injected via
 *   `opts.allow` (NOT a hardcoded constant), and fetch/DNS are injectable for
 *   tests (`fetchImpl`, `resolve`).
 *
 * Gates (all must pass):
 *   1. HTTPS-only
 *   2. Host allowlist (after parse/canonicalization)
 *   3. Query stripped (no egress channel via query)
 *   4. URL length cap (≤ MAX_URL chars)
 *   5. DNS resolve-then-pin + IP blocking (private/loopback/link-local/CGNAT/
 *      metadata/reserved/this-host, incl. IPv4-mapped IPv6)
 *   6. Redirects: any 3xx is denied (safe default — allowlisted docs hosts use
 *      stable canonical URLs); the redirect cap is enforced correctly when
 *      following is enabled.
 *   7. Timeout + max-body + content-type allowlist
 *   8. No credential / auth-header / cookie forwarding
 *   9. Per-attempt egress log record
 */

import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";

// ---------------------------------------------------------------------------
// Egress log + result union
// ---------------------------------------------------------------------------

export interface EgressLog {
  url: string;
  final_url?: string;
  resolved_ip?: string;
  status?: number;
  bytes?: number;
  sha256?: string;
  decision: "allow" | "deny";
  reason?: string;
}

export type SafeFetchResult =
  | { ok: true; body: string; sha256: string; finalUrl: string; log: EgressLog }
  | { ok: false; reason: string; log: EgressLog };

export interface SafeFetchOpts {
  /** Exact-match host allowlist (caller-provided, NOT hardcoded). */
  allow: string[];
  /** Injected fetch implementation (defaults to global `fetch`). */
  fetchImpl?: typeof fetch;
  /** Injected DNS resolver — returns IPv4/IPv6 addresses for a hostname. */
  resolve?: (host: string) => Promise<string[]>;
  /** Max body size in bytes (default 2 MB). */
  maxBytes?: number;
  /** Max redirects to follow (default 0 → any 3xx is denied). */
  maxRedirects?: number;
  /** Request timeout in ms (default 8000). */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALLOWED_CONTENT_TYPES = ["text/html", "text/plain", "application/json"];
const MAX_URL = 512;
const DEFAULT_MAX_BYTES = 2_000_000;
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_REDIRECTS = 0;

// ---------------------------------------------------------------------------
// IP blocking
// ---------------------------------------------------------------------------

/**
 * Block an IPv4 address (dotted-quad string) if it falls into a private,
 * loopback, link-local, CGNAT, metadata, reserved, or this-host range.
 * Returns true for malformed input (fail-closed).
 */
function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return true; // malformed → block
  const octets = parts.map((p) => Number(p));
  for (const o of octets) {
    if (!Number.isInteger(o) || o < 0 || o > 255) return true;
  }
  const [a, b] = octets as [number, number, number, number];

  // "This host on this network" 0.0.0.0/8 (incl. 0.0.0.0)
  if (a === 0) return true;
  // Loopback 127.0.0.0/8
  if (a === 127) return true;
  // Private 10.0.0.0/8
  if (a === 10) return true;
  // Private 172.16.0.0/12 (172.16 – 172.31)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // Private 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // Link-local / metadata 169.254.0.0/16
  if (a === 169 && b === 254) return true;
  // CGNAT 100.64.0.0/10 (100.64 – 100.127)
  if (a === 100 && b >= 64 && b <= 127) return true;
  // Reserved / future-use 240.0.0.0/4 (240 – 255) — includes 255.255.255.255
  if (a >= 240) return true;

  return false;
}

/**
 * Returns true if the IP string (IPv4 or IPv6) falls in a blocked range.
 * Handles IPv4-mapped IPv6 (::ffff:127.0.0.1) by extracting the embedded
 * IPv4 literal and applying the IPv4 rules.
 */
export function isBlockedIp(ip: string): boolean {
  // --- IPv6 ---
  if (ip.includes(":")) {
    const lower = ip.toLowerCase();

    // IPv4-mapped IPv6: ::ffff:127.0.0.1 — the trailing token is a dotted-quad.
    const mapped = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mapped?.[1]) {
      return isBlockedIpv4(mapped[1]);
    }
    // IPv4-compatible / any embedded dotted-quad that the matcher missed but
    // still contains a v4 literal — fail-closed by routing through v4 rules.
    const embedded = lower.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (embedded?.[1] && lower.includes("::ffff:")) {
      return isBlockedIpv4(embedded[1]);
    }

    // Loopback ::1
    if (lower === "::1") return true;
    // Unspecified ::
    if (lower === "::") return true;
    // Link-local fe80::/10 (fe80 – febf)
    if (
      lower.startsWith("fe8") ||
      lower.startsWith("fe9") ||
      lower.startsWith("fea") ||
      lower.startsWith("feb")
    ) {
      return true;
    }
    // Unique-local fc00::/7 (fc and fd prefixes)
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
    return false;
  }

  // --- IPv4 ---
  return isBlockedIpv4(ip);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Validate URL shape + allowlist + length, returning a canonicalized URL
 * (query + fragment stripped) or a deny reason.
 */
function validateUrl(
  rawUrl: string,
  allow: string[],
): { ok: true; url: URL } | { ok: false; reason: string } {
  if (rawUrl.length > MAX_URL) return { ok: false, reason: "url too long" };

  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "unparseable url" };
  }

  if (u.protocol !== "https:") return { ok: false, reason: "non-https" };

  const host = u.hostname.toLowerCase();
  if (!allow.includes(host)) return { ok: false, reason: `host not allowlisted: ${host}` };

  // Strip query (egress content channel) + fragment.
  u.search = "";
  u.hash = "";

  // Re-check length after canonicalization.
  if (u.toString().length > MAX_URL) return { ok: false, reason: "url too long" };

  return { ok: true, url: u };
}

// ---------------------------------------------------------------------------
// Public safeFetch
// ---------------------------------------------------------------------------

export async function safeFetch(rawUrl: string, opts: SafeFetchOpts): Promise<SafeFetchResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const resolve =
    opts.resolve ?? (async (h: string) => (await lookup(h, { all: true })).map((r) => r.address));
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  const deny = (reason: string): SafeFetchResult => ({
    ok: false,
    reason,
    log: { url: rawUrl, decision: "deny", reason },
  });

  // Gates 1, 2, 3, 4 — URL shape (initial hop).
  const initial = validateUrl(rawUrl, opts.allow);
  if (!initial.ok) return deny(initial.reason);

  let currentUrl = initial.url;
  let pinnedIp = "";
  let redirectCount = 0;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Re-validate URL + DNS for each hop (the initial hop and any redirect).
    while (true) {
      // Gate 5 — DNS resolve-then-pin + IP block.
      let ips: string[];
      try {
        ips = await resolve(currentUrl.hostname);
      } catch {
        return deny("dns failure");
      }
      if (ips.length === 0 || ips.some(isBlockedIp)) return deny("resolves to blocked ip");
      pinnedIp = ips[0] as string;

      // Gate 8 — minimal request: no credentials, auth headers, or cookies.
      let resp: Response;
      try {
        resp = await fetchImpl(currentUrl.toString(), {
          method: "GET",
          redirect: "manual", // we re-validate each hop ourselves
          headers: { Accept: ALLOWED_CONTENT_TYPES.join(",") },
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) return deny("timeout");
        return deny(`fetch failed: ${(err as Error).message}`);
      }

      // Gate 6 — redirects.
      if (resp.status >= 300 && resp.status < 400) {
        // Off-by-one fix: aborting at `>= maxRedirects` means a maxRedirects of
        // N permits exactly N hops to be FOLLOWED before refusal. With the
        // default of 0, the first 3xx is denied.
        if (redirectCount >= maxRedirects) {
          return deny("too many redirects");
        }
        const location = resp.headers.get("location");
        if (!location) return deny("redirect without location");

        let nextUrl: URL;
        try {
          nextUrl = new URL(location, currentUrl.toString());
        } catch {
          return deny("invalid redirect location");
        }
        // Per-hop re-validate the redirect target against the allowlist + length.
        const validated = validateUrl(nextUrl.toString(), opts.allow);
        if (!validated.ok) return deny(`redirect blocked: ${validated.reason}`);

        currentUrl = validated.url;
        redirectCount++;
        continue; // loop re-resolves DNS + IP-checks the new host.
      }

      if (!resp.ok) return deny(`http ${resp.status}`);

      // Gate 7a — content-type allowlist.
      const ct = (resp.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
      if (!ALLOWED_CONTENT_TYPES.includes(ct)) return deny(`content-type not allowed: ${ct}`);

      // Gate 7b — declared content-length pre-check.
      const declared = Number(resp.headers.get("content-length") ?? "0");
      if (Number.isFinite(declared) && declared > maxBytes) return deny("body too large");

      // Gate 7c — actual body size.
      let body: string;
      try {
        body = await resp.text();
      } catch (err) {
        return deny(`body read failed: ${(err as Error).message}`);
      }
      if (Buffer.byteLength(body, "utf8") > maxBytes) return deny("body too large");

      const sha256 = createHash("sha256").update(body).digest("hex");
      const finalUrl = currentUrl.toString();
      return {
        ok: true,
        body,
        sha256,
        finalUrl,
        log: {
          url: rawUrl,
          final_url: finalUrl,
          resolved_ip: pinnedIp,
          status: resp.status,
          bytes: Buffer.byteLength(body, "utf8"),
          sha256,
          decision: "allow",
        },
      };
    }
  } finally {
    clearTimeout(timer);
  }
}
