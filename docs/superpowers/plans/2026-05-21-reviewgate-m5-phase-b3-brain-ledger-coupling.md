# M5 Phase B3 — Brain↔Ledger Coupling (core) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an FP-ledger entry is `active`/`sticky`, create a paired Brain `convention` entry (the human-readable "this is a known false positive — why") and cross-link `linked_brain_id` ↔ `linked_fp_id`. Idempotent, non-blocking, post-verdict. (Contradiction-check is deferred to a later B3b — explicitly OUT of scope here.)

**Architecture:** A pure `pairActiveFpEntries()` finds active/sticky FP entries that have no `linked_brain_id` yet, embeds a short title/body for each (batch, fail-closed), writes a `convention` Brain entry via `BrainStore.addAllocatingId`, then writes the new brain id back into the FP entry's `linked_brain_id` via `FpLedgerStore.mutate`. It runs in the orchestrator's post-verdict, non-blocking path (next to the Curator), gated on BOTH brain enabled AND fpLedger enabled — independent of whether this run produced proposals. Idempotency comes from the `!linked_brain_id` filter, so a paired entry is never paired twice.

**Tech Stack:** Bun + TS, zod, `bun test`, biome. `export PATH="$HOME/.bun/bin:$PATH"`. Worktree from local `master` HEAD. Prereqs (all merged): B1 (`FpLedgerStore`, `linked_brain_id` on the FP schema), M4 brain (`BrainStore`, `BrainEntrySchema`, `Embedder`), and the brain-promotion quorum fix (`cb90ea6`).

---

## File structure
- **Modify** `src/schemas/brain.ts` — add `linked_fp_id: z.string().optional()` to `BrainEntrySchema`.
- **Create** `src/core/brain/fp-coupling.ts` — `pairActiveFpEntries({...})`.
- **Modify** `src/core/orchestrator.ts` — extract `buildEmbedder(brainCfg)`; call the pairing post-verdict (brain + fpLedger enabled).
- **Create** `tests/unit/fp-brain-coupling.test.ts`.

---

## Task 1: Schema — `linked_fp_id` on BrainEntry

**Files:** Modify `src/schemas/brain.ts`; Test `tests/unit/fp-brain-coupling.test.ts` (covers indirectly).

- [ ] **Step 1: Add the field** — in `BrainEntrySchema`, after `source_run_id`:

```typescript
  source_run_id: z.string(),
  linked_fp_id: z.string().optional(), // Phase B3: paired FP-ledger entry
```

- [ ] **Step 2: typecheck** — `bun run typecheck` → clean. (Commit with Task 2.)

---

## Task 2: `pairActiveFpEntries` (`src/core/brain/fp-coupling.ts`)

**Files:** Create `src/core/brain/fp-coupling.ts`; Test `tests/unit/fp-brain-coupling.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/fp-brain-coupling.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrainStore } from "../../src/core/brain/store.ts";
import type { Embedder } from "../../src/core/brain/embeddings.ts";
import { pairActiveFpEntries } from "../../src/core/brain/fp-coupling.ts";
import { FpLedgerStore } from "../../src/core/fp-ledger/store.ts";

const fakeEmbedder = (vec: number[]): Embedder => ({ embed: async (t) => t.map(() => vec) });
const meta = { rule_id: "sql-injection", category: "security" as const, file: "a.ts", symbol: "" };

async function seedActive(repo: string, sig = "sigFP") {
  const s = new FpLedgerStore(repo);
  const t = "2026-05-21T00:00:00Z";
  await s.recordReject(sig, meta, { run_id: "r1", provider: "codex", reason: "intentional demo xx" }, t);
  await s.recordReject(sig, meta, { run_id: "r2", provider: "gemini", reason: "intentional demo xx" }, t);
  await s.recordReject(sig, meta, { run_id: "r3", provider: "codex", reason: "intentional demo xx" }, t);
  return s;
}

describe("pairActiveFpEntries", () => {
  it("creates a paired brain convention entry + cross-links both ways", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-b3-"));
    const fpStore = await seedActive(repo);
    const brainStore = new BrainStore(repo);
    const res = await pairActiveFpEntries({
      fpStore,
      brainStore,
      embedder: fakeEmbedder([1, 0]),
      runId: "run1",
      nowIso: "2026-05-21T00:00:00Z",
    });
    expect(res.paired).toBe(1);
    const brain = (await brainStore.snapshot()).entries[0];
    expect(brain?.type).toBe("convention");
    expect(brain?.title).toContain("sql-injection");
    const fp = (await fpStore.snapshot()).entries[0];
    expect(fp?.linked_brain_id).toBe(brain?.id as string);
    expect(brain?.linked_fp_id).toBe(fp?.id);
  });

  it("is idempotent — an already-linked entry is not paired again", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-b3-idem-"));
    const fpStore = await seedActive(repo);
    const brainStore = new BrainStore(repo);
    const args = {
      fpStore,
      brainStore,
      embedder: fakeEmbedder([1, 0]),
      runId: "run1",
      nowIso: "2026-05-21T00:00:00Z",
    };
    await pairActiveFpEntries(args);
    const res2 = await pairActiveFpEntries(args);
    expect(res2.paired).toBe(0);
    expect((await brainStore.snapshot()).entries).toHaveLength(1);
  });

  it("does NOT pair candidate (non-active) FP entries", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-b3-cand-"));
    const fpStore = new FpLedgerStore(repo);
    // single reject → candidate, not active
    await fpStore.recordReject("sigC", meta, { run_id: "r1", provider: "codex", reason: "x" }, "2026-05-21T00:00:00Z");
    const res = await pairActiveFpEntries({
      fpStore,
      brainStore: new BrainStore(repo),
      embedder: fakeEmbedder([1, 0]),
      runId: "run1",
      nowIso: "2026-05-21T00:00:00Z",
    });
    expect(res.paired).toBe(0);
  });

  it("is non-blocking on embed failure (returns paired:0, no throw)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-b3-embfail-"));
    const fpStore = await seedActive(repo);
    const throwing: Embedder = { embed: async () => { throw new Error("embed down"); } };
    const res = await pairActiveFpEntries({
      fpStore,
      brainStore: new BrainStore(repo),
      embedder: throwing,
      runId: "run1",
      nowIso: "2026-05-21T00:00:00Z",
    });
    expect(res.paired).toBe(0);
    expect((await fpStore.snapshot()).entries[0]?.linked_brain_id).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `bun test tests/unit/fp-brain-coupling.test.ts` → module not found.

- [ ] **Step 3: Implement**

```typescript
// src/core/brain/fp-coupling.ts
import { BrainEntrySchema } from "../../schemas/brain.ts";
import type { FpLedgerEntry } from "../../schemas/fp-ledger.ts";
import type { FpLedgerStore } from "../fp-ledger/store.ts";
import type { Embedder } from "./embeddings.ts";
import type { BrainStore } from "./store.ts";

