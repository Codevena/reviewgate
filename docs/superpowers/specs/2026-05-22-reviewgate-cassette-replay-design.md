# Reviewgate — Cassette Replay (design)

**Date:** 2026-05-22 · **Status:** design (brainstormed + Codex design-reviewed; NEEDS-REVISION items folded in) · **Milestone:** M6/roadmap · **Default:** inert (no behavior unless `REVIEWGATE_CASSETTE` is set or a ReplayAdapter is injected)

## Problem

Reviewgate's downstream pipeline stages — `scopeToDiff` (Phase A), the FP-ledger demote, the critic, and the Brain curator/promotion — depend on what the heterogeneous LLM reviewer panel returns. Verifying those stages **live** is unreliable: real reviewers are non-deterministic, slow (minutes), and cost quota. Session 4's live-e2e confirmed the wall — the panel now (correctly) refuses to flag out-of-diff code, so the FP-ledger/Phase-A-demote/Brain paths cannot be provoked on demand with real reviewers. We need **recorded reviewer interactions** that can be replayed deterministically: as committed test fixtures driving the real pipeline in `bun test`, and as a record-real-then-replay-offline tool for debugging "why did the panel decide X" or for demos.

## Approach (decided)

Record/replay at the **adapter boundary** using the **decorator pattern** (VCR-style). A `RecordingAdapter` wraps a real adapter and appends each interaction to a cassette; a `ReplayAdapter` is bound to one provider id, reads a cassette, and serves recorded results — no CLI, no network. The real adapters stay untouched. Granularity is the **parsed `ReviewResult`** (and the `complete()` string), so replay drives `aggregate → scopeToDiff → fp-ledger → critic → brain` directly (the CLI parser is bypassed; it has its own unit tests).

The covered surface is the **three adapter methods reviewgate consumes**: `review()`, `complete()`, and the OpenRouter adapter's non-interface **`embed()`**. `embed()` MUST be covered because the Brain phase is gated on an embedder (`buildEmbedder` looks for a `function`-typed `embed` on `adapters.openrouter`; with no embedder the curator + FP↔Brain pairing are skipped entirely) — so without recorded embeddings the Brain path is not replayable at all. Context7 (`safeApiFetch`) stays out of scope (separate seam, has `fetchOverrides`).

## Architecture

Decorator pattern at the adapter seam (`src/providers/adapter-base.ts` + the concrete OpenRouter `embed()`). New `src/cassette/` module + a zod schema. A shared `buildAdapters` helper (used by **both** `gate.ts` and `review-plan.ts`) applies the `REVIEWGATE_CASSETTE` env var, reusing the existing `providerOverrides ?? createAdapter(id)` seam. Lives in `src/` (not test-only): record runs through the production gate path, replay is CLI-usable.

### Cassette format — append-only JSONL

A cassette is a **`.jsonl` file**: one JSON `CassetteEntry` per line, **append-only**. This is the fix for concurrent recording — the panel runs reviewers via `Promise.allSettled` (parallel), and every `RecordingAdapter` appends to the same path. A single `appendFileSync(path, line + "\n")` is atomic for a small line on POSIX, so no lock is needed and no entry is lost. Cross-reviewer interleaving in the file is irrelevant because matching is per-key (below). Recording is **single-process** (one gate process records its own panel); concurrent recording from multiple processes to the same cassette is unsupported (no lock — out of scope). The first line MAY be a header object `{ schema: "reviewgate.cassette.v1", recordedAt }`; entries are validated per-line on load (a malformed line → skip + warn, never abort).

### Components (one responsibility each)

