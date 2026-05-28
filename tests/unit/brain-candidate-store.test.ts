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
