# Reviewgate M4 — Brain + Curator: Scope & Design Decisions

**Date:** 2026-05-21
**Status:** Brainstorm complete, approved — ready for writing-plans
**Semantic source of truth:** `docs/superpowers/specs/2026-05-20-reviewgate-design.md` §5.6
(Brain & Curator) + the `MemoryProposal` schema at §5 (lines ~886–909). This doc
does NOT restate §5.6; it captures the M4 milestone boundary, the decisions made
during brainstorming, and how §5.6 maps onto the existing M1–M3 code.

Prior milestones (all shipped): M1 single-reviewer loop, M2 multi-reviewer panel,
M3 adaptive triage + research. M4 = Brain + Curator. M5 = FP-Ledger. M6 = cassette
replay / weekly reports / full `reviewgate stats` + native sandbox.

---

## 1. Goal

Give Reviewgate a committed, self-curating per-repo memory ("brain"). Reviewers
read relevant brain entries before reviewing (read path) and may propose new
entries (write path); a non-blocking Curator phase validates proposals against
seven hard rules before any of them enter `brain.md`. The brain calibrates future
reviews and reduces repeated findings/false-positives over time.

## 2. Scope

### In M4

1. **Read path — BrainEngine injection.** Before each reviewer runs, BrainEngine
   selects up to `maxPromptTokens` (default 1500) of relevant brain content and
   prepends it to the reviewer prompt. Selection is by **triage tags + file globs
   + category match** (NOT embeddings — §5.6). Priority order: conventions >
   anti-patterns > external-knowledge > research-cache > disagreement. Each entry
   annotated `[Source: …]`. Reviewers may contradict via the existing
   `contradicts_memory` field on findings (already in `src/schemas/finding.ts`).
2. **Write path — `memory_proposals[]`.** New optional array on the reviewer
   output. Extend the finding/review-output schema (`src/schemas/`) and the
   tolerant parser (`src/providers/review-output.ts`) to read it. Confidence floor
   0.5 — lower-confidence proposals are not submitted at all.

   **Two-stage evidence (resolves the schema requirement for `web-fetch`).** The
   approved §5 `MemoryProposal` schema requires `body_sha256` + `fetched_at` for
   `kind:'web-fetch'`, which a reviewer (no web tools) cannot produce. So a
   reviewer-submitted proposal carries URL citations in a lightweight form
   (`source_url` + optional `snippet`), NOT a strict `web-fetch` item. During the
   Curator phase Reviewgate **enriches** each citation into a schema-conformant
   `kind:'web-fetch'` evidence record by adding `body_sha256` + `fetched_at` from
   its own hardened fetch (§2.4). §5.6 **rule 1 (schema validation) is applied to
   the ENRICHED proposal**, so the approved schema is honored, not weakened. If
   enrichment fails (fetch blocked/failed), that evidence item is dropped and the
   proposal falls back to the LLM-citation quorum (or is rejected).
3. **Curator phase (P4).** Modeled on the existing Critic phase
   (`src/core/orchestrator.ts:215`), but runs AFTER the verdict is computed and is
   **non-blocking** (never affects the gate decision or the loop). Uses its own
   configured provider/model that is NOT one of the active reviewers. Validates
   each proposal against the seven §5.6 rules: (1) schema-conform, (2) source
   quorum, (3) consistency with brain.md, (4) embedding dedup (cosine 0.85),
   (5) scope plausibility, (6) diff-derived proposals require doubled quorum +
   `provenance: diff-derived` tag, (7) max 3 promotions per run (excess queued).