// M5 Phase B3 — couple the FP-ledger to the Brain: every active/sticky FP entry
// gets a paired Brain `convention` entry (the human-readable "this is a known
// false positive — why"), cross-linked both ways. Idempotent (skips entries that
// already have linked_brain_id) and non-blocking (any embed/store error → paired:0,
// never throws into the caller). Contradiction-check is intentionally NOT here (B3b).
export async function pairActiveFpEntries(input: {
  fpStore: FpLedgerStore;
  brainStore: BrainStore;
  embedder: Embedder;
  embedCfg?: { model?: string; apiKeyEnv?: string; timeoutMs?: number };
  runId: string;
  nowIso: string;
}): Promise<{ paired: number }> {
  const snap = await input.fpStore.snapshot();
  const toPair = snap.entries.filter((e) => e.stage !== "candidate" && !e.linked_brain_id);
  if (toPair.length === 0) return { paired: 0 };

  const title = (e: FpLedgerEntry) =>
    `Known false positive: ${e.rule_id} in ${e.file}`.slice(0, 80);
  const body = (e: FpLedgerEntry) => {
    const reasons = e.rejects
      .map((r) => r.reason)
      .filter((r) => r && r.trim().length > 0)
      .slice(-3);
    return `Maintainers confirmed this is NOT a real issue (providers: ${e.distinct_providers.join(", ")}). ${reasons.join("; ")}`.slice(
      0,
      500,
    );
  };

  let vecs: number[][];
  try {
    vecs = await input.embedder.embed(
      toPair.map((e) => `${title(e)}\n${body(e)}`),
      input.embedCfg,
    );
  } catch {
    return { paired: 0 }; // non-blocking: brain coupling never fails the gate
  }
  if (vecs.length !== toPair.length) return { paired: 0 };

  let paired = 0;
  for (let i = 0; i < toPair.length; i++) {
    const e = toPair[i] as FpLedgerEntry;
    try {
      const brainId = await input.brainStore.addAllocatingId((allocId) =>
        BrainEntrySchema.parse({
          id: allocId,
          type: "convention",
          scope: "this-repo",
          title: title(e),
          body: body(e),
          tags: ["false-positive", e.rule_id],
          file_globs: [e.file],
          status: "candidate",
          referenced_count: 1,
          referencing_reviewers: [...e.distinct_providers],
          confidence: 0.9,
          embedding: vecs[i] ?? null,
          evidence: [],
          created_at: input.nowIso,
          source_run_id: input.runId,
          linked_fp_id: e.id,
        }),
      );
      await input.fpStore.mutate((idx) => {
        const t = idx.entries.find((x) => x.id === e.id);
        if (t) t.linked_brain_id = brainId;
        return { next: idx, result: undefined };
      });
      paired++;
    } catch {
      // best-effort per entry; continue with the rest
    }
  }
  return { paired };
}
```

- [ ] **Step 4: Run to verify it passes** — `bun test tests/unit/fp-brain-coupling.test.ts` → PASS (4 tests).
- [ ] **Step 5: typecheck + lint + commit** — `git add -A && git commit -m "feat(brain): B3 — pairActiveFpEntries + linked_fp_id (FP↔Brain coupling)"`

---

## Task 3: Wire the pairing into the orchestrator

**Files:** Modify `src/core/orchestrator.ts`

The embedder is currently built inline inside `runCuratorPhase`. Extract it so the B3 pairing (which must run even when there are no proposals) can reuse it.

- [ ] **Step 1: Extract `buildEmbedder`** — add a private method that returns the wrapped OpenRouter embedder or `null` (mirrors the existing inline logic in `runCuratorPhase`):

```typescript
  private buildEmbedder(
    brainCfg: NonNullable<ReviewgateConfig["phases"]["brain"]>,
  ): Embedder | null {
    const orAdapter = this.input.adapters.openrouter;
    if (!orAdapter || typeof (orAdapter as { embed?: unknown }).embed !== "function") return null;
    const orEmbed = orAdapter as unknown as {
      embed(
        text: string,
        opts: { model: string; apiKeyEnv: string; timeoutMs?: number },
      ): Promise<number[]>;
    };
    return {
      embed: async (texts, cfg) =>
        Promise.all(
          texts.map((t) =>
            orEmbed.embed(t, {
              model: cfg?.model ?? brainCfg.embeddings.model,
              apiKeyEnv: cfg?.apiKeyEnv ?? brainCfg.embeddings.apiKeyEnv,
              ...(cfg?.timeoutMs != null ? { timeoutMs: cfg.timeoutMs } : {}),
            }),
          ),
        ),
    };
  }
