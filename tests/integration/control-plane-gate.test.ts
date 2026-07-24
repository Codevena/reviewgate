import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGate } from "../../src/cli/commands/gate.ts";
import { runInit } from "../../src/cli/commands/init.ts";
import { StateStore } from "../../src/core/state-store.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";
import type { Finding } from "../../src/schemas/finding.ts";
import { gitHeadSha, workingTreeStateHash } from "../../src/utils/git.ts";

function run(repo: string, args: string[]): void {
  execFileSync("git", args, { cwd: repo });
}

function writePolicy(
  repo: string,
  softPassPolicy: "allow" | "block",
  model = "approved",
  opts: { acknowledgePass?: boolean } = {},
): void {
  const loopLine = opts.acknowledgePass
    ? `  loop: { softPassPolicy: ${JSON.stringify(softPassPolicy)}, acknowledgePass: true },`
    : `  loop: { softPassPolicy: ${JSON.stringify(softPassPolicy)} },`;
  writeFileSync(
    join(repo, "reviewgate.config.ts"),
    [
      "export default {",
      `  providers: { codex: { model: ${JSON.stringify(model)} } },`,
      "  phases: {",
      "    review: { reviewers: [{ provider: 'codex', persona: 'security' }] },",
      "    brain: null,",
      "  },",
      loopLine,
      "};",
      "",
    ].join("\n"),
  );
}

async function repoWithApprovedPolicy(
  softPassPolicy: "allow" | "block",
  opts: { acknowledgePass?: boolean } = {},
) {
  const repo = mkdtempSync(join(tmpdir(), "rg-control-gate-"));
  run(repo, ["init", "-q"]);
  run(repo, ["config", "user.email", "test@example.test"]);
  run(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
  writePolicy(repo, softPassPolicy, "approved", opts);
  run(repo, ["add", "a.ts", "reviewgate.config.ts"]);
  run(repo, ["commit", "-qm", "baseline"]);
  await runInit({ repoRoot: repo, mode: "agent-loop" });
  // Commit init scaffolding so a later config-only change has a genuinely empty
  // normal diff. control-plane.json remains ignored and out-of-band.
  run(repo, ["add", "-A"]);
  run(repo, ["commit", "-qm", "init reviewgate"]);
  const head = await gitHeadSha(repo);
  const tree = await workingTreeStateHash(repo);
  const state = new StateStore(repo);
  await state.initialise("01CONTROLPLANE");
  await state.update((current) => ({
    ...current,
    last_reviewed_head_sha: head,
    last_reviewed_tree_hash: tree,
  }));
  return repo;
}

function warnReviewer(): ProviderAdapter {
  return {
    id: "codex",
    async preflight() {
      return { available: true, version: "stub", authMode: "oauth", error: null };
    },
    async review(input): Promise<ReviewResult> {
      const finding: Finding = {
        id: "F-001",
        signature: "control-plane-warn",
        severity: "WARN",
        category: "quality",
        rule_id: "control-plane-warn",
        file: "a.ts",
        line_start: 1,
        line_end: 1,
        message: "A deterministic warning for the policy regression test",
        details: "This singleton warning produces SOFT-PASS at the aggregator layer.",
        reviewer: { provider: "codex", model: "stub", persona: "security" },
        confidence: 0.95,
        consensus: "singleton",
      };
      return {
        reviewerId: input.reviewerId,
        verdict: "FAIL",
        findings: [finding],
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
        durationMs: 1,
        exitCode: 0,
        rawEventsPath: "",
        status: "ok",
      };
    },
  };
}

function cleanReviewer(): ProviderAdapter {
  return {
    id: "codex",
    async preflight() {
      return { available: true, version: "stub", authMode: "oauth", error: null };
    },
    async review(input): Promise<ReviewResult> {
      return {
        reviewerId: input.reviewerId,
        verdict: "PASS",
        findings: [],
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
        durationMs: 1,
        exitCode: 0,
        rawEventsPath: "",
        status: "ok",
      };
    },
  };
}

function quotaReviewer(): ProviderAdapter {
  return {
    id: "codex",
    async preflight() {
      return { available: true, version: "stub", authMode: "oauth", error: null };
    },
    async review(input): Promise<ReviewResult> {
      return {
        reviewerId: input.reviewerId,
        verdict: "ERROR",
        findings: [],
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, quotaUsedPct: 100 },
        durationMs: 1,
        exitCode: 1,
        rawEventsPath: "",
        status: "quota-exhausted",
        statusDetail: "test quota exhausted",
      };
    },
  };
}

