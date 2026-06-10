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
import http from "node:http";
import https from "node:https";

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

/**
 * F-24: header pinnedFetch uses to carry the upstream's RAW status code on the
 * Response it constructs. The Web `Response` constructor throws a RangeError
 * for any status outside 101 / [200, 599], so out-of-range or missing upstream
 * statuses (CDN 999, a custom 700, a malformed status line) are clamped to 502
 * via `clampResponseStatus` — this header preserves the real value so the
 * downstream `http <status>` deny message stays truthful. pinnedFetch ALWAYS
 * sets it (overwriting any same-named upstream header), so it cannot be
 * spoofed on the pinned path.
 */
export const RAW_STATUS_HEADER = "x-reviewgate-raw-status";

/**
 * Clamp a raw upstream status code to one the Web `Response` constructor
 * accepts (101 or [200, 599]); anything else — including a missing statusCode —
 * maps to 502 Bad Gateway. Returns the raw value as a string for
 * RAW_STATUS_HEADER (missing → "0", matching the old `?? 0` intent). (F-24)
 */
export function clampResponseStatus(raw: number | undefined): { status: number; raw: string } {
  const valid = typeof raw === "number" && (raw === 101 || (raw >= 200 && raw <= 599));
  return { status: valid ? raw : 502, raw: String(raw ?? 0) };
}

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
 * Extract an IPv4 address embedded in an IPv6 literal, in any of the forms an
 * attacker might use to smuggle a private/loopback v4 target past the IPv6
 * checks. Returns a dotted-quad string, or null if no embedded v4 is present.
 *
 * Handles, case-insensitively and tolerant of leading zeros / `::` compression:
 *   - IPv4-mapped, dotted:   ::ffff:127.0.0.1
 *   - IPv4-mapped, hex:      ::ffff:7f00:1   /  0:0:0:0:0:ffff:7f00:0001
 *   - IPv4-compatible (dep.) ::127.0.0.1     /  ::7f00:1
 *
 * The two trailing 16-bit groups (each up to 4 hex digits) decode to the four
 * octets a.b.c.d:  group1 = (a<<8)|b,  group2 = (c<<8)|d.
 */
function extractEmbeddedIpv4(lowerIp: string): string | null {
  // Form 1: trailing dotted-quad literal (mapped or compatible).
  // e.g. ::ffff:127.0.0.1, ::127.0.0.1, 0:0:0:0:0:ffff:127.0.0.1
  const dotted = lowerIp.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted?.[1]) return dotted[1];

  // Normalize the `::` compression so we can read the final groups reliably.
  // Split on "::" (at most one occurrence in a valid address).
  const dblIdx = lowerIp.indexOf("::");
  let groups: string[];
  if (dblIdx >= 0) {
    const head = lowerIp
      .slice(0, dblIdx)
      .split(":")
      .filter((g) => g !== "");
    const tail = lowerIp
      .slice(dblIdx + 2)
      .split(":")
      .filter((g) => g !== "");
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null; // malformed
    groups = [...head, ...Array(missing).fill("0"), ...tail];
  } else {
    groups = lowerIp.split(":");
  }
  if (groups.length !== 8) return null; // not a full 8-group v6 → no hex v4

  // Each group must be ≤ 4 hex digits.
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
  }

  const g0 = Number.parseInt(groups[0] as string, 16);
  const g1 = Number.parseInt(groups[1] as string, 16);
  const g2 = Number.parseInt(groups[2] as string, 16);
  const g3 = Number.parseInt(groups[3] as string, 16);
  const g4 = Number.parseInt(groups[4] as string, 16);
  const g5 = Number.parseInt(groups[5] as string, 16);
  const hi = Number.parseInt(groups[6] as string, 16);
  const lo = Number.parseInt(groups[7] as string, 16);

  // IPv4-mapped: 0:0:0:0:0:ffff:HHHH:HHHH
  const isMapped = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff;
  // IPv4-compatible (deprecated): 0:0:0:0:0:0:HHHH:HHHH (but not :: / ::1).
  const isCompat =
    g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && (hi !== 0 || lo > 1);

  if (isMapped || isCompat) {
    const a = (hi >> 8) & 0xff;
    const b = hi & 0xff;
    const c = (lo >> 8) & 0xff;
    const d = lo & 0xff;
    return `${a}.${b}.${c}.${d}`;
  }
  return null;
}

