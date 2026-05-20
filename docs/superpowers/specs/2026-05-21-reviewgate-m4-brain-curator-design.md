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
   During the Curator phase, Reviewgate fetches each cited URL over a conservative
   **egress allowlist** (HTTPS only, per-run logged), computes `body_sha256`, sets
   `fetched_at`, and writes the deterministic evidence record. A reviewer can
   never forge the hash. This satisfies §5.6 rule 2's "1 deterministic source".
5. **Embeddings via OpenRouter** for rule-4 dedup. Extend the existing OpenRouter
   adapter with an embeddings path (`POST /api/v1/embeddings`, OpenAI-compatible,
   same key/auth). Cosine similarity ≥ 0.85 against existing brain entries =
   duplicate (rejected/merged). Embeddings are used ONLY for dedup, nowhere else.
6. **Lifecycle.** `candidate` (on approval, `referenced_count: 1`) → `active`
   (after 3 references across ≥ 3 distinct reviewers) → `stale` (90 days without
   reference; drops from default prompt injection) → archived to
   `brain/archive.md` (180 more days stale). A cheap decay check runs at the start
   of each Curator phase.
7. **CLI.** `reviewgate brain list`, `reviewgate brain show <id>`,
   `reviewgate brain revoke <id>` (immediate invalidation — §5.6 user veto).
8. **Storage & audit.** `.reviewgate/brain/{brain.md, brain.json, sources.jsonl,
   proposals/}`. `brain.md`/`brain.json`/`sources.jsonl` are committed;
   `proposals/` (and `proposals/curator-decisions/<run_id>.jsonl`) are gitignored.
   Curator decisions are appended to the hash-chained audit log.

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
and returned BEFORE the Curator runs; the Curator's work happens after and only
mutates `.reviewgate/brain/`. A Curator failure must never change a verdict.

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
  the compiled Bun binary and that the allowlist is enforced; decide default
  allowed domains (docs sites) and the per-run egress log format.
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
