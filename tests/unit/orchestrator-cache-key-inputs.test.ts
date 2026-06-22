// tests/unit/orchestrator-cache-key-inputs.test.ts
//
// Audit fixes (cache-key staleness + incomplete-diff fail-open + redaction):
//
//  - The verdict cache key must fold in BOTH the claude-code host-model TIER
//    (which decides the reviewer model, and is NOT part of configHash) AND the
//    project-conventions content (CLAUDE.md/README.md/package.json scripts,
//    injected as reviewer context but NOT in the diff hash). A change to either
//    must invalidate a cached PASS, else a stale verdict is served.
//  - A PASS earned on an INCOMPLETE (truncated/timed-out) diff must NOT be cached
//    as a full PASS — the hidden portion was never reviewed (fail-open).
//  - The reviewer-readable diff tmp file must carry the SANITIZED (redacted)
//    diff, not the raw one, or redaction is defeated for the file path.
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "../../src/config/define-config.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";
import type { HostTier } from "../../src/utils/host-model.ts";

// A codex stub that counts how many times the panel actually ran (a cache hit
// short-circuits BEFORE the adapter, so the count stays flat on a hit) and
// captures the bytes written to the reviewer-readable diff tmp file.
function countingStub(state: { calls: number; lastDiffFile?: string }): ProviderAdapter {
  return {
    id: "codex",
    async preflight() {
      return { available: true, version: "x", authMode: "oauth", error: null };
    },
    async review(inp) {
      state.calls++;
      state.lastDiffFile = readFileSync(inp.diffPath, "utf8");
      return {
        reviewerId: inp.reviewerId,
        verdict: "PASS",
        findings: [],
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
        durationMs: 1,
        exitCode: 0,
        rawEventsPath: "",
        status: "ok",
      } satisfies ReviewResult;
    },
  };
}

const diff = "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-a\n+b\n";

function orch(
  repo: string,
  state: { calls: number; lastDiffFile?: string },
  opts: {
    hostTier?: HostTier;
    diffIncomplete?: boolean;
    diff?: string;
    foreignFiles?: Set<string> | null;
  } = {},
) {
  return new Orchestrator({
    repoRoot: repo,
    config: defineConfig({
      cache: { enabled: true, reviewTtlDays: 7 },
      phases: { triage: null },
    }),
    adapters: { codex: countingStub(state) },
    sandboxMode: "off",
    hostTier: opts.hostTier ?? "opus",
    diff: opts.diff ?? diff,
    reasonOnFailEnabled: true,
    ...(opts.diffIncomplete !== undefined ? { diffIncomplete: opts.diffIncomplete } : {}),
    ...(opts.foreignFiles !== undefined ? { foreignFiles: opts.foreignFiles } : {}),
  });
}

describe("verdict cache key folds in host-model tier + conventions", () => {
  it("serves a cached PASS on identical inputs (sanity: cache works)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-ck-hit-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    const state = { calls: 0 };
    await orch(repo, state).runIteration({ runId: "R", iter: 1 });
    expect(state.calls).toBe(1); // miss → panel ran
    await orch(repo, state).runIteration({ runId: "R", iter: 2 });
    expect(state.calls).toBe(1); // hit → panel did NOT run again
  });

  it("invalidates the cache when the host-model tier changes", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-ck-tier-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    const state = { calls: 0 };
    await orch(repo, state, { hostTier: "opus" }).runIteration({ runId: "R", iter: 1 });
    expect(state.calls).toBe(1);
    // host downgraded opus→sonnet ⇒ claude-code reviewer drops a tier ⇒ must re-review.
    await orch(repo, state, { hostTier: "sonnet" }).runIteration({ runId: "R", iter: 2 });
    expect(state.calls).toBe(2); // miss → panel ran again
  });

  it("invalidates the cache when project conventions (CLAUDE.md) change", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-ck-conv-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    writeFileSync(join(repo, "CLAUDE.md"), "Use tabs. Always validate inputs.");
    const state = { calls: 0 };
    await orch(repo, state).runIteration({ runId: "R", iter: 1 });
    expect(state.calls).toBe(1);
    // The maintainer rewrote the house rules — injected as reviewer context, so the
    // prior verdict no longer reflects the context the panel would now see.
    writeFileSync(join(repo, "CLAUDE.md"), "Use spaces. NEVER validate inputs (test).");
    await orch(repo, state).runIteration({ runId: "R", iter: 2 });
    expect(state.calls).toBe(2); // miss → panel ran again
  });
});

