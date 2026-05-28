import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CandidateStore } from "../../src/core/brain/candidate-store.ts";
import {
  normalizeProposal,
  normalizeProposalResult,
  providerOf,
  runCurator,
} from "../../src/core/brain/curator.ts";
import type { Embedder } from "../../src/core/brain/embeddings.ts";
import { decayPass } from "../../src/core/brain/lifecycle.ts";
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

  it("END-TO-END: a convention re-proposed across 3 runs by ≥2 providers reaches active", async () => {
    // The headline fix: candidate → active was previously unreachable. Re-proposing
    // the same convention (dup-merge) across runs accrues references; once
    // referenced_count≥3 with ≥2 distinct providers, decayPass promotes it.
    const repo = mkdtempSync(join(tmpdir(), "rg-cur-e2e-"));
    const store = new BrainStore(repo);
    const base = { repoRoot: repo, store, embedder: fakeEmbedder([1, 0]) };
    const ev = (run: string, rid: string) => ({
      kind: "reviewer-finding" as const,
      run_id: run,
      reviewer_id: rid,
    });
    for (const run of ["r1", "r2", "r3"]) {
      await runCurator({
        ...base,
        runId: run,
        nowIso: `2026-05-21T0${["r1", "r2", "r3"].indexOf(run)}:00:00Z`,
        proposals: [p({ evidence: [ev(run, "codex-security"), ev(run, "gemini-architecture")] })],
      });
    }
    expect((await store.snapshot()).entries[0]?.status).toBe("candidate");
    expect((await store.snapshot()).entries[0]?.referenced_count).toBe(3);
    await decayPass(store, repo, "2026-05-21T03:00:00Z");
    expect((await store.snapshot()).entries[0]?.status).toBe("active");
  });

  it("unions new providers into referencing_reviewers on a duplicate re-proposal", async () => {
    // The dup-merge path used to bump referenced_count only, freezing
    // referencing_reviewers at the creation set → candidate→active was unreachable.
    const repo = mkdtempSync(join(tmpdir(), "rg-cur-union-"));
    const store = new BrainStore(repo);
    const base = { repoRoot: repo, store, embedder: fakeEmbedder([1, 0]) };
    await runCurator({
      ...base,
      runId: "r1",
      nowIso: "2026-05-21T00:00:00Z",
      proposals: [
        p({
          evidence: [
            { kind: "reviewer-finding", run_id: "r1", reviewer_id: "codex-security" },
            { kind: "reviewer-finding", run_id: "r1", reviewer_id: "gemini-architecture" },
          ],
        }),
      ],
    });
    const res2 = await runCurator({
      ...base,
      runId: "r2",
      nowIso: "2026-05-22T00:00:00Z",
      proposals: [
        p({
          evidence: [
            { kind: "reviewer-finding", run_id: "r2", reviewer_id: "codex-security" },
            { kind: "reviewer-finding", run_id: "r2", reviewer_id: "claude-adversarial" },
          ],
        }),
      ],
    });
    expect(res2.merged).toBe(1);
    const e = (await store.snapshot()).entries[0];
    expect(e?.referenced_count).toBe(2);
    expect(new Set(e?.referencing_reviewers)).toEqual(new Set(["codex", "gemini", "claude"]));
  });

  it("promotes when TWO providers each emit ONE evidence item for the same convention (realistic convergence)", async () => {
    // The real panel synthesizes ~1 evidence item per proposal, so two distinct
    // providers independently proposing the same convention is the realistic best
    // case: 2 items spanning 2 providers. This must promote (anti-collusion only
    // requires ≥2 DISTINCT providers — not ≥3 raw items).
    const repo = mkdtempSync(join(tmpdir(), "rg-cur-conv-"));
    const store = new BrainStore(repo);
    const res = await runCurator({
      repoRoot: repo,
      runId: "r",
      proposals: [
        p({
          title: "prefer X",
          evidence: [{ kind: "reviewer-observation", run_id: "r", reviewer_id: "codex-security" }],
        }),
        p({
          title: "prefer X",
          evidence: [
            { kind: "reviewer-observation", run_id: "r", reviewer_id: "gemini-architecture" },
          ],
        }),
      ],
      store,
      embedder: fakeEmbedder([1, 0]),
      nowIso: "2026-05-21T00:00:00Z",
    });
    expect(res.promoted).toBe(1);
    const e = (await store.snapshot()).entries[0];
    expect(e?.status).toBe("candidate");
    expect(e?.referencing_reviewers?.sort()).toEqual(["codex", "gemini"]);
  });

  it("does NOT promote a diff-derived convention from only TWO providers (stricter diff quorum)", async () => {
    // from_diff evidence makes the group 'doubled' → needs ≥3 distinct providers.
    const repo = mkdtempSync(join(tmpdir(), "rg-cur-diff-"));
    const store = new BrainStore(repo);
    const diffEv = (rid: string) => ({
      kind: "reviewer-finding" as const,
      run_id: "r",
      reviewer_id: rid,
      from_diff: { file: "a.ts", line_start: 1, line_end: 1 },
    });
    const res = await runCurator({
      repoRoot: repo,
      runId: "r",
      proposals: [
        p({ title: "diff conv", evidence: [diffEv("codex-security")] }),
        p({ title: "diff conv", evidence: [diffEv("gemini-architecture")] }),
      ],
      store,
      embedder: fakeEmbedder([1, 0]),
      nowIso: "2026-05-21T00:00:00Z",
    });
    expect(res.promoted).toBe(0); // 2 providers < the diff-derived ≥3 requirement
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

  it("diff-derived requires a STRICTER provider quorum (≥3 distinct) — 2 providers is rejected", async () => {
    // Diff-derived knowledge is more speculative, so it needs an extra provider
    // vs general knowledge (≥3 distinct vs ≥2). 3 reviewer items but only 2
    // distinct providers (codex + gemini) → still rejected.
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
          reviewer_id: "codex-architecture",
          from_diff: { file: "a.ts", line_start: 1, line_end: 2 },
        },
        {
          kind: "reviewer-observation",
          run_id: "r",
          reviewer_id: "gemini-arch",
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
    expect(res.promoted).toBe(0); // only 2 distinct providers < diff-derived's ≥3
  });

  it("promotes a diff-derived proposal backed by ≥3 DISTINCT providers (panel-relative quorum)", async () => {
    // Pre-fix this needed ≥6 reviewer evidence items — unreachable with a 4-reviewer
    // panel and no web-fetch, so diff-derived memories could NEVER promote. The
    // panel-relative rule requires ≥3 distinct providers instead.
    const repo = mkdtempSync(join(tmpdir(), "rg-cur6b-"));
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
          reviewer_id: "claude-code-adversarial",
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
    expect(res.promoted).toBe(1); // 3 distinct providers meets diff-derived quorum
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

  it("groups paraphrased proposals at cosine ~0.80 (≥ GROUP_THRESHOLD) → reaches cross-provider quorum", async () => {
    // The same convention worded differently by two providers embeds to similar
    // (not identical) vectors. With the old 0.85 group threshold these paraphrases
    // stayed separate single-provider singletons and never reached quorum; at 0.78
    // they cluster (cosine 0.80) → merged evidence spans 2 providers → promoted.
    const repo = mkdtempSync(join(tmpdir(), "rg-cur-para-"));
    const store = new BrainStore(repo);
    // a=[1,0], b=[0.8,0.6] → cosine 0.80 (both unit vectors): between 0.78 and 0.85.
    const embedder: Embedder = {
      embed: async (t) => t.map((s) => (s.startsWith("conv-a") ? [1, 0] : [0.8, 0.6])),
    };
    const codexProp = p({
      title: "conv-a phrasing",
      evidence: [
        { kind: "reviewer-observation", run_id: "r", reviewer_id: "codex-security" },
        { kind: "reviewer-observation", run_id: "r", reviewer_id: "codex-security" },
      ],
    });
    const geminiProp = p({
      title: "conv-b phrasing",
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
      embedder,
      nowIso: "2026-05-21T00:00:00Z",
    });
    expect(res.promoted).toBe(1); // clustered at 0.80 → 4 items / 2 providers
    expect((await store.snapshot()).entries.length).toBe(1);
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

  it("cross-run quorum: 1 stored candidate + 1 new from DIFFERENT provider → promote", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-xrun-"));
    const store = new BrainStore(repo);
    const candStore = new CandidateStore(repo);
    // Pre-seed: codex proposed P some days ago; stored in the candidate pool.
    await candStore.addOrMerge({
      id: "C-001",
      title: "use prepared queries",
      body: "always parameterize SQL",
      scope: "language-ts",
      type: "convention",
      embedding: [1, 0, 0],
      embedding_model: "bge",
      provider: "codex",
      source_run_id: "R-old",
      created_at: new Date().toISOString(),
      evidence_kinds: ["reviewer-observation"],
      confidence: 0.85,
    });
    // Today: gemini proposes a semantically identical P (same embedding).
    const res = await runCurator({
      repoRoot: repo,
      runId: "R-new",
      nowIso: new Date().toISOString(),
      proposals: [
        p({
          title: "use prepared queries",
          body: "always parameterize SQL",
          evidence: [
            {
              kind: "reviewer-observation",
              snippet: "from gemini",
              run_id: "R-new",
              reviewer_id: "gemini",
            },
          ],
        }),
      ],
      embedder: { embed: async () => [[1, 0, 0]] },
      embedCfg: { model: "bge", apiKeyEnv: "X", timeoutMs: 8000 },
      store,
      candidateStore: candStore,
      crossRunCfg: { enabled: true, ttlDays: 60, maxEntries: 5000 },
      judge: async () => ({ accept: true }),
    });
    expect(res.promoted).toBe(1); // cross-run quorum kicked in → judge accepted → promoted
    const snap = await store.snapshot();
    expect(snap.entries.length).toBe(1);
  });

  it("cross-run quorum: embedding_model mismatch → candidate NOT matched (no spurious quorum from incompatible models)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-xrun-mm-"));
    const store = new BrainStore(repo);
    const candStore = new CandidateStore(repo);
    // Stored candidate was embedded with an OLDER model; same vector by coincidence.
    await candStore.addOrMerge({
      id: "C-old",
      title: "use prepared queries",
      body: "always parameterize SQL",
      scope: "language-ts",
      type: "convention",
      embedding: [1, 0, 0],
      embedding_model: "ada-002",
      provider: "codex",
      source_run_id: "R-old",
      created_at: new Date().toISOString(),
      evidence_kinds: ["reviewer-observation"],
      confidence: 0.85,
    });
    const res = await runCurator({
      repoRoot: repo,
      runId: "R-new",
      nowIso: new Date().toISOString(),
      proposals: [
        p({
          title: "use prepared queries",
          body: "always parameterize SQL",
          evidence: [
            {
              kind: "reviewer-observation",
              snippet: "from gemini",
              run_id: "R-new",
              reviewer_id: "gemini",
            },
          ],
        }),
      ],
      embedder: { embed: async () => [[1, 0, 0]] },
      embedCfg: { model: "bge", apiKeyEnv: "X", timeoutMs: 8000 }, // ← NEW model, mismatches "ada-002"
      store,
      candidateStore: candStore,
      crossRunCfg: { enabled: true, ttlDays: 60, maxEntries: 5000 },
      judge: async () => ({ accept: true }),
    });
    expect(res.promoted).toBe(0); // model mismatch → no cross-run match → only 1 provider → quorum fails
    const snap = await store.snapshot();
    expect(snap.entries.length).toBe(0);
  });

  it("on promote success: matched candidates are deleted from the pool", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-promo-delete-"));
    const store = new BrainStore(repo);
    const candStore = new CandidateStore(repo);
    await candStore.addOrMerge({
      id: "C-old",
      title: "use prepared queries",
      body: "always parameterize SQL",
      scope: "language-ts",
      type: "convention",
      embedding: [1, 0, 0],
      embedding_model: "bge",
      provider: "codex",
      source_run_id: "R-old",
      created_at: new Date().toISOString(),
      evidence_kinds: ["reviewer-observation"],
      confidence: 0.85,
    });
    const res = await runCurator({
      repoRoot: repo,
      runId: "R-new",
      nowIso: new Date().toISOString(),
      proposals: [
        p({
          title: "use prepared queries",
          body: "always parameterize SQL",
          evidence: [
            {
              kind: "reviewer-observation",
              snippet: "from gemini",
              reviewer_id: "gemini",
              run_id: "R-new",
            },
          ],
        }),
      ],
      embedder: { embed: async () => [[1, 0, 0]] },
      embedCfg: { model: "bge", apiKeyEnv: "X" },
      store,
      candidateStore: candStore,
      crossRunCfg: { enabled: true, ttlDays: 60, maxEntries: 5000 },
      judge: async () => ({ accept: true }),
    });
    expect(res.promoted).toBe(1);
    // The matched cross-run candidate is gone after the promote — it's now a brain entry.
    expect(await candStore.listAll()).toHaveLength(0);
  });

  it("on quorum-still-fail: single-provider rep is stored in the candidate pool", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-storefail-"));
    const candStore = new CandidateStore(repo);
    const store = new BrainStore(repo);
    const res = await runCurator({
      repoRoot: repo,
      runId: "R-1",
      nowIso: new Date().toISOString(),
      proposals: [
        p({
          title: "lone observation",
          evidence: [
            { kind: "reviewer-observation", snippet: "x", reviewer_id: "codex", run_id: "R-1" },
          ],
        }),
      ],
      embedder: { embed: async () => [[1, 0, 0]] },
      embedCfg: { model: "bge", apiKeyEnv: "X" },
      store,
      candidateStore: candStore,
      crossRunCfg: { enabled: true, ttlDays: 60, maxEntries: 5000 },
      judge: async () => ({ accept: true }),
    });
    expect(res.promoted).toBe(0);
    const pool = await candStore.listAll();
    expect(pool).toHaveLength(1);
    expect(pool[0]?.provider).toBe("codex");
    expect(pool[0]?.embedding_model).toBe("bge");
    expect(pool[0]?.title).toBe("lone observation");
    expect(pool[0]?.source_run_id).toBe("R-1");
    expect(pool[0]?.confidence).toBeGreaterThan(0); // rep.confidence carried through (whatever p() sets it to)
  });
});

