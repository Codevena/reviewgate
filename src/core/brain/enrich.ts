/**
 * src/core/brain/enrich.ts
 *
 * Two-stage web-fetch evidence enrichment.
 *
 * For each proposal, any evidence item carrying a `source_url` but not yet a
 * `body_sha256` is a *citation*. `enrichProposal()` fetches the URL through the
 * shared SSRF-resistant `safeFetch` from ./fetcher.ts; on success it rewrites
 * the item to a schema-valid `kind:'web-fetch'` record (adds `body_sha256` +
 * `fetched_at`), persists the body as a content-addressed snapshot under
 * `brainSnapshotsDir`, and appends an egress log entry. On failure the citation
 * is DROPPED (fail-closed).
 *
 * The fetcher opts (allow, fetchImpl, resolve, …) are injected and passed
 * straight through to `safeFetch`, so unit tests can drive both the happy path
 * and the denial path without real network or DNS.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryProposal } from "../../schemas/brain.ts";
import { brainSnapshotsDir } from "../../utils/paths.ts";
import { type EgressLog, type SafeFetchOpts, safeFetch } from "./fetcher.ts";

// Re-export so existing importers of EgressLog from enrich keep working.
export type { EgressLog, SafeFetchOpts } from "./fetcher.ts";

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
  fetchOpts: SafeFetchOpts,
): Promise<{ enriched: MemoryProposal; egress: EgressLog[] }> {
  const egress: EgressLog[] = [];
  const evidence: MemoryProposal["evidence"] = [];

  for (const item of proposal.evidence) {
    const isCitation = item.source_url != null && item.kind !== "web-fetch" && !item.body_sha256;
    if (!isCitation) {
      evidence.push(item);
      continue;
    }

    const res = await safeFetch(item.source_url as string, fetchOpts);
    egress.push(res.log);

    if (!res.ok) {
      // Drop the citation — the Curator falls back to reviewer-quorum rule.
      continue;
    }

    // Persist content-addressed snapshot.
    const dir = brainSnapshotsDir(repoRoot);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, res.sha256), res.body, { mode: 0o600 });

    // Rewrite to a schema-valid web-fetch evidence item.
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
