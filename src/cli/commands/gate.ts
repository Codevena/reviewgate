// src/cli/commands/gate.ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { ulid } from "ulid";
import { AuditLogger } from "../../audit/logger.ts";
import { loadEffectiveConfig } from "../../config/global.ts";
import { LoopDriver } from "../../core/loop-driver.ts";
import { Orchestrator } from "../../core/orchestrator.ts";
import { StateStore } from "../../core/state-store.ts";
import { handleReset, handleTrigger, parseHookStdin } from "../../hooks/handlers.ts";
import type { ProviderAdapter } from "../../providers/adapter-base.ts";
import type { ProviderId } from "../../providers/registry.ts";
import { DIFF_INCOMPLETE_MARKER, collectDiff, collectGitInfo } from "../../utils/git.ts";
import { detectHostModel } from "../../utils/host-model.ts";
import { notifyDesktop } from "../../utils/notify.ts";
import { auditDir, dirtyFlagPath } from "../../utils/paths.ts";
import { buildAdapters } from "../build-adapters.ts";

export interface GateInput {
  repoRoot: string;
  hook: "trigger" | "stop" | "reset";
  hookStdinRaw: string;
  providerOverrides?: Partial<Record<ProviderId, ProviderAdapter>>;
  sandboxModeOverride?: "strict" | "permissive" | "off";
}

export interface GateOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function stopHookActiveFlag(parsed: unknown): boolean {
  const obj = parsed as { stop_hook_active?: boolean } | null;
  return Boolean(obj?.stop_hook_active);
}

export async function runGate(input: GateInput): Promise<GateOutput> {
  const cfg = await loadEffectiveConfig({
    cwd: input.repoRoot,
    env: process.env as Record<string, string | undefined>,
    home: homedir(),
  });
  const audit = new AuditLogger(auditDir(input.repoRoot));

  if (input.hook === "reset") {
    await handleReset({ repoRoot: input.repoRoot });
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  if (input.hook === "trigger") {
    await handleTrigger({ repoRoot: input.repoRoot, hookStdinRaw: input.hookStdinRaw });
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  // hook === 'stop'
  const parsedStdin = parseHookStdin(input.hookStdinRaw);
  const state = new StateStore(input.repoRoot);
  await state.loadOrRecover(ulid());
  const host = detectHostModel({
    env: process.env as Record<string, string>,
    hookStdin: parsedStdin as { session?: { model?: string } } | null,
  });

  const adapters = buildAdapters(cfg, input.providerOverrides);
  const gitInfo = await collectGitInfo(input.repoRoot);
  // Review base: the pre-batch HEAD captured in dirty.flag, so commit-per-task
  // work (committed mid-batch) is reviewed too — not just the working tree.
  const dp = dirtyFlagPath(input.repoRoot);
  const hasDirtyFlag = existsSync(dp);
  let reviewBase: string | null = null;
  // Reused when the HEAD-advanced path already computed the since-base diff, so
  // the gate doesn't run collectDiff twice for the same base.
  let precomputedDiff: string | undefined;
  if (hasDirtyFlag) {
    try {
      reviewBase = (JSON.parse(readFileSync(dp, "utf8")) as { base_sha?: string }).base_sha ?? null;
    } catch {
      reviewBase = null;
    }
  } else {
    // HEAD-advanced trigger: committed/merged work can arrive WITHOUT an Edit/Write
    // — e.g. a `git merge` or `git commit` run via Bash, or a worktree merge into
    // the watched checkout. No PostToolUse fires, so no dirty.flag, and the gate
    // would allow the turn UNREVIEWED. If HEAD moved past the last reviewed sha AND
    // there is a real diff since then, synthesize the trigger (base = last reviewed
    // sha) so that committed work is actually reviewed. (Requires a prior review to
    // have set last_reviewed_head_sha — the common case once the session is going.)
    const st = await state.load();
    const last = st.last_reviewed_head_sha;
    // Compute the since-`last` diff ONCE here and reuse it below when this path
    // sets reviewBase = last (avoids a second identical collectDiff = duplicate git work).
    const sinceLast =
      gitInfo.sha && last && gitInfo.sha !== last ? await collectDiff(input.repoRoot, last) : "";
    if (sinceLast.trim().length > 0) {
      reviewBase = last;
      precomputedDiff = sinceLast;
      writeFileSync(
        dp,
        JSON.stringify({
          diff_hash: gitInfo.sha.slice(0, 16),
          ts: new Date().toISOString(),
          base_sha: last,
        }),
        { mode: 0o600 },
      );
    }
  }
  const diff = precomputedDiff ?? (await collectDiff(input.repoRoot, reviewBase));
  const orchestrator = new Orchestrator({
    repoRoot: input.repoRoot,
    config: cfg,
    adapters,
    sandboxMode: input.sandboxModeOverride ?? cfg.sandbox.mode,
    hostTier: host.tier,
    diff,
    gitInfo,
    reasonOnFailEnabled: true,
    reviewBaseSha: reviewBase,
    // Partial-diff guard: surfaced to reviewers as trusted context (not buried in
    // the untrusted fence) so a truncated/timed-out diff isn't trusted as complete.
    diffIncomplete: diff.includes(DIFF_INCOMPLETE_MARKER),
  });

  const driver = new LoopDriver({
    repoRoot: input.repoRoot,
    config: cfg,
    state,
    audit,
    orchestrator,
    stopHookActive: stopHookActiveFlag(parsedStdin),
    headSha: gitInfo.sha,
  });
  const decision = await driver.run();

  // Completion signal — so a passing review is no longer SILENT (the agent
  // can't be pinged on allow_stop by the hook architecture, but the human can):
  //  - always write the gate status to stderr (surfaced in the hook output),
  //  - optionally fire a desktop notification when notify.desktop is enabled.
  // The reason is already self-branded ("🟢 Reviewgate · GATE OPEN — …").
  const signal = decision.reason;
  if (cfg.notify.desktop) {
    notifyDesktop("Reviewgate", decision.reason);
  }

  if (decision.kind === "block") {
    return {
      exitCode: 0,
      stdout: JSON.stringify({ decision: "block", reason: decision.reason }),
      stderr: signal,
    };
  }
  // allow_stop: exit 0. The summary still goes to stderr so "green" is visible.
  return { exitCode: 0, stdout: "", stderr: signal };
}
