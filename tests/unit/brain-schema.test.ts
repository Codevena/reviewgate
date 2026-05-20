import { describe, expect, it } from "bun:test";
import {
  BrainEntrySchema,
  CuratorDecisionSchema,
  EvidenceItemSchema,
  MemoryProposalSchema,
} from "../../src/schemas/brain.ts";

describe("brain schemas", () => {
  it("accepts a minimal valid brain entry and defaults lifecycle fields", () => {
    const e = BrainEntrySchema.parse({
      id: "B-001",
      type: "convention",
      scope: "this-repo",
      title: "cart null-guards are intentional",
      body: "src/cart.ts Promise.all null-guard is deliberate.",
      tags: ["cart"],
      file_globs: ["src/cart.ts"],
      confidence: 0.9,
      evidence: [{ kind: "reviewer-finding", run_id: "r1", reviewer_id: "codex-security" }],
      created_at: "2026-05-21T00:00:00Z",
      source_run_id: "r1",
    });
    expect(e.status).toBe("candidate");
    expect(e.referenced_count).toBe(1);
    expect(e.referencing_reviewers).toEqual([]);
    expect(e.embedding).toBeNull();
  });

  it("requires body_sha256 + fetched_at on a web-fetch evidence item", () => {
    expect(() =>
      EvidenceItemSchema.parse({ kind: "web-fetch", source_url: "https://x/y" }),
    ).toThrow();
    expect(
      EvidenceItemSchema.parse({
        kind: "web-fetch",
        source_url: "https://x/y",
        body_sha256: "a".repeat(64),
        fetched_at: "2026-05-21T00:00:00Z",
      }).kind,
    ).toBe("web-fetch");
  });

  it("rejects a proposal whose body exceeds 500 chars", () => {
    expect(() =>
      MemoryProposalSchema.parse({
        type: "convention",
        scope: "this-repo",
        title: "t",
        body: "x".repeat(501),
        evidence: [{ kind: "reviewer-observation", run_id: "r", reviewer_id: "codex" }],
        confidence: 0.6,
        tags: [],
      }),
    ).toThrow();
  });

  it("requires entry_id on a 'promoted' curator decision", () => {
    const base = {
      schema: "reviewgate.curator.v1" as const,
      run_id: "r1",
      proposal_title: "t",
      provider: "openrouter",
      ts: "2026-05-21T00:00:00Z",
    };
    // promoted WITHOUT entry_id → reject
    expect(() => CuratorDecisionSchema.parse({ ...base, decision: "promoted" })).toThrow();
    // promoted WITH entry_id → ok
    expect(
      CuratorDecisionSchema.parse({ ...base, decision: "promoted", entry_id: "B-001" }).entry_id,
    ).toBe("B-001");
    // rejected WITHOUT entry_id → still ok (entry_id only required when promoted)
    expect(CuratorDecisionSchema.parse({ ...base, decision: "rejected" }).decision).toBe(
      "rejected",
    );
  });
});
