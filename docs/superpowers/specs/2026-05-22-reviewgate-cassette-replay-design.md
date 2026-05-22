# Reviewgate — Cassette Replay (design)

**Date:** 2026-05-22 · **Status:** design (brainstormed, approved) · **Milestone:** M6/roadmap · **Default:** inert (no behavior unless `REVIEWGATE_CASSETTE` set or a ReplayAdapter is injected)

## Problem

Reviewgate's downstream pipeline stages — `scopeToDiff` (Phase A), the FP-ledger demote, the critic, and the Brain curator/promotion — depend on what the heterogeneous LLM reviewer panel returns. Verifying those stages **live** is unreliable: real reviewers are non-deterministic, slow (minutes), and cost quota. Session 4's live-e2e confirmed the wall — the panel now (correctly) refuses to flag out-of-diff code, so the FP-ledger/Phase-A-demote/Brain paths cannot be provoked on demand with real reviewers. We need **recorded reviewer interactions** that can be replayed deterministically: as committed test fixtures driving the real pipeline in `bun test`, and as a record-real-then-replay-offline tool for debugging "why did the panel decide X" or for demos.

## Approach (decided)

Record/replay at the **`ProviderAdapter` boundary** using the **decorator pattern** (VCR-style). A `RecordingAdapter` wraps a real adapter and appends each `review()`/`complete()` interaction to a cassette file; a `ReplayAdapter` implements `ProviderAdapter`, reads a cassette, and serves recorded results **FIFO per `(provider, persona, method)`** — no CLI, no network. The real adapters stay untouched. Granularity is the **parsed `ReviewResult`** (and the `complete()` string), so replay drives `aggregate → scopeToDiff → fp-ledger → critic → brain` directly (the parser is bypassed; it has its own unit tests). Scope is the adapter layer only: embeddings and Context7 use their **existing** test seams (`buildEmbedder`, `fetchOverrides`) and compose with cassettes.

## Architecture

Decorator pattern at the `ProviderAdapter` seam (`src/providers/adapter-base.ts`). New `src/cassette/` module + a zod schema. Wiring in `gate.ts` via the `REVIEWGATE_CASSETTE` env var, reusing the existing `providerOverrides` seam. Lives in `src/` (not test-only): record runs through the production gate path, and replay is CLI-usable.

### Components (one responsibility each)

- **`src/schemas/cassette.ts` — zod schema (source of truth).**
  `Cassette = { schema: "reviewgate.cassette.v1"; recordedAt: string; entries: CassetteEntry[] }`.
  `CassetteEntry = { provider: ProviderId; persona: string; method: "review" | "complete"; promptSha256: string; result: ReviewResult | { text: string } }`. `result` is a `ReviewResult` for `method:"review"`, `{ text }` for `method:"complete"`. Validated on load.

- **`src/cassette/store.ts` — load/append + env parsing.**
  `loadCassette(path): Cassette` (read + zod-validate; throws on malformed). `appendEntry(path, entry)` (atomic write: tmp + rename, `mode:0o600`; creates the file with an empty `entries` array on first append). `cassetteFromEnv(): { mode: "record" | "replay"; path: string } | null` parses `REVIEWGATE_CASSETTE` of the form `record:<path>` / `replay:<path>` (anything else → null).

- **`src/cassette/recording-adapter.ts` — `RecordingAdapter`.**
  Constructed with a real `ProviderAdapter` + a cassette path. `preflight` delegates unchanged. `review(input)` calls `real.review(input)`, then appends `{ provider: real.id, persona: input.persona, method: "review", promptSha256: sha256(readFile(input.promptFile)), result }` and returns the real result. `complete(prompt, opts)` (only if `real.complete` exists) calls through, appends `{ …, method: "complete", promptSha256: sha256(prompt), result: { text } }`, returns the text. A write failure is a best-effort `console.warn` — it never breaks the real review.

