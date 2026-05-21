/**
 * src/research/context7.ts
 *
 * fetchLibraryDocs(libs, opts) — for each imported library, resolve it to a
 * Context7 library id (search), fetch its current docs (context), cache them
 * (TTL'd, keyed by libraryId@requested-version), and render a per-lib docs body.
 *
 * Best-effort + non-blocking: ANY failure for a lib (no match, HTTP error,
 * timeout, parse error, empty context) → that lib is SKIPPED with a recorded
 * reason; the function never throws and the other libs continue.
 *
 * Egress goes ONLY through `safeApiFetch` to the single allowlisted `host`
 * (NOT the brain's egressAllowlist). HTTP redirects stay off; Context7's
 * documented `redirectUrl` is followed once at the JSON level (same host).
 *
 * MUST-VERIFY (Task 8, against live Context7 with a real key): the exact
 * search/context response shapes, the version-pin id form (here `<id>@v<ver>`),
 * and the redirectUrl semantics. Adjust the parsing below if reality differs.
 */

import { createHash } from "node:crypto";
import {
  type CachedDocs,
  docsCacheKey,
  getCachedDocs,
  putCachedDocs,
} from "../cache/docs-cache.ts";
import type { ImportedLib } from "./imports.ts";
import { safeApiFetch } from "./safe-api-fetch.ts";

const API_VERSION = "v2";

export interface FetchDocsOpts {
  repoRoot: string;
  host: string;
  /** env var holding the Context7 API key; undefined value → keyless. */
  apiKeyEnv: string;
  timeoutMs: number;
  ttlDays: number;
  perLibBytes: number;
  maxLibs?: number | undefined;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch | undefined;
  resolve?: ((host: string) => Promise<string[]>) | undefined;
}

export type LibOutcomeKind = "fetched" | "cache-hit" | "truncated" | `skipped:${string}`;

export interface LibOutcome {
  name: string;
  outcome: LibOutcomeKind;
  /** rendered docs body for this lib (empty when skipped). */
  text: string;
}

/** Per-lib digest entry that feeds the review behavior-hash (cache invalidation). */
export interface DocsCorpusEntry {
  name: string;
  libraryId: string;
  version: string | null;
  responseHash: string;
}

export interface RenderedContextDocs {
  /** convenience aggregate body (per-lib texts joined); the writer owns final layout. */
  text: string;
  libs: LibOutcome[];
  corpus: DocsCorpusEntry[];
}

