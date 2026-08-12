import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  cpSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalJson } from "../../audit/canonical.ts";
import { matchesAnyTag } from "../../bench/matcher.ts";
import type { PolicyPassId } from "../../core/policy/catalog.ts";
import { POLICY_PASS_IDS } from "../../core/policy/catalog.ts";
import { POLICY_MEASUREMENT_INTERACTIONS } from "../../core/policy/measurement-contract.ts";
import { validateRigPolicyReplayArtifacts } from "../../rig/policy-replay-state.ts";
import {
  type PolicyReplayPair,
  type PolicyReplaySequenceItem,
  assertRigResultManifestBinding,
  replayPolicyProfileSequence,
} from "../../rig/replay.ts";
import type { Finding } from "../../schemas/finding.ts";
import type { PolicyMeasurementPreregistration } from "../../schemas/policy-measurement-preregistration.ts";
import {
  type PolicyRigEvidence,
  PolicyRigEvidenceSchema,
  type PolicyRigScenarioManifest,
  PolicyRigScenarioManifestSchema,
} from "../../schemas/policy-measurement.ts";
import type { PolicyTrace } from "../../schemas/policy-trace.ts";
import { RigManifestSchema } from "../../schemas/rig-manifest.ts";
import { RigResultSchema } from "../../schemas/rig-result.ts";
import { RigTurnScriptSchema } from "../../schemas/rig-turn-script.ts";

const MAX_BOUND_ARTIFACT_BYTES = 8 * 1_048_576;
export const POLICY_RIG_HISTORY_GROUP = POLICY_PASS_IDS.filter((passId) =>
  POLICY_MEASUREMENT_INTERACTIONS[2].includes(passId as never),
);

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function validRef(ref: string): boolean {
  return (
    ref.length > 0 &&
    !isAbsolute(ref) &&
    !ref.includes("\\") &&
    !ref.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  );
}

function artifactPath(root: string, ref: string): string {
  if (!validRef(ref)) throw new Error(`policy Rig evidence has an invalid ref: ${ref}`);
  const path = resolve(root, ...ref.split("/"));
  if (!contained(resolve(root), path)) {
    throw new Error(`policy Rig evidence artifact escapes source root: ${ref}`);
  }
  return path;
}

/** Private, bounded, no-follow, single-FD read of one scenario-declared artifact. */
function readBound(root: string, binding: { ref: string; sha256: string }): Buffer {
  if (!/^[0-9a-f]{64}$/.test(binding.sha256)) {
    throw new Error(`policy Rig evidence has an invalid hash: ${binding.ref}`);
  }
  const rootPath = resolve(root);
  const path = artifactPath(rootPath, binding.ref);
  const rootStat = lstatSync(rootPath);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("policy Rig evidence root is unsafe");
  }
  const realRoot = realpathSync(rootPath);
  let parent = rootPath;
  for (const component of binding.ref.split("/").slice(0, -1)) {
    parent = join(parent, component);
    const stat = lstatSync(parent);
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      !contained(realRoot, realpathSync(parent))
    ) {
      throw new Error(`policy Rig evidence parent is unsafe: ${binding.ref}`);
    }
  }
  const before = lstatSync(path);
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.nlink !== 1 ||
    (before.mode & 0o7777) !== 0o600 ||
    before.size > MAX_BOUND_ARTIFACT_BYTES ||
    !contained(realRoot, realpathSync(path))
  ) {
    throw new Error(`policy Rig evidence artifact is unsafe: ${binding.ref}`);
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      (opened.mode & 0o7777) !== 0o600 ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size > MAX_BOUND_ARTIFACT_BYTES
    ) {
      throw new Error(`policy Rig evidence artifact changed before read: ${binding.ref}`);
    }
    const bounded = Buffer.allocUnsafe(MAX_BOUND_ARTIFACT_BYTES + 1);
    const bytesRead = readSync(fd, bounded, 0, bounded.length, null);
    if (bytesRead > MAX_BOUND_ARTIFACT_BYTES) {
      throw new Error(`policy Rig evidence artifact is too large: ${binding.ref}`);
    }
    const bytes = bounded.subarray(0, bytesRead);
    const after = fstatSync(fd);
    const pathAfter = lstatSync(path);
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs ||
      pathAfter.isSymbolicLink() ||
      !pathAfter.isFile() ||
      pathAfter.nlink !== 1 ||
      (pathAfter.mode & 0o7777) !== 0o600 ||
      pathAfter.dev !== after.dev ||
      pathAfter.ino !== after.ino ||
      sha256(bytes) !== binding.sha256
    ) {
      throw new Error(`policy Rig evidence artifact identity mismatch: ${binding.ref}`);
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function parseJson(bytes: Buffer, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error(`policy Rig evidence ${label} is not valid UTF-8 JSON`);
  }
}

