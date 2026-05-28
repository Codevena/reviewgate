# Brain Cross-Run Quorum (so the brain actually promotes)

**Date:** 2026-05-28
**Status:** Design (approved) → ready for codex review then implementation plan
**Locus:** new `src/core/brain/candidate-store.ts`; wired into `src/core/brain/curator.ts` before the existing `quorumOk` check; small `phases.brain` config addition.

## Problem (root-caused from real data)

Investigation in shoal (11 `.reviewgate/brain/proposals/curator-decisions/*.jsonl` files, every entry):
```
"decision":"rejected","rule_failed":"quorum"
```
The brain has promoted zero entries — same in flashbuddy. The curator's `quorumOk` (`curator.ts:159`) requires **≥2 distinct providers proposing semantically similar knowledge in the SAME run**. Real reviewer panels almost never converge that way on codebase-specific patterns: each provider proposes a *different* repo-specific observation per run, none cluster into the same group, quorum fails, all are rejected, all are discarded. There is no mechanism for cross-run convergence — a proposal from run N is forgotten before run N+1 runs.

The system works in theory for universal knowledge convergence; in practice it filters out the very repo-specific conventions a brain would be most useful for.

## Goals / non-goals

**Goals**
- Persist proposals that fail ONLY on the quorum gate, so that a future run's proposal from a *different* provider can complete the quorum and promote.
- Mirror proven FP-ledger conventions (TTL + cap + lock semantics) for low-cognitive-load consistency.
- Add the cross-run path *additively* — the existing in-run quorum path is unchanged; the new path only opens up *more* promotions, never fewer.

**Non-goals (explicitly deferred)**
- A full `candidate → active → sticky` stage model (the FP-ledger style). The brain's existing `BrainEntry.status` lifecycle handles post-promotion stages; the candidate pool just gates the promote/no-promote decision.
- Skipping or weakening the existing LLM-judge gate. It still runs after quorum, identical to today.
- Manual brain entries / CLI pinning (a separate idea, not this slice).
- Cross-repo candidate sharing.

## Design

### New module `src/core/brain/candidate-store.ts`

Single responsibility: persist proposals that *almost* qualified for the brain (passed every rule but quorum) and look them up by semantic similarity in a future run. Append-only NDJSON for crash safety; periodic in-place compaction; file-locked via the project's existing lock helper.

```ts
export interface BrainCandidate {
  id: string;                // ulid
  title: string;
  body: string;
  scope: string;
  type: BrainEntryType;
  embedding: number[];       // unit-normalized, like the brain's
  embedding_model: string;   // model identity — guards against silent re-embed drift
  provider: string;          // the ONE provider that emitted this proposal
  source_run_id: string;
  created_at: string;        // ISO; drives TTL
  evidence_kinds: ("reviewer-observation" | "web-fetch" | "diff-derived")[];
}

export interface CandidateStoreConfig {
  ttlDays: number;     // default 60
  maxEntries: number;  // default 5000 (hard cap, prune oldest first beyond)
}

export interface CandidateStore {
  listAll(): Promise<BrainCandidate[]>;          // snapshot for read-path
  addOrMerge(c: BrainCandidate): Promise<void>;  // dedup-by-(embedding, provider)
  deleteByIds(ids: string[]): Promise<void>;     // post-promotion cleanup
  prune(now: Date): Promise<{ expired: number; capped: number }>;
}
```

**Storage:** `.reviewgate/brain/candidates.jsonl`. One JSON object per line. Compaction = write `candidates.jsonl.tmp` then atomic `rename()`. Locking reuses the project's existing file-lock helper (the same one `BrainStore`/`FpStore` use today) — if those helpers turn out to be module-private, expose a single shared helper rather than duplicate the lock primitive. Truncated last lines from a crashed write are skipped by `listAll` (lenient line-parse), then squeezed out by the next compaction.

**Embedding-model identity (`embedding_model`):** the stable identity of the model that produced the embedding (e.g. the `embeddings.provider/model` config string, or whatever stable identifier the embedder exposes — see `src/core/brain/embeddings.ts`). If the embedder lacks a stable identifier, persist the configured provider+model string so a config change invalidates matches deterministically.

**Pruning policy (run at the *start* of each curator run, before any reads):**
1. Drop entries with `now - created_at > ttlDays`.
2. If still > `maxEntries`, drop the oldest (lowest `created_at`) until at cap.

**Dedup-by-(embedding, provider) on add:**
- A proposal from provider P that already has a candidate from P with `cosine ≥ GROUP_THRESHOLD` is a no-op (don't double-count the same provider's repeated observation).
- A proposal from provider Q that matches an existing candidate from provider P (≠ Q) is stored as a new entry — together they're the cross-run quorum.

### Curator-flow change (`src/core/brain/curator.ts`)

The current per-run flow is unchanged except for one addition right before the existing `quorumOk(mergedEvidence, doubled)` call (~`:317`):

```
For each per-run group with representative `rep` (highest-confidence member):
  1. Read candidate pool: `candidates = store.listAll()`
  2. Filter to matches:
       `matched = candidates.filter(c =>
          c.embedding_model === currentEmbeddingModel
          && cosineSimilarity(c.embedding, repEmbedding) ≥ GROUP_THRESHOLD)`
  3. Build the merged evidence used by `quorumOk`:
       `crossRunEvidence = mergedEvidence ∪ { synthetic reviewer-observation items, one per
         matched.provider, so the existing quorum function sees them as distinct-provider
         reviewer evidence without re-running web/diff classification }`
     (the `synthetic` items carry only `kind: "reviewer-observation"` and `provider`; they
     are not promoted into the final BrainEntry.evidence — they exist solely so the
     unchanged `quorumOk` function can count provider distinctness across runs.)
  4. If `quorumOk(crossRunEvidence, doubled)` passes → continue into the existing flow
     (consistency → dedup → judge → promote).
       On promote success: `store.deleteByIds(matched.map(m => m.id))`.
     If `quorumOk` still fails → `store.addOrMerge(repAsCandidate)`
       (the rep enters the pool with its single provider attribution; future runs may
       complete the quorum.)
```

