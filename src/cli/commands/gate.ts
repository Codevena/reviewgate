import { spawnSync } from "node:child_process";
// src/cli/commands/gate.ts
import { existsSync, readFileSync } from "node:fs";
import { ulid } from "ulid";
import { AuditLogger } from "../../audit/logger.ts";
import type { ReviewgateConfig } from "../../config/define-config.ts";
import { defaultConfigPath, loadConfig } from "../../config/loader.ts";
import { LoopDriver } from "../../core/loop-driver.ts";
import { Orchestrator } from "../../core/orchestrator.ts";
import { StateStore } from "../../core/state-store.ts";
import { handleReset, handleTrigger, parseHookStdin } from "../../hooks/handlers.ts";
import type { ProviderAdapter } from "../../providers/adapter-base.ts";
import { CodexAdapter } from "../../providers/codex.ts";
import { detectHostModel } from "../../utils/host-model.ts";
import { auditDir } from "../../utils/paths.ts";

export interface GateInput {
  repoRoot: string;
  hook: "trigger" | "stop" | "reset";
  hookStdinRaw: string;
  providerOverrides?: { codex?: ProviderAdapter };
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

function readDiff(repoRoot: string): string {
  // Use git to get the working-tree diff against HEAD.
  const r = spawnSync("git", ["diff", "--no-color", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  return r.status === 0 ? r.stdout : "";
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

  const codex = input.providerOverrides?.codex ?? new CodexAdapter();
  const orchestrator = new Orchestrator({
    repoRoot: input.repoRoot,
    config: cfg,
    providers: { codex },
    sandboxMode: input.sandboxModeOverride ?? cfg.sandbox.mode,
    hostTier: host.tier,
    diff: readDiff(input.repoRoot),
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

  if (decision.kind === "block") {
    return {
      exitCode: 0,
      stdout: JSON.stringify({ decision: "block", reason: decision.reason }),
      stderr: "",
    };
  }
  // allow_stop: print empty body; exit 0.
  return { exitCode: 0, stdout: "", stderr: "" };
}