interface SearchResponse {
  results?: { id?: string; title?: string }[];
  redirectUrl?: string;
}
interface ContextResponse {
  codeSnippets?: { codeTitle?: string; codeList?: { code?: string }[] }[];
  infoSnippets?: { content?: string }[];
  redirectUrl?: string;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function isEmptyContext(ctx: ContextResponse | null): boolean {
  if (!ctx) return true;
  const code = ctx.codeSnippets?.length ?? 0;
  const info = ctx.infoSnippets?.length ?? 0;
  return code === 0 && info === 0;
}

/** Render a Context7 context response into a plain (unfenced) per-lib docs body. */
function renderContext(ctx: ContextResponse): string {
  const parts: string[] = [];
  for (const s of ctx.infoSnippets ?? []) {
    if (s?.content) parts.push(s.content);
  }
  for (const c of ctx.codeSnippets ?? []) {
    const title = c?.codeTitle ? `// ${c.codeTitle}` : "";
    const code = (c?.codeList ?? [])
      .map((x) => x?.code)
      .filter((x): x is string => Boolean(x))
      .join("\n");
    const block = [title, code].filter(Boolean).join("\n");
    if (block) parts.push(block);
  }
  return parts.join("\n\n");
}

export async function fetchLibraryDocs(
  libs: ImportedLib[],
  opts: FetchDocsOpts,
): Promise<RenderedContextDocs> {
  const apiKey = process.env[opts.apiKeyEnv]; // undefined → keyless (no Bearer)
  const baseUrl = `https://${opts.host}/api/${API_VERSION}`;
  const fetchArgs = {
    allowHost: opts.host,
    apiKey,
    timeoutMs: opts.timeoutMs,
    fetchImpl: opts.fetchImpl,
    resolve: opts.resolve,
  };

  // JSON-level single-hop redirect (HTTP redirects stay off in safeApiFetch).
  const c7fetch = async <T extends { redirectUrl?: string }>(
    url: string,
    query?: Record<string, string>,
  ): Promise<T> => {
    const r = await safeApiFetch<T>(url, { ...fetchArgs, query });
    if (r && typeof r === "object" && typeof r.redirectUrl === "string") {
      return await safeApiFetch<T>(r.redirectUrl, fetchArgs); // same host enforced by safeApiFetch
    }
    return r;
  };

  const selected = opts.maxLibs ? libs.slice(0, opts.maxLibs) : libs;
  const outcomes: LibOutcome[] = [];
  const corpus: DocsCorpusEntry[] = [];

  for (const lib of selected) {
    try {
      // 1) resolve name → libraryId (search)
      const search = await c7fetch<SearchResponse>(`${baseUrl}/libs/search`, {
        libraryName: lib.name,
      });
      const libraryId = search.results?.[0]?.id;
      if (!libraryId) {
        outcomes.push({ name: lib.name, outcome: "skipped:no-match", text: "" });
        continue;
      }

      // 2) cache check — keyed by libraryId + the REQUESTED version (stable across runs).
      const key = docsCacheKey(libraryId, lib.version);
      const cached = await getCachedDocs(opts.repoRoot, key);
      if (cached) {
        outcomes.push({ name: lib.name, outcome: "cache-hit", text: cached.docs });
        corpus.push({
          name: lib.name,
          libraryId,
          version: cached.version,
          responseHash: cached.responseHash,
        });
        continue;
      }

      // 3) context fetch — try the version-pinned id, fall back to unpinned.
      let usedVersion = lib.version;
      const pinnedId = lib.version ? `${libraryId}@v${lib.version}` : libraryId;
      let ctx: ContextResponse | null = null;
      try {
        ctx = await c7fetch<ContextResponse>(`${baseUrl}/context`, {
          libraryId: pinnedId,
          query: lib.name,
          type: "json",
        });
      } catch {
        ctx = null;
      }
      if (isEmptyContext(ctx) && pinnedId !== libraryId) {
        usedVersion = null; // pinned id had no docs → use the unpinned id
        try {
          ctx = await c7fetch<ContextResponse>(`${baseUrl}/context`, {
            libraryId,
            query: lib.name,
            type: "json",
          });
        } catch {
          ctx = null;
        }
      }
      if (isEmptyContext(ctx) || !ctx) {
        outcomes.push({ name: lib.name, outcome: "skipped:no-context", text: "" });
        continue;
      }

      // 4) render + truncate + cache
      const rendered = renderContext(ctx);
      const truncated = rendered.length > opts.perLibBytes;
      const text = truncated ? rendered.slice(0, opts.perLibBytes) : rendered;
      const responseHash = sha256(JSON.stringify(ctx));

      const entry: CachedDocs = {
        name: lib.name,
        libraryId,
        version: usedVersion,
        query: lib.name,
        apiVersion: API_VERSION,
        fetchedAt: Date.now(),
        responseHash,
        docs: text,
      };
      await putCachedDocs(opts.repoRoot, key, entry, opts.ttlDays);

      outcomes.push({ name: lib.name, outcome: truncated ? "truncated" : "fetched", text });
      corpus.push({ name: lib.name, libraryId, version: usedVersion, responseHash });
    } catch (err) {
      const reason = err instanceof Error ? err.message.slice(0, 60) : "error";
      outcomes.push({ name: lib.name, outcome: `skipped:${reason}`, text: "" });
    }
  }

  const text = outcomes
    .map((o) => o.text)
    .filter(Boolean)
    .join("\n\n");
  return { text, libs: outcomes, corpus };
}
