// src/cli/commands/rig.ts
// CLI surface for the longitudinal effectiveness rig. `bench` measures the panel against
// labelled diffs with a fresh state dir per case, which leaves every history-dependent
// layer (fp-ledger, reputation, region memory, lore, agent-lessons) inert. The rig measures
// what that structurally cannot: the gate as an interactive loop, over a run whose history
// accumulates.
import { createHash } from "node:crypto";
import {
  constants,
  accessSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createPrivateCassette } from "../../cassette/store.ts";
import {
  POLICY_CATALOG_VERSION,
  POLICY_PASS_IDS,
  type PolicyPassId,
} from "../../core/policy/catalog.ts";
import { resolvePolicyReplayCaptureSink } from "../../core/policy/replay-capture.ts";
import {
  SUPPRESSION_LAYERS,
  type SuppressionLayer,
  ablate,
  isSuppressionLayer,
  renderAblationMatrix,
  seededTagsFromScript,
} from "../../rig/ablate.ts";
import { type DriverRunManifest, runDriver } from "../../rig/driver.ts";
import { harvest } from "../../rig/harvest.ts";
import { createPolicyStateSnapshot } from "../../rig/policy-replay-state.ts";
import {
  renderPolicyAblationRows,
  renderReplayReport,
  replay,
  replayPolicyAblations,
} from "../../rig/replay.ts";
import { renderRigReport } from "../../rig/report.ts";
import { loadTurnScript, readTurnScript } from "../../rig/turn-script.ts";
import { type RigResult, RigResultSchema } from "../../schemas/rig-result.ts";
import { writeFileAtomic } from "../../utils/atomic-write.ts";
import { gitHeadSha, workingTreeDirtyFiles } from "../../utils/git.ts";

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
  // The parent validates the destination now and exclusively creates the private file after
  // all other pre-flight checks. The child may only append through the no-follow Store path;
  // Driver revalidates the same inode before every size/read/hash/copy operation.
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
  // The cassette must live INSIDE the repo being reviewed. The recorder refuses anything
  // else (path-traversal/symlink guard), and it refuses it inside the GATE's setup phase —
  // which fails the whole review before a single audit event is written. This guard checked
  // absolute/exists/writable and missed exactly that, so a run whose cassette pointed at the
  // rig's own results directory passed pre-flight and then produced twelve turns of nothing.
  // Cost three pilot attempts to find (field, 2026-08-05); mirror the recorder's rule here,
  // where it is still free to be wrong.
  const repoLexical = resolve(input.repoRoot);
  const cassetteRelative = relative(repoLexical, resolve(cassettePath));
  const repoReal = realpathSync(input.repoRoot);
  const cassetteDirReal = realpathSync(cassetteDir);
  const cassetteRealRelative = relative(repoReal, cassetteDirReal);
  const isRelativeInside = (value: string): boolean =>
    value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
  if (!isRelativeInside(cassetteRelative) || !isRelativeInside(cassetteRealRelative)) {
    throw new Error(
      `rig run: REVIEWGATE_CASSETTE must point INSIDE the repo under review (${input.repoRoot}), but got "${cassettePath}". The recorder refuses to write outside it, and it refuses during the gate's SETUP phase — so every turn would complete with the agent's edits made and no review at all. Put the cassette in the sandbox and copy it out after the run.`,
    );
  }
  try {
    lstatSync(cassettePath);
    throw new Error(
      `rig run: private cassette ${cassettePath} already exists; refusing to follow or overwrite it`,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
  const output = resolve(input.outDir);
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const outputStat = lstatSync(output);
  if (outputStat.isSymbolicLink() || !outputStat.isDirectory()) {
    throw new Error("rig run: the output root must be an ordinary directory");
  }
  const outputReal = realpathSync(output);
  const outputRelative = relative(repoReal, outputReal);
  const repoRelative = relative(outputReal, repoReal);
  const related = (value: string): boolean =>
    value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
  if (related(outputRelative) || related(repoRelative)) {
    throw new Error(
      "rig run: --out must be separate from the measured repository so replay artifacts cannot change the measured tree",
    );
  }
  const replaySinkDir = resolve(outputReal, "policy-replay");
  mkdirSync(replaySinkDir, { mode: 0o700 });
  const captureSink = resolvePolicyReplayCaptureSink({
    sinkDir: replaySinkDir,
    measuredRepoRoot: repoReal,
  });
  if (captureSink === null || relative(outputReal, captureSink.sinkDir).startsWith("..")) {
    throw new Error("rig run: policy replay sink is not contained by the Rig output root");
  }
  const initialState = createPolicyStateSnapshot({
    sourceRepoRoot: repoReal,
    outputRoot: outputReal,
  });
  const sourceCommit = await gitHeadSha(repoReal);
  if (sourceCommit === null) throw new Error("rig run: could not resolve the source commit");
  createPrivateCassette(cassettePath);
  const emptyCassetteSha256 = new Bun.CryptoHasher("sha256").update("").digest("hex");
  process.stderr.write(
    `rig run: an agent will EDIT ${input.repoRoot} with acceptEdits, for ${script.turns.length} scripted turn(s).\n`,
  );
  return await runDriver({
    scriptPath: input.scriptPath,
    outDir: outputReal,
    repoRoot: repoReal,
    agentCmd: claudeAgentCmd,
    maxTurns: input.maxTurns ?? script.turns.length,
    policyReplay: {
      sinkDir: captureSink.sinkDir,
      cassettePath,
      metadata: {
        catalogVersion: POLICY_CATALOG_VERSION,
        sourceCommit,
        initialStateRef: initialState.ref,
        initialStateSha256: initialState.sha256,
        initialStateDigest: initialState.stateSha256,
        cassetteSha256: emptyCassetteSha256,
        cassetteRef: "cassette.jsonl",
        captureDir: "policy-replay",
      },
    },
  });
}

/** Read a harvested result off disk, validated — never structurally trusted. */
function loadResult(path: string): RigResult {
  return RigResultSchema.parse(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

export interface RigReportInput {
  resultPath: string;
  markdown?: boolean;
}

export function runRigReport(input: RigReportInput): string {
  const rendered = renderRigReport(loadResult(input.resultPath));
  return input.markdown === true ? rendered.markdown : rendered.table;
}

export interface RigAblateInput {
  resultPath: string;
  scriptPath: string;
  /** Omitted → every layer, as a matrix. */
  layer?: string | undefined;
  sourceRepoRoot?: string | undefined;
}

export class RigLayerSelectorError extends Error {
  readonly exitCode = 2;

  constructor(message: string) {
    super(message);
    this.name = "RigLayerSelectorError";
  }
}

/**
 * Exact traced results replay every closed-catalog pass in isolated branches. Legacy results
 * retain the old four-layer heuristic with a mandatory non-authoritative label.
 */
export async function runRigAblate(input: RigAblateInput): Promise<string> {
  const base = loadResult(input.resultPath);
  if (base.policyReplay?.authoritative === true) {
    const passId = input.layer;
    if (passId !== undefined && !(POLICY_PASS_IDS as readonly string[]).includes(passId)) {
      throw new RigLayerSelectorError(
        `rig ablate: exact --layer must be one closed-catalog id: ${POLICY_PASS_IDS.join(", ")}`,
      );
    }
    const scriptArtifact = readTurnScript(input.scriptPath);
    const script = scriptArtifact.script;
    const scriptSha256 = createHash("sha256").update(scriptArtifact.bytes).digest("hex");
    const siblingManifest = resolve(
      dirname(input.resultPath),
      base.policyReplay.artifactBinding?.manifestRef ?? "manifest.json",
    );
    const manifestPath = existsSync(siblingManifest)
      ? siblingManifest
      : base.provenance.manifest_path;
    return renderPolicyAblationRows(
      await replayPolicyAblations({
        manifestPath,
        sourceRepoRoot: input.sourceRepoRoot ?? process.cwd(),
        authority: { result: base, scriptId: script.id, scriptSha256 },
        ...(passId === undefined ? {} : { passId: passId as PolicyPassId }),
      }),
    );
  }
  if (input.layer !== undefined && !isSuppressionLayer(input.layer)) {
    throw new RigLayerSelectorError(
      `rig ablate: legacy --layer must be one of ${SUPPRESSION_LAYERS.join(", ")}`,
    );
  }
  const tags = seededTagsFromScript(input.scriptPath);
  const layers: SuppressionLayer[] =
    input.layer === undefined ? [...SUPPRESSION_LAYERS] : [input.layer as SuppressionLayer];
  return `NON-AUTHORITATIVE LEGACY ANALYSIS — exact policy opportunities were not captured.\n${renderAblationMatrix(
    base,
    layers.map((l) => ablate(base, l, tags)),
  )}`;
}

export interface RigReplayInput {
  manifestPath: string;
  scriptPath: string;
  cassettePath?: string | undefined;
  sourceRepoRoot?: string | undefined;
}

/**
 * Exact traced runs validate/counterfactually replay policy; legacy runs keep the harness check.
 */
export async function runRigReplay(input: RigReplayInput): Promise<{ text: string; ok: boolean }> {
  const report = await replay(input);
  return { text: renderReplayReport(report), ok: report.deterministic };
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
