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
 * `isBlockedIp` policy as the brain, content-type allowlist, max-body cap,
 * timeout) but additionally allows reviewgate-constructed query params and an
 * `Authorization: Bearer` header. HTTP redirects stay OFF (`redirect: manual`);
 * Context7's documented `redirectUrl` is followed by the CALLER at the JSON
 * level (re-resolved through the same allowlisted host, max 1 hop).
 */

import { lookup } from "node:dns/promises";
// Reuse the brain's IP-block policy — ONE shared SSRF rule set, not a copy.
import { isBlockedIp } from "../core/brain/fetcher.ts";

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
  /** Injectable for tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch | undefined;
  /** Injectable for tests; defaults to node DNS lookup. */
  resolve?: ((host: string) => Promise<string[]>) | undefined;
}

const DEFAULT_MAX_BYTES = 2_000_000;

export async function safeApiFetch<T = unknown>(url: string, opts: SafeApiFetchOpts): Promise<T> {
  const u = new URL(url);
  if (u.protocol !== "https:") throw new Error(`safeApiFetch: non-HTTPS url ${url}`);
  if (u.hostname.toLowerCase() !== opts.allowHost.toLowerCase()) {
    throw new Error(`safeApiFetch: host ${u.hostname} not allowlisted (${opts.allowHost})`);
  }

  // SSRF: resolve + block private/loopback/link-local IPs (same policy as brain).
  const resolve =
    opts.resolve ?? (async (h: string) => (await lookup(h, { all: true })).map((a) => a.address));
  const ips = await resolve(u.hostname);
  if (ips.length === 0 || ips.some((ip) => isBlockedIp(ip))) {
    throw new Error(`safeApiFetch: ${u.hostname} resolves to a blocked/empty address`);
  }

  // reviewgate-constructed query params (NOT user input → safe to set).
  for (const [k, v] of Object.entries(opts.query ?? {})) u.searchParams.set(k, v);

  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const resp = await fetchImpl(u.toString(), {
      method: "GET",
      redirect: "manual", // HTTP redirects OFF; Context7 redirectUrl handled at JSON level by the caller.
      headers: {
        Accept: "application/json",
        ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
      },
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`safeApiFetch HTTP ${resp.status}`);
    const ct = resp.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) {
      throw new Error(`safeApiFetch: non-JSON content-type ${ct}`);
    }
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
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
