// tests/unit/brain-curator-model-dedup.test.ts
//
// Finding 5: cross-entry dedup compared cosine similarity across embeddings that
// could have been produced by DIFFERENT embedding models (cosine is only
// meaningful WITHIN one model's vector space). BrainEntry now records an optional
// `embedding_model`, and the curator only treats an existing entry as a duplicate
// when its model matches cfg.model (legacy entries with no recorded model are
// still compared, for back-compat).
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCurator } from "../../src/core/brain/curator.ts";
import type { Embedder } from "../../src/core/brain/embeddings.ts";
import { BrainStore } from "../../src/core/brain/store.ts";
import type { BrainEntry, MemoryProposal } from "../../src/schemas/brain.ts";

const fakeEmbedder = (vec: number[]): Embedder => ({ embed: async (t) => t.map(() => vec) });

function proposal(over: Partial<MemoryProposal> = {}): MemoryProposal {
  return {
    type: "convention",
    scope: "this-repo",
    title: "fresh title not matching existing",
    body: "b",
    confidence: 0.8,
    tags: [],
    evidence: [
      { kind: "reviewer-finding", run_id: "r", reviewer_id: "codex-security" },
      { kind: "reviewer-finding", run_id: "r", reviewer_id: "gemini-architecture" },
    ],
    ...over,
  };
}

const existing = (over: Partial<BrainEntry>): BrainEntry => ({
  id: "B-existing",
  type: "convention",
  scope: "this-repo",
  title: "an existing active entry",
  body: "b",
  tags: [],
  file_globs: [],
  status: "active",
  referenced_count: 1,
  referencing_reviewers: ["codex"],
  confidence: 0.9,
  embedding: [1, 0],
  evidence: [{ kind: "reviewer-finding", run_id: "r0", reviewer_id: "codex" }],
  created_at: "2026-05-01T00:00:00Z",
  source_run_id: "r0",
  ...over,
});

describe("runCurator — model-aware cross-entry dedup (Finding 5)", () => {
  it("does NOT merge into an existing entry embedded by a DIFFERENT model", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-cur-mdedup-"));
    const store = new BrainStore(repo);
    // Existing entry embedded by model-A with an identical vector to what the
    // curator (running model-B) will produce — cosine would be 1.0.
    await store.add(existing({ embedding: [1, 0], embedding_model: "model-A" }));

    const res = await runCurator({
      repoRoot: repo,
      runId: "r",
      proposals: [proposal()],
      store,
      embedder: fakeEmbedder([1, 0]),
      embedCfg: { model: "model-B" },
      nowIso: "2026-05-21T00:00:00Z",
    });

    // Cross-model cosine is skipped → no false merge → a NEW candidate is promoted.
    expect(res.merged).toBe(0);
    expect(res.promoted).toBe(1);
    const entries = (await store.snapshot()).entries;
    expect(entries).toHaveLength(2);
    const promoted = entries.find((e) => e.id !== "B-existing");
    expect(promoted?.embedding_model).toBe("model-B"); // model recorded on promotion
  });

  it("DOES merge into an existing entry embedded by the SAME model", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-cur-mdedup2-"));
    const store = new BrainStore(repo);
    await store.add(existing({ embedding: [1, 0], embedding_model: "model-B" }));

    const res = await runCurator({
      repoRoot: repo,
      runId: "r",
      proposals: [proposal()],
      store,
      embedder: fakeEmbedder([1, 0]),
      embedCfg: { model: "model-B" },
      nowIso: "2026-05-21T00:00:00Z",
    });

    expect(res.merged).toBe(1);
    expect(res.promoted).toBe(0);
    expect((await store.snapshot()).entries).toHaveLength(1); // bumped, not duplicated
  });

  it("treats a legacy entry with NO embedding_model as same-model (back-compat merge)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-cur-mdedup3-"));
    const store = new BrainStore(repo);
    // No embedding_model field → existing data still dedups.
    const legacy = existing({ embedding: [1, 0] });
    // biome-ignore lint/performance/noDelete: simulate a pre-field persisted entry
    delete (legacy as { embedding_model?: string }).embedding_model;
    await store.add(legacy);

    const res = await runCurator({
      repoRoot: repo,
      runId: "r",
      proposals: [proposal()],
      store,
      embedder: fakeEmbedder([1, 0]),
      embedCfg: { model: "model-B" },
      nowIso: "2026-05-21T00:00:00Z",
    });

    expect(res.merged).toBe(1);
    expect(res.promoted).toBe(0);
  });
});
