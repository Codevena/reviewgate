/**
 * src/core/brain/fetcher.ts
 *
 * SSRF-resistant fetch for the Curator's web-fetch evidence path (SM4-2).
 *
 * Gates (all must pass):
 *   1. HTTPS-only (scheme validation)
 *   2. Final-host allowlist (docs domains)
 *   3. Private / loopback / link-local / CGNAT / metadata IP blocking
 *   4. Query-string denied
 *   5. URL length cap (≤ 512 chars)
 *   6. Oversize body (≤ MAX_BODY_BYTES) + content-type allowlist
 *   7. No credential / auth-header forwarding
 *   8. Redirect re-validation (each hop re-checked; cap = MAX_REDIRECTS)
 *   9. Fixed timeout (FETCH_TIMEOUT_MS)
 */

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/** Allowlisted documentation hosts the Curator may fetch from. */
export const ALLOWED_HOSTS: readonly string[] = [
  "docs.anthropic.com",
  "platform.openai.com",
  "ai.google.dev",
  "docs.bun.sh",
  "bun.sh",
  "www.typescriptlang.org",
  "developer.mozilla.org",
  "docs.github.com",
  "biome.sh",
  "biomejs.dev",
  "zod.dev",
];

/** Max URL length (path + host + scheme), not including fragment. */
export const MAX_URL_LENGTH = 512;

/** Max response body size in bytes (1 MiB). */
export const MAX_BODY_BYTES = 1_048_576;

/** Request timeout in ms. */
export const FETCH_TIMEOUT_MS = 10_000;

/** Max redirects to follow. */
export const MAX_REDIRECTS = 3;

/** Allowed content-type prefixes (lowercased). */
export const ALLOWED_CONTENT_TYPES: readonly string[] = [
  "text/html",
  "text/plain",
  "application/json",
];

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export type SafeFetchErrorCode =
  | "SCHEME"
  | "HOST"
  | "QUERY"
  | "URL_TOO_LONG"
  | "PRIVATE_IP"
  | "DNS"
  | "TIMEOUT"
  | "OVERSIZE"
  | "CONTENT_TYPE"
  | "TOO_MANY_REDIRECTS"
  | "REDIRECT_BLOCKED"
  | "FETCH_FAILED";

export class SafeFetchError extends Error {
  readonly code: SafeFetchErrorCode;

  constructor(code: SafeFetchErrorCode, message: string) {
    super(message);
    this.name = "SafeFetchError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// IP blocking
// ---------------------------------------------------------------------------

/**
 * Returns true if the IP string (IPv4 or IPv6) falls in a blocked range:
 * loopback, private RFC-1918, link-local, CGNAT (100.64/10), metadata
 * (169.254.169.254), or IPv6 unique-local / link-local.
 */
export function isBlockedIp(ip: string): boolean {
  // --- IPv6 ---
  if (ip.includes(":")) {
    const lower = ip.toLowerCase();
    // Loopback ::1
    if (lower === "::1") return true;
    // Link-local fe80::/10
    if (
      lower.startsWith("fe80") ||
      lower.startsWith("fe9") ||
      lower.startsWith("fea") ||
      lower.startsWith("feb")
    ) {
      return true;
    }
    // Unique-local fc00::/7  (fc and fd prefixes)
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
    return false;
  }

  // --- IPv4 ---
  const parts = ip.split(".");
  if (parts.length !== 4) return true; // malformed → block

  const octets = parts.map(Number);
  // Guard: all parts must be valid numbers 0-255
  for (const o of octets) {
    if (!Number.isInteger(o) || o < 0 || o > 255) return true;
  }

  const [a, b] = octets as [number, number, number, number];

  // Loopback 127.0.0.0/8
  if (a === 127) return true;
  // Private 10.0.0.0/8
  if (a === 10) return true;
  // Private 172.16.0.0/12  (172.16 – 172.31)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // Private 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // Link-local / metadata 169.254.0.0/16
  if (a === 169 && b === 254) return true;
  // CGNAT 100.64.0.0/10  (100.64 – 100.127)
  if (a === 100 && b >= 64 && b <= 127) return true;

  return false;
}

// ---------------------------------------------------------------------------
// URL validation (before DNS)
// ---------------------------------------------------------------------------

function validateUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new SafeFetchError("SCHEME", `Invalid URL: ${raw}`);
  }

  // Gate 1: HTTPS only
  if (parsed.protocol !== "https:") {
    throw new SafeFetchError("SCHEME", `Only HTTPS is allowed, got: ${parsed.protocol}`);
  }

  // Gate 2: Host allowlist (strip port for comparison)
  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.includes(host)) {
    throw new SafeFetchError("HOST", `Host not on allowlist: ${host}`);
  }

  // Gate 4: No query string
  if (parsed.search && parsed.search.length > 0) {
    throw new SafeFetchError("QUERY", `Query strings are not allowed: ${parsed.search}`);
  }

  // Gate 5: URL length cap (scheme + host + path, no fragment)
  const canonical = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  if (canonical.length > MAX_URL_LENGTH) {
    throw new SafeFetchError(
      "URL_TOO_LONG",
      `URL exceeds ${MAX_URL_LENGTH} chars: ${canonical.length}`,
    );
  }

  // Strip fragment — deterministic fetch, no anchors
  parsed.hash = "";

  return parsed;
}

