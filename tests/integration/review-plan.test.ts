import { describe, expect, it } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReviewPlan } from "../../src/cli/commands/review-plan.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";

function gitInit(repo: string) {
  execSync("git init -q && git config user.email t@t.t && git config user.name t", {
    cwd: repo,
    shell: "/bin/bash",
  });
}

function stub(verdict: "PASS" | "FAIL"): ProviderAdapter {
  return {
    id: "codex",
    async preflight() {
      return { available: true, version: "x", authMode: "oauth", error: null };
    },
    async review(inp): Promise<ReviewResult> {
      return {
        reviewerId: inp.reviewerId,
        verdict,
        findings:
          verdict === "FAIL"
            ? [
                {
                  id: "F-001",
                  severity: "CRITICAL",
                  category: "correctness",
                  rule_id: "x",
                  file: inp.persona,
                  line_start: 1,
                  line_end: 1,
                  message: "m",
                  details: "d",
                  confidence: 0.9,
                  consensus: "singleton",
                  signature: "sig",
                  reviewer: { provider: "codex", model: "x", persona: inp.persona },
                } as ReviewResult["findings"][number],
              ]
            : [],
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
        durationMs: 1,
        exitCode: 0,
        rawEventsPath: "",
        status: "ok",
      };
    },
  };
}

describe("review-plan CLI", () => {
  it("reviews a plan file and returns exit 0 on PASS", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-rp1-"));
    gitInit(repo);
    writeFileSync(join(repo, "plan.md"), "# Plan\nStep 1: do the thing.\n");
    const res = await runReviewPlan({
      repoRoot: repo,
      files: ["plan.md"],
      providerOverrides: { codex: stub("PASS") },
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("PASS");
  });

  it("returns non-zero exit on FAIL", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-rp2-"));
    gitInit(repo);
    writeFileSync(join(repo, "plan.md"), "# Plan\n");
    const res = await runReviewPlan({
      repoRoot: repo,
      files: ["plan.md"],
      providerOverrides: { codex: stub("FAIL") },
    });
    expect(res.exitCode).not.toBe(0);
  });

  it("errors clearly on a missing file", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-rp3-"));
    gitInit(repo);
    const res = await runReviewPlan({
      repoRoot: repo,
      files: ["nope.md"],
      providerOverrides: { codex: stub("PASS") },
    });
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr.toLowerCase()).toContain("not found");
  });

  it("returns a distinct exit code (3) when all reviewers error (ERROR verdict)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-rp5-"));
    gitInit(repo);
    writeFileSync(join(repo, "plan.md"), "# Plan\nStep 1: do the thing.\n");
    // An adapter that always errors → no reviewer completes → orchestrator
    // yields verdict ERROR (distinct from a substantive FAIL). Stub the whole
    // default failover chain (codex → gemini → claude-code) so nothing spawns a
    // real CLI; every slot errors, so the panel produces no verdict at all.
    const erroring = (id: ProviderAdapter["id"]): ProviderAdapter => ({
      id,
      async preflight() {
        return { available: true, version: "x", authMode: "oauth", error: null };
      },
      async review(inp): Promise<ReviewResult> {
        return {
          reviewerId: inp.reviewerId,
          verdict: "PASS",
          findings: [],
          usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, quotaUsedPct: null },
          durationMs: 1,
          exitCode: 1,
          rawEventsPath: "",
          status: "error",
        };
      },
    });
    const res = await runReviewPlan({
      repoRoot: repo,
      files: ["plan.md"],
      providerOverrides: {
        codex: erroring("codex"),
        gemini: erroring("gemini"),
        "claude-code": erroring("claude-code"),
      },
    });
    expect(res.stdout).toContain("ERROR");
    expect(res.exitCode).toBe(3);
    // ERROR must NOT collide with a genuine FAIL (exit 1).
    expect(res.exitCode).not.toBe(1);
  });

  it("rejects a path outside the repo", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-rp4-"));
    gitInit(repo);
    const res = await runReviewPlan({
      repoRoot: repo,
      files: ["../escape.md"],
      providerOverrides: { codex: stub("PASS") },
    });
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr.toLowerCase()).toContain("outside");
  });
});
