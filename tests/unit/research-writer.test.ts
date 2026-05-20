// tests/unit/research-writer.test.ts
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeDiffFacts } from "../../src/research/diff-facts.ts";
import { writeResearch } from "../../src/research/research-writer.ts";
import { triageFromFacts } from "../../src/triage/matrix.ts";

describe("writeResearch", () => {
  it("writes research.md with diff facts, triage, conventions, and a symbol section", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-research-"));
    mkdirSync(join(repo, ".reviewgate"), { recursive: true });
    const diff =
      "diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n";
    const facts = computeDiffFacts(diff);
    await writeResearch({
      repoRoot: repo,
      facts,
      triage: triageFromFacts(facts),
      symbolGraph: { symbols: [], callers: {} },
      conventions: { summary: "Uses biome + zod." },
    });
    const md = readFileSync(join(repo, ".reviewgate", "research.md"), "utf8");
    expect(md).toContain("# Reviewgate Research");
    expect(md).toContain("src/x.ts");
    expect(md).toContain("default"); // risk class
    expect(md).toContain("biome");
  });
});
