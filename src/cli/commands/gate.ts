// src/cli/commands/gate.ts
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
import { collectDiff, collectGitInfo } from "../../utils/git.ts";
import { detectHostModel } from "../../utils/host-model.ts";
import { notifyDesktop } from "../../utils/notify.ts";
import { auditDir } from "../../utils/paths.ts";
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
  const gitInfo = collectGitInfo(input.repoRoot);
  const orchestrator = new Orchestrator({
    repoRoot: input.repoRoot,
    config: cfg,
    adapters,
    sandboxMode: input.sandboxModeOverride ?? cfg.sandbox.mode,
    hostTier: host.tier,
    diff: collectDiff(input.repoRoot),
    gitInfo,
    reasonOnFailEnabled: true,
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
