// src/cli/commands/rig.ts
// CLI surface for the longitudinal effectiveness rig. `bench` measures the panel against
// labelled diffs with a fresh state dir per case, which leaves every history-dependent
// layer (fp-ledger, reputation, region memory, lore, agent-lessons) inert. The rig measures
// what that structurally cannot: the gate as an interactive loop, over a run whose history
// accumulates.
import { constants, accessSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { type DriverRunManifest, runDriver } from "../../rig/driver.ts";
import { loadTurnScript } from "../../rig/turn-script.ts";

export interface RigRunInput {
  scriptPath: string;
  outDir: string;
  repoRoot: string;
  maxTurns?: number;
  cassetteEnv?: string | undefined;
}

/**
 * The agent invocation proven in the headless-gate spike (2026-07-29):
 * `--permission-mode acceptEdits` is required or the agent cannot edit files, and the Stop
 * hook fires — including the FAIL → decision → re-review loop — within this single process.
 */
export function claudeAgentCmd(prompt: string): string[] {
  return ["claude", "-p", prompt, "--permission-mode", "acceptEdits"];
}

export async function runRigRun(input: RigRunInput): Promise<DriverRunManifest> {
  // Refuse an unrecorded run. A pilot without a cassette cannot be replayed, and replay is
  // the whole reason the run is affordable to re-examine later — re-running it costs real
  // agent quota, so an unrecorded run is a one-shot result nobody can check.
  if (!input.cassetteEnv?.startsWith("record:")) {
    throw new Error(
      "rig run: REVIEWGATE_CASSETTE must be set to `record:<path>`. Without a recording the " +
        "run cannot be replayed or re-examined, and reproducing it costs real agent quota.",
    );
  }
  // The prefix alone is not enough: `record:/nope/x.jsonl` passes it and then records
  // nowhere, which is the exact failure the guard exists to prevent — discovered only after
  // a multi-turn run has already spent its quota. Check the destination is writable NOW.
  const cassettePath = input.cassetteEnv.slice("record:".length);
  const cassetteDir = dirname(cassettePath);
  if (cassettePath.length === 0 || !existsSync(cassetteDir)) {
    throw new Error(
      `rig run: the cassette directory ${cassetteDir || "(empty path)"} does not exist, so the run would record nothing. Create it before starting — this is only detectable now, not after the quota is spent.`,
    );
  }
  try {
    accessSync(cassetteDir, constants.W_OK);
  } catch {
    throw new Error(
      `rig run: the cassette directory ${cassetteDir} is not writable, so the run would record nothing.`,
    );
  }
  // Validate the script BEFORE spawning anything: a malformed script must stop the run
  // before it burns quota, not halfway through turn 7.
  const script = loadTurnScript(input.scriptPath);
  return await runDriver({
    scriptPath: input.scriptPath,
    outDir: input.outDir,
    repoRoot: input.repoRoot,
    agentCmd: claudeAgentCmd,
    maxTurns: input.maxTurns ?? script.turns.length,
  });
}
