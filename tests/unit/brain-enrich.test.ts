import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enrichProposal } from "../../src/core/brain/enrich.ts";
import type { MemoryProposal } from "../../src/schemas/brain.ts";

const okFetch = (async () =>
  new Response("doc body", {
    status: 200,
    headers: { "content-type": "text/html" },
  })) as unknown as typeof fetch;

function proposal(): MemoryProposal {
  return {
    type: "external-knowledge",
    scope: "framework-next",
    title: "use cache directive",
    body: "Next 16 uses `use cache`.",
    confidence: 0.7,
    tags: ["next"],
    evidence: [
      {
        kind: "reviewer-observation",
        run_id: "r",
        reviewer_id: "codex",
        source_url: "https://docs.example.com/use-cache",
      },
    ],
  };
}

describe("enrichProposal", () => {
  it("turns a cited source_url into a web-fetch evidence record with hash + snapshot", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-enr-"));
    const { enriched, egress } = await enrichProposal(repo, proposal(), {
      allow: ["docs.example.com"],
      fetchImpl: okFetch,
      resolve: async () => ["93.184.216.34"],
    });
    const web = enriched.evidence.find((e) => e.kind === "web-fetch");
    expect(web?.body_sha256).toHaveLength(64);
    expect(web?.fetched_at).toBeTruthy();
    expect(egress.length).toBe(1);
    expect(existsSync(join(repo, ".reviewgate/brain/snapshots", `${web?.body_sha256}`))).toBe(true);
  });

  it("keeps the citation as plain reviewer evidence when the fetch is denied (does not drop to empty)", async () => {
    // Previously a failed fetch DROPPED the citation. If it was the proposal's only
    // evidence, the proposal then arrived at the curator with zero evidence and was
    // rejected as rule_failed:"schema"[evidence] — it never reached the reviewer-
    // quorum rule the drop comment claimed to fall back to. Keep the original item
    // (it counts as reviewer evidence, just not a verified web-fetch source).
    const repo = mkdtempSync(join(tmpdir(), "rg-enr2-"));
    const p = proposal();
    const ev = p.evidence[0];
    if (ev) ev.source_url = "https://evil.com/x";
    const { enriched } = await enrichProposal(repo, p, {
      allow: ["docs.example.com"],
      fetchImpl: okFetch,
      resolve: async () => ["1.2.3.4"],
    });
    expect(enriched.evidence.some((e) => e.kind === "web-fetch")).toBe(false); // fetch failed
    expect(enriched.evidence).toHaveLength(1); // kept, not dropped to empty
    expect(enriched.evidence[0]?.kind).toBe("reviewer-observation");
  });
});
