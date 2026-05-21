import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder } from "../../src/core/brain/embeddings.ts";
import { pairActiveFpEntries } from "../../src/core/brain/fp-coupling.ts";
import { BrainStore } from "../../src/core/brain/store.ts";
import { FpLedgerStore } from "../../src/core/fp-ledger/store.ts";

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
});