describe("normalizeProposal", () => {
  // --- (a) overlong title + body normalised, valid 2-provider quorum group → PROMOTED ---
  it("(a) normalises 120-char title and 800-char body so the proposal reaches quorum and is PROMOTED", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-norm-a-"));
    const store = new BrainStore(repo);

    // Two proposals from distinct providers with identical semantic content
    // (same vec) and the same overlong title — they will be grouped, merged
    // evidence will span 2 providers (codex + gemini) with 3+ reviewer items.
    const longTitle = "A".repeat(120); // 40 chars over the 80-char limit
    const longBody = "B".repeat(800); // 300 chars over the 500-char limit

    const proposalA = {
      type: "convention",
      scope: "this-repo",
      title: longTitle,
      body: longBody,
      confidence: 0.9,
      tags: [],
      evidence: [
        { kind: "reviewer-finding", run_id: "r", reviewer_id: "codex-security" },
        { kind: "reviewer-finding", run_id: "r", reviewer_id: "codex-security" },
      ],
    };
    const proposalB = {
      type: "convention",
      scope: "this-repo",
      title: longTitle,
      body: longBody,
      confidence: 0.85,
      tags: [],
      evidence: [
        { kind: "reviewer-finding", run_id: "r", reviewer_id: "gemini-architecture" },
        { kind: "reviewer-finding", run_id: "r", reviewer_id: "gemini-architecture" },
      ],
    };

    const res = await runCurator({
      repoRoot: repo,
      runId: "r",
      // Pass as unknown — simulates raw reviewer output bypassing TS typing
      proposals: [proposalA, proposalB] as unknown as MemoryProposal[],
      store,
      embedder: fakeEmbedder([1, 0]),
      nowIso: "2026-05-21T00:00:00Z",
    });

    // Normalisation should have truncated title/body; quorum is met across 2 providers.
    expect(res.promoted).toBe(1);
    expect(res.rejected).toBe(0);
    const entry = (await store.snapshot()).entries[0];
    expect(entry?.title.length).toBeLessThanOrEqual(80);
    expect((entry?.body ?? "").length).toBeLessThanOrEqual(500);
  });

  // --- (b) one bad-kind evidence item is dropped; proposal survives on valid items ---
  it("(b) drops evidence items with invalid kind but promotes when valid items remain", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-norm-b-"));
    const store = new BrainStore(repo);

    const proposalA = {
      type: "convention",
      scope: "this-repo",
      title: "t",
      body: "b",
      confidence: 0.8,
      tags: [],
      evidence: [
        { kind: "INVALID_KIND", run_id: "r", reviewer_id: "codex-security" }, // bad — dropped
        { kind: "reviewer-finding", run_id: "r", reviewer_id: "codex-security" }, // valid
        { kind: "reviewer-finding", run_id: "r", reviewer_id: "codex-security" }, // valid
      ],
    };
    const proposalB = {
      type: "convention",
      scope: "this-repo",
      title: "t",
      body: "b",
      confidence: 0.75,
      tags: [],
      evidence: [
        { kind: "reviewer-finding", run_id: "r", reviewer_id: "gemini-architecture" },
        { kind: "reviewer-finding", run_id: "r", reviewer_id: "gemini-architecture" },
      ],
    };

    const res = await runCurator({
      repoRoot: repo,
      runId: "r",
      proposals: [proposalA, proposalB] as unknown as MemoryProposal[],
      store,
      embedder: fakeEmbedder([1, 0]),
      nowIso: "2026-05-21T00:00:00Z",
    });

    // Bad evidence item was dropped; remaining valid items form quorum across 2 providers.
    expect(res.promoted).toBe(1);
    expect(res.rejected).toBe(0);
  });

  // --- (c) irreparable proposals are rejected as schema ---
  it("(c-i) rejects a proposal whose title is not a string", () => {
    const result = normalizeProposal({
      type: "convention",
      scope: "this-repo",
      title: 42, // not a string
      body: "b",
      confidence: 0.8,
      tags: [],
      evidence: [{ kind: "reviewer-finding", run_id: "r", reviewer_id: "codex-security" }],
    });
    expect(result).toBeNull();
  });

  it("(c-ii) defaults an unknown type to 'convention' instead of rejecting", () => {
    // Reviewers often use loose type labels ("security", "best-practice"). Losing
    // the knowledge entirely is worse than bucketing it as a generic convention.
    const result = normalizeProposal({
      type: "totally-made-up-type", // not a valid BrainEntryType
      scope: "this-repo",
      title: "valid title",
      body: "b",
      confidence: 0.8,
      tags: [],
      evidence: [{ kind: "reviewer-finding", run_id: "r", reviewer_id: "codex-security" }],
    });
    expect(result).not.toBeNull();
    expect(result?.type).toBe("convention");
  });

  it("keeps a valid type as-is (does not coerce anti-pattern → convention)", () => {
    const result = normalizeProposal({
      type: "anti-pattern",
      scope: "this-repo",
      title: "valid title",
      body: "b",
      confidence: 0.8,
      tags: [],
      evidence: [{ kind: "reviewer-finding", run_id: "r", reviewer_id: "codex-security" }],
    });
    expect(result?.type).toBe("anti-pattern");
  });

  it("(c-iii) rejects a proposal with NO valid evidence items", () => {
    const result = normalizeProposal({
      type: "convention",
      scope: "this-repo",
      title: "valid title",
      body: "b",
      confidence: 0.8,
      tags: [],
      evidence: [
        { kind: "GARBAGE_KIND" }, // invalid kind
        { kind: 12345 }, // not a string kind
      ],
    });
    expect(result).toBeNull();
  });

  it("normalises defaults: missing scope → 'this-repo', non-number confidence → 0.5, non-array tags → []", () => {
    const result = normalizeProposal({
      type: "convention",
      title: "  hello  ", // leading/trailing spaces
      body: "body text",
      // scope, confidence, tags all missing/wrong type
      confidence: "not-a-number",
      tags: "oops-a-string",
      evidence: [{ kind: "reviewer-finding", run_id: "r", reviewer_id: "codex-x" }],
    });
    expect(result).not.toBeNull();
    expect(result?.title).toBe("hello"); // trimmed
    expect(result?.scope).toBe("this-repo");
    expect(result?.confidence).toBe(0.5);
    expect(result?.tags).toEqual([]);
  });

  it("clamps confidence to [0,1]", () => {
    const high = normalizeProposal({
      type: "convention",
      title: "t",
      body: "",
      confidence: 9999,
      evidence: [{ kind: "deterministic" }],
    });
    expect(high?.confidence).toBe(1);

    const low = normalizeProposal({
      type: "convention",
      title: "t",
      body: "",
      confidence: -5,
      evidence: [{ kind: "deterministic" }],
    });
    expect(low?.confidence).toBe(0);
  });
});

describe("normalizeProposalResult (schema reject sub-reasons for observability)", () => {
  const validEvidence = [{ kind: "reviewer-finding", run_id: "r", reviewer_id: "codex-security" }];
  it("ok for a valid proposal", () => {
    const r = normalizeProposalResult({
      type: "convention",
      title: "t",
      body: "b",
      confidence: 0.8,
      tags: [],
      evidence: validEvidence,
    });
    expect(r.ok).toBe(true);
  });
  it("reason 'not-object' for a non-object", () => {
    expect(normalizeProposalResult(null)).toEqual({ ok: false, reason: "not-object" });
    expect(normalizeProposalResult("nope")).toEqual({ ok: false, reason: "not-object" });
  });
  it("reason 'title' for a non-string title", () => {
    const r = normalizeProposalResult({ type: "convention", title: 42, evidence: validEvidence });
    expect(r).toEqual({ ok: false, reason: "title" });
  });
  it("reason 'evidence' when no valid evidence item remains", () => {
    const r = normalizeProposalResult({
      type: "convention",
      title: "t",
      evidence: [{ kind: "GARBAGE" }],
    });
    expect(r).toEqual({ ok: false, reason: "evidence" });
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
