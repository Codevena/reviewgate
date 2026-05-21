// tests/e2e/brain-fetch-real.test.ts
//
// Gated real end-to-end test for safeFetch (SSRF-resistant web fetcher).
// Only runs when REVIEWGATE_E2E=1 — skipped otherwise.
import { describe, expect, it } from "bun:test";
import { safeFetch } from "../../src/core/brain/fetcher.ts";

const E2E = process.env.REVIEWGATE_E2E === "1";
const E2E_TIMEOUT_MS = 30_000;

// Stable public URL on the allowlist — returns a predictable HTML page.
const PUBLIC_URL = "https://example.com/";
const PUBLIC_HOST = "example.com";

(E2E ? describe : describe.skip)("e2e: brain safeFetch", () => {
  it(
    "fetches a public allowlisted URL and returns a 64-char sha256",
    async () => {
      const result = await safeFetch(PUBLIC_URL, {
        allow: [PUBLIC_HOST],
        timeoutMs: 10_000,
      });

      console.info(`[brain-fetch-real] ok=${result.ok}`);
      if (result.ok) {
        console.info(`[brain-fetch-real] sha256=${result.sha256}`);
        console.info(`[brain-fetch-real] finalUrl=${result.finalUrl}`);
        console.info(`[brain-fetch-real] bytes=${result.log.bytes}`);
      } else {
        console.info(`[brain-fetch-real] reason=${result.reason}`);
      }

      expect(result.ok).toBe(true);
      if (result.ok) {
        // sha256 hex digest is always exactly 64 hex characters
        expect(result.sha256).toHaveLength(64);
        expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(result.finalUrl).toContain(PUBLIC_HOST);
      }
    },
    E2E_TIMEOUT_MS,
  );

  it(
    "denies a private-IP URL before making any network request",
    async () => {
      // 192.168.1.1 is in the private 192.168/16 block — the DNS-then-pin gate
      // will block any IP resolving to a private range. But the host allowlist
      // gate (Gate 2) fires FIRST since the host is not on the allowlist at all,
      // so no real network call is ever made.
      const result = await safeFetch("https://192.168.1.1/", {
        allow: [PUBLIC_HOST], // 192.168.1.1 NOT in the allowlist
        timeoutMs: 5_000,
      });

      console.info(
        `[brain-fetch-real] private-IP deny: ok=${result.ok}, reason=${!result.ok ? result.reason : "n/a"}`,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // Gate 2 fires: host not allowlisted
        expect(result.reason).toMatch(/allowlist|blocked|non-https|http/i);
      }
    },
    E2E_TIMEOUT_MS,
  );

  it(
    "denies a non-allowlisted public URL",
    async () => {
      const result = await safeFetch("https://httpbin.org/get", {
        allow: [PUBLIC_HOST], // httpbin.org NOT in allow list
        timeoutMs: 5_000,
      });

      console.info(
        `[brain-fetch-real] non-allowlisted deny: ok=${result.ok}, reason=${!result.ok ? result.reason : "n/a"}`,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/allowlist/i);
      }
    },
    E2E_TIMEOUT_MS,
  );
});