function sameIndices(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Opportunity carriers are trace facts; a merely executed pass is not an opportunity. */
export function policyRigOpportunity(trace: PolicyTrace, passIds: readonly PolicyPassId[]) {
  let summary = 0;
  let evaluations = 0;
  for (const passId of passIds) {
    const row = trace.passes.find((candidate) => candidate.pass_id === passId);
    if (row?.status === "ran") summary += row.opportunities;
    evaluations += trace.evaluations.filter(
      (candidate) => candidate.pass_id === passId && candidate.result !== "no-opportunity",
    ).length;
  }
  return { summary, evaluations, stages: 0, observed: summary + evaluations > 0 };
}

function truth(findings: readonly Finding[], tags: readonly string[] | null) {
  const blocking = findings.filter(
    (finding) => finding.severity === "CRITICAL" || finding.severity === "WARN",
  );
  if (tags === null) {
    return { blocking_fp: blocking.length, blocking_fn: 0, blocking_tp: 0 };
  }
  const matched = blocking.findIndex((finding) =>
    matchesAnyTag(`${finding.message} ${finding.details}`, [...tags]),
  );
  return {
    blocking_fp: blocking.length - (matched >= 0 ? 1 : 0),
    blocking_fn: matched >= 0 ? 0 : 1,
    blocking_tp: matched >= 0 ? 1 : 0,
  };
}

/** A seeded script label becomes Rig ground truth only after its landed diff was verified. */
export function policyRigSeedTags(
  seeded: { tags: readonly string[] } | null,
  seedLanded: boolean | null | undefined,
): readonly string[] | null {
  if (seeded === null) return null;
  if (seedLanded !== true) {
    throw new Error("policy Rig seeded ground truth requires verified seed landing");
  }
  return seeded.tags;
}

type TruthCounts = ReturnType<typeof truth>;

function sumTruth(
  rows: readonly { baseline: { truth: TruthCounts }; counterfactual: { truth: TruthCounts } }[],
) {
  const sum = (branch: "baseline" | "counterfactual") =>
    rows.reduce(
      (total, row) => ({
        blocking_fp: total.blocking_fp + row[branch].truth.blocking_fp,
        blocking_fn: total.blocking_fn + row[branch].truth.blocking_fn,
        blocking_tp: total.blocking_tp + row[branch].truth.blocking_tp,
      }),
      { blocking_fp: 0, blocking_fn: 0, blocking_tp: 0 },
    );
  const baseline = sum("baseline");
  const ablated = sum("counterfactual");
  return {
    baseline,
    ablated,
    error_reduction:
      ablated.blocking_fp + ablated.blocking_fn - baseline.blocking_fp - baseline.blocking_fn,
  };
}

interface FlatTurn {
  turnIndex: number;
  tags: readonly string[] | null;
  item: PolicyReplaySequenceItem;
}

function turnEvidence(input: {
  flat: readonly FlatTurn[];
  pairs: readonly PolicyReplayPair[];
  passIds: readonly PolicyPassId[];
}) {
  const indices = [...new Set(input.flat.map((row) => row.turnIndex))].sort((a, b) => a - b);
  return indices.map((turnIndex) => {
    const positions = input.flat.flatMap((row, index) =>
      row.turnIndex === turnIndex ? [index] : [],
    );
    const lastPosition = positions.at(-1);
    const last = lastPosition === undefined ? undefined : input.pairs[lastPosition];
    const tags = input.flat[positions[0] ?? -1]?.tags ?? null;
    if (last === undefined) throw new Error(`policy Rig replay omitted turn ${turnIndex}`);
    const carriers = positions.map((position) => {
      const pair = input.pairs[position];
      if (pair === undefined) throw new Error(`policy Rig replay omitted position ${position}`);
      return policyRigOpportunity(pair.baseline, input.passIds);
    });
    const observed = carriers.some((carrier) => carrier.observed);
    return {
      turn_index: turnIndex,
      opportunity: {
        summary: carriers.reduce((sum, carrier) => sum + carrier.summary, 0),
        evaluations: carriers.reduce((sum, carrier) => sum + carrier.evaluations, 0),
        stages: carriers.reduce((sum, carrier) => sum + carrier.stages, 0),
        observed,
      },
      baseline: { truth: truth(last.findings.baseline, tags), state: last.state.baseline },
      counterfactual: {
        truth: truth(last.findings.counterfactual, tags),
        state: last.state.counterfactual,
      },
    };
  });
}

function profileEvidence(input: {
  flat: readonly FlatTurn[];
  pairs: readonly PolicyReplayPair[];
  passIds: readonly PolicyPassId[];
}) {
  const turns = turnEvidence(input);
  return {
    opportunity_turns: turns.filter((turn) => turn.opportunity.observed).length,
    truth_effects: sumTruth(turns),
    turns,
  };
}

function copyReplaySnapshots(flat: readonly FlatTurn[]): {
  root: string;
  flat: FlatTurn[];
} {
  const root = mkdtempSync(join(tmpdir(), "reviewgate-policy-rig-evidence-"));
  return {
    root,
    flat: flat.map((row, index) => {
      const destination = join(root, `state-${index + 1}`);
      cpSync(row.item.stateSnapshotRoot, destination, { recursive: true, dereference: false });
      return {
        ...row,
        item: { ...row.item, stateSnapshotRoot: destination },
      };
    }),
  };
}

/** Collect fully bound truth/state evidence only after every Rig artifact passes authority checks. */
export async function collectPolicyRigEvidence(input: {
  preregistration: PolicyMeasurementPreregistration;
  manifest: PolicyRigScenarioManifest;
  sourceRepoRoot: string;
}): Promise<PolicyRigEvidence> {
  const scenarioBinding = {
    ref: input.preregistration.stateful.manifest_ref,
    sha256: input.preregistration.stateful.manifest_sha256,
  };
  const scenarioBytes = readBound(input.sourceRepoRoot, scenarioBinding);
  const persisted = PolicyRigScenarioManifestSchema.parse(parseJson(scenarioBytes, "manifest"));
  if (
    canonicalJson(persisted) !== new TextDecoder("utf-8", { fatal: true }).decode(scenarioBytes)
  ) {
    throw new Error("policy Rig scenario manifest is not canonical");
  }
  const scenarios = PolicyRigScenarioManifestSchema.parse(input.manifest);
  if (canonicalJson(persisted) !== canonicalJson(scenarios)) {
    throw new Error("policy Rig scenario manifest differs from preregistered bytes");
  }

  const sequences: PolicyRigEvidence["sequences"] = [];
  for (const scenario of scenarios.scenarios) {
    const manifestBytes = readBound(input.sourceRepoRoot, scenario.manifest);
    const rigManifestPath = artifactPath(input.sourceRepoRoot, scenario.manifest.ref);
    const rigManifest = RigManifestSchema.parse(parseJson(manifestBytes, "Rig manifest"));
    const result = RigResultSchema.parse(
      parseJson(readBound(input.sourceRepoRoot, scenario.result), "Rig result"),
    );
    const script = RigTurnScriptSchema.parse(
      parseJson(readBound(input.sourceRepoRoot, scenario.script), "turn script"),
    );
    if (scenario.id !== rigManifest.runId || scenario.id !== result.runId) {
      throw new Error(
        `policy Rig scenario run identity differs from its bound artifacts: ${scenario.id}`,
      );
    }
    if (
      script.id !== rigManifest.scriptId ||
      script.id !== result.provenance.script_id ||
      script.id !== result.policyReplay?.artifactBinding?.scriptId
    ) {
      throw new Error(`policy Rig scenario script identity differs: ${scenario.id}`);
    }
    if (
      rigManifest.scriptSha256 === undefined ||
      rigManifest.scriptSha256 !== scenario.script.sha256 ||
      result.policyReplay?.artifactBinding?.scriptSha256 !== scenario.script.sha256
    ) {
      throw new Error(`policy Rig scenario script content binding differs: ${scenario.id}`);
    }
    assertRigResultManifestBinding({
      result,
      manifest: rigManifest,
      manifestPath: rigManifestPath,
      manifestBytes,
      scriptId: script.id,
      scriptSha256: scenario.script.sha256,
    });
    const manifestIndices = rigManifest.turns.map((turn) => turn.index);
    if (
      !sameIndices(
        manifestIndices,
        script.turns.map((turn) => turn.index),
      ) ||
      !sameIndices(
        manifestIndices,
        result.turns.map((turn) => turn.index),
      )
    ) {
      throw new Error(`policy Rig scenario turn inventories differ: ${scenario.id}`);
    }
    for (const [index, turn] of script.turns.entries()) {
      if (result.turns[index]?.seededId !== (turn.seeded?.id ?? null)) {
        throw new Error(`policy Rig scenario seed identity differs: ${scenario.id}`);
      }
    }
    const metadata = rigManifest.policyReplay;
    if (metadata === undefined) {
      throw new Error(`policy Rig scenario has no replay metadata: ${scenario.id}`);
    }
    const expectedStatePath = resolve(dirname(rigManifestPath), metadata.initialStateRef);
    if (
      artifactPath(input.sourceRepoRoot, scenario.initial_state.ref) !== expectedStatePath ||
      metadata.initialStateSha256 !== scenario.initial_state.sha256
    ) {
      throw new Error(`policy Rig scenario state binding mismatch: ${scenario.id}`);
    }
    readBound(input.sourceRepoRoot, scenario.initial_state);
    const validated = validateRigPolicyReplayArtifacts({
      manifest: rigManifest,
      manifestPath: rigManifestPath,
    });
    if (validated === null) {
      throw new Error(`policy Rig scenario is not authoritative: ${scenario.id}`);
    }
    const flat: FlatTurn[] = [...validated.turns.entries()]
      .sort(([left], [right]) => left - right)
      .flatMap(([turnIndex, rows]) => {
        const scriptTurn = script.turns[turnIndex - 1];
        const resultTurn = result.turns[turnIndex - 1];
        const tags = policyRigSeedTags(scriptTurn?.seeded ?? null, resultTurn?.seedLanded);
        return rows.map(({ envelope, stateRoot }) => ({
          turnIndex,
          tags,
          item: { envelope, stateSnapshotRoot: stateRoot },
        }));
      });
    const copied = copyReplaySnapshots(flat);
    try {
      const singletonPairs = await replayPolicyProfileSequence({
        sourceRepoRoot: input.sourceRepoRoot,
        items: copied.flat.map((row) => row.item),
        ablatedPassIds: [scenario.pass_id],
      });
      const singleton = profileEvidence({
        flat: copied.flat,
        pairs: singletonPairs,
        passIds: [scenario.pass_id],
      });
      if (singleton.opportunity_turns < scenario.expected_opportunity_turns) {
        throw new Error(`policy Rig scenario has insufficient opportunity turns: ${scenario.id}`);
      }
      const historyInteraction = POLICY_RIG_HISTORY_GROUP.includes(scenario.pass_id)
        ? profileEvidence({
            flat: copied.flat,
            pairs: await replayPolicyProfileSequence({
              sourceRepoRoot: input.sourceRepoRoot,
              items: copied.flat.map((row) => row.item),
              ablatedPassIds: POLICY_RIG_HISTORY_GROUP,
            }),
            passIds: POLICY_RIG_HISTORY_GROUP,
          })
        : null;
      if (
        historyInteraction !== null &&
        historyInteraction.opportunity_turns < scenario.expected_opportunity_turns
      ) {
        throw new Error(`policy Rig history group has insufficient opportunities: ${scenario.id}`);
      }
      sequences.push({
        scenario_id: scenario.id,
        pass_id: scenario.pass_id,
        authoritative: true,
        ...singleton,
        history_interaction:
          historyInteraction === null
            ? null
            : { pass_ids: [...POLICY_RIG_HISTORY_GROUP], ...historyInteraction },
        manifest: scenario.manifest,
        result: scenario.result,
        script: scenario.script,
        initial_state: scenario.initial_state,
      });
    } finally {
      rmSync(copied.root, { recursive: true, force: true });
    }
  }
  return PolicyRigEvidenceSchema.parse({
    schema: "reviewgate.policy-rig-evidence.v1",
    scenario_manifest: scenarioBinding,
    manifest: scenarios,
    authoritative: true,
    sequences,
  });
}
