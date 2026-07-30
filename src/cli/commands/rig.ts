// src/cli/commands/rig.ts
// CLI surface for the longitudinal effectiveness rig. `bench` measures the panel against
// labelled diffs with a fresh state dir per case, which leaves every history-dependent
// layer (fp-ledger, reputation, region memory, lore, agent-lessons) inert. The rig measures
// what that structurally cannot: the gate as an interactive loop, over a run whose history
// accumulates.
import { constants, accessSync, existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { type DriverRunManifest, runDriver } from "../../rig/driver.ts";
import { harvest } from "../../rig/harvest.ts";
import { loadTurnScript } from "../../rig/turn-script.ts";
import type { RigResult } from "../../schemas/rig-result.ts";
import { writeFileAtomic } from "../../utils/atomic-write.ts";
import { workingTreeDirtyFiles } from "../../utils/git.ts";

export interface RigRunInput {
  scriptPath: string;
  outDir: string;
  repoRoot: string;
  maxTurns?: number;
  cassetteEnv?: string | undefined;
  /** Opt out of the clean-worktree guard. Only for a repo you have decided is disposable. */
  allowDirtyRepo?: boolean;
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
  //
  // BEST-EFFORT BY CONSTRUCTION, and deliberately so: the parent checks, but the CHILD
  // writes the cassette (through the inherited env var), so the directory can still vanish
  // in between. This is a pre-flight check that catches the common misconfiguration, not a
  // guarantee — do not let a later reader mistake it for one (gate finding F-002).
  const cassettePath = input.cassetteEnv.slice("record:".length);
  // An absolute path is REQUIRED. `record:cassette.jsonl` has a dirname of ".", which
  // existsSync always accepts, and the file would then land relative to the SPAWNED
  // process's cwd rather than the caller's — a guard that passes while pointing somewhere
  // nobody intended is worse than no guard.
  if (!isAbsolute(cassettePath)) {
    throw new Error(
      `rig run: REVIEWGATE_CASSETTE must use an ABSOLUTE path (got "${cassettePath}"). A relative path resolves against the spawned agent's working directory, not yours, so the recording would land somewhere unintended.`,
    );
  }
  const cassetteDir = dirname(cassettePath);
  // No empty-path branch here: isAbsolute("") is false, so an empty path already threw above.
  if (!existsSync(cassetteDir)) {
    throw new Error(
      `rig run: the cassette directory ${cassetteDir} does not exist, so the run would record nothing. Create it before starting — this is only detectable now, not after the quota is spent.`,
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

  // A rig run points a real `claude -p --permission-mode acceptEdits` at repoRoot and feeds
  // it prompts from a user-supplied JSON file. The pilot script deliberately contains
  // prompts like "put the API token directly in the source" — harmless in a throwaway repo,
  // not harmless in yours. Nothing in the driver sandboxes this, so refuse the case that
  // distinguishes the two: a throwaway rig repo is committed and clean when a turn starts;
  // a repo somebody is working in usually is not (gate finding F-001).
  const dirty = await workingTreeDirtyFiles(input.repoRoot);
  if (dirty.length > 0 && !input.allowDirtyRepo) {
    throw new Error(
      `rig run: ${input.repoRoot} has ${dirty.length} uncommitted change(s). This run would let an agent edit that directory with acceptEdits, driven by prompts from ${input.scriptPath}. Point it at a throwaway repo, or pass allowDirtyRepo once you have read the script and accept what it will do.`,
    );
  }
  process.stderr.write(
    `rig run: an agent will EDIT ${input.repoRoot} with acceptEdits, for ${script.turns.length} scripted turn(s).\n`,
  );
  return await runDriver({
    scriptPath: input.scriptPath,
    outDir: input.outDir,
    repoRoot: input.repoRoot,
    agentCmd: claudeAgentCmd,
    maxTurns: input.maxTurns ?? script.turns.length,
  });
}

export interface RigHarvestInput {
  manifestPath: string;
  scriptPath: string;
  /** Where to write the result JSON. Omitted → the result is only returned/printed. */
  outPath?: string | undefined;
}

/**
 * Fold a completed (or partial) run's snapshots into one `reviewgate.rig.result.v1`.
 *
 * Pure and offline: it reads snapshots and writes one JSON file. No agent, no network, no
 * quota — so a run's numbers can be re-derived as often as the definitions change, which is
 * the point of harvesting from artifacts instead of scraping a live turn.
 */
export function runRigHarvest(input: RigHarvestInput): RigResult {
  const result = harvest(input.manifestPath, input.scriptPath);
  if (input.outPath !== undefined) {
    mkdirSync(dirname(input.outPath), { recursive: true });
    writeFileAtomic(input.outPath, `${JSON.stringify(result, null, 2)}\n`);
  }
  // Warnings go to stderr, unconditionally and BEFORE any summary line: a skipped turn, an
  // unreadable report or a sub-2-provider panel changes how every number below must be read,
  // and Task 6's honesty rules require it to be stated in the same breath, not looked up.
  for (const w of result.warnings) process.stderr.write(`rig harvest: ⚠ ${w}\n`);
  return result;
}
