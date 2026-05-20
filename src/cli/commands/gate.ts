// src/cli/commands/gate.ts
import { existsSync } from "node:fs";
import { ulid } from "ulid";
import { AuditLogger } from "../../audit/logger.ts";
import type { ReviewgateConfig } from "../../config/define-config.ts";
import { defaultConfigPath, loadConfig } from "../../config/loader.ts";
import { LoopDriver } from "../../core/loop-driver.ts";
import { Orchestrator } from "../../core/orchestrator.ts";
import { StateStore } from "../../core/state-store.ts";
import { handleReset, handleTrigger, parseHookStdin } from "../../hooks/handlers.ts";
import type { ProviderAdapter } from "../../providers/adapter-base.ts";
import { type ProviderId, createAdapter } from "../../providers/registry.ts";
import { collectDiff, collectGitInfo } from "../../utils/git.ts";
import { detectHostModel } from "../../utils/host-model.ts";
import { notifyDesktop } from "../../utils/notify.ts";
import { auditDir } from "../../utils/paths.ts";

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

async function loadEffectiveConfig(repoRoot: string): Promise<ReviewgateConfig> {
  const p = defaultConfigPath(repoRoot);
  if (existsSync(p)) {
    try {
      return await loadConfig(p);
    } catch {
      // Config file present but failed to load (e.g. missing peer package in test env).
      // Fall back to defaults so the gate remains functional.
    }
  }
  return loadConfig(null);
}

function stopHookActiveFlag(parsed: unknown): boolean {
  const obj = parsed as { stop_hook_active?: boolean } | null;
  return Boolean(obj?.stop_hook_active);
}

export async function runGate(input: GateInput): Promise<GateOutput> {
  const cfg = await loadEffectiveConfig(input.repoRoot);
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

  const adapters: Partial<Record<ProviderId, ProviderAdapter>> = {};
  for (const r of cfg.phases.review.reviewers) {
    if (!adapters[r.provider]) {
      adapters[r.provider] = input.providerOverrides?.[r.provider] ?? createAdapter(r.provider);
    }
  }
  if (cfg.phases.critic && !adapters[cfg.phases.critic.provider]) {
    adapters[cfg.phases.critic.provider] =
      input.providerOverrides?.[cfg.phases.critic.provider] ??
      createAdapter(cfg.phases.critic.provider);
  }
  const orchestrator = new Orchestrator({
    repoRoot: input.repoRoot,
    config: cfg,
    adapters,
    sandboxMode: input.sandboxModeOverride ?? cfg.sandbox.mode,
    hostTier: host.tier,
    diff: collectDiff(input.repoRoot),
    gitInfo: collectGitInfo(input.repoRoot),
    reasonOnFailEnabled: true,
  });

  const driver = new LoopDriver({
    repoRoot: input.repoRoot,
    config: cfg,
    state,
    audit,
    orchestrator,
    stopHookActive: stopHookActiveFlag(parsedStdin),
  });
  const decision = await driver.run();

  // Completion signal — so a passing review is no longer SILENT (the agent
  // can't be pinged on allow_stop by the hook architecture, but the human can):
  //  - always write a one-line summary to stderr (surfaced in the hook output),
  //  - optionally fire a desktop notification when notify.desktop is enabled.
  const signal = `Reviewgate: ${decision.kind === "block" ? "BLOCK" : "DONE"} — ${decision.reason}`;
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
