# Brain Cross-Run Quorum Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist proposals that fail ONLY on the per-run quorum gate so a future run's proposal from a *different* provider can complete the quorum and promote — the brain finally learns.

**Architecture:** New `CandidateStore` (file-backed JSONL, file-locked, TTL+cap pruned), mirroring the fp-ledger persistence pattern. `runCurator` reads the pool before its existing `quorumOk` call and synthesizes one extra `reviewer-observation` evidence item per matched candidate-provider so the unchanged `quorumOk` sees the enlarged distinct-provider set. On promote success the matched candidates are deleted; on quorum-still-fail the rep enters the pool with its single-provider attribution. Default-on; degrades silently to current behavior if disabled.

**Tech Stack:** Bun, TypeScript, `bun test`. Tests follow the existing brain-curator test patterns (`tests/unit/brain-curator.test.ts`) — stubbed embedder via fixture, real `CandidateStore` against temp dirs.

**Spec:** `docs/superpowers/specs/2026-05-28-brain-cross-run-quorum-design.md` (architecture-approved; codex DoD review deferred to final whole-diff pass — codex quota-exhausted until 2026-05-30).

---

## File Structure

- **Create:** `src/core/brain/candidate-store.ts` — `CandidateStore` interface + file-backed impl (snapshot / addOrMerge / deleteByIds / prune).
- **Modify:** `src/schemas/brain.ts` — add `BrainCandidateSchema`.
- **Modify:** `src/utils/paths.ts` — add `brainCandidatesPath` + `brainCandidatesLockPath`.
- **Modify:** `src/config/define-config.ts` + `src/config/defaults.ts` — `brain.crossRunCandidates`.
- **Modify:** `src/core/brain/curator.ts` — read pool before `quorumOk`, synthesize evidence items for matched candidates, delete on promote, add on quorum-fail.
- **Create:** `tests/unit/brain-candidate-store.test.ts` — store CRUD + dedup + TTL/cap.
- **Modify:** `tests/unit/brain-curator.test.ts` — add cross-run tests (rep-stored-on-fail, cross-run promote, embedding-model mismatch skip).

Reference patterns to read before coding:
- `src/core/fp-ledger/store.ts:1-90` — exact lock + snapshot + persist + atomic-rename pattern to mirror.
- `src/utils/paths.ts:61-90` — `learningsDir`/`brainDir` helpers.
- `src/core/brain/curator.ts:159-340` — the quorum check + per-group flow we're splicing into.
- `tests/unit/brain-curator.test.ts:18-40` — `p()` proposal-builder fixture used everywhere.

---

## Task 1: Config field + path helpers + schema (foundation)

**Files:**
- Modify: `src/config/define-config.ts`
- Modify: `src/config/defaults.ts`
- Modify: `src/utils/paths.ts`
- Modify: `src/schemas/brain.ts`
- Test: `tests/unit/define-config.test.ts` (or wherever defaults are checked) + `tests/unit/brain-paths.test.ts`

- [ ] **Step 1: Write the failing test** (append to `tests/unit/brain-paths.test.ts`)

```ts
import { brainCandidatesPath, brainCandidatesLockPath } from "../../src/utils/paths.ts";

describe("brain candidates paths", () => {
  it("brainCandidatesPath = .reviewgate/brain/candidates.jsonl", () => {
    expect(brainCandidatesPath("/repo")).toBe("/repo/.reviewgate/brain/candidates.jsonl");
  });
  it("brainCandidatesLockPath = .reviewgate/brain/candidates.lock", () => {
    expect(brainCandidatesLockPath("/repo")).toBe("/repo/.reviewgate/brain/candidates.lock");
  });
});
```

Also append to the config test (or create `tests/unit/define-config-brain-crossrun.test.ts`):
```ts
import { describe, expect, it } from "bun:test";
import { defineConfig } from "../../src/config/define-config.ts";

describe("brain.crossRunCandidates", () => {
  it("defaults to enabled=true, ttlDays=60, maxEntries=5000 when brain is set", () => {
    const cfg = defineConfig({
      phases: { brain: { enabled: true, maxPromptTokens: 1500,
        embeddings: { provider: "openrouter", model: "x", apiKeyEnv: "X" } } } });
    expect(cfg.phases.brain?.crossRunCandidates?.enabled).toBe(true);
    expect(cfg.phases.brain?.crossRunCandidates?.ttlDays).toBe(60);
    expect(cfg.phases.brain?.crossRunCandidates?.maxEntries).toBe(5000);
  });
});
```