**Why this is additive only:** the existing `quorumOk` is still the same function and still the same threshold. The only thing that changes is *the input set* of distinct providers — which can only grow (cross-run candidates have already-distinct providers, never the same). A proposal that today gets quorum from in-run alone still does. A proposal that today fails by 1 provider and matches a stored candidate from a *different* provider now passes — exactly the intended behavior.

### Config

Extend `phases.brain` (in `src/config/define-config.ts` + `src/config/defaults.ts`):

```ts
brain: {
  enabled: boolean;
  maxPromptTokens: number;
  // NEW — Cross-run candidate pool gating
  crossRunCandidates: {
    enabled: boolean;     // default true
    ttlDays: number;      // default 60
    maxEntries: number;   // default 5000
  };
}
```

Disable-able for environments that want the strict in-run-only behavior; defaults wire it on.

## Files touched

- **Create:** `src/core/brain/candidate-store.ts` — `CandidateStore` interface + on-disk JSONL impl + pruning.
- **Modify:** `src/core/brain/curator.ts` — read pool, enlarge distinct-provider set before `quorumOk`, write/delete on promote/store paths.
- **Modify:** `src/config/define-config.ts` + `src/config/defaults.ts` — `brain.crossRunCandidates`.
- **Modify:** `src/schemas/brain.ts` (or new schema file) — `BrainCandidateSchema` (zod).
- **Create:** `tests/unit/brain-candidate-store.test.ts` — store CRUD + TTL/cap + dedup-by-(embedding, provider) + lock correctness.
- **Create:** `tests/unit/brain-cross-run-quorum.test.ts` — curator-level: 1-stored + 1-new from different provider → promote; same provider → keep stored; embedding-model mismatch → safe skip.
- **Create:** `tests/integration/brain-2-run-promote.test.ts` — full 2-run sequence proving the headline behavior: run 1 stores; run 2 promotes; pool ends empty.

## Test plan (real behavior; no fakes for the headline)

`CandidateStore` (unit, real temp dirs + injected clock):
1. `addOrMerge` of a new (embedding, provider) → entry persisted to JSONL.
2. `addOrMerge` of same (embedding ≥ threshold, same provider) → no-op (already counted).
3. `addOrMerge` of similar embedding from *different* provider → second entry persisted (quorum-relevant).
4. `prune` with mixed ages → only expired (now-created_at > ttlDays) removed.
5. `prune` with > `maxEntries` → oldest dropped to cap.
6. `deleteByIds` → entries gone after the next `listAll`.
7. Concurrent `addOrMerge` calls serialize through the file lock (no data loss/corruption).
8. Crash mid-write (truncated last line) → `listAll` skips the partial line; subsequent compaction rewrites cleanly.

Curator-level (unit, real `CandidateStore` + real embeddings via the existing test fixtures):
9. Pool empty, new run with 1 provider → quorum fails today's way → rep is stored as candidate; brain unchanged.
10. Pool has candidate from provider A; new run has matching proposal from provider B → distinct={A,B} → quorum passes → judge runs → promote → matched candidate is deleted from pool.
11. Pool has candidate from provider A; new run has matching proposal from same provider A → distinct={A} → quorum still fails → candidate pool unchanged (no duplicate store).
12. Pool has candidate with old `embedding_model`; new run uses new model → candidate is skipped (no false match), but not deleted (it'll TTL out).
13. Pool entries past TTL → pruned at start of run.

Integration (the headline — real `Orchestrator` + stub embedder + stub adapters):
14. **2-run sequence:** run 1 has codex-only proposing P with `evidence.provider="codex"` → quorum fails (singleton) → pool: 1 entry. Run 2 has gemini-only proposing P-similar → distinct={codex, gemini} → quorum passes → judge accepts → `brain.json.entries` length increases by 1 with matching title; pool length is 0.

## Acceptance

- `bunx tsc --noEmit` and `bun run lint` clean.
- `bun test` green including the new tests.
- Manual: run the integration test verbosely and confirm the 2-run sequence promotes.
- DoD pipeline (codex + opus reviews) green; merge to master + rebuild dist + push only on explicit user go.

## Risks (honest)

- **Embedding-model drift:** mitigated by `embedding_model` per-entry — mismatches skip, pool TTL clears stale model entries over time.
- **Pool growth:** capped at 5000 entries × ~5 KB ≈ 25 MB worst case; TTL keeps it shorter in practice. Bounded.
- **Self-quorum forgery:** a single provider re-proposing P over many runs would not pass quorum because the dedup-by-(embedding, provider) prevents double-counting the same provider. Safe.
- **Cache invalidation:** the candidate pool changing does NOT change the current iteration's prompt or the active brain snapshot, so it's correctly excluded from the cache key. A *promotion* changes the brain, which is already folded into `behaviorHash` — no new cache concern.
- **Privacy:** the pool stores proposal text + provider source — same data class as `brain.json`, no new privacy posture.
- **Future-promotion still gated by the LLM-judge:** if the judge consistently rejects a class of proposals, cross-run quorum won't rescue them. That's correct — the judge is the quality floor; the quorum gate is the integrity floor. We loosen quality-floor by giving more inputs (more matched candidates), but the judge still arbitrates.

## Out of scope / explicit non-goals (restated)

- Stage model (candidate→active→sticky parallel to FP-ledger).
- Manual brain CLI.
- Cross-repo sharing.
- Touching the LLM-judge logic.
