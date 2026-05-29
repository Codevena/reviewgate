/**
 * src/research/safe-api-fetch.ts
 *
 * Hardened first-party API GET for reviewgate-CONSTRUCTED calls (M6 Context7).
 *
 * The brain's `safeFetch` (src/core/brain/fetcher.ts) is for UNTRUSTED,
 * user-supplied evidence URLs: it strips the query string, sends only `Accept`,
 * forbids any auth header, and denies every redirect. That posture makes it
 * unusable for calling a real API that needs query parameters + a Bearer token.
 *
 * `safeApiFetch` keeps the SSRF hardening (HTTPS-only, single exact-match host
 * allowlist, DNS-resolve + private/loopback/link-local IP block via the SAME
 * `isBlockedIp` policy as the brain, then PINS the connection to the validated
 * IP via the brain's `pinnedFetch` so the block is ENFORCED not advisory — the
 * check and the connect share one resolution, closing the DNS-rebinding TOCTOU
 * (F-063), content-type allowlist, max-body cap, timeout) but additionally
 * allows reviewgate-constructed query params and an
 * `Authorization: Bearer` header. HTTP redirects stay OFF (`redirect: manual`);
 * Context7's documented `redirectUrl` is followed by the CALLER at the JSON
 * level (re-resolved through the same allowlisted host, max 1 hop).
 */

import { lookup } from "node:dns/promises";
// Reuse the brain's IP-block policy AND its IP-pinned connector — ONE shared
// SSRF rule set + connect path, not a copy.
import { isBlockedIp, pinnedFetch } from "../core/brain/fetcher.ts";
import { withTimeout } from "../utils/with-timeout.ts";

export interface SafeApiFetchOpts {
  /** Single exact-match host allowlist (the only host egress is permitted to). */
  allowHost: string;
  // `| undefined` on the optional fields so callers can forward a shared opts
  // object that carries explicit-undefined values under exactOptionalPropertyTypes.
  /** reviewgate-constructed query params (NOT user input → safe to set). */
  query?: Record<string, string> | undefined;
  /** Bearer token; omitted → no Authorization header (keyless). */
  apiKey?: string | undefined;
  /** Request timeout in ms. */
  timeoutMs: number;
  /** Max response body size in bytes (default 2 MB). */
  maxBytes?: number | undefined;
  /**
   * Injectable plain-fetch for tests ONLY. When set it BYPASSES IP-pinning and
   * lets the impl control resolution itself — production must NOT set this, or the
   * DNS-rebinding (F-063) guard is defeated. Leave unset to use the pinned path.
   */
  fetchImpl?: typeof fetch | undefined;
  /** Injectable for tests; defaults to node DNS lookup. */
  resolve?: ((host: string) => Promise<string[]>) | undefined;
  /** Injectable for tests; defaults to the brain's IP-pinned `pinnedFetch`. */
  pinnedFetchImpl?: typeof pinnedFetch | undefined;
}

const DEFAULT_MAX_BYTES = 2_000_000;

export async function safeApiFetch<T = unknown>(url: string, opts: SafeApiFetchOpts): Promise<T> {
  const u = new URL(url);
  if (u.protocol !== "https:") throw new Error(`safeApiFetch: non-HTTPS url ${url}`);
  if (u.hostname.toLowerCase() !== opts.allowHost.toLowerCase()) {
    throw new Error(`safeApiFetch: host ${u.hostname} not allowlisted (${opts.allowHost})`);
  }

  // SSRF: resolve + block private/loopback/link-local IPs (same policy as brain).
  // Node's DNS lookup has no built-in timeout, so bound it explicitly — a stalled
  // resolver must NOT hang the (best-effort, pre-cache) docs fetch indefinitely.
  const resolve =
    opts.resolve ?? (async (h: string) => (await lookup(h, { all: true })).map((a) => a.address));
  const ips = await withTimeout(resolve(u.hostname), opts.timeoutMs, "safeApiFetch dns");
  if (ips.length === 0 || ips.some((ip) => isBlockedIp(ip))) {
    throw new Error(`safeApiFetch: ${u.hostname} resolves to a blocked/empty address`);
  }
  // F-063: PIN the connection to the IP we just validated. Otherwise the
  // IP-block check and the actual connect would be two independent DNS
  // resolutions (DNS-rebinding TOCTOU), making the check advisory only. The
  // default path connects through the brain's `pinnedFetch` (node http(s)
  // `lookup` honored on Bun) so the socket goes to `pinnedIp`, not a re-resolve.
  const pinnedIp = ips[0] as string;

  // reviewgate-constructed query params (NOT user input → safe to set).
  for (const [k, v] of Object.entries(opts.query ?? {})) u.searchParams.set(k, v);

  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const pinnedFetchImpl = opts.pinnedFetchImpl ?? pinnedFetch;
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    // Tests may inject a plain `fetchImpl` (it controls resolution itself);
    // production leaves it unset and goes through the IP-pinned connector.
    // `pinnedFetch` doesn't auto-follow redirects, so a 3xx falls through to the
    // `!resp.ok` check below — equivalent to the previous `redirect: "manual"`.
    const resp = opts.fetchImpl
      ? await opts.fetchImpl(u.toString(), {
          method: "GET",
          redirect: "manual", // HTTP redirects OFF; Context7 redirectUrl handled at JSON level by the caller.
          headers,
          signal: controller.signal,
        })
      : await pinnedFetchImpl(u, pinnedIp, {
          headers,
          signal: controller.signal,
          maxBytes,
        });
    if (!resp.ok) throw new Error(`safeApiFetch HTTP ${resp.status}`);
    const ct = resp.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) {
      throw new Error(`safeApiFetch: non-JSON content-type ${ct}`);
    }
    // Hard size limit, mirroring the brain fetcher: REJECT an oversized body, never
    // truncate. Slicing a JSON string would corrupt it into a parse error rather
    // than enforcing a clean cap. Declared content-length is checked first; the
    // actual byte length is re-checked after read (header may be absent/lying).
    const declared = Number(resp.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error(`safeApiFetch: body too large (declared ${declared} > ${maxBytes})`);
    }
    const text = await resp.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new Error(`safeApiFetch: body too large (> ${maxBytes} bytes)`);
    }
    return JSON.parse(text) as T;
  } finally {
    clearTimeout(timer);
  }
}