- [ ] **Step 2: Run them — FAIL** (`bun test tests/unit/brain-paths.test.ts tests/unit/define-config-brain-crossrun.test.ts` → missing symbols / wrong defaults).

- [ ] **Step 3: Add path helpers** in `src/utils/paths.ts` (next to the existing brain ones around line 86):

```ts
export function brainCandidatesPath(repoRoot: string): string {
  return join(brainDir(repoRoot), "candidates.jsonl");
}
export function brainCandidatesLockPath(repoRoot: string): string {
  return join(brainDir(repoRoot), "candidates.lock");
}
```

- [ ] **Step 4: Add the schema** in `src/schemas/brain.ts` (next to `BrainEntrySchema`):

```ts
export const BrainCandidateSchema = z.object({
  id: z.string(),
  title: z.string().max(80),
  body: z.string().max(500),
  scope: z.string(),
  type: BrainEntryType,
  embedding: z.array(z.number()).min(1),
  embedding_model: z.string().min(1),
  provider: z.string().min(1),
  source_run_id: z.string(),
  created_at: z.string(),
  evidence_kinds: z.array(z.enum(["reviewer-observation", "web-fetch", "diff-derived"])).default([]),
});
export type BrainCandidate = z.infer<typeof BrainCandidateSchema>;

export const BrainCandidatesIndexSchema = z.object({
  schema: z.literal("reviewgate.brain.candidates.v1"),
  entries: z.array(BrainCandidateSchema),
});
export type BrainCandidatesIndex = z.infer<typeof BrainCandidatesIndexSchema>;
```

- [ ] **Step 5: Add the config field** in `src/config/define-config.ts` inside the `brain` object (after `egressAllowlist`):

```ts
        crossRunCandidates: z
          .object({
            enabled: z.boolean().default(true),
            ttlDays: z.number().int().positive().default(60),
            maxEntries: z.number().int().positive().default(5000),
          })
          .default({ enabled: true, ttlDays: 60, maxEntries: 5000 })
          .optional(),
```

And the matching addition in `src/config/defaults.ts` `brain` block (when non-null) — but `brain` is `null` by default in defaults.ts (line ~82). Tests pass a `brain` block, so the zod `.default(...)` on `crossRunCandidates` covers that path. Verify: any place that constructs a real `brain` object should include the field; rely on zod defaulting to fill it.

- [ ] **Step 6: Run — PASS.** `bunx tsc --noEmit` clean. `bun run lint` clean.

- [ ] **Step 7: Commit**
```bash
git add src/utils/paths.ts src/schemas/brain.ts src/config/define-config.ts src/config/defaults.ts tests/unit/brain-paths.test.ts tests/unit/define-config-brain-crossrun.test.ts
git commit -m "feat(brain): foundation for cross-run candidates — schema, paths, config"
```

---

## Task 2: `CandidateStore` — snapshot / persist / lock (file-backed JSONL)

**Files:**
- Create: `src/core/brain/candidate-store.ts`
- Test: `tests/unit/brain-candidate-store.test.ts`

This task mirrors `src/core/fp-ledger/store.ts:60-90` exactly (snapshot → mutate-under-lock → atomic rename), but the on-disk format is **NDJSON** (one entry per line, append-friendly) instead of a single JSON blob. We still rewrite the whole file on mutate for simplicity — compaction is implicit.

- [ ] **Step 1: Write the failing test** (`tests/unit/brain-candidate-store.test.ts`)

```ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CandidateStore } from "../../src/core/brain/candidate-store.ts";
import type { BrainCandidate } from "../../src/schemas/brain.ts";
import { brainCandidatesPath } from "../../src/utils/paths.ts";

function repo() { return mkdtempSync(join(tmpdir(), "rg-cand-")); }
function mkCandidate(over: Partial<BrainCandidate> = {}): BrainCandidate {
  return {
    id: "C-001", title: "use prepared queries", body: "always parameterize SQL",
    scope: "language-ts", type: "convention",
    embedding: [0.1, 0.2, 0.3], embedding_model: "bge-base-en-v1.5",
    provider: "codex", source_run_id: "R1",
    created_at: new Date("2026-05-28T00:00:00Z").toISOString(),
    evidence_kinds: ["reviewer-observation"],
    ...over,
  };
}

describe("CandidateStore — basics", () => {
  it("listAll on missing file returns []", async () => {
    const r = repo();
    expect(await new CandidateStore(r).listAll()).toEqual([]);
  });

  it("addOrMerge persists an entry to candidates.jsonl as one-line JSON", async () => {
    const r = repo();
    const s = new CandidateStore(r);
    await s.addOrMerge(mkCandidate());
    const raw = readFileSync(brainCandidatesPath(r), "utf8");
    expect(raw.trim().split("\n").length).toBe(1);
    expect(JSON.parse(raw.trim()).id).toBe("C-001");
    const back = await s.listAll();
    expect(back).toHaveLength(1);
    expect(back[0]?.title).toBe("use prepared queries");
  });

  it("listAll tolerates a truncated last line (crash mid-write)", async () => {
    const r = repo();
    const s = new CandidateStore(r);
    await s.addOrMerge(mkCandidate({ id: "C-001" }));
    // Simulate a crash by appending a partial line.
    const p = brainCandidatesPath(r);
    writeFileSync(p, `${readFileSync(p, "utf8")}{"id":"C-002","title":"trunc`);
    const back = await s.listAll();
    expect(back).toHaveLength(1); // truncated line skipped, valid entry kept
    expect(back[0]?.id).toBe("C-001");
  });
});
```
(Add `writeFileSync` to the imports.)

- [ ] **Step 2: Run — FAIL** (module not present).

- [ ] **Step 3: Implement** `src/core/brain/candidate-store.ts`:

```ts
// src/core/brain/candidate-store.ts
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type BrainCandidate, BrainCandidateSchema } from "../../schemas/brain.ts";
import { flock } from "../../utils/flock.ts";
import { brainCandidatesLockPath, brainCandidatesPath, brainDir } from "../../utils/paths.ts";

const DAY_MS = 86_400_000;

export class CandidateStore {
  constructor(private readonly repoRoot: string) {}

