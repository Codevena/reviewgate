import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder } from "../../src/core/brain/embeddings.ts";
import { type ContradictionJudge, pairActiveFpEntries } from "../../src/core/brain/fp-coupling.ts";
import { BrainStore } from "../../src/core/brain/store.ts";
import { FpLedgerStore } from "../../src/core/fp-ledger/store.ts";
import { BrainEntrySchema } from "../../src/schemas/brain.ts";

const fakeEmbedder = (vec: number[]): Embedder => ({ embed: async (t) => t.map(() => vec) });
const meta = { rule_id: "sql-injection", category: "security" as const, file: "a.ts", symbol: "" };

async function seedActive(repo: string, sig = "sigFP") {
  const s = new FpLedgerStore(repo);
  const t = "2026-05-21T00:00:00Z";
  await s.recordReject(
    sig,
    meta,
    { run_id: "r1", provider: "codex", reason: "intentional demo xx" },
    t,
  );
  await s.recordReject(
    sig,
    meta,
    { run_id: "r2", provider: "gemini", reason: "intentional demo xx" },
    t,
  );
  await s.recordReject(
    sig,
    meta,
    { run_id: "r3", provider: "codex", reason: "intentional demo xx" },
    t,
  );
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
    await fpStore.recordReject(
      "sigC",
      meta,
      { run_id: "r1", provider: "codex", reason: "x" },
      "2026-05-21T00:00:00Z",
    );
    const res = await pairActiveFpEntries({
      fpStore,
      brainStore: new BrainStore(repo),
      embedder: fakeEmbedder([1, 0]),
      runId: "run1",
      nowIso: "2026-05-21T00:00:00Z",
    });
    expect(res.paired).toBe(0);
  });

  it("re-links an ORPHAN brain entry instead of creating a duplicate (partial-write recovery)", async () => {
    // Simulate a prior run that created the paired brain entry but crashed BEFORE
    // writing linked_brain_id back to the FP entry. The FP is still unlinked, but
    // a brain entry with linked_fp_id == the FP id already exists. The next pairing
    // must RE-LINK (not create a second brain entry).
    const repo = mkdtempSync(join(tmpdir(), "rg-b3-orphan-"));
    const fpStore = await seedActive(repo);
    const fpId = (await fpStore.snapshot()).entries[0]?.id as string;
    const brainStore = new BrainStore(repo);
    const orphanId = await brainStore.addAllocatingId((id) =>
      BrainEntrySchema.parse({
        id,
        type: "convention",
        scope: "this-repo",
        title: "Known false positive: sql-injection in a.ts",
        body: "prior run",
        tags: ["false-positive", "sql-injection"],
        file_globs: ["a.ts"],
        status: "candidate",
        confidence: 0.9,
        evidence: [],
        created_at: "t",
        source_run_id: "prior",
        linked_fp_id: fpId,
      }),
    );
    const res = await pairActiveFpEntries({
      fpStore,
      brainStore,
      embedder: fakeEmbedder([1, 0]),
      runId: "run2",
      nowIso: "2026-05-21T00:00:00Z",
    });
    expect(res.paired).toBe(1);
    expect((await brainStore.snapshot()).entries).toHaveLength(1); // no duplicate
    expect((await fpStore.snapshot()).entries[0]?.linked_brain_id).toBe(orphanId);
  });

  it("is non-blocking on embed failure (returns paired:0, no throw)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-b3-embfail-"));
    const fpStore = await seedActive(repo);
    const throwing: Embedder = {
      embed: async () => {
        throw new Error("embed down");
      },
    };
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

  // --- B3b: contradiction check ---
  async function seedActiveBrain(repo: string): Promise<BrainStore> {
    const bs = new BrainStore(repo);
    await bs.add(
      BrainEntrySchema.parse({
        id: "B-001",
        type: "anti-pattern",
        scope: "this-repo",
        title: "sql-injection is always a real bug here",
        body: "Never dismiss sql-injection findings in this repo.",
        tags: ["sql-injection"],
        file_globs: ["a.ts"],
        status: "active",
        confidence: 0.9,
        evidence: [],
        created_at: "t",
        source_run_id: "seed",
      }),
    );
    return bs;
  }
  const yesJudge: ContradictionJudge = async () => ({
    contradicts: true,
    brain_entry_id: "B-001",
    reason: "anti-pattern asserts this rule is real",
  });
  const noJudge: ContradictionJudge = async () => ({ contradicts: false });

  it("B3b: skips pairing + flags contradicts_brain_id when the judge finds a contradiction", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-b3b-yes-"));
    const fpStore = await seedActive(repo);
    const brainStore = await seedActiveBrain(repo);
    const res = await pairActiveFpEntries({
      fpStore,
      brainStore,
      embedder: fakeEmbedder([1, 0]),
      runId: "run1",
      nowIso: "2026-05-21T00:00:00Z",
      judge: yesJudge,
    });
    expect(res.paired).toBe(0);
    expect(res.contradictions).toBe(1);
    const fp = (await fpStore.snapshot()).entries[0];
    expect(fp?.contradicts_brain_id).toBe("B-001");
    expect(fp?.linked_brain_id).toBeUndefined();
    // no NEW brain entry was created (only the seeded B-001 remains)
    expect((await brainStore.snapshot()).entries).toHaveLength(1);
  });

  it("B3b: pairs normally when the judge finds NO contradiction", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-b3b-no-"));
    const fpStore = await seedActive(repo);
    const brainStore = await seedActiveBrain(repo);
    const res = await pairActiveFpEntries({
      fpStore,
      brainStore,
      embedder: fakeEmbedder([1, 0]),
      runId: "run1",
      nowIso: "2026-05-21T00:00:00Z",
      judge: noJudge,
    });
    expect(res.paired).toBe(1);
    expect(res.contradictions).toBe(0);
    expect((await fpStore.snapshot()).entries[0]?.linked_brain_id).toBeDefined();
  });

  it("B3b: a judge error fails OPEN (pairs anyway)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-b3b-err-"));
    const fpStore = await seedActive(repo);
    const brainStore = await seedActiveBrain(repo);
    const throwingJudge: ContradictionJudge = async () => {
      throw new Error("judge down");
    };
    const res = await pairActiveFpEntries({
      fpStore,
      brainStore,
      embedder: fakeEmbedder([1, 0]),
      runId: "run1",
      nowIso: "2026-05-21T00:00:00Z",
      judge: throwingJudge,
    });
    expect(res.paired).toBe(1);
    expect((await fpStore.snapshot()).entries[0]?.linked_brain_id).toBeDefined();
  });

  it("B3b: a contradiction-flagged entry is not re-checked on a later run", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-b3b-idem-"));
    const fpStore = await seedActive(repo);
    const brainStore = await seedActiveBrain(repo);
    const args = {
      fpStore,
      brainStore,
      embedder: fakeEmbedder([1, 0]),
      runId: "run1",
      nowIso: "2026-05-21T00:00:00Z",
      judge: yesJudge,
    };
    await pairActiveFpEntries(args);
    const res2 = await pairActiveFpEntries(args);
    expect(res2.paired).toBe(0);
    expect(res2.contradictions).toBe(0); // already flagged → not re-checked
  });
});
