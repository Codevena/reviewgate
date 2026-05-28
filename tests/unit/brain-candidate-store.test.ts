import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CandidateStore } from "../../src/core/brain/candidate-store.ts";
import type { BrainCandidate } from "../../src/schemas/brain.ts";
import { brainCandidatesPath } from "../../src/utils/paths.ts";

function repo() {
  return mkdtempSync(join(tmpdir(), "rg-cand-"));
}
function mkCandidate(over: Partial<BrainCandidate> = {}): BrainCandidate {
  return {
    id: "C-001",
    title: "use prepared queries",
    body: "always parameterize SQL",
    scope: "language-ts",
    type: "convention",
    embedding: [0.1, 0.2, 0.3],
    embedding_model: "bge-base-en-v1.5",
    provider: "codex",
    source_run_id: "R1",
    created_at: new Date("2026-05-28T00:00:00Z").toISOString(),
    evidence_kinds: ["reviewer-observation"],
    confidence: 0.8,
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
    const p = brainCandidatesPath(r);
    writeFileSync(p, `${readFileSync(p, "utf8")}{"id":"C-002","title":"trunc`);
    const back = await s.listAll();
    expect(back).toHaveLength(1);
    expect(back[0]?.id).toBe("C-001");
  });
});

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
  it("same provider + same embedding but DIFFERENT embedding_model → two entries", async () => {
    const r = repo();
    const s = new CandidateStore(r);
    await s.addOrMerge(
      mkCandidate({
        id: "C-001",
        provider: "codex",
        embedding: [1, 0, 0],
        embedding_model: "model-A",
      }),
    );
    await s.addOrMerge(
      mkCandidate({
        id: "C-002",
        provider: "codex",
        embedding: [1, 0, 0],
        embedding_model: "model-B",
      }),
    );
    expect(await s.listAll()).toHaveLength(2);
  });
});

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
    await s.addOrMerge(mkCandidate({ id: "old", created_at: "2026-01-01T00:00:00Z" }));
    await s.addOrMerge(
      mkCandidate({ id: "new", embedding: [0, 1, 0], created_at: NOW.toISOString() }),
    );
    const res = await s.prune(NOW, { ttlDays: 60, maxEntries: 5000 });
    expect(res.expired).toBe(1);
    expect(res.capped).toBe(0);
    const back = await s.listAll();
    expect(back.map((e) => e.id)).toEqual(["new"]);
  });

  it("caps at maxEntries, dropping the oldest first", async () => {
    const r = repo();
    const s = new CandidateStore(r);
    for (let i = 0; i < 3; i++) {
      const day = new Date(NOW.getTime() - (3 - i) * 86_400_000);
      const emb = [0, 0, 0];
      emb[i] = 1;
      await s.addOrMerge(
        mkCandidate({ id: `E${i}`, embedding: emb, created_at: day.toISOString() }),
      );
    }
    const res = await s.prune(NOW, { ttlDays: 60, maxEntries: 2 });
    expect(res.capped).toBe(1);
    const back = await s.listAll();
    expect(back.map((e) => e.id)).toEqual(["E1", "E2"]); // E0 dropped (oldest); E1+E2 in oldest→newest order
  });

  it("TTL boundary: an entry exactly at ttlDays is KEPT; 1ms older is expired", async () => {
    const r = repo();
    const s = new CandidateStore(r);
    const ttlMs = 60 * 86_400_000;
    await s.addOrMerge(
      mkCandidate({ id: "edge", created_at: new Date(NOW.getTime() - ttlMs).toISOString() }),
    );
    await s.addOrMerge(
      mkCandidate({
        id: "older",
        embedding: [0, 1, 0],
        created_at: new Date(NOW.getTime() - ttlMs - 1).toISOString(),
      }),
    );
    const res = await s.prune(NOW, { ttlDays: 60, maxEntries: 5000 });
    expect(res.expired).toBe(1);
    const back = await s.listAll();
    expect(back.map((e) => e.id)).toEqual(["edge"]);
  });
});