4. **Web-fetch evidence (Reviewgate-owned).** Reviewers have web tools disabled
   (spec line 557), so they only cite `source_url` in `web-fetch` evidence items.
   During the Curator phase, Reviewgate fetches each cited URL, computes
   `body_sha256`, sets `fetched_at`, and writes the deterministic evidence record.
   A reviewer can never forge the hash. This satisfies §5.6 rule 2's "1
   deterministic source". **Because `source_url` is attacker-controllable (esp.
   from diff-derived proposals), the fetcher is a hardened SSRF-resistant gate, not
   a plain `fetch`:**
   - HTTPS only; scheme + host validated against a **final-host allowlist** (docs
     domains) AFTER URL canonicalization.
   - Resolve DNS, then **block private / loopback / link-local / CGNAT / unique-
     local / metadata (169.254.169.254) addresses**; pin the resolved IP for the
     actual connection to resist **DNS rebinding** (resolve-then-connect to the
     same IP).
   - Redirects followed only up to a small cap, and **each hop is re-validated**
     against the allowlist + IP rules; a redirect to a non-allowlisted/private
     host aborts the fetch.
   - **No credential or auth-header forwarding**; a fixed minimal request (no
     cookies, no Authorization), bounded **timeout**, **max body size**, and an
     allowed **content-type** set (text/HTML/JSON). Oversize/disallowed responses
     are rejected, not truncated-then-trusted.
   - **URL-shape policy (closes the egress *content* channel, master spec R10):**
     query strings are stripped/denied by default and the URL + path are
     length-capped, so attacker-controlled path/query bytes cannot smuggle diff/
     repo data out to an allowlisted host. Only plain doc-page path shapes are
     fetched.
   - **Reproducible evidence:** the fetched body is persisted as a content-
     addressed snapshot (keyed by `body_sha256`) under the brain store; the
     evidence record points at that snapshot. This keeps the evidence verifiable
     even if the live page later changes (§5.6 rule 2 "reproducible content").
   - Every fetch (URL, final host, resolved IP, status, bytes, sha256, allow/deny
     decision) is appended to a **per-run egress log** in the audit trail.
   - A `source_url` that fails any check yields **no** web-fetch evidence (the
     proposal then falls back to the LLM-citation quorum or is rejected).
5. **Embeddings via OpenRouter** for rule-4 dedup. Extend the existing OpenRouter
   adapter with an embeddings path (`POST /api/v1/embeddings`, OpenAI-compatible,
   same key/auth). Cosine similarity ≥ 0.85 against existing brain entries =
   duplicate (rejected/merged). Embeddings are used ONLY for dedup, nowhere else.
   **Fail-closed:** if the embeddings call errors or returns an invalid/empty
   vector, rule 4 cannot be verified, so the Curator does NOT promote the
   proposal — it is queued to the next run (never admitted as "not a duplicate").
6. **Lifecycle.** `candidate` (on approval, `referenced_count: 1`) → `active`
   (after 3 references across ≥ 3 distinct reviewers) → `stale` (90 days without
   reference; drops from default prompt injection) → archived to
   `brain/archive.md` (180 more days stale). A cheap decay check runs at the start
   of each Curator phase.

   > **Per-run brain snapshot (consistency with the M3 cache).** BrainEngine pins
   > an immutable snapshot of the active brain at the START of a run. That single
   > snapshot feeds BOTH the injected reviewer content AND the M3 cache key's
   > brain-active hash. The Curator (P4) runs after the verdict and its mutations
   > are visible only to SUBSEQUENT runs — so within one run, cache-key
   > computation, prompt assembly, and audit all observe the same brain state, and
   > async curation can never make cache reuse or the audit nondeterministic.
7. **CLI.** `reviewgate brain list`, `reviewgate brain show <id>`,
   `reviewgate brain revoke <id>` (immediate invalidation — §5.6 user veto).
8. **Storage & audit.** `.reviewgate/brain/{brain.md, brain.json, sources.jsonl,
   proposals/}`. `brain.md`/`brain.json`/`sources.jsonl` are committed;
   `proposals/` (and `proposals/curator-decisions/<run_id>.jsonl`) are gitignored.
   Curator decisions are appended to the hash-chained audit log. **All brain
   mutations are atomic + locked:** the Curator acquires the same per-repo lock as
   `StateStore` and writes `brain.md` / `brain.json` / `sources.jsonl` / archive
   via temp-write-then-rename in one guarded update, so a concurrent or next run
   never reads a torn brain and a Curator crash leaves the committed brain files
   untouched.

### Out of M4 (deferred)

- **Persona-bias detector (live surfacing).** M4 RECORDS per-proposal acceptance
  data (in `curator-decisions/<run_id>.jsonl` + `brain.json`) so the detector can
  be computed later, but the "flag in `reviewgate stats`" UX depends on
  `reviewgate stats`, which is **M6**. No live alerting in M4.
