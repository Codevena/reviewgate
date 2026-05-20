/**
 * src/core/brain/enrich.ts
 *
 * Two-stage web-fetch evidence enrichment.
 *
 * For each proposal, any evidence item carrying a `source_url` but not yet a
 * `body_sha256` is a *citation*. `enrichProposal()` fetches the URL through an
 * SSRF gate; on success it rewrites the item to a schema-valid `kind:'web-fetch'`
 * record (adds `body_sha256` + `fetched_at`), persists the body as a
 * content-addressed snapshot under `brainSnapshotsDir`, and appends an egress
 * log entry. On failure the citation is DROPPED (fail-closed).
 *
 * The fetcher opts are injected (fetchImpl, allow, resolve) so that unit tests
 * can drive both the happy path and the denial path without real network or DNS.
 * The real `safeFetch` from ./fetcher.ts uses Bun.dns.lookup and global fetch
 * (not injectable), so enrich.ts implements its own minimal SSRF gate using the
 * shared `isBlockedIp` helper from ./fetcher.ts.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryProposal } from "../../schemas/brain.ts";
import { brainSnapshotsDir } from "../../utils/paths.ts";
import { isBlockedIp } from "./fetcher.ts";

// ---------------------------------------------------------------------------
// Egress log (one entry per citation attempt, written by the caller / curator)
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

// ---------------------------------------------------------------------------
// Opts — all injectable for testability
// ---------------------------------------------------------------------------

export interface EnrichFetchOpts {
  /** Exact-match hostname allowlist. */
  allow: string[];
  /** Injected fetch implementation (defaults to global `fetch`). */
  fetchImpl?: typeof fetch;
  /** Injected DNS resolver — returns IPv4/IPv6 addresses for a hostname. */
  resolve?: (hostname: string) => Promise<string[]>;
  /** Max body size in bytes (default 2 MB). */
  maxBytes?: number;
}

const ALLOWED_CONTENT_TYPES = ["text/html", "text/plain", "application/json"];
const MAX_URL_LENGTH = 512;

// ---------------------------------------------------------------------------
// Internal one-shot fetch with SSRF gate (uses injected fetchImpl + resolve)
// ---------------------------------------------------------------------------

type FetchGateResult =
  | { ok: true; body: string; sha256: string; finalUrl: string; log: EgressLog }
  | { ok: false; reason: string; log: EgressLog };

async function gatedFetch(rawUrl: string, opts: EnrichFetchOpts): Promise<FetchGateResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const resolve =
    opts.resolve ??
    (async (h: string) => {
      const result = await Bun.dns.lookup(h);
      return result.map((r) => r.address);
    });
  const maxBytes = opts.maxBytes ?? 2_000_000;

  const deny = (reason: string): FetchGateResult => ({
    ok: false,
    reason,
    log: { url: rawUrl, decision: "deny", reason },
  });

  // Gate: URL length
  if (rawUrl.length > MAX_URL_LENGTH) return deny("url too long");

  // Gate: parse URL
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return deny("unparseable url");
  }

  // Gate: HTTPS only
  if (u.protocol !== "https:") return deny("non-https");

  // Gate: host allowlist
  if (!opts.allow.includes(u.hostname)) return deny(`host not allowlisted: ${u.hostname}`);

  // Strip query and fragment (no egress via query)
  u.search = "";
  u.hash = "";

  // Gate: DNS + IP blocking
  let ips: string[];
  try {
    ips = await resolve(u.hostname);
  } catch {
    return deny("dns failure");
  }
  if (ips.length === 0 || ips.some(isBlockedIp)) return deny("resolves to blocked ip");
  const pinnedIp = ips[0] as string;

  // Fetch (single hop — redirect treated as deny in M4, same as real safeFetch)
  let resp: Response;
  try {
    resp = await fetchImpl(u.toString(), {
      method: "GET",
      redirect: "manual",
      headers: { Accept: ALLOWED_CONTENT_TYPES.join(",") },
    });
  } catch (err) {
    return deny(`fetch failed: ${(err as Error).message}`);
  }

  if (resp.status >= 300 && resp.status < 400) {
    return deny("redirect not followed (single-hop M4 policy)");
  }
  if (!resp.ok) return deny(`http ${resp.status}`);

  // Gate: content-type
  const ct = (resp.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
  if (!ALLOWED_CONTENT_TYPES.includes(ct)) return deny(`content-type not allowed: ${ct}`);

  // Gate: body size
  let body: string;
  try {
    body = await resp.text();
  } catch (err) {
    return deny(`body read failed: ${(err as Error).message}`);
  }
  if (body.length > maxBytes) return deny("body too large");

  const sha256 = createHash("sha256").update(body).digest("hex");
  return {
    ok: true,
    body,
    sha256,
    finalUrl: u.toString(),
    log: {
      url: rawUrl,
      final_url: u.toString(),
      resolved_ip: pinnedIp,
      status: resp.status,
      bytes: body.length,
      sha256,
      decision: "allow",
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Enrich all citation evidence items in a proposal with fetched content.
 *
 * A *citation* is an evidence item that has a `source_url` but is NOT already
 * `kind:'web-fetch'` and has NO `body_sha256` (i.e. it hasn't been enriched yet).
 *
 * On success the item is rewritten to `kind:'web-fetch'` with `body_sha256` and
 * `fetched_at`, and the body is persisted as a content-addressed snapshot at
 * `brainSnapshotsDir(repoRoot)/<sha256>`.
 *
 * On failure the citation is dropped. The egress log (one entry per citation
 * attempt) is returned for the curator to append to the audit trail.
 */
export async function enrichProposal(
  repoRoot: string,
  proposal: MemoryProposal,
  fetchOpts: EnrichFetchOpts,
): Promise<{ enriched: MemoryProposal; egress: EgressLog[] }> {
  const egress: EgressLog[] = [];
  const evidence: MemoryProposal["evidence"] = [];

  for (const item of proposal.evidence) {
    const isCitation = item.source_url != null && item.kind !== "web-fetch" && !item.body_sha256;
    if (!isCitation) {
      evidence.push(item);
      continue;
    }

    const res = await gatedFetch(item.source_url as string, fetchOpts);
    egress.push(res.log);

    if (!res.ok) {
      // Drop the citation — the Curator falls back to reviewer-quorum rule
      continue;
    }

    // Persist content-addressed snapshot
    const dir = brainSnapshotsDir(repoRoot);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, res.sha256), res.body, { mode: 0o600 });

    // Rewrite to a schema-valid web-fetch evidence item
    evidence.push({
      kind: "web-fetch" as const,
      source_url: res.finalUrl,
      body_sha256: res.sha256,
      fetched_at: new Date().toISOString(),
      ...(item.snippet != null ? { snippet: item.snippet } : {}),
    });
  }

  return { enriched: { ...proposal, evidence }, egress };
}
