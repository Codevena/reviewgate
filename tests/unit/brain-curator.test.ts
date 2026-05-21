import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerOf, runCurator } from "../../src/core/brain/curator.ts";
import type { Embedder } from "../../src/core/brain/embeddings.ts";
import { BrainStore } from "../../src/core/brain/store.ts";
import type { MemoryProposal } from "../../src/schemas/brain.ts";

const fakeEmbedder = (vec: number[]): Embedder => ({ embed: async (t) => t.map(() => vec) });

function p(over: Partial<MemoryProposal> = {}): MemoryProposal {
  return {
    type: "convention",
    scope: "this-repo",
    title: "t",
    body: "b",
    confidence: 0.8,
    tags: [],
    evidence: [
      { kind: "reviewer-finding", run_id: "r", reviewer_id: "codex-security" },
      { kind: "reviewer-finding", run_id: "r", reviewer_id: "gemini-architecture" },
      { kind: "reviewer-finding", run_id: "r", reviewer_id: "claude-adversarial" },
    ],
    ...over,
  };
}

describe("runCurator", () => {
  it("promotes a 3-citation / ≥2-provider proposal as a candidate", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-cur-"));
    const store = new BrainStore(repo);
    const res = await runCurator({
      repoRoot: repo,
      runId: "r",
      proposals: [p()],
      store,
      embedder: fakeEmbedder([1, 0]),
      nowIso: "2026-05-21T00:00:00Z",
    });
    expect(res.promoted).toBe(1);
    expect((await store.snapshot()).entries[0]?.status).toBe("candidate");
  });

  it("rejects a single-provider quorum (anti-collusion rule 2)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-cur2-"));
    const store = new BrainStore(repo);
    const single = p({
      evidence: [
        { kind: "reviewer-finding", run_id: "r", reviewer_id: "codex-security" },
        { kind: "reviewer-finding", run_id: "r", reviewer_id: "codex-architecture" },
        { kind: "reviewer-finding", run_id: "r", reviewer_id: "codex-adversarial" },
      ],
    });
    const res = await runCurator({
      repoRoot: repo,
      runId: "r",
      proposals: [single],
      store,
      embedder: fakeEmbedder([1, 0]),
      nowIso: "t",
    });
    expect(res.promoted).toBe(0);
  });

  it("merges a near-duplicate (cosine ≥ 0.85) instead of adding a new entry", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-cur3-"));
    const store = new BrainStore(repo);
    await runCurator({
      repoRoot: repo,
      runId: "r1",
      proposals: [p({ title: "x" })],
      store,
      embedder: fakeEmbedder([1, 0]),
      nowIso: "t",
    });
    const res = await runCurator({
      repoRoot: repo,
      runId: "r2",
      proposals: [p({ title: "x2" })],
      store,
      embedder: fakeEmbedder([1, 0]),
      nowIso: "t",
    });
    expect(res.promoted).toBe(0);
    expect((await store.snapshot()).entries.length).toBe(1);
    expect((await store.snapshot()).entries[0]?.referenced_count).toBe(2);
  });

  it("caps promotions at 3 per run and queues the rest", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-cur4-"));
    const store = new BrainStore(repo);
    // 4 DISTINCT proposals — each gets a mutually-orthogonal unit vector
    // (cosine 0 < 0.85) so neither grouping nor dedup folds them together. With
    // each emitted by ≥2 providers all 4 meet quorum; the run cap promotes 3,
    // queues 1.
    const basis: Record<string, number[]> = {
      p0: [1, 0, 0, 0],
      p1: [0, 1, 0, 0],
      p2: [0, 0, 1, 0],
      p3: [0, 0, 0, 1],
    };
    const embedder: Embedder = {
      embed: async (t) =>
        t.map((s) => {
          const key = (Object.keys(basis) as string[]).find((k) => s.startsWith(k));
          return (key ? basis[key] : [1, 0, 0, 0]) as number[];
        }),
    };
    const props = [0, 1, 2, 3].map((i) =>
      p({
        title: `p${i}`,
        body: `body ${i}`,
        evidence: [
          { kind: "reviewer-finding", run_id: "r", reviewer_id: "codex-security" },
          { kind: "reviewer-finding", run_id: "r", reviewer_id: "codex-security" },
          { kind: "reviewer-finding", run_id: "r", reviewer_id: "gemini-architecture" },
        ],
      }),
    );
    const res = await runCurator({
      repoRoot: repo,
      runId: "r",
      proposals: props,
      store,
      embedder,
      nowIso: "t",
    });
    expect(res.promoted).toBeLessThanOrEqual(3);
    expect(res.queued).toBeGreaterThanOrEqual(1);
  });

  it("fails closed when embedding errors (queues, does not promote)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-cur5-"));
    const store = new BrainStore(repo);
    const boom: Embedder = {
      embed: async () => {
        throw new Error("embeddings down");
      },
    };
    const res = await runCurator({
      repoRoot: repo,
      runId: "r",
      proposals: [p()],
      store,
      embedder: boom,
      nowIso: "t",
    });
    expect(res.promoted).toBe(0);
    expect(res.queued).toBe(1);
  });

  it("hybrid: a configured LLM judge can reject a proposal that passed the deterministic gates", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-cur-judge-"));
    const store = new BrainStore(repo);
    const rejectJudge = async () => ({ accept: false, reason: "contradicts existing convention" });
    const res = await runCurator({
      repoRoot: repo,
      runId: "r",
      proposals: [p()],
      store,
      embedder: fakeEmbedder([1, 0]),
      nowIso: "t",
      judge: rejectJudge,
    });
    expect(res.promoted).toBe(0);
    expect(res.rejected).toBe(1);
  });

  it("requires doubled quorum for diff-derived proposals", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-cur6-"));
    const store = new BrainStore(repo);
    const diffDerived = p({
      evidence: [
        {
          kind: "reviewer-observation",
          run_id: "r",
          reviewer_id: "codex-security",
          from_diff: { file: "a.ts", line_start: 1, line_end: 2 },
        },
        {
          kind: "reviewer-observation",
          run_id: "r",
          reviewer_id: "gemini-arch",
          from_diff: { file: "a.ts", line_start: 1, line_end: 2 },
        },
        {
          kind: "reviewer-observation",
          run_id: "r",
          reviewer_id: "claude-x",
          from_diff: { file: "a.ts", line_start: 1, line_end: 2 },
        },
      ],
    });
    const res = await runCurator({
      repoRoot: repo,
      runId: "r",
      proposals: [diffDerived],
      store,
      embedder: fakeEmbedder([1, 0]),
      nowIso: "t",
    });
    expect(res.promoted).toBe(0); // 3 < doubled threshold (6)
  });

  it("GROUPS similar single-provider proposals across reviewers → reaches cross-provider quorum", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-cur-group-"));
    const store = new BrainStore(repo);
    // Two proposals with IDENTICAL title+body, each emitted by a DIFFERENT
    // provider (codex / gemini), each carrying 2 reviewer evidence items. On
    // their own neither meets quorum (single provider). Grouped (cosine 1.0) the
    // merged evidence = 4 items across 2 providers → promoted as ONE entry.
    const sameVec = [1, 0];
    const codexProp = p({
      evidence: [
        { kind: "reviewer-observation", run_id: "r", reviewer_id: "codex-security" },
        { kind: "reviewer-observation", run_id: "r", reviewer_id: "codex-security" },
      ],
    });
    const geminiProp = p({
      evidence: [
        { kind: "reviewer-observation", run_id: "r", reviewer_id: "gemini-architecture" },
        { kind: "reviewer-observation", run_id: "r", reviewer_id: "gemini-architecture" },
      ],
    });
    const res = await runCurator({
      repoRoot: repo,
      runId: "r",
      proposals: [codexProp, geminiProp],
      store,
      embedder: fakeEmbedder(sameVec),
      nowIso: "2026-05-21T00:00:00Z",
    });
    expect(res.promoted).toBe(1); // one representative entry per surviving group
    expect((await store.snapshot()).entries.length).toBe(1);
  });

  it("does NOT promote when ALL grouped proposals are from the SAME provider (anti-collusion)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-cur-collude-"));
    const store = new BrainStore(repo);
    // Two similar proposals, but BOTH emitted by codex (as the orchestrator would
    // stamp a single colluding reviewer). Merged evidence spans only 1 provider →
    // quorum fails even though there are ≥3 reviewer items.
    const a = p({
      evidence: [
        { kind: "reviewer-observation", run_id: "r", reviewer_id: "codex-security" },
        { kind: "reviewer-observation", run_id: "r", reviewer_id: "codex-security" },
      ],
    });
    const b = p({
      evidence: [{ kind: "reviewer-observation", run_id: "r", reviewer_id: "codex-security" }],
    });
    const res = await runCurator({
      repoRoot: repo,
      runId: "r",
      proposals: [a, b],
      store,
      embedder: fakeEmbedder([1, 0]),
      nowIso: "t",
    });
    expect(res.promoted).toBe(0);
  });

  it("counts a single web-fetch item as quorum (deterministic-source path)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-cur-web-"));
    const store = new BrainStore(repo);
    const webProp = p({
      type: "external-knowledge",
      scope: "framework-next",
      evidence: [
        {
          kind: "web-fetch",
          source_url: "https://docs.example.com/x",
          body_sha256: "a".repeat(64),
          fetched_at: "2026-05-21T00:00:00Z",
        },
      ],
    });
    const res = await runCurator({
      repoRoot: repo,
      runId: "r",
      proposals: [webProp],
      store,
      embedder: fakeEmbedder([1, 0]),
      nowIso: "t",
    });
    expect(res.promoted).toBe(1);
  });
});

describe("providerOf (longest-prefix provider extraction)", () => {
  it("maps known reviewer ids to their provider via longest-prefix", () => {
    expect(providerOf("codex-security")).toBe("codex");
    expect(providerOf("gemini-architecture")).toBe("gemini");
    // The bug guard: claude-code-security must NOT collapse to "claude".
    expect(providerOf("claude-code-security")).toBe("claude-code");
    expect(providerOf("claude-code")).toBe("claude-code");
    expect(providerOf("openrouter-adversarial")).toBe("openrouter");
  });

  it("falls back to the part before the last dash for unknown providers", () => {
    expect(providerOf("acme-tool-security")).toBe("acme-tool");
    expect(providerOf("solo")).toBe("solo");
  });
});