/**
 * Returns true if the IP string (IPv4 or IPv6) falls in a blocked range.
 * Handles IPv4-mapped/-compatible IPv6 in BOTH dotted (::ffff:127.0.0.1) and
 * pure-hex (::ffff:7f00:1, ::7f00:1) forms by extracting the embedded IPv4
 * literal and applying the IPv4 rules.
 */
export function isBlockedIp(ip: string): boolean {
  // --- IPv6 ---
  if (ip.includes(":")) {
    const lower = ip.toLowerCase();

    // Embedded IPv4 (mapped or compatible, dotted or hex) → IPv4 rules.
    const embedded = extractEmbeddedIpv4(lower);
    if (embedded) return isBlockedIpv4(embedded);

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

  // Strip userinfo — never forward embedded credentials (user:pass@host) to
  // the server. An attacker-controlled source_url must not smuggle auth.
  u.username = "";
  u.password = "";

  // Re-check length after canonicalization.
  if (u.toString().length > MAX_URL) return { ok: false, reason: "url too long" };

  return { ok: true, url: u };
}

// ---------------------------------------------------------------------------
// DNS-rebinding / TOCTOU pin (Gate 5)
// ---------------------------------------------------------------------------

// A custom DNS lookup (node's `lookup` option shape) that ALWAYS resolves to the
// already-checked IP, ignoring the hostname. Wired into node:https/http's request
// `lookup` option — which Bun honors (verified) — so the IP the gate validated is
// the IP the socket actually connects to, closing the window where an
// attacker-controlled host re-resolves to 127.0.0.1/169.254.169.254 between our
// check and the client's own resolution (F-026). The request URL/Host stays the
// hostname, so TLS validates against it (we pin the IP, not the URL/SNI).
//
// NOTE: this MUST go through node:https — Bun 1.3.14's bundled undici Agent
// silently ignores `connect.lookup` and its fetch ignores the `dispatcher`
// option, so a fetch()/undici-based pin is a no-op on this runtime.
export function pinnedLookup(
  ip: string,
): (
  hostname: string,
  options: unknown,
  callback: (err: Error | null, addresses: Array<{ address: string; family: number }>) => void,
) => void {
  const family = ip.includes(":") ? 6 : 4;
  return (_hostname, _options, callback) => {
    callback(null, [{ address: ip, family }]);
  };
}

// Perform a GET via node:https (or node:http) with the connection pinned to
// `pinnedIp` through the honored `lookup` option, returning a standard Response.
// Redirects are NOT auto-followed (node http(s) doesn't) so safeFetch re-validates
// each hop. The body is capped at `maxBytes` mid-stream to avoid buffering an
// oversized response (downstream still denies "body too large").
export function pinnedFetch(
  url: URL,
  pinnedIp: string,
  init: { headers: Record<string, string>; signal: AbortSignal; maxBytes: number },
): Promise<Response> {
  const lib = url.protocol === "http:" ? http : https;
  return new Promise<Response>((resolve, reject) => {
    // Single settle latch for the WHOLE request: the Promise must always settle
    // exactly once. In particular Bun 1.3.14 does NOT emit 'error' on a request
    // whose connection is established but has no response yet when req.destroy()
    // is called (e.g. on abort/timeout) — only 'close' fires. So we reject on
    // 'close'-without-settle too, or safeFetch's await would hang forever
    // (violating its "NEVER throws / always returns" contract).
    let settled = false;
    let responded = false; // true once the response callback fired
    const ok = (r: Response) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      reject(e);
    };
    const toError = (e: unknown) => (e instanceof Error ? e : new Error(String(e)));
    const closedErr = () => new Error(init.signal.aborted ? "aborted" : "connection closed");
    const req = lib.request(
      url,
      { method: "GET", headers: init.headers, lookup: pinnedLookup(pinnedIp) },
      (res) => {
        responded = true;
        const chunks: Buffer[] = [];
        let total = 0;
        const finish = () => {
          // F-24: this runs inside res 'data'/'end' event-handler callbacks — a
          // later event-loop tick, OUTSIDE the promise executor. Any throw here
          // (the Response constructor's RangeError on a non-standard status,
          // Headers rejecting a malformed header, …) would surface as an
          // uncaughtException that bypasses safeFetch's try/catch and crashes
          // the process. Convert EVERY failure to a promise rejection instead.
          try {
            const headers = new Headers();
            for (const [k, v] of Object.entries(res.headers)) {
              if (typeof v === "string") headers.set(k, v);
              else if (Array.isArray(v)) headers.set(k, v.join(", "));
            }
            // `Response` only accepts 101 / [200,599]; clamp anything else to
            // 502 and carry the truthful raw status in RAW_STATUS_HEADER for
            // the downstream `http <status>` deny message. Always set → an
            // upstream sending its own copy of the header cannot spoof it.
            const { status, raw } = clampResponseStatus(res.statusCode);
            headers.set(RAW_STATUS_HEADER, raw);
            ok(new Response(Buffer.concat(chunks), { status, headers }));
          } catch (err) {
            fail(toError(err));
          }
        };
        res.on("data", (c: Buffer) => {
          if (settled) return;
          // Same uncaughtException class as finish(): guard the whole handler.
          try {
            total += c.length;
            chunks.push(c);
            if (total > init.maxBytes) {
              // Past the cap: stop buffering and resolve now with a body just over
              // the limit (destroy() won't emit 'end', so resolve here). Downstream's
              // byte-length check then denies "body too large".
              res.destroy();
              finish();
            }
          } catch (err) {
            fail(toError(err));
          }
        });
        res.on("end", finish);
        res.on("error", fail);
        // Connection torn down mid-body (e.g. abort/timeout after headers but
        // before 'end') — 'end' won't fire, so settle here so we never hang. On a
        // clean response 'end' already ok()'d, so this is a guarded no-op.
        res.on("close", () => fail(closedErr()));
      },
    );
    req.on("error", fail);
    // Backstop for a connection that is established but NEVER produces a response
    // (Bun 1.3.14 emits only 'close', not 'error', when req.destroy() runs on such
    // a socket). Only reject here if no response ever started — otherwise the
    // response-level handlers above own the outcome (req 'close' also fires after a
    // normal response, where it must be a no-op).
    req.on("close", () => {
      if (!responded) fail(closedErr());
    });
    const onAbort = () => {
      // Runs as an 'abort' event listener (later tick) — a throw from destroy()
      // would also escape as uncaughtException; reject instead (F-24 class).
      try {
        req.destroy(new Error("aborted"));
      } catch (err) {
        fail(toError(err));
      }
    };
    if (init.signal.aborted) onAbort();
    else init.signal.addEventListener("abort", onAbort, { once: true });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Public safeFetch
// ---------------------------------------------------------------------------

export async function safeFetch(rawUrl: string, opts: SafeFetchOpts): Promise<SafeFetchResult> {
  const resolve =
    opts.resolve ?? (async (h: string) => (await lookup(h, { all: true })).map((r) => r.address));
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  // Sanitized form of the requested URL for logging — never persist embedded
  // credentials (user:pass@host) into the egress log.
  let logUrl = rawUrl;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
      logUrl = parsed.toString();
    }
  } catch {
    // Unparseable URLs can't carry structured userinfo; log as-is.
  }

  const deny = (reason: string): SafeFetchResult => ({
    ok: false,
    reason,
    log: { url: logUrl, decision: "deny", reason },
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
      // The connection is pinned to the checked IP (`pinnedIp`) so the client
      // cannot independently re-resolve the hostname to a blocked IP between the
      // check above and the socket connect (DNS-rebinding / TOCTOU, F-026). The
      // default path goes through node:https/http whose `lookup` option IS honored
      // on Bun; an injected fetchImpl (tests) controls resolution itself.
      const headers = { Accept: ALLOWED_CONTENT_TYPES.join(",") };
      let resp: Response;
      try {
        resp = opts.fetchImpl
          ? await opts.fetchImpl(currentUrl.toString(), {
              method: "GET",
              redirect: "manual", // we re-validate each hop ourselves
              headers,
              signal: controller.signal,
            })
          : await pinnedFetch(currentUrl, pinnedIp, {
              headers,
              signal: controller.signal,
              maxBytes,
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

      // F-24: pinnedFetch clamps out-of-range upstream statuses to 502 so the
      // Response can be constructed at all; the truthful raw code travels in
      // RAW_STATUS_HEADER (always overwritten by pinnedFetch — not spoofable),
      // so the deny reason reports what the upstream actually sent.
      if (!resp.ok) return deny(`http ${resp.headers.get(RAW_STATUS_HEADER) ?? resp.status}`);

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
          url: logUrl,
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
