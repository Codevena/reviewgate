// tests/integration/context-docs-pipeline.test.ts
//
// End-to-end wiring for M6: with phases.contextDocs enabled, the libraries a
// changed file imports are detected, their Context7 docs fetched (via an
// injected stub fetch), and an untrusted docs section is rendered into
// research.md AND reaches the reviewer prompt (before the diff fence). The docs
// corpus identity feeds the review behavior-hash, so a docs change invalidates a
// previously-cached verdict.
//
// `extractImportedLibs` reads the changed file FROM DISK (not from the diff), so
// we can change which lib a.ts imports between runs without touching the diff or
// the config — isolating the docs-corpus contribution to the cache key.
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../src/config/defaults.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import type { ProviderAdapter } from "../../src/providers/adapter-base.ts";

const DIFF = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n";

// Stub Context7: search returns /ctx/<libraryName>, context returns lib-specific docs.
function stubContext7Fetch(): typeof fetch {
  return (async (url: string) => {
    const u = new URL(url);
    let body: unknown = {};
    if (u.pathname.includes("/libs/search")) {
      const name = u.searchParams.get("libraryName") ?? "x";
      body = { results: [{ id: `/ctx/${name}`, title: name }] };
    } else if (u.pathname.includes("/context")) {
      const id = u.searchParams.get("libraryId") ?? "";
      const name = id.split("/").pop() ?? "lib";
      body = { infoSnippets: [{ content: `DOCS_FOR_${name.toUpperCase()} current API.` }] };
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function configWithDocs(enabled: boolean) {
  return {
    ...defaultConfig,
    phases: {
      review: { reviewers: [{ provider: "codex" as const, persona: "security" }] },
      critic: null,
      triage: null,
      ...(enabled
        ? {
            // full object — the orchestrator consumes the EFFECTIVE config (zod
            // defaults already applied in production); this raw test config must
            // supply every field itself.
            contextDocs: {
              enabled: true,
              apiKeyEnv: "C7_UNSET_ENV_INTEG",
              host: "context7.com",
              budgetBytes: 8000,
              perLibBytes: 2500,
              maxLibs: 5,
              ttlDays: 30,
            },
          }
        : {}),
    },
  };
}

// Capturing reviewer: records the prompt + counts invocations, always PASS.
function capturingReviewer(state: { prompt: string; calls: number }): ProviderAdapter {
  return {
    id: "codex",
    async preflight() {
      return { available: true, version: "x", authMode: "oauth", error: null };
    },
    async review(inp) {
      state.calls++;
      state.prompt = readFileSync(inp.promptFile, "utf8");
      return {
        reviewerId: inp.reviewerId,
        verdict: "PASS",
        findings: [],
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
        durationMs: 1,
        exitCode: 0,
        rawEventsPath: "",
        rawText: "",
        status: "ok",
      };
    },
  };
}

function mkOrch(repo: string, enabled: boolean, state: { prompt: string; calls: number }) {
  return new Orchestrator({
    repoRoot: repo,
    config: configWithDocs(enabled),
    adapters: { codex: capturingReviewer(state) },
    sandboxMode: "off",
    hostTier: "opus",
    diff: DIFF,
    reasonOnFailEnabled: true,
    fetchOverrides: { fetchImpl: stubContext7Fetch(), resolve: async () => ["93.184.216.34"] },
  });
}

describe("Context7 docs pipeline (opt-in)", () => {
  it("injects the untrusted docs section into research.md AND the reviewer prompt", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-c7pipe-"));
    writeFileSync(join(repo, "package.json"), JSON.stringify({ dependencies: { zod: "3.25.0" } }));
    writeFileSync(join(repo, "a.ts"), `import { z } from "zod";\nexport const x = z;`);

    const state = { prompt: "", calls: 0 };
    await mkOrch(repo, true, state).runIteration({ runId: "RUN", iter: 1 });

    const md = readFileSync(join(repo, ".reviewgate", "research.md"), "utf8");
    expect(md).toContain("## External library docs (Context7 — untrusted reference");
    expect(md).toContain("### zod");
    expect(md).toContain("DOCS_FOR_ZOD");

    // the docs section reaches the reviewer prompt, inside the trusted Research block
    expect(state.prompt).toContain("DOCS_FOR_ZOD");
    expect(state.prompt.indexOf("DOCS_FOR_ZOD")).toBeLessThan(
      state.prompt.indexOf("<<UNTRUSTED_DIFF>>"),
    );
  });

  it("renders no docs section when contextDocs is disabled", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-c7pipe-off-"));
    writeFileSync(join(repo, "package.json"), JSON.stringify({ dependencies: { zod: "3.25.0" } }));
    writeFileSync(join(repo, "a.ts"), `import { z } from "zod";`);
    const state = { prompt: "", calls: 0 };
    await mkOrch(repo, false, state).runIteration({ runId: "RUN", iter: 1 });
    const md = readFileSync(join(repo, ".reviewgate", "research.md"), "utf8");
    expect(md).not.toContain("External library docs");
    expect(state.prompt).not.toContain("DOCS_FOR_");
  });

  it("a docs-corpus change invalidates the cached verdict (docs feed the behavior-hash)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-c7pipe-cache-"));
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ dependencies: { zod: "3.25.0", next: "15.1.8" } }),
    );
    const state = { prompt: "", calls: 0 };

    // Run 1: a.ts imports zod → PASS cached under a key that folds in zod's docs.
    writeFileSync(join(repo, "a.ts"), `import { z } from "zod";`);
    await mkOrch(repo, true, state).runIteration({ runId: "RUN", iter: 1 });
    expect(state.calls).toBe(1);

    // Run 2: identical inputs → docs cache-hit → same corpus → verdict cache HIT
    // (reviewer NOT called again).
    await mkOrch(repo, true, state).runIteration({ runId: "RUN", iter: 1 });
    expect(state.calls).toBe(1);

    // Run 3: a.ts now imports `next` (diff + config unchanged) → different docs
    // corpus → behavior-hash changes → verdict cache MISS → reviewer runs again.
    writeFileSync(join(repo, "a.ts"), `import N from "next";`);
    await mkOrch(repo, true, state).runIteration({ runId: "RUN", iter: 1 });
    expect(state.calls).toBe(2);
  });
});