- **`src/schemas/cassette.ts` — zod schema (source of truth).**
  `ReviewResultSchema` composed from the existing `FindingSchema` (no parallel enums) — it must cover ALL `ReviewResult` fields the pipeline reads: `reviewerId`, `verdict` (`PASS|FAIL|ERROR`), `findings: FindingSchema[]`, `usage` (`inputTokens`, `outputTokens`, optional `cachedInputTokens`/`reasoningTokens`, `costUsd`, `quotaUsedPct: number|null`), `durationMs`, `exitCode`, `rawEventsPath`, optional `rawText`, `status` (`ReviewStatus`), optional `statusDetail`. `CassetteEntry`:
  ```
  { schema:"reviewgate.cassette.entry.v1",
    provider: ProviderId,   // which adapter produced it — ReplayAdapter filters on THIS, not on parsing the key
    key: string,            // the match key WITHIN that provider (see Matching)
    method: "review" | "complete" | "embed",
    promptSha256: string,   // sha256 of the prompt/text that produced result (drift detection)
    result: ReviewResult | { text: string } | { vector: number[] } }
  ```
  Validated per-line on load. `ReviewResult.rawEventsPath` is `z.string()` (MAY be empty — several adapters return `""`; never required-non-empty).

- **`src/cassette/store.ts` — JSONL load/append + env parsing.**
  `appendEntry(path, entry)` — ensure dir, single atomic `appendFileSync(path, JSON.stringify(entry)+"\n", {mode:0o600})`. `loadCassette(path): CassetteEntry[]` — read, split lines, zod-validate each (skip+warn malformed). `cassetteFromEnv(): { mode:"record"|"replay"; path:string } | null` — parses `REVIEWGATE_CASSETTE` of the form `record:<path>` / `replay:<path>`.