- **`src/cassette/replay-adapter.ts` — `ReplayAdapter` (implements `ProviderAdapter`).**
  Constructed with a loaded `Cassette` **and a bound `provider` id** (`new ReplayAdapter(cassette, "codex")`). The orchestrator addresses adapters by provider (`adapters[provider].review(...)`), so one instance serves exactly one provider; `id` returns the bound id. Internally it filters the cassette to its provider and keeps a FIFO queue per `(persona, method)`. `preflight` returns a synthetic `{ available: true, version: "replay", authMode: "oauth", error: null }`. `review(input)` / `complete(...)` pop the next entry for their key; on a hit, compare `promptSha256` against the recorded one → `console.warn` on drift (no hard failure); return the recorded `result`. On a miss (no/empty queue) → **throw** `Error("cassette: no recorded <method> for <provider>-<persona> (entry N)")` so tests fail loudly rather than silently passing. (A shared cassette across providers is fine — each `ReplayAdapter` reads only its own provider's entries.)

- **`gate.ts` (modify).** After building `adapters`, if `cassetteFromEnv()` is set: `record` → wrap each adapter in `RecordingAdapter(real, path)`; `replay` → replace each with `ReplayAdapter(cassette, id)` (one per provider id, sharing the loaded cassette). Reuses the existing `providerOverrides ?? createAdapter(...)` seam (overrides still win). Inert when the env var is unset.

### Data flow

```
record:  REVIEWGATE_CASSETTE=record:<p>
  → gate wraps createAdapter(id) in RecordingAdapter(real, p)
  → real panel runs (real CLIs) → each review()/complete() appended to <p>

replay:  REVIEWGATE_CASSETTE=replay:<p>   (or tests inject ReplayAdapter directly)
  → loadCassette(p) → adapters[id] = ReplayAdapter(cassette)
  → review()/complete() served FIFO from the cassette (no CLI/network)
  → orchestrator pipeline (aggregate→scopeToDiff→fp-ledger→critic→brain) runs deterministically
```

### Error handling

- Replay **miss** → throw (loud; surfaces an exhausted/incomplete cassette).
- Prompt **drift** (recorded `promptSha256` ≠ live) → `console.warn`, still serve (VCR-style; tolerant of `research.md` timestamps / Context7 docs / few-shot changes).
- Record **write failure** → `console.warn`, the real review proceeds unaffected.
- `ReviewResult.rawEventsPath` points to an ephemeral tmp file; on replay it is returned as the stored string (consumers tolerate a missing file). Audit `response_ref` may dangle on replay — acceptable.

### Redaction / placement

Faithful recording, **no auto-redaction** (redaction would alter replayed content). Record default path under `.reviewgate/cassettes/` (gitignored) + a one-line "contains raw reviewer output — review before committing" notice on record. Hand-authored test fixtures live in `tests/fixtures/cassettes/` (deliberately clean, committed).

## Testing

- **Unit:** `store` (load + zod-validate, append atomic + first-append creates file, `cassetteFromEnv` parsing incl. malformed → null); `ReplayAdapter` (FIFO order per key, multi-iteration same reviewer consumes in order, miss → throws, drift → warns); `RecordingAdapter` (delegates + appends review and complete, write failure → warn not throw, preflight passthrough).
- **Integration:** Orchestrator driven by a fixture cassette → deterministically exercises the paths that were unprovable live: **FP-ledger demote** (a recorded finding whose signature is `active` → demoted to INFO), **Phase-A scopeToDiff** (a recorded out-of-diff finding → demoted), and **Brain curation** (recorded `memory_proposals` + recorded curator `complete()` → a deterministic curator decision), composed with the existing stub embedder.
- **Round-trip:** a stub "real" adapter → `RecordingAdapter` writes a cassette → `ReplayAdapter` reads it → the orchestrator produces an identical verdict/findings.
- **Compiled-binary note:** record/replay run through the gate; a smoke check that `REVIEWGATE_CASSETTE` is honored by `dist/reviewgate` (env parsing works in the compiled binary).

## Scope / non-goals

- **In:** the `ProviderAdapter` layer (`review()` + `complete()`); the cassette schema + store; record/replay adapters; `gate.ts` env wiring; fixture-driven deterministic pipeline tests.
- **Out (use existing seams or follow-ups):** recording embeddings calls and Context7 `safeApiFetch` (covered by `buildEmbedder` / `fetchOverrides`); raw-CLI-stdout granularity; auto-redaction; a `phases.cassette` config field; a dedicated `reviewgate cassette` CLI subcommand (env-var activation suffices for now).

## Decomposition

One implementation plan, bottom-up: (1) `schemas/cassette.ts` → (2) `cassette/store.ts` (+ `cassetteFromEnv`) → (3) `ReplayAdapter` → (4) `RecordingAdapter` → (5) `gate.ts` wiring → (6) fixture-driven integration tests (FP-ledger/Phase-A/Brain) + round-trip → (7) DoD + compiled-binary smoke.