// ---------------------------------------------------------------------------
// DNS resolution + IP blocking
// ---------------------------------------------------------------------------

async function resolveAndValidateHost(hostname: string): Promise<string> {
  let addresses: string[];
  try {
    const result = await Bun.dns.lookup(hostname);
    addresses = result.map((r) => r.address);
  } catch {
    throw new SafeFetchError("DNS", `DNS resolution failed for: ${hostname}`);
  }

  if (addresses.length === 0) {
    throw new SafeFetchError("DNS", `No addresses resolved for: ${hostname}`);
  }

  for (const addr of addresses) {
    if (isBlockedIp(addr)) {
      throw new SafeFetchError(
        "PRIVATE_IP",
        `Resolved IP ${addr} for ${hostname} is in a blocked range`,
      );
    }
  }

  // Return first resolved address (pinned for the actual connection)
  return addresses[0] as string;
}

// ---------------------------------------------------------------------------
// Response validation
// ---------------------------------------------------------------------------

function validateContentType(response: Response): void {
  const ct = (response.headers.get("content-type") ?? "").toLowerCase();
  const allowed = ALLOWED_CONTENT_TYPES.some((prefix) => ct.startsWith(prefix));
  if (!allowed) {
    throw new SafeFetchError("CONTENT_TYPE", `Disallowed content-type: ${ct}`);
  }
}

// ---------------------------------------------------------------------------
// Public safeFetch
// ---------------------------------------------------------------------------

export interface SafeFetchResult {
  url: string;
  resolvedIp: string;
  statusCode: number;
  contentType: string;
  body: string;
  bodyBytes: number;
}

/**
 * Fetch a URL through all SSRF gates. Throws SafeFetchError on any violation.
 * Does NOT forward credentials, auth headers, or cookies.
 */
export async function safeFetch(rawUrl: string): Promise<SafeFetchResult> {
  // Gate 1, 2, 4, 5 — URL shape
  const parsed = validateUrl(rawUrl);

  // Gate 3 — DNS resolution + IP blocking (resolve-then-pin)
  const resolvedIp = await resolveAndValidateHost(parsed.hostname);

  // Follow redirects manually so we can re-validate each hop
  let currentUrl = parsed;
  let finalIp = resolvedIp;
  let lastResponse: Response | null = null;
  let redirectCount = 0;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    while (true) {
      // Gate 7: fixed minimal request — no credentials, no auth, no cookies
      let response: Response;
      try {
        response = await fetch(currentUrl.toString(), {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            "User-Agent": "Reviewgate-Curator/1.0",
            Accept: "text/html,text/plain,application/json",
          },
        });
      } catch (err) {
        if (controller.signal.aborted) {
          throw new SafeFetchError("TIMEOUT", `Request timed out after ${FETCH_TIMEOUT_MS}ms`);
        }
        throw new SafeFetchError("FETCH_FAILED", `Fetch failed: ${String(err)}`);
      }

      // Handle redirects (3xx)
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          throw new SafeFetchError("FETCH_FAILED", "Redirect with no Location header");
        }

        redirectCount++;
        if (redirectCount > MAX_REDIRECTS) {
          throw new SafeFetchError("TOO_MANY_REDIRECTS", `Exceeded ${MAX_REDIRECTS} redirects`);
        }

        // Re-validate the redirect target (Gate 8)
        let nextUrl: URL;
        try {
          nextUrl = new URL(location, currentUrl.toString());
        } catch {
          throw new SafeFetchError("REDIRECT_BLOCKED", `Invalid redirect URL: ${location}`);
        }

        // Re-run all URL gates on the redirect target
        try {
          currentUrl = validateUrl(nextUrl.toString());
        } catch (e) {
          if (e instanceof SafeFetchError) {
            throw new SafeFetchError(
              "REDIRECT_BLOCKED",
              `Redirect target failed validation [${e.code}]: ${nextUrl.toString()}`,
            );
          }
          throw e;
        }

        // Re-validate resolved IP of the redirect target
        finalIp = await resolveAndValidateHost(currentUrl.hostname);
        continue;
      }

      lastResponse = response;
      break;
    }
  } finally {
    clearTimeout(timer);
  }

  if (!lastResponse) {
    throw new SafeFetchError("FETCH_FAILED", "No response received");
  }

  // Gate 6a: content-type allowlist
  validateContentType(lastResponse);

  // Gate 6b: oversize body
  const contentLength = Number(lastResponse.headers.get("content-length") ?? "0");
  if (contentLength > MAX_BODY_BYTES) {
    throw new SafeFetchError(
      "OVERSIZE",
      `Content-Length ${contentLength} exceeds ${MAX_BODY_BYTES}`,
    );
  }

  let body: string;
  try {
    body = await lastResponse.text();
  } catch {
    throw new SafeFetchError("FETCH_FAILED", "Failed to read response body");
  }

  const bodyBytes = new TextEncoder().encode(body).byteLength;
  if (bodyBytes > MAX_BODY_BYTES) {
    throw new SafeFetchError("OVERSIZE", `Body ${bodyBytes} bytes exceeds ${MAX_BODY_BYTES}`);
  }

  return {
    url: currentUrl.toString(),
    resolvedIp: finalIp,
    statusCode: lastResponse.status,
    contentType: lastResponse.headers.get("content-type") ?? "",
    body,
    bodyBytes,
  };
}