describe("control-plane gate integration", () => {
  it("a config-only Bash mutation cannot take the unchanged-tree fast exit", async () => {
    const repo = await repoWithApprovedPolicy("allow");
    writePolicy(repo, "allow", "candidate-model"); // no PostToolUse trigger
    const out = await runGate({
      repoRoot: repo,
      hook: "stop",
      snapshotVerifyOpts: { dwellMs: 0 },
      hookStdinRaw: "{}",
    });
    const decision = JSON.parse(out.stdout || "{}") as { decision?: string; reason?: string };
    expect(decision.decision).toBe("block");
    expect(decision.reason).toContain("GATE POLICY CHANGED");
    const control = JSON.parse(
      readFileSync(join(repo, ".reviewgate", "control-plane.json"), "utf8"),
    );
    expect(control.pending.reviewed_under_lkg_at).not.toBeNull();
  }, 30_000);

  it("a mixed code+weakening-config change is reviewed with the old blocking policy", async () => {
    const repo = await repoWithApprovedPolicy("block");
    writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
    writePolicy(repo, "allow", "candidate-model");
    await runGate({
      repoRoot: repo,
      hook: "trigger",
      hookStdinRaw: JSON.stringify({
        tool_name: "Edit",
        tool_input: { file_path: join(repo, "a.ts") },
      }),
    });
    const out = await runGate({
      repoRoot: repo,
      hook: "stop",
      snapshotVerifyOpts: { dwellMs: 0 },
      hookStdinRaw: "{}",
      providerOverrides: { codex: warnReviewer() },
      sandboxModeOverride: "off",
    });
    const decision = JSON.parse(out.stdout || "{}") as { decision?: string; reason?: string };
    expect(decision.decision).toBe("block");
    expect(decision.reason).toContain("Gate policy candidate remains pending");
    const pending = JSON.parse(readFileSync(join(repo, ".reviewgate", "pending.json"), "utf8"));
    expect(pending.verdict).toBe("SOFT-PASS");
    // The candidate says `allow`; only the approved `block` policy can turn this
    // SOFT-PASS into a blocked gate.
    expect(decision.reason).toContain("GATE CLOSED");
  }, 30_000);

  it("advances the LKG checkpoint on a clean PASS even when acknowledgePass renders it as a block (else config approve deadlocks)", async () => {
    // FlashBuddy field bug: with loop.acknowledgePass a clean PASS becomes a block
    // ("end your turn again to pass through"). That block path must STILL finalize
    // the control-plane review, or a pending policy candidate can never reach
    // reviewed_under_lkg and `reviewgate config approve` deadlocks forever.
    const repo = await repoWithApprovedPolicy("allow", { acknowledgePass: true });
    writeFileSync(join(repo, "a.ts"), "export const a = 5;\n");
    writePolicy(repo, "allow", "candidate-model", { acknowledgePass: true });
    await runGate({
      repoRoot: repo,
      hook: "trigger",
      hookStdinRaw: JSON.stringify({
        tool_name: "Edit",
        tool_input: { file_path: join(repo, "a.ts") },
      }),
    });
    const out = await runGate({
      repoRoot: repo,
      hook: "stop",
      snapshotVerifyOpts: { dwellMs: 0 },
      hookStdinRaw: "{}",
      providerOverrides: { codex: cleanReviewer() },
      sandboxModeOverride: "off",
    });
    const decision = JSON.parse(out.stdout || "{}") as { decision?: string };
    // acknowledgePass renders the clean pass as a block (agent acknowledges by
    // ending again) — but the checkpoint must have advanced regardless.
    expect(decision.decision).toBe("block");
    const control = JSON.parse(
      readFileSync(join(repo, ".reviewgate", "control-plane.json"), "utf8"),
    );
    expect(control.pending.reviewed_under_lkg_at).not.toBeNull();
  }, 30_000);

  it("never treats an infrastructure defer as a successful LKG policy review", async () => {
    const repo = await repoWithApprovedPolicy("allow");
    writeFileSync(join(repo, "a.ts"), "export const a = 4;\n");
    writePolicy(repo, "allow", "candidate-model");
    await runGate({
      repoRoot: repo,
      hook: "trigger",
      hookStdinRaw: JSON.stringify({
        tool_name: "Edit",
        tool_input: { file_path: join(repo, "a.ts") },
      }),
    });
    const out = await runGate({
      repoRoot: repo,
      hook: "stop",
      snapshotVerifyOpts: { dwellMs: 0 },
      hookStdinRaw: "{}",
      providerOverrides: { codex: quotaReviewer() },
      sandboxModeOverride: "off",
    });
    const decision = JSON.parse(out.stdout || "{}") as { decision?: string; reason?: string };
    expect(decision.decision).toBe("block");
    expect(decision.reason).toContain("GATE POLICY PENDING");
    expect(decision.reason).toContain("did not complete with PASS/SOFT-PASS");
    const control = JSON.parse(
      readFileSync(join(repo, ".reviewgate", "control-plane.json"), "utf8"),
    );
    expect(control.pending.reviewed_under_lkg_at).toBeNull();
  }, 30_000);
});