```

Then in `runCuratorPhase`, replace the inline embedder construction with: `const embedder = this.buildEmbedder(brainCfg); if (!embedder) return;`.

- [ ] **Step 2: Call the pairing post-verdict.** Find the Curator gate (`if (brainCfg?.enabled && proposals.length > 0) { await this.runCuratorPhase(...) }`). Add AFTER it (note: NOT gated on proposals — a previously-active FP may still need pairing):

```typescript
    // M5 Phase B3 — FP↔Brain coupling: pair active FP-ledger entries to brain
    // convention entries. Post-verdict + non-blocking, like the curator. Needs
    // BOTH brain and the FP-ledger enabled.
    if (brainCfg?.enabled && fpStore) {
      const embedder = this.buildEmbedder(brainCfg);
      if (embedder) {
        await pairActiveFpEntries({
          fpStore,
          brainStore: new BrainStore(repo),
          embedder,
          embedCfg: {
            model: brainCfg.embeddings.model,
            apiKeyEnv: brainCfg.embeddings.apiKeyEnv,
            timeoutMs: brainCfg.curatorTimeoutMs,
          },
          runId: opts.runId,
          nowIso: new Date().toISOString(),
        }).catch(() => undefined);
      }
    }
```

Imports: `import { pairActiveFpEntries } from "./brain/fp-coupling.ts";` (sorted into the `./brain/` group).

- [ ] **Step 3: Run** — `bun run typecheck && bun run lint && bun test` → clean / all pass (incl. existing brain-curator integration tests — confirm the `buildEmbedder` extraction didn't regress curation).
- [ ] **Step 4: commit** — `git add -A && git commit -m "feat(orchestrator): wire B3 FP↔Brain pairing (post-verdict, non-blocking)"`

---

## Task 4: Full-suite gate + DoD + merge

- [ ] **Step 1:** `bun test && bun run typecheck && bun run lint` → all pass / clean.
- [ ] **Step 2: DoD** (touches schema + orchestrator + brain): Codex Agent A (or OpenCode fallback while codex is usage-capped) reviewing `git diff master...HEAD`, run typecheck+lint itself → PASS = 0 CRITICAL/WARN; fix + re-run; then Claude Agent A → PASS. `rm -rf .review/`.
- [ ] **Step 3:** FF-merge to master, rebuild binary (verify boots), remove worktree, delete branch. Ask before pushing.
- [ ] **Step 4: Real e2e** (later, in flashbuddy): with brain + fpLedger enabled and an FP entry reaching `active`, confirm `brain.json` gets a paired `convention` entry whose `linked_fp_id` matches and the FP entry's `linked_brain_id` is set.

---

## Self-review (spec coverage)
- "On promotion to active, create a paired Brain convention entry" → Task 2 (`pairActiveFpEntries`, active/sticky filter) + Task 3 (wiring). ✓
- "Cross-link linked_brain_id ↔ linked_fp_id" → Task 1 (`linked_fp_id` schema) + Task 2 (both writes). ✓
- Non-blocking, post-verdict, idempotent → Task 2 (try/catch, `!linked_brain_id` filter) + Task 3 (`.catch`, after the verdict). ✓
- NOT in B3 core (deferred to B3b): contradiction cross-check of a new FP entry against existing brain entries (fuzzy / LLM-judge).