describe("Slice A (M3): verdict cache key folds in the session foreign-file scope", () => {
  it("does NOT serve a session-scoped PASS to a differently-scoped (or unscoped) run", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-ck-fgn-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    const state = { calls: 0 };
    // Run 1: review scoped to a session that owns nothing here → a PASS produced UNDER that
    // scope. It must not be reused for a run with a different/absent scope (where the same diff
    // could surface a real blocking finding) — that was the M3 cache-poisoning fail-open.
    await orch(repo, state, { foreignFiles: new Set(["other.ts"]) }).runIteration({
      runId: "R",
      iter: 1,
    });
    expect(state.calls).toBe(1);
    await orch(repo, state, { foreignFiles: null }).runIteration({ runId: "R", iter: 2 });
    expect(state.calls).toBe(2); // miss → panel re-ran under the new (unscoped) scope
  });

  it("serves a cached PASS when the foreign-file scope is identical (no over-correction)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-ck-fgn-hit-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    const state = { calls: 0 };
    await orch(repo, state, { foreignFiles: new Set(["other.ts"]) }).runIteration({
      runId: "R",
      iter: 1,
    });
    expect(state.calls).toBe(1);
    await orch(repo, state, { foreignFiles: new Set(["other.ts"]) }).runIteration({
      runId: "R",
      iter: 2,
    });
    expect(state.calls).toBe(1); // hit → identical scope reuses the verdict
  });
});

describe("incomplete diff is never cached as a full PASS", () => {
  it("does not serve a cached PASS for a PASS earned on an incomplete diff", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-ck-incomplete-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    const state = { calls: 0 };
    // First run: diff was INCOMPLETE → PASS must NOT be persisted to cache.
    await orch(repo, state, { diffIncomplete: true }).runIteration({ runId: "R", iter: 1 });
    expect(state.calls).toBe(1);
    // Second run, same (still incomplete) diff: if the partial PASS had been cached,
    // this would be a hit and the panel would NOT run. It must re-review.
    await orch(repo, state, { diffIncomplete: true }).runIteration({ runId: "R", iter: 2 });
    expect(state.calls).toBe(2);
  });

  it("DOES cache a PASS earned on a complete diff (no over-correction)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-ck-complete-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    const state = { calls: 0 };
    await orch(repo, state, { diffIncomplete: false }).runIteration({ runId: "R", iter: 1 });
    expect(state.calls).toBe(1);
    await orch(repo, state, { diffIncomplete: false }).runIteration({ runId: "R", iter: 2 });
    expect(state.calls).toBe(1); // hit → complete-diff PASS was cached
  });
});

describe("reviewer-readable diff tmp file is sanitized (redaction not bypassed)", () => {
  it("writes the SANITIZED (redacted + fenced) diff, not the raw diff", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-ck-redact-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    // A high-entropy secret inside the diff must be redacted in the tmp file too.
    const secret = "AKIA1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const secretDiff = `diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-a\n+const k = "${secret}";\n`;
    const state: { calls: number; lastDiffFile?: string } = { calls: 0 };
    await orch(repo, state, { diff: secretDiff }).runIteration({ runId: "R", iter: 1 });
    expect(state.calls).toBe(1);
    const written = state.lastDiffFile ?? "";
    // The raw secret must be gone; the redaction placeholder + fence must be present.
    expect(written).not.toContain(secret);
    expect(written).toContain("<REDACTED:HIGH_ENTROPY>");
    expect(written).toContain("<<UNTRUSTED_DIFF>>");
  });
});
