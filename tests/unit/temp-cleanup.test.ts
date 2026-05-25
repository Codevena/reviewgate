// tests/unit/temp-cleanup.test.ts
// Phase 4 #1 — Reviewgate must not leak per-run temp dirs into the OS tmp dir.
// The orchestrator's per-reviewer runDir (rg-rev-*) and each adapter's preflight
// dir (rg-*-pf-*) hold the diff + prompt + output at default permissions; a leak
// leaves them in /tmp forever. We isolate the OS tmp dir via TMPDIR (bun's
// os.tmpdir() honours it dynamically — see test), run the real code path, and
// assert nothing of ours remains.
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../src/config/defaults.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";
import { ClaudeAdapter } from "../../src/providers/claude.ts";
import { CodexAdapter } from "../../src/providers/codex.ts";
import { GeminiAdapter } from "../../src/providers/gemini.ts";
import type { Finding } from "../../src/schemas/finding.ts";

// Run `fn` with TMPDIR pointed at a fresh isolated dir; return the list of
// leftover entries created inside it. Restores TMPDIR afterwards.
async function leftoversIn(fn: () => Promise<void>): Promise<string[]> {
  const prev = process.env.TMPDIR;
  // Create the isolation dir under the REAL tmp (before we redirect TMPDIR).
  const iso = mkdtempSync(join(tmpdir(), "rg-iso-"));
  process.env.TMPDIR = iso;
  try {
    await fn();
  } finally {
    process.env.TMPDIR = prev;
  }
  return readdirSync(iso);
}

function stub(id: ProviderAdapter["id"], findings: Finding[]): ProviderAdapter {
  return {
    id,
    async preflight() {
      return { available: true, version: "x", authMode: "oauth", error: null };
    },
    async review(inp) {
      return {
        reviewerId: inp.reviewerId,
        verdict: findings.length ? "FAIL" : "PASS",
        findings,
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
        durationMs: 1,
        exitCode: 0,
        rawEventsPath: "",
        rawText: "",
        status: "ok",
      } satisfies ReviewResult;
    },
  };
}

function f(): Finding {
  return {
    id: "F-1",
    signature: "sig",
    severity: "WARN",
    category: "security",
    rule_id: "r",
    file: "foo.ts",
    line_start: 1,
    line_end: 1,
    message: "m",
    details: "d",
    reviewer: { provider: "codex", model: "m", persona: "security" },
    confidence: 0.8,
    consensus: "singleton",
  };
}

describe("temp-dir hygiene", () => {
  it("orchestrator panel leaves no rg-rev-* dir behind", async () => {
    const leftovers = await leftoversIn(async () => {
      const repo = mkdtempSync(join(tmpdir(), "rg-cleanup-repo-"));
      writeFileSync(join(repo, "foo.ts"), "x");
      const config = {
        ...defaultConfig,
        phases: {
          ...defaultConfig.phases,
          review: { reviewers: [{ provider: "codex" as const, persona: "security" }] },
          critic: null,
          triage: null,
        },
      };
      const orch = new Orchestrator({
        repoRoot: repo,
        config,
        adapters: { codex: stub("codex", [f()]) },
        sandboxMode: "off",
        hostTier: "opus",
        diff: "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-a\n+b\n",
        reasonOnFailEnabled: true,
      });
      await orch.runIteration({ runId: "RUN", iter: 1 });
    });
    expect(leftovers.filter((e) => e.startsWith("rg-rev-"))).toEqual([]);
  });

  it("adapter preflight leaves no rg-*-pf-* dir behind", async () => {
    const leftovers = await leftoversIn(async () => {
      await new CodexAdapter({
        binPath: join(process.cwd(), "tests/fixtures/fake-codex.sh"),
      }).preflight({ enabled: true, auth: "oauth", model: "m", timeoutMs: 5_000 });
      await new GeminiAdapter({
        binPath: join(process.cwd(), "tests/fixtures/fake-gemini.sh"),
      }).preflight({ enabled: true, auth: "oauth", model: "m", timeoutMs: 5_000 });
      await new ClaudeAdapter({
        binPath: join(process.cwd(), "tests/fixtures/fake-claude.sh"),
      }).preflight({ enabled: true, auth: "oauth", model: "m", timeoutMs: 5_000 });
    });
    expect(leftovers.filter((e) => /-pf-/.test(e))).toEqual([]);
  });

  it("TMPDIR isolation sanity: bun os.tmpdir() honours the redirect", () => {
    const prev = process.env.TMPDIR;
    const iso = mkdtempSync(join(tmpdir(), "rg-iso-sanity-"));
    process.env.TMPDIR = iso;
    try {
      expect(tmpdir()).toBe(iso);
      expect(existsSync(iso)).toBe(true);
    } finally {
      process.env.TMPDIR = prev;
    }
  });
});