- **FP-Ledger learning loop** → **M5** (incl. the §5.7 "FP-Ledger entry promoted
  to active → invoke Curator" interaction).
- **Aggressive cross-run research-cache reuse.** The `research-cache` entry type
  and web-fetch records exist in M4, but treating them as a persistent web-fetch
  cache to skip future fetches is a later optimization.
- **Native sandbox isolation** remains blocked on `@anthropic-ai/sandbox-runtime`
  v1 (M1/M2 fail-closed + `sandbox.mode:"off"` default unchanged). The egress
  allowlist for Curator web-fetch is enforced in Reviewgate's own fetch code, not
  via the (still-unavailable) sandbox.

## 3. Architecture mapping onto M1–M3

| §5.6 concept | M4 implementation surface |
|---|---|
| BrainEngine (read) | New `src/core/brain/` engine; called in the orchestrator review-prompt assembly path (where research.md is currently prepended) |
| `memory_proposals[]` (write) | Extend `src/schemas/finding.ts` (or a sibling schema) + `src/providers/review-output.ts` parser + `REVIEW_PROMPT_PREAMBLE` so schema-less reviewers know the shape |
| Curator (P4) | New phase after the verdict in `src/core/orchestrator.ts`, mirroring the optional Critic phase wiring; new `phases.curator` + `brain` config blocks in `src/config/define-config.ts` + defaults |
| Web-fetch evidence | New Reviewgate-owned fetch util with egress allowlist; invoked from the Curator phase |
| Embeddings dedup | New embeddings method on `src/providers/openrouter.ts` |
| Lifecycle + storage | New `src/core/brain/store.ts` (brain.md/json/sources.jsonl + proposals/); decay check; SessionStart/gitignore handling |
| CLI | New `reviewgate brain` subcommands in `src/cli/` |

The Curator being non-blocking means the gate decision (LoopDriver) is computed
BEFORE the Curator runs; the Curator's work only mutates `.reviewgate/brain/` and
can never change a verdict, never corrupt the committed brain files (per §2.8 —
locked, atomic temp-write-then-rename, single guarded update per run).

**Execution model (M4): synchronous-after-verdict, in-process, hard-timeout-bounded,
best-effort.** The gate process computes the decision FIRST, then runs the Curator
synchronously within the same process before exiting. This keeps recording
deterministic — the brain lock is held in-process, so there is no orphaned/killed
background job and no torn write (resolves the "post-return curator may be skipped"
race). To honor §5.6's "does not block Claude Code's loop", P4 is **strictly
bounded by `phases.curator.timeoutMs`** and is **best-effort**: verdict delivery is
detached from curator success — the already-computed decision is emitted regardless
of curator outcome. If the curator (or its provider/web-fetch) hangs, errors, or
exceeds the timeout, the gate **abandons it, queues the proposals to the next run,
and emits the decision** — so turn-end latency is bounded by
`verdict-compute + curator.timeoutMs` and never depends on curator success. The
curator only runs at all when reviewers actually emitted proposals (often none).
It adds NO review iterations and never affects the gate decision. A detached/durable
background executor (zero added turn-end latency) is a deferred optimization, not M4.

## 4. Decisions locked during brainstorming

- **Source quorum:** full §5.6 rule 2, INCLUDING the deterministic web-fetch path
  (not just the LLM-citation path).
- **Web-fetch owner:** Reviewgate (Curator phase), over an egress allowlist —
  reviewers only cite `source_url`.
- **Dedup:** real embeddings via OpenRouter (`/api/v1/embeddings`), cosine 0.85.
- **Curator model:** configurable like the Critic phase; default a provider that
  is not an active reviewer.
- **Persona-bias + FP-Ledger:** out of M4 (record data now; surface in M6 / build
  ledger in M5).

## 5. Open items for the plan (spikes)

- **SM4-1 (embedding model choice):** pick a small/cheap OpenRouter embedding
  model; verify `/api/v1/embeddings` works with the project's key and returns
  stable vectors; confirm cosine 0.85 is a sane threshold on a few real
  near-duplicate convention strings.
- **SM4-2 (egress allowlist + binary):** confirm the Curator web-fetch works from
  the compiled Bun binary. **Acceptance gates (must all hold before M4 ships the
  web-fetch path):** final-host allowlist after canonicalization; private/
  loopback/link-local/CGNAT/metadata IP blocking; resolve-then-pin (DNS-rebinding
  resistance); per-hop redirect re-validation with a small cap; no credential/
  header forwarding; timeout + max-body-size + content-type allowlist; per-run
  egress log. Decide default allowed domains (docs sites) and the log format.
- **SM4-3 (curator default provider):** confirm a non-reviewer OAuth provider can
  run the Curator without colliding with the host session; pick the default.

## 6. Testing approach

- Unit: BrainEngine selection (tag/glob/category priority + token budget), the
  seven curator rules (each rule's pass/reject, esp. quorum across ≥2 providers,
  diff-derived doubled quorum, rate-limit-3, dedup-0.85), lifecycle transitions,
  web-fetch evidence record creation + sha256, embeddings client (mocked).
- Integration: full P0→P4 run where a proposal is approved and injected into the
  next run's reviewer prompt; a colluding-single-provider proposal is rejected; a
  diff-derived proposal needs doubled quorum.
- Real e2e (gated by `REVIEWGATE_E2E=1`): real OpenRouter embeddings call; a real
  web-fetch + hash; the Curator running on a real provider — per the project's
  "real verification" rule.