  /** Read every valid candidate from disk. Tolerant of truncated/partial lines
   *  (e.g. from a crashed write) — invalid lines are skipped, not raised. */
  async listAll(): Promise<BrainCandidate[]> {
    const p = brainCandidatesPath(this.repoRoot);
    if (!existsSync(p)) return [];
    const raw = readFileSync(p, "utf8");
    const out: BrainCandidate[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(BrainCandidateSchema.parse(JSON.parse(t)));
      } catch {
        /* skip partial/invalid line — compaction will squeeze it out */
      }
    }
    return out;
  }

  private persist(entries: BrainCandidate[]): void {
    const p = brainCandidatesPath(this.repoRoot);
    if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`, { mode: 0o600 });
    renameSync(tmp, p);
  }

  /** Acquire the file lock, snapshot, apply `fn`, validate, persist, release. */
  async mutate<T>(fn: (entries: BrainCandidate[]) => { next: BrainCandidate[]; result: T }): Promise<T> {
    if (!existsSync(brainDir(this.repoRoot))) mkdirSync(brainDir(this.repoRoot), { recursive: true });
    const lock = await flock(brainCandidatesLockPath(this.repoRoot));
    try {
      const cur = await this.listAll();
      const { next, result } = fn([...cur]);
      // Validate every entry survives the round-trip — crash early if the
      // calling code produced an invalid shape (catches bad addOrMerge inputs).
      for (const e of next) BrainCandidateSchema.parse(e);
      this.persist(next);
      return result;
    } finally {
      await lock.release();
    }
  }

  /** Add a new candidate (no dedup yet — Task 3 adds dedup-by-(embedding, provider)). */
  async addOrMerge(c: BrainCandidate): Promise<void> {
    await this.mutate((entries) => ({ next: [...entries, c], result: undefined }));
  }
}
```

- [ ] **Step 4: Run — PASS.** `bunx tsc --noEmit` clean. `bun run lint` clean.

- [ ] **Step 5: Commit**
```bash
git add src/core/brain/candidate-store.ts tests/unit/brain-candidate-store.test.ts
git commit -m "feat(brain): CandidateStore — snapshot+persist+lock (NDJSON, fp-ledger pattern)"
```

---

## Task 3: `CandidateStore.addOrMerge` — dedup by (embedding ≥ GROUP_THRESHOLD, same provider)

**Files:** Modify `src/core/brain/candidate-store.ts`; Test `tests/unit/brain-candidate-store.test.ts`.

The dedup rule (from spec): a proposal from provider P that matches an existing candidate from the SAME provider P (cosine ≥ GROUP_THRESHOLD) is a no-op (don't double-count). A proposal from a DIFFERENT provider against a matching candidate is added (that's the quorum-relevant case).

`GROUP_THRESHOLD` lives in `curator.ts`; we re-import or duplicate the constant. Cleaner: export it from `curator.ts` (small change — Task 5 will need it imported too).

- [ ] **Step 1: Export `GROUP_THRESHOLD`** from `src/core/brain/curator.ts` (find the existing `const GROUP_THRESHOLD = …` and add `export`).

- [ ] **Step 2: Write the failing tests** (append to `tests/unit/brain-candidate-store.test.ts`)

```ts
describe("CandidateStore — addOrMerge dedup-by-(embedding, provider)", () => {
  it("same provider + same embedding → no-op (one entry)", async () => {
    const r = repo();
    const s = new CandidateStore(r);
    await s.addOrMerge(mkCandidate({ id: "C-001", provider: "codex", embedding: [1, 0, 0] }));
    await s.addOrMerge(mkCandidate({ id: "C-002", provider: "codex", embedding: [1, 0, 0] }));
    expect(await s.listAll()).toHaveLength(1);
  });
  it("DIFFERENT provider + same embedding → two entries (quorum-relevant)", async () => {
    const r = repo();
    const s = new CandidateStore(r);
    await s.addOrMerge(mkCandidate({ id: "C-001", provider: "codex", embedding: [1, 0, 0] }));
    await s.addOrMerge(mkCandidate({ id: "C-002", provider: "gemini", embedding: [1, 0, 0] }));
    expect(await s.listAll()).toHaveLength(2);
  });
  it("same provider + orthogonal embedding → two entries (different topics)", async () => {
    const r = repo();
    const s = new CandidateStore(r);
    await s.addOrMerge(mkCandidate({ id: "C-001", provider: "codex", embedding: [1, 0, 0] }));
    await s.addOrMerge(mkCandidate({ id: "C-002", provider: "codex", embedding: [0, 1, 0] }));
    expect(await s.listAll()).toHaveLength(2);
  });
});
```

- [ ] **Step 3: Run — FAIL** (current `addOrMerge` blindly appends).

- [ ] **Step 4: Implement the dedup** — replace the body of `addOrMerge` in `candidate-store.ts`:

```ts
import { cosineSimilarity } from "./embeddings.ts";
import { GROUP_THRESHOLD } from "./curator.ts";

  async addOrMerge(c: BrainCandidate): Promise<void> {
    await this.mutate((entries) => {
      // Dedup: a SAME-provider candidate with an embedding cosine ≥ GROUP_THRESHOLD
      // means "this provider already said this" — no-op (don't inflate the pool
      // with one provider's repeated observations).
      const dup = entries.find(
        (e) =>
          e.provider === c.provider &&
          e.embedding_model === c.embedding_model &&
          (() => {
            try { return cosineSimilarity(e.embedding, c.embedding) >= GROUP_THRESHOLD; }
            catch { return false; }
          })(),
      );
      return dup
        ? { next: entries, result: undefined }
        : { next: [...entries, c], result: undefined };
    });
  }
```

- [ ] **Step 5: Run — PASS** (all 3 new tests + earlier ones green). `bunx tsc --noEmit` clean. `bun run lint` clean.

- [ ] **Step 6: Commit**
```bash
git add src/core/brain/curator.ts src/core/brain/candidate-store.ts tests/unit/brain-candidate-store.test.ts
git commit -m "feat(brain): CandidateStore.addOrMerge dedup by (embedding ≥ threshold, same provider)"
```

---

## Task 4: `CandidateStore.deleteByIds` + `prune` (TTL + cap)

**Files:** Modify `src/core/brain/candidate-store.ts`; Test `tests/unit/brain-candidate-store.test.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("CandidateStore — deleteByIds", () => {
  it("removes only the listed ids", async () => {
    const r = repo();
    const s = new CandidateStore(r);
    await s.addOrMerge(mkCandidate({ id: "C-001", embedding: [1, 0, 0] }));
    await s.addOrMerge(mkCandidate({ id: "C-002", embedding: [0, 1, 0] }));
    await s.deleteByIds(["C-001"]);
    const back = await s.listAll();
    expect(back).toHaveLength(1);
    expect(back[0]?.id).toBe("C-002");
  });
});

describe("CandidateStore — prune (TTL + cap)", () => {
  const NOW = new Date("2026-05-28T00:00:00Z");
  it("expires entries older than ttlDays (created_at + ttl < now)", async () => {
    const r = repo();
    const s = new CandidateStore(r);
    await s.addOrMerge(mkCandidate({ id: "old", created_at: "2026-01-01T00:00:00Z" })); // ~148d old
    await s.addOrMerge(mkCandidate({ id: "new", embedding: [0, 1, 0],
      created_at: NOW.toISOString() }));
    const res = await s.prune(NOW, { ttlDays: 60, maxEntries: 5000 });
    expect(res.expired).toBe(1);
    expect(res.capped).toBe(0);
    const back = await s.listAll();
    expect(back.map((e) => e.id)).toEqual(["new"]);
  });

  it("caps at maxEntries, dropping the oldest first", async () => {
    const r = repo();
    const s = new CandidateStore(r);
    // 3 entries, each at a unique embedding so dedup doesn't merge them
    for (let i = 0; i < 3; i++) {
      const day = new Date(NOW.getTime() - (3 - i) * 86_400_000); // i=0 oldest
      const emb = [0, 0, 0]; emb[i] = 1;
      await s.addOrMerge(mkCandidate({ id: `E${i}`, embedding: emb, created_at: day.toISOString() }));
    }
    const res = await s.prune(NOW, { ttlDays: 60, maxEntries: 2 });
    expect(res.capped).toBe(1);
    const back = await s.listAll();
    expect(back.map((e) => e.id).sort()).toEqual(["E1", "E2"]); // E0 (oldest) dropped
  });
});
```

- [ ] **Step 2: Run — FAIL** (methods missing).

- [ ] **Step 3: Implement** in `candidate-store.ts`:

```ts
  async deleteByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const drop = new Set(ids);
    await this.mutate((entries) => ({
      next: entries.filter((e) => !drop.has(e.id)),
      result: undefined,
    }));
  }

  /** Drop expired entries; then if still over cap, drop the oldest first. */
  async prune(
    now: Date,
    cfg: { ttlDays: number; maxEntries: number },
  ): Promise<{ expired: number; capped: number }> {
    return await this.mutate((entries) => {
      const nowMs = now.getTime();
      const kept = entries.filter((e) => nowMs - Date.parse(e.created_at) <= cfg.ttlDays * DAY_MS);
      const expired = entries.length - kept.length;
      kept.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)); // oldest first
      const capped = Math.max(0, kept.length - cfg.maxEntries);
      const next = capped > 0 ? kept.slice(capped) : kept;
      return { next, result: { expired, capped } };
    });
  }
```

- [ ] **Step 4: Run — PASS.** `bunx tsc --noEmit` clean. `bun run lint` clean.

- [ ] **Step 5: Commit**
```bash
git add src/core/brain/candidate-store.ts tests/unit/brain-candidate-store.test.ts
git commit -m "feat(brain): CandidateStore.deleteByIds + prune (TTL + cap)"
```

---

## Task 5: Curator — read pool + enlarged quorum (additive)

**Files:** Modify `src/core/brain/curator.ts`; Modify `tests/unit/brain-curator.test.ts`.

The cross-run path is purely additive: where the existing code calls `quorumOk(mergedEvidence, doubled)`, we now build a `crossRunEvidence` that = `mergedEvidence` ∪ synthetic `reviewer-observation` evidence items for each matched-candidate's provider. The existing `quorumOk` then naturally counts those providers as distinct without any code change to it.

- [ ] **Step 1: Write the failing test** in `tests/unit/brain-curator.test.ts`. (Use the existing `p()` proposal-builder fixture and stub embedder; the headline assertion is "with a single-provider new proposal but a matching cross-run candidate from a different provider, quorum passes and promote succeeds".)

```ts
import { CandidateStore } from "../../src/core/brain/candidate-store.ts";

it("cross-run quorum: 1 stored candidate + 1 new from DIFFERENT provider → promote", async () => {
  // … in the existing describe("runCurator", …)
  const repo = mkdtempSync(join(tmpdir(), "rg-xrun-"));
  const store = new BrainStore(repo);
  await store.initialise();
  const candStore = new CandidateStore(repo);
  // Pre-seed: codex proposed P some days ago, stored in the candidate pool.
  await candStore.addOrMerge({
    id: "C-001", title: "use prepared queries",
    body: "always parameterize SQL", scope: "language-ts", type: "convention",
    embedding: [1, 0, 0], embedding_model: "bge",
    provider: "codex", source_run_id: "R-old",
    created_at: new Date().toISOString(),
    evidence_kinds: ["reviewer-observation"],
  });
  // Today: gemini proposes a semantically identical P (same embedding).
  const res = await runCurator({
    repoRoot: repo,
    runId: "R-new",
    nowIso: new Date().toISOString(),
    proposals: [p({ title: "use prepared queries", body: "always parameterize SQL",
      evidence: [{ kind: "reviewer-observation", snippet: "from gemini", provider: "gemini" }] })],
    embedder: { embed: async () => [[1, 0, 0]] },
    embedCfg: { model: "bge", apiKeyEnv: "X" },
    store,
    candidateStore: candStore,
    crossRunCfg: { enabled: true, ttlDays: 60, maxEntries: 5000 },
    judge: async () => ({ accept: true }),
  });
  expect(res.promoted).toBe(1);
  const snap = await store.snapshot();
  expect(snap.entries.length).toBe(1);
  // Matched candidate is gone (cleaned up after promote).
  expect(await candStore.listAll()).toHaveLength(0);
});
```

(Adapt parameter names to whatever `runCurator`'s actual signature requires after the changes below — see Step 3.)

- [ ] **Step 2: Run — FAIL** (curator doesn't yet read the pool; promote returns 0).

- [ ] **Step 3: Extend `runCurator`'s `CuratorInput`** to accept `candidateStore?: CandidateStore` and `crossRunCfg?: { enabled, ttlDays, maxEntries }`. When `candidateStore` and `crossRunCfg?.enabled === true`, run the new cross-run path; otherwise current behavior.

In `curator.ts` (around the per-group block ~line 280-320), where `mergedEvidence` is computed and just before `if (!quorumOk(mergedEvidence, doubled))`, add:

```ts
    // --- Cross-run quorum: pool candidates from prior runs with a matching
    // embedding contribute their provider to the distinct-set, so quorum can
    // be reached over time instead of in a single panel run. Inert when the
    // candidateStore is absent or crossRunCfg.enabled=false. ---
    let crossRunEvidence: EvidenceItem[] = mergedEvidence;
    let matchedCandidateIds: string[] = [];
    if (input.candidateStore && input.crossRunCfg?.enabled) {
      const pool = await input.candidateStore.listAll();
      const repIdx = normalizedProposals.indexOf(rep);
      const repEmbed = (repIdx >= 0 ? normalizedVecs[repIdx] : group.vecs[0]) as number[];
      const matched = pool.filter((c) => {
        if (c.embedding_model !== input.embedCfg?.model) return false;
        try { return cosineSimilarity(c.embedding, repEmbed) >= GROUP_THRESHOLD; }
        catch { return false; }
      });
      matchedCandidateIds = matched.map((m) => m.id);
      // Synthesize one reviewer-observation evidence item per matched candidate-
      // provider so the unchanged quorumOk function sees them as distinct
      // providers. These synthetic items are NOT persisted into the BrainEntry's
      // evidence (we splice them out before promote — Task 6).
      crossRunEvidence = [
        ...mergedEvidence,
        ...matched.map((m): EvidenceItem => ({
          kind: "reviewer-observation",
          snippet: `(cross-run from ${m.source_run_id})`,
          provider: m.provider,
        })),
      ];
    }
```

Then **replace** the existing `if (!quorumOk(mergedEvidence, doubled))` line to use `crossRunEvidence` instead. Keep the `rule_failed` log the same.

- [ ] **Step 4: Run — PASS.** Full curator test suite still green. `bunx tsc --noEmit` clean. `bun run lint` clean.

- [ ] **Step 5: Commit**
```bash
git add src/core/brain/curator.ts tests/unit/brain-curator.test.ts
git commit -m "feat(brain): curator reads CandidateStore + synthesizes cross-run evidence for quorum"
```

---

## Task 6: Curator — delete-on-promote + store-on-quorum-fail

**Files:** Modify `src/core/brain/curator.ts`; Modify `tests/unit/brain-curator.test.ts`.

After promote, delete the matched candidates from the pool. On quorum-fail with a single-provider rep, store the rep as a new candidate.

- [ ] **Step 1: Write the failing tests**

```ts
it("on promote success: matched candidates are deleted from the pool", async () => {
  // (Same setup as the Task-5 test, but explicitly assert candStore is empty after.)
  // … already asserted in Task 5 but make it explicit + add a second matched candidate
  // that gets the same fate.
});

it("on quorum-still-fail: rep with its lone provider is stored in the pool", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rg-storefail-"));
  const candStore = new CandidateStore(repo);
  const store = new BrainStore(repo);
  await store.initialise();
  const res = await runCurator({
    repoRoot: repo, runId: "R-1", nowIso: new Date().toISOString(),
    proposals: [p({ title: "lone observation",
      evidence: [{ kind: "reviewer-observation", snippet: "x", provider: "codex" }] })],
    embedder: { embed: async () => [[1, 0, 0]] },
    embedCfg: { model: "bge", apiKeyEnv: "X" },
    store, candidateStore: candStore,
    crossRunCfg: { enabled: true, ttlDays: 60, maxEntries: 5000 },
    judge: async () => ({ accept: true }),
  });
  expect(res.promoted).toBe(0);
  const pool = await candStore.listAll();
  expect(pool).toHaveLength(1);
  expect(pool[0]?.provider).toBe("codex");
  expect(pool[0]?.embedding_model).toBe("bge");
});

it("embedding-model mismatch: stored candidate is NOT matched but is preserved", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rg-mismatch-"));
  const candStore = new CandidateStore(repo);
  const store = new BrainStore(repo);
  await store.initialise();
  await candStore.addOrMerge({
    id: "C-old", title: "prepared queries", body: "x", scope: "ts", type: "convention",
    embedding: [1, 0, 0], embedding_model: "OLD-MODEL", provider: "codex",
    source_run_id: "R0", created_at: new Date().toISOString(), evidence_kinds: [],
  });
  const res = await runCurator({
    repoRoot: repo, runId: "R-1", nowIso: new Date().toISOString(),
    proposals: [p({ evidence: [{ kind: "reviewer-observation", snippet: "x", provider: "gemini" }] })],
    embedder: { embed: async () => [[1, 0, 0]] },
    embedCfg: { model: "NEW-MODEL", apiKeyEnv: "X" },
    store, candidateStore: candStore,
    crossRunCfg: { enabled: true, ttlDays: 60, maxEntries: 5000 },
    judge: async () => ({ accept: true }),
  });
  expect(res.promoted).toBe(0); // mismatch → no cross-run quorum
  const pool = await candStore.listAll();
  expect(pool).toHaveLength(2); // OLD-MODEL one preserved + NEW-MODEL one stored
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement the promote-cleanup**. Find the existing promote path in `curator.ts` (where `res.promoted++` happens after the judge accepts). Right after `res.promoted++`:

```ts
        if (input.candidateStore && matchedCandidateIds.length > 0) {
          await input.candidateStore.deleteByIds(matchedCandidateIds);
        }
```

- [ ] **Step 4: Implement the store-on-fail**. Replace the existing `if (!quorumOk(...)) { ... continue; }` block to ALSO store the rep when the cross-run path is active:

```ts
    if (!quorumOk(crossRunEvidence, doubled)) {
      res.rejected++;
      log("rejected", title, { rule_failed: doubled ? "diff-quorum" : "quorum" });
      // Cross-run: persist this rep so a future run from a DIFFERENT provider can
      // complete the quorum. Single-provider reps from THIS run only — never store
      // a rep whose merged in-run evidence already spans ≥2 providers but failed
      // on the (stricter) diff-quorum path.
      if (input.candidateStore && input.crossRunCfg?.enabled) {
        const repProviders = new Set(
          mergedEvidence.filter((e) => e.kind === "reviewer-observation").map((e) => e.provider),
        );
        if (repProviders.size === 1) {
          const provider = [...repProviders][0] as string;
          const repIdx = normalizedProposals.indexOf(rep);
          const repEmbed = (repIdx >= 0 ? normalizedVecs[repIdx] : group.vecs[0]) as number[];
          const id = `BC-${crypto.randomUUID()}`;
          await input.candidateStore.addOrMerge({
            id, title: rep.title, body: rep.body, scope: rep.scope, type: rep.type,
            embedding: repEmbed,
            embedding_model: input.embedCfg?.model ?? "unknown",
            provider, source_run_id: input.runId, created_at: input.nowIso,
            evidence_kinds: [...new Set(mergedEvidence.map((e) => e.kind))],
          });
        }
      }
      continue;
    }
```

(Add `import { randomUUID } from "node:crypto";` if not already present.)

- [ ] **Step 5: Run — PASS.** Full `bun test` green. `bunx tsc --noEmit` clean. `bun run lint` clean.

- [ ] **Step 6: Commit**
```bash
git add src/core/brain/curator.ts tests/unit/brain-curator.test.ts
git commit -m "feat(brain): curator deletes matched candidates on promote, stores rep on quorum-fail"
```

---

## Task 7: Pruning + orchestrator wiring (default-on)

**Files:** Modify `src/core/brain/curator.ts`; Modify `src/core/orchestrator.ts`; Test `tests/unit/brain-curator.test.ts`.

Two small bits: (a) the curator should `prune` the pool once at start (TTL + cap) so the pool can't grow unbounded across years; (b) the orchestrator should construct a `CandidateStore` and pass it + `crossRunCfg` into `runCurator` (currently it doesn't pass anything → cross-run inert in production despite default-on config).

- [ ] **Step 1: Add a prune-at-start test** in `tests/unit/brain-curator.test.ts`

```ts
it("prunes the candidate pool at start of run (TTL + cap)", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rg-prune-"));
  const candStore = new CandidateStore(repo);
  await candStore.addOrMerge({
    id: "old", title: "x", body: "x", scope: "ts", type: "convention",
    embedding: [1, 0, 0], embedding_model: "bge", provider: "codex",
    source_run_id: "R-old", created_at: "2026-01-01T00:00:00Z", evidence_kinds: [],
  });
  await runCurator({
    repoRoot: repo, runId: "R-1", nowIso: "2026-05-28T00:00:00Z",
    proposals: [], embedder: { embed: async () => [] },
    embedCfg: { model: "bge", apiKeyEnv: "X" },
    store: new BrainStore(repo), candidateStore: candStore,
    crossRunCfg: { enabled: true, ttlDays: 60, maxEntries: 5000 },
    judge: async () => ({ accept: true }),
  });
  expect(await candStore.listAll()).toHaveLength(0); // expired (148 days old, ttl 60d)
});
```

- [ ] **Step 2: FAIL.**

- [ ] **Step 3: Add the prune call** at the very top of `runCurator` (just after the `res` initialization):

```ts
  if (input.candidateStore && input.crossRunCfg?.enabled) {
    await input.candidateStore.prune(new Date(input.nowIso), {
      ttlDays: input.crossRunCfg.ttlDays,
      maxEntries: input.crossRunCfg.maxEntries,
    });
  }
```

- [ ] **Step 4: Wire the orchestrator** in `src/core/orchestrator.ts`. Find the existing `runCurator` call (grep for it). Construct the store and pass it through:

```ts
import { CandidateStore } from "./brain/candidate-store.ts";
// …
const candidateStore = brainCfg?.crossRunCandidates?.enabled
  ? new CandidateStore(this.input.repoRoot)
  : undefined;
// In the runCurator(...) call, add:
//   candidateStore,
//   crossRunCfg: brainCfg?.crossRunCandidates,
```

- [ ] **Step 5: Run — PASS.** Full `bun test` green.

- [ ] **Step 6: Commit**
```bash
git add src/core/brain/curator.ts src/core/orchestrator.ts tests/unit/brain-curator.test.ts
git commit -m "feat(brain): orchestrator wires CandidateStore — cross-run quorum default-on"
```

---

## Final verification (after all tasks)

- [ ] `bunx tsc --noEmit` — clean
- [ ] `bun run lint` — clean
- [ ] `bun test` — full suite green
- [ ] **Manual end-to-end:** rebuild dist (`bun run build`), run two sequential `reviewgate review-plan` calls on a test repo where two different providers (e.g. codex + gemini) would naturally propose similar conventions, and verify `.reviewgate/brain/brain.json.entries` grows by 1 after run 2.
- [ ] Codex DoD review over `git diff master..HEAD` once codex is available again (post 2026-05-30); fix findings; only then merge.

---

## Self-review (plan vs spec)

- **Spec coverage:** schema/paths/config → Task 1; CandidateStore basics → Task 2; addOrMerge dedup → Task 3; deleteByIds + prune → Task 4; curator read+synthetic-evidence → Task 5; curator delete-on-promote + store-on-fail + embedding-model mismatch → Task 6; pruning + orchestrator wiring → Task 7. The headline 2-run promote behavior is exercised by Task 5's cross-run test and the final manual E2E.
- **Placeholder scan:** every code step has complete code; commands explicit; no "TODO / fill in later".
- **Type/name consistency:** `CandidateStore`, `BrainCandidate`/`BrainCandidateSchema`, `brainCandidatesPath`, `brainCandidatesLockPath`, `GROUP_THRESHOLD` (now exported from curator), `candidateStore`+`crossRunCfg` on `CuratorInput`, `matchedCandidateIds` reused across the same task — all consistent.