- **`src/cassette/matching.ts` — the key function (shared by record + replay).**
  - `review()` → key = **`reviewerId`** (e.g. `codex-security`, `critic-opencode`). This disambiguates a panel reviewer from the critic even when they share a provider+persona (the critic's `reviewerId` is `critic-<provider>`), fixing the FIFO-collision risk. Matched **FIFO** (the same `reviewerId` is called once per iteration; multi-iteration consumes in order). **Constraint:** reviewer ids must be unique within a config — two reviewer entries with the identical `(provider, persona)` produce the same `reviewerId`, and because panel calls run concurrently their record order (completion) would not match replay order (invocation). Such duplicate entries are a degenerate config and are **unsupported** for cassettes: when a cassette is active (record OR replay), `buildAdapters` does a **hard preflight error** if two configured reviewers resolve to the same `reviewerId` (`<provider>-<persona>`, or the forced doc-review persona collapses two into one), rather than silently mis-ordering under concurrency.
  - `complete()` → key = **`<provider>:complete`** (`complete()` has no persona). Matched **FIFO** in call order (curator judge + contradiction judge share the curator provider).
  - `embed()` → key = **`<provider>:embed:<sha256(text)>`** — **content-addressed** (an embedding is a pure function of its text), so matching is order-independent and robust. A repeated identical text reuses the same recorded vector.

- **`src/cassette/recording-adapter.ts` — `RecordingAdapter`.**
  Wraps a real `ProviderAdapter` + a cassette path. `preflight`/`review`/`complete` delegate to the real adapter and append `{key, method, promptSha256, result}` (review key from `input.reviewerId`; prompt hash from the prompt file / prompt string). **Crucially forwards the non-interface `embed()`**: if the wrapped adapter has a `function`-typed `embed`, the decorator exposes its own `embed(text, opts)` that calls through, records `{method:"embed", key:<provider>:embed:<hash>, result:{vector}}`, and returns the real vector — so recording a real session keeps the Brain working AND captures the vectors. A write failure is best-effort `console.warn` (never breaks the real review).

- **`src/cassette/replay-adapter.ts` — `ReplayAdapter` (implements `ProviderAdapter`).**
  Constructed with the loaded entries **and a bound `provider` id** (`new ReplayAdapter(entries, "openrouter", { strict })`). The orchestrator addresses adapters by provider, so one instance serves one provider; `id` returns the bound id. It filters entries by the explicit **`entry.provider === boundId`** (NOT by parsing the string key — so `critic-codex` is correctly served by the `codex` adapter, disambiguated from `codex-security` by its distinct `key`). Builds FIFO queues for `review`/`complete` keys and a content map for `embed` keys, all scoped to its provider. `preflight` → synthetic `{available:true, version:"replay", authMode:"oauth", error:null}`. `review`/`complete` pop the next entry for their key; `embed` looks up by text hash. On a hit: compare `promptSha256` → `console.warn` on drift (default) or **throw** in `strict` mode (for regression fixtures that must fail when the prompt drifts). On a miss → **throw** `Error("cassette: no recorded <method> for <key>")`. It exposes `embed()` only when its provider has embed entries (so `buildEmbedder`'s `typeof embed === "function"` check behaves like the real openrouter adapter).

- **`src/cli/_build-adapters.ts` (new shared helper) + `gate.ts` / `review-plan.ts` (modify).**
  Extract the adapter-construction both commands already duplicate into `buildAdapters(cfg, providerOverrides)`. **It must build the COMPLETE set of providers the orchestrator consumes — not just reviewers.** Today `gate.ts` builds adapters only for `phases.review.reviewers[].provider` + `phases.critic?.provider`; but `orchestrator.ts` also consumes `adapters[brain.embeddings.provider]` (for `buildEmbedder`'s non-interface `embed()`) and `adapters[brain.curator.provider]` (for the curator + contradiction `complete()` judges). If those providers are not also reviewers/critic, they are never built — so recording would miss them and replay would not provide them, and the Brain path would silently skip. `buildAdapters` therefore constructs the union: **reviewers ∪ critic ∪ `brain.embeddings.provider` ∪ `brain.curator.provider`** (deduped), in both `gate` and `review-plan`. (This also fixes a latent gap where the embeddings/curator adapters only existed by coincidence of being reviewers.) Cassette wiring: **explicit `providerOverrides` always win** (tests/explicit injection beat the env); for any provider in the set NOT overridden, `record` wraps `createAdapter(id)` in `RecordingAdapter`, `replay` uses `ReplayAdapter(entries, id)`. Inert when the env var is unset. (Tests of the orchestrator still inject `ReplayAdapter` directly via `adapters`, bypassing the env entirely.)

### Data flow

```
record:  REVIEWGATE_CASSETTE=record:<p>
  → buildAdapters wraps each non-overridden adapter in RecordingAdapter(real, p)
  → real panel + critic + curator + embeddings run → each review/complete/embed appended (JSONL) to <p>

replay:  REVIEWGATE_CASSETTE=replay:<p>   (or tests inject ReplayAdapter directly via `adapters`)
  → loadCassette(p) → adapters[id] = ReplayAdapter(entries, id)
  → review/complete served FIFO by key, embed by text-hash (no CLI/network)
  → orchestrator pipeline (aggregate→scopeToDiff→fp-ledger→critic→brain incl. curator) runs deterministically
```

### Error handling

- Replay **miss** → throw. For a **panel** reviewer this is swallowed by the orchestrator's `Promise.allSettled` (treated as a failed run → can make `okRuns==0` → verdict `ERROR`, fail-closed) — so the ReplayAdapter ALSO `console.error`s the miss reason before throwing, to keep it diagnosable. For the **critic** and **embed** paths the throw propagates (those calls are not behind `allSettled`). Unit tests of `ReplayAdapter` assert the throw directly; integration tests assert the resulting `ERROR`/skip.
- Prompt **drift** → `console.warn` (default) or throw (`strict` mode).
- Record **write failure** → `console.warn`, the real run proceeds.
- `ReviewResult.rawEventsPath` is an ephemeral tmp path; on replay it is returned as the stored string (consumers tolerate a missing file; audit `response_ref` may dangle — acceptable).

### Redaction / placement / security

Faithful recording, **no auto-redaction** (it would alter replayed content). Record default path under `.reviewgate/cassettes/` (gitignored by `init.ts`); on record, print a prominent one-line warning **including the resolved absolute path** ("contains raw reviewer output + prompts — review before committing"). Hand-authored test fixtures live in `tests/fixtures/cassettes/` (deliberately clean, committed) with hygiene guidance in the plan. **Note:** `init.ts` deliberately UN-ignores `.reviewgate/cassettes/golden/` (a committed-golden-cassette convention), so the **secret guard must scan every committed cassette path** — `tests/fixtures/cassettes/**` AND `.reviewgate/cassettes/golden/**` — for high-entropy tokens (reusing the sanitizer's entropy heuristic) and fail if any are found.

## Testing

- **Unit:** `store` (JSONL append atomic + dir-create; load skips+warns a malformed line; `cassetteFromEnv` parsing incl. malformed→null); `matching` (review→reviewerId, complete→provider:complete, embed→provider:embed:hash); `ReplayAdapter` (FIFO per reviewerId incl. critic vs same-provider reviewer not colliding; complete FIFO; embed content-map; miss→throws; drift→warn, strict→throw; `embed` exposed only when entries exist); `RecordingAdapter` (delegates + appends review/complete/embed, forwards non-interface embed, write-failure→warn not throw).
- **Integration (the payoff — deterministic via a fixture cassette):** **FP-ledger demote** (recorded finding whose signature is `active` → INFO), **Phase-A scopeToDiff** (recorded out-of-diff finding → INFO), **Brain curation/promotion** (recorded `memory_proposals` in two reviewers' `rawText` + recorded `embed()` vectors that cluster + recorded curator `complete()` verdict → a deterministic promotion). Critic demote driven by a recorded critic `review()` entry. **Pre-adapter state MUST be controlled** so a divergence/miss can only come from the cassette: set `cache.enabled:false` (the verdict cache short-circuits before adapters), seed-or-disable the Brain + FP-ledger snapshots the orchestrator reads pre-review, and disable `contextDocs` (or pass `fetchOverrides`) so Context7 doesn't perturb the prompt/behavior-hash. The **Brain fixture also uses `memory_proposals` with reviewer-observation evidence only (NO `source_url`)** so the curator's `enrichProposal()` has nothing to web-fetch (otherwise it hits the network unless `fetchOverrides` is supplied — citation enrichment is NOT in cassette scope). Add a **`buildAdapters` regression test** for a config where the embeddings/curator provider is NOT a reviewer (it must still be built + cassette-wrapped).
- **Round-trip:** a stub "real" adapter (incl. a stub `embed`) → `RecordingAdapter` writes a JSONL cassette → `ReplayAdapter` reads it → the orchestrator produces an identical verdict/findings.
- **Secret guard:** the fixture-scan test above.
- **Compiled-binary smoke:** `REVIEWGATE_CASSETTE` is honored by `dist/reviewgate` (env parsing + JSONL load work in the compiled binary).

## Scope / non-goals

- **In:** the adapter surface reviewgate consumes — `review()`, `complete()`, and the OpenRouter `embed()`; the JSONL cassette schema + store; record/replay adapters; the shared `buildAdapters` helper wired into `gate.ts` AND `review-plan.ts`; fixture-driven deterministic pipeline tests (FP-ledger, Phase-A, Brain, critic); the committed-fixture secret guard.
- **Out (follow-ups):** Context7 `safeApiFetch` recording (separate seam, has `fetchOverrides`); raw-CLI-stdout granularity; auto-redaction; a `phases.cassette` config field; a dedicated `reviewgate cassette` CLI subcommand (env-var activation suffices).

## Decomposition

One implementation plan, bottom-up: (1) `schemas/cassette.ts` (+ `ReviewResultSchema`) → (2) `cassette/matching.ts` → (3) `cassette/store.ts` (JSONL + `cassetteFromEnv`) → (4) `ReplayAdapter` (incl. embed + strict) → (5) `RecordingAdapter` (incl. forwarded embed) → (6) shared `buildAdapters` helper + wire `gate.ts` & `review-plan.ts` → (7) fixture-driven integration tests (FP-ledger / Phase-A / Brain / critic) + round-trip + secret guard → (8) DoD + compiled-binary smoke.
