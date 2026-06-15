// tests/unit/brain-enrich-provenance.test.ts
//
// Finding 3: enrichProposal dropped quorum-bearing provenance fields when it
// rewrote a successfully-fetched citation to a web-fetch record:
//   - `from_diff`   → silently relaxed the diff-derived (stricter) quorum bar
//   - `reviewer_id` / `run_id` → removed a provider from the cross-provider
//     distinct-count quorumOk relies on.
// They must be preserved through enrichment.
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enrichProposal } from "../../src/core/brain/enrich.ts";
import type { MemoryProposal } from "../../src/schemas/brain.ts";

const okFetch = (async () =>
  new Response("doc body", {
    status: 200,
    headers: { "content-type": "text/html" },
  })) as unknown as typeof fetch;

describe("enrichProposal — preserves quorum-bearing provenance (Finding 3)", () => {
  it("keeps from_diff, reviewer_id and run_id when rewriting a cited item to web-fetch", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-enr-prov-"));
    const proposal: MemoryProposal = {
      type: "external-knowledge",
      scope: "framework-next",
      title: "use cache directive",
      body: "Next 16 uses `use cache`.",
      confidence: 0.7,
      tags: ["next"],
      evidence: [
        {
          kind: "reviewer-finding",
          run_id: "RUN-42",
          reviewer_id: "codex-security",
          source_url: "https://docs.example.com/use-cache",
          from_diff: { file: "src/page.tsx", line_start: 10, line_end: 12 },
        },
      ],
    };
    const { enriched } = await enrichProposal(repo, proposal, {
      allow: ["docs.example.com"],
      fetchImpl: okFetch,
      resolve: async () => ["93.184.216.34"],
    });
    const web = enriched.evidence.find((e) => e.kind === "web-fetch");
    expect(web).toBeDefined();
    // Rewritten as web-fetch with a hash...
    expect(web?.body_sha256).toHaveLength(64);
    // ...but the provenance that the quorum depends on is preserved.
    expect(web?.from_diff).toEqual({ file: "src/page.tsx", line_start: 10, line_end: 12 });
    expect(web?.reviewer_id).toBe("codex-security");
    expect(web?.run_id).toBe("RUN-42");
  });

  it("does not synthesize provenance fields that were absent on the citation", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-enr-prov2-"));
    const proposal: MemoryProposal = {
      type: "external-knowledge",
      scope: "framework-next",
      title: "t",
      body: "b",
      confidence: 0.5,
      tags: [],
      evidence: [
        {
          kind: "reviewer-observation",
          run_id: "RUN-1",
          reviewer_id: "gemini",
          source_url: "https://docs.example.com/x",
          // no from_diff
        },
      ],
    };
    const { enriched } = await enrichProposal(repo, proposal, {
      allow: ["docs.example.com"],
      fetchImpl: okFetch,
      resolve: async () => ["93.184.216.34"],
    });
    const web = enriched.evidence.find((e) => e.kind === "web-fetch");
    expect(web?.reviewer_id).toBe("gemini");
    expect(web?.run_id).toBe("RUN-1");
    expect(web?.from_diff).toBeUndefined();
  });
});
