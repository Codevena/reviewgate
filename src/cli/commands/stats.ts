import { createHash } from "node:crypto";
// src/cli/commands/stats.ts
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
  verifyCanonicalJsonArtifact,
  verifyNamedBytes,
  verifyNamedCanonicalJsonBytes,
  verifyNamedTextBytes,
  verifyUnboundNamedCanonicalJsonBytes,
  writeCanonicalJsonArtifact,
} from "../../artifacts/canonical-json.ts";
import { canonicalJson } from "../../audit/canonical.ts";
import { BrainStore } from "../../core/brain/store.ts";
import { FpLedgerStore } from "../../core/fp-ledger/store.ts";
import { POLICY_PASSES, POLICY_PASS_IDS, type PolicyPassId } from "../../core/policy/catalog.ts";
import {
  type PolicyBaselineProtectionEvent,
  type PolicyIdentityEvent,
  type PolicySingletonIdentityEvent,
  baselineProtectionEventKey,
  identityEventKey,
  singletonIdentityEventKey,
  sortBaselineProtectionEvents,
  sortIdentityEvents,
  sortSingletonIdentityEvents,
} from "../../core/policy/identity-events.ts";
import { POLICY_MEASUREMENT_LANES } from "../../core/policy/measurement-contract.ts";
import { policyStateTreeDigest } from "../../rig/policy-replay-state.ts";
import {
  type BenchPolicyRepeatResult,
  BenchPolicyRepeatResultSchema,
  type CaseResult,
} from "../../schemas/bench-result.ts";
import {
  type PolicyMeasurementPreregistration,
  PolicyMeasurementPreregistrationSchema,
} from "../../schemas/policy-measurement-preregistration.ts";
import {
  PolicyBenchBundleSchema,
  PolicyDogfoodAdjudicationSchema,
  PolicyDogfoodAttestationSchema,
  PolicyDogfoodInputManifestSchema,
  PolicyDogfoodSnapshotSchema,
  type PolicyMeasurement,
  PolicyMeasurementSchema,
  PolicyRigEvidenceSchema,
} from "../../schemas/policy-measurement.ts";
import { aggregate } from "../../stats/aggregate.ts";
import { loadAuditWindow } from "../../stats/load.ts";
import {
  PolicyMeasurementAuthorityError,
  assemblePolicyMeasurement,
} from "../../stats/policy/assemble.ts";
import {
  attestPolicyDogfood,
  policyDogfoodAttestationPreflight,
} from "../../stats/policy/dogfood-attestation.ts";
import { harvestPolicyDogfoodFromVerifiedSources } from "../../stats/policy/dogfood-snapshot.ts";
import { renderPolicyMeasurement } from "../../stats/policy/render.ts";
import {
  type PolicyBenchCaseEffect,
  holmAdjustPolicyFamilies,
  policyBenchStatistics,
  policyIndependentSequenceStatistics,
} from "../../stats/policy/statistics.ts";
import { renderStats } from "../../stats/render.ts";
import { writeFileIfAbsent } from "../../utils/atomic-write.ts";

const MAX_POLICY_SOURCE_BYTES = 128 * 1024 * 1024;
const CompleteBindingSchema = z
  .object({ ref: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/) })
  .strict();
const PolicyMeasurementCompleteSchema = z
  .object({
    schema: z.literal("reviewgate.policy-measurement-complete.v1"),
    result: CompleteBindingSchema,
    report: CompleteBindingSchema,
    outputs: z
      .object({
        bench_bundle: CompleteBindingSchema,
        rig_bundle: CompleteBindingSchema,
        dogfood_snapshot: CompleteBindingSchema,
        result_json: CompleteBindingSchema,
        report_md: CompleteBindingSchema,
      })
      .strict(),
    sources: z
      .array(
        CompleteBindingSchema.extend({
          material: z.enum(["file", "state-tree"]),
          copy_ref: z.string().min(1).optional(),
          members: z.array(CompleteBindingSchema).optional(),
        }).strict(),
      )
      .min(1),
  })
  .strict();

type PublishedPolicySource = z.infer<typeof PolicyMeasurementCompleteSchema>["sources"][number];

export interface RunPolicyStatsInput {
  repoRoot: string;
  preregistration: string;
  bench: string;
  rig: string;
  out: string;
}

export interface RunPolicyStatsOutput {
  exitCode: 0 | 2 | 4;
  stdout: string;
  stderr: string;
}

type PolicyAssembly = Awaited<ReturnType<typeof assemblePolicyMeasurement>>;

interface PolicyStatsRuntime {
  assemble: (input: {
    repoRoot: string;
    preregistrationPath: string;
    benchBundlePath: string;
    rigManifestPath: string;
  }) => Promise<PolicyAssembly>;
  rereadPreregistration?: (
    source: PolicyAssembly["sources"][number],
  ) => PolicyMeasurementPreregistration;
  beforeRename?: (stage: string, output: string) => void;
  beforeComplete?: (output: string) => void;
}

type PublishedSource =
  | { ref: string; sha256: string; material: "file"; copy_ref: string }
  | {
      ref: string;
      sha256: string;
      material: "state-tree";
      members: Array<{ ref: string; sha256: string }>;
    };

function sourceCopyRef(source: PolicyAssembly["sources"][number]): string {
  return `artifacts/policy-measurement-sources/${source.sha256}-${sha256(source.ref).slice(0, 16)}.bin`;
}

function verifySourceForPublication(source: PolicyAssembly["sources"][number], root: string) {
  if (source.material === "state-tree") return undefined;
  return verifyNamedBytes({
    root,
    ref: source.ref,
    sha256: source.sha256,
    maxBytes: MAX_POLICY_SOURCE_BYTES,
    privateMode: source.kind !== "preregistration",
  });
}

/** Copy the closed source inventory without inferring a format from its path. */
function copyPolicySourcesToStage(
  root: string,
  stage: string,
  sources: readonly PolicyAssembly["sources"][number][],
): PublishedSource[] {
  const copiedSources: PublishedSource[] = [];
  const verifiedFiles = new Map<string, Buffer>();
  for (const source of sources) {
    const verified = verifySourceForPublication(source, root);
    if (verified === undefined) continue;
    if (!verified.ok)
      policyAuthority(
        "artifact-ref-invalid",
        `cannot reverify source ${source.ref}: ${verified.reason}`,
      );
    const copy_ref = sourceCopyRef(source);
    const copyPath = join(stage, copy_ref);
    ensurePrivateDirectory(stage, dirname(copyPath));
    if (
      !writeFileIfAbsent(copyPath, verified.bytes, { mode: 0o600 }) ||
      !verifyNamedBytes({
        root: stage,
        ref: copy_ref,
        sha256: source.sha256,
        maxBytes: MAX_POLICY_SOURCE_BYTES,
        privateMode: true,
      }).ok
    ) {
      policyAuthority("artifact-ref-invalid", `cannot publish source ${source.ref}`);
    }
    verifiedFiles.set(source.ref, verified.bytes);
    copiedSources.push({ ref: source.ref, sha256: source.sha256, material: "file", copy_ref });
  }
  for (const source of sources.filter((candidate) => candidate.material === "state-tree")) {
    const members = sources
      .filter(
        (candidate) => candidate.material === "file" && candidate.ref.startsWith(`${source.ref}/`),
      )
      .map((candidate) => ({ ref: candidate.ref, sha256: candidate.sha256 }));
    const entries = members.map((member) => {
      const bytes = verifiedFiles.get(member.ref);
      if (bytes === undefined)
        policyAuthority("artifact-ref-invalid", `state-tree member is absent: ${member.ref}`);
      return {
        path: member.ref.slice(source.ref.length + 1),
        size: bytes.length,
        sha256: member.sha256,
      };
    });
    if (members.length === 0 || policyStateTreeDigest(entries) !== source.sha256) {
      policyAuthority("artifact-ref-invalid", `state-tree closure is invalid: ${source.ref}`);
    }
    copiedSources.push({ ref: source.ref, sha256: source.sha256, material: "state-tree", members });
  }
  copiedSources.sort(
    (left, right) =>
      sources.findIndex((source) => source.ref === left.ref) -
      sources.findIndex((source) => source.ref === right.ref),
  );
  return copiedSources;
}

function policyAuthority(
  code: ConstructorParameters<typeof PolicyMeasurementAuthorityError>[0],
  message: string,
): never {
  throw new PolicyMeasurementAuthorityError(code, message);
}

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

type RegisteredOutputKey = Exclude<
  keyof PolicyMeasurementPreregistration["outputs"],
  "attempt_dir"
>;
type RegisteredOutputRefs = Record<RegisteredOutputKey, string>;

function registeredOutputRefs(
  preregistration: PolicyMeasurementPreregistration,
  repoRoot: string,
  output: string,
): RegisteredOutputRefs {
  const refs = {} as RegisteredOutputRefs;
  const seen = new Set<string>();
  for (const key of [
    "bench_bundle",
    "rig_bundle",
    "dogfood_snapshot",
    "result_json",
    "report_md",
  ] as const) {
    const path = resolve(repoRoot, preregistration.outputs[key]);
    const ref = relative(output, path).split("\\").join("/");
    if (!contained(output, path) || ref.length === 0 || seen.has(ref)) {
      policyAuthority("preregistration-mismatch", "registered policy output paths are unsafe");
    }
    seen.add(ref);
    refs[key] = ref;
  }
  return refs;
}

function ensurePrivateDirectory(root: string, target: string): OwnedDirectory[] {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  if (!contained(resolvedRoot, resolvedTarget)) {
    policyAuthority("artifact-ref-invalid", "policy output escapes the repository root");
  }
  const created: OwnedDirectory[] = [];
  let cursor = resolvedRoot;
  try {
    const rootStat = lstatSync(cursor);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("unsafe root");
    const suffix = relative(resolvedRoot, resolvedTarget).split(sep).filter(Boolean);
    for (const component of suffix) {
      cursor = join(cursor, component);
      const missing = !existsSync(cursor);
      if (missing) mkdirSync(cursor, { mode: 0o700 });
      const stat = lstatSync(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe directory");
      if (missing) created.push({ path: cursor, dev: stat.dev, ino: stat.ino });
    }
  } catch {
    policyAuthority("artifact-ref-invalid", "policy output directory is unsafe");
  }
  return created;
}

function safeRemoveStage(
  stage: string,
  parent: string,
  prefix: string,
  identity: ReservedOutput,
): void {
  const resolvedParent = resolve(parent);
  const resolvedStage = resolve(stage);
  if (
    !contained(resolvedParent, resolvedStage) ||
    dirname(resolvedStage) !== resolvedParent ||
    !basename(resolvedStage).startsWith(prefix)
  ) {
    return;
  }
  try {
    const stat = lstatSync(resolvedStage);
    if (
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      stat.dev === identity.dev &&
      stat.ino === identity.ino
    )
      rmSync(resolvedStage, { recursive: true, force: true });
  } catch {
    // A failed cleanup must never broaden its target beyond the validated stage.
  }
}

interface ReservedOutput {
  dev: number;
  ino: number;
}

interface OwnedFile extends ReservedOutput {
  path: string;
}

interface OwnedDirectory extends ReservedOutput {
  path: string;
}

function sameDirectoryIdentity(path: string, identity: ReservedOutput): boolean {
  try {
    const stat = lstatSync(path);
    return (
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      stat.dev === identity.dev &&
      stat.ino === identity.ino
    );
  } catch {
    return false;
  }
}

function removeOwnedFile(file: OwnedFile): void {
  try {
    const stat = lstatSync(file.path);
    if (stat.isFile() && !stat.isSymbolicLink() && stat.dev === file.dev && stat.ino === file.ino) {
      rmSync(file.path, { force: true });
    }
  } catch {
    // Never remove a replacement created by another actor.
  }
}

function removeOwnedDirectory(directory: OwnedDirectory): void {
  try {
    const stat = lstatSync(directory.path);
    if (
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      stat.dev === directory.dev &&
      stat.ino === directory.ino &&
      readdirSync(directory.path).length === 0
    ) {
      rmSync(directory.path, { recursive: true, force: true });
    }
  } catch {
    // Never remove a replacement or a directory containing another actor's data.
  }
}

function reserveOutput(output: string, parent: string): ReservedOutput | undefined {
  try {
    mkdirSync(output, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw error;
  }
  const stat = lstatSync(output);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o7777) !== 0o700 ||
    dirname(resolve(output)) !== resolve(parent) ||
    !contained(resolve(parent), resolve(output))
  ) {
    policyAuthority("artifact-ref-invalid", "policy output reservation is unsafe");
  }
  return { dev: stat.dev, ino: stat.ino };
}

function safeRemoveReservedOutput(
  output: string,
  parent: string,
  reservation: ReservedOutput,
): void {
  try {
    const resolvedParent = resolve(parent);
    const resolvedOutput = resolve(output);
    const stat = lstatSync(resolvedOutput);
    if (
      dirname(resolvedOutput) === resolvedParent &&
      contained(resolvedParent, resolvedOutput) &&
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      stat.dev === reservation.dev &&
      stat.ino === reservation.ino
    ) {
      rmSync(resolvedOutput, { recursive: true, force: true });
    }
  } catch {
    // Never widen cleanup beyond the exact output directory this process reserved.
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function benchErrorIdentities(row: CaseResult): Set<string> | undefined {
  if (row.policy_truth === undefined) return undefined;
  return new Set([
    ...row.policy_truth.findings.flatMap((finding) =>
      finding.outcome === "FP" && finding.severity !== "INFO"
        ? [`blocking-fp:${finding.signature}`]
        : [],
    ),
    ...row.policy_truth.fn_label_indexes.map((index) => `blocking-fn:label-${index}`),
  ]);
}

/**
 * Recompute persisted identity events from already byte-verified publication inputs. This is
 * intentionally outside the result schema: a self-consistent event list is not source authority.
 */
function verifyPublishedIdentityEventClosure(input: {
  root: string;
  attemptDir: string;
  rigBinding: { ref: string; sha256: string };
  result: PolicyMeasurement;
  benchBundle: unknown;
  rig: z.infer<typeof PolicyRigEvidenceSchema>;
  sources: ReadonlyArray<z.infer<typeof PolicyMeasurementCompleteSchema>["sources"][number]>;
}): boolean {
  const bundle = PolicyBenchBundleSchema.safeParse(input.benchBundle);
  const sourceByRef = new Map(input.sources.map((source) => [source.ref, source]));
  const rigSource = sourceByRef.get(input.rigBinding.ref);
  if (
    input.rig.scenario_manifest.ref !== input.rigBinding.ref ||
    input.rig.scenario_manifest.sha256 !== input.rigBinding.sha256 ||
    rigSource?.material !== "file" ||
    rigSource.sha256 !== input.rigBinding.sha256 ||
    rigSource.copy_ref === undefined
  ) {
    return false;
  }
  const normalizeBenchBinding = (binding: { ref: string; sha256: string }):
    | { ref: string; sha256: string }
    | undefined => {
    const parts = binding.ref.split("/");
    if (
      binding.ref.length === 0 ||
      isAbsolute(binding.ref) ||
      parts.some((part) => part.length === 0 || part === "." || part === "..")
    ) {
      return undefined;
    }
    return binding.ref.startsWith(`${input.attemptDir}/`)
      ? binding
      : { ...binding, ref: `${input.attemptDir}/${binding.ref}` };
  };
  const hasCopiedSource = (binding: { ref: string; sha256: string }): boolean => {
    const normalized = normalizeBenchBinding(binding);
    const source = normalized === undefined ? undefined : sourceByRef.get(normalized.ref);
    return (
      source !== undefined &&
      source.material === "file" &&
      source.sha256 === normalized?.sha256 &&
      source.copy_ref !== undefined
    );
  };
  const readRepeat = (binding: { ref: string; sha256: string }):
    | BenchPolicyRepeatResult
    | undefined => {
    const normalized = normalizeBenchBinding(binding);
    const source = normalized === undefined ? undefined : sourceByRef.get(normalized.ref);
    if (
      normalized === undefined ||
      source === undefined ||
      source.material !== "file" ||
      source.sha256 !== normalized.sha256 ||
      source.copy_ref === undefined
    ) {
      return undefined;
    }
    const parsed = verifyNamedCanonicalJsonBytes({
      root: input.root,
      ref: source.copy_ref,
      sha256: normalized.sha256,
      schema: BenchPolicyRepeatResultSchema,
      maxBytes: MAX_POLICY_SOURCE_BYTES,
      privateMode: true,
    });
    return parsed.ok ? parsed.value : undefined;
  };
  const profileById = bundle.success
    ? new Map(bundle.data.profiles.map((profile) => [profile.id, profile]))
    : undefined;
  const baselineProfile = profileById?.get("baseline");

  const sameSingletonEvents = (
    left: readonly PolicySingletonIdentityEvent[],
    right: readonly PolicySingletonIdentityEvent[],
  ): boolean =>
    canonicalJson(sortSingletonIdentityEvents(left).map(singletonIdentityEventKey)) ===
    canonicalJson(sortSingletonIdentityEvents(right).map(singletonIdentityEventKey));
  const sameProtectionEvents = (
    left: readonly PolicyBaselineProtectionEvent[],
    right: readonly PolicyBaselineProtectionEvent[],
  ): boolean =>
    canonicalJson(sortBaselineProtectionEvents(left).map(baselineProtectionEventKey)) ===
    canonicalJson(sortBaselineProtectionEvents(right).map(baselineProtectionEventKey));
  const appendSingletonEvents = (input: {
    into: PolicySingletonIdentityEvent[];
    lane: "stateless-bench" | "stateful-rig";
    unit: string;
    identityPrefix: string;
    baseline: ReadonlySet<string>;
    ablated: ReadonlySet<string>;
    passId: PolicyPassId;
    source: { ref: string; sha256: string };
  }): void => {
    for (const identity of input.ablated) {
      if (input.baseline.has(identity)) continue;
      input.into.push({
        lane: input.lane,
        unit: input.unit,
        identity: `${input.identityPrefix}:${identity}`,
        direction: "worsened",
        count: 1,
        pass_id: input.passId,
        source: input.source,
      });
    }
    for (const identity of input.baseline) {
      if (input.ablated.has(identity)) continue;
      input.into.push({
        lane: input.lane,
        unit: input.unit,
        identity: `${input.identityPrefix}:${identity}`,
        direction: "improved",
        count: 1,
        pass_id: input.passId,
        source: input.source,
      });
    }
  };
  const verifyBenchRepeatSources = (input: {
    repeat: {
      response_manifest: { ref: string; sha256: string };
      result: { ref: string; sha256: string };
      policy_trace_set: { ref: string; sha256: string };
    };
    result: BenchPolicyRepeatResult;
  }): boolean =>
    hasCopiedSource(input.repeat.response_manifest) &&
    hasCopiedSource(input.repeat.result) &&
    hasCopiedSource(input.repeat.policy_trace_set) &&
    hasCopiedSource(input.result.source_result) &&
    input.result.cases.every(
      (row) =>
        row.policy_trace?.trace_ref !== undefined &&
        row.policy_trace.trace_sha256 !== undefined &&
        hasCopiedSource({
          ref: row.policy_trace.trace_ref,
          sha256: row.policy_trace.trace_sha256,
        }),
    );

  const expectedBenchSingleton = new Map<
    PolicyPassId,
    { events: PolicySingletonIdentityEvent[]; protectionEvents: PolicyBaselineProtectionEvent[] }
  >();
  if (bundle.success && baselineProfile !== undefined) {
    for (const passId of POLICY_PASS_IDS) {
      const profile = profileById?.get(`single:${passId}`);
      const normalizedProfile =
        profile === undefined ? undefined : normalizeBenchBinding(profile.artifact);
      if (
        profile === undefined ||
        normalizedProfile === undefined ||
        !hasCopiedSource(profile.artifact)
      )
        return false;
      const events: PolicySingletonIdentityEvent[] = [];
      const protectionEvents: PolicyBaselineProtectionEvent[] = [];
      for (const repeat of profile.data.repeats) {
        const baselineRepeat = baselineProfile.data.repeats.find(
          (candidate) => candidate.repeat === repeat.repeat,
        );
        if (baselineRepeat === undefined) return false;
        const baseline = readRepeat(baselineRepeat.result);
        const ablated = readRepeat(repeat.result);
        if (
          baseline === undefined ||
          ablated === undefined ||
          baseline.repeat !== ablated.repeat ||
          !verifyBenchRepeatSources({ repeat, result: ablated }) ||
          !verifyBenchRepeatSources({ repeat: baselineRepeat, result: baseline })
        ) {
          return false;
        }
        const baselineByCase = new Map(baseline.cases.map((row) => [row.id, row]));
        const catalog = POLICY_PASSES.find((candidate) => candidate.id === passId);
        if (catalog === undefined) return false;
        for (const row of ablated.cases) {
          const base = baselineByCase.get(row.id);
          const trace = base?.policy_trace?.trace;
          if (base === undefined || trace === undefined) return false;
          const carriers = trace.evaluations.filter(
            (evaluation) => evaluation.pass_id === passId && evaluation.result !== "no-opportunity",
          );
          if (carriers.length === 0) continue;
          const baselineErrors = benchErrorIdentities(base);
          const ablatedErrors = benchErrorIdentities(row);
          if (baselineErrors === undefined || ablatedErrors === undefined) return false;
          const unit = `bench:${row.id}:repeat-${repeat.repeat}`;
          appendSingletonEvents({
            into: events,
            lane: "stateless-bench",
            unit,
            identityPrefix: `bench:${row.id}`,
            baseline: baselineErrors,
            ablated: ablatedErrors,
            passId,
            source: normalizedProfile,
          });
          for (const errorIdentity of ablatedErrors) {
            if (!errorIdentity.startsWith("blocking-fp:")) continue;
            const signature = errorIdentity.slice("blocking-fp:".length);
            const protectedEvaluation = trace.evaluations.find(
              (evaluation) =>
                evaluation.pass_id === passId &&
                evaluation.result === "protected" &&
                evaluation.protected_by !== undefined &&
                evaluation.source_signatures.includes(signature) &&
                catalog.protection_rules.some(
                  (rule) =>
                    rule.reason_code === evaluation.reason_code &&
                    rule.protected_by === evaluation.protected_by &&
                    rule.before === evaluation.before,
                ),
            );
            if (protectedEvaluation?.protected_by === undefined) continue;
            const normalizedBaseline = normalizeBenchBinding(baselineProfile.artifact);
            if (normalizedBaseline === undefined) return false;
            protectionEvents.push({
              lane: "stateless-bench",
              unit,
              identity: `bench:${row.id}:${errorIdentity}`,
              pass_id: passId,
              result: "protected",
              source: normalizedBaseline,
              reason_code: protectedEvaluation.reason_code,
              protected_by: protectedEvaluation.protected_by,
              before: protectedEvaluation.before,
            });
          }
        }
      }
      expectedBenchSingleton.set(passId, { events, protectionEvents });
    }
  }

  const expectedRigSingleton = new Map<PolicyPassId, PolicySingletonIdentityEvent[]>();
  for (const sequence of input.rig.sequences) {
    const sequenceIdentity = sequence.scenario_id.startsWith(`${sequence.pass_id}-`)
      ? sequence.scenario_id.slice(sequence.pass_id.length + 1)
      : sequence.scenario_id;
    const events = expectedRigSingleton.get(sequence.pass_id) ?? [];
    expectedRigSingleton.set(sequence.pass_id, events);
    for (const turn of sequence.turns) {
      appendSingletonEvents({
        into: events,
        lane: "stateful-rig",
        unit: `rig:${sequenceIdentity}:turn-${turn.turn_index}`,
        identityPrefix: `rig:${sequenceIdentity}:turn-${turn.turn_index}`,
        baseline: new Set(turn.baseline.errors.map((row) => `${row.kind}:${row.identity}`)),
        ablated: new Set(turn.counterfactual.errors.map((row) => `${row.kind}:${row.identity}`)),
        passId: sequence.pass_id,
        source: input.rigBinding,
      });
    }
  }
  for (const facts of input.result.identity_evidence) {
    const lane = POLICY_MEASUREMENT_LANES[facts.pass_id];
    if (lane === "stateless-bench") {
      const expected = expectedBenchSingleton.get(facts.pass_id);
      if (
        expected === undefined
          ? facts.singleton_inventory.events.length > 0 ||
            facts.singleton_inventory.protection_events.length > 0
          : !sameSingletonEvents(facts.singleton_inventory.events, expected.events) ||
            !sameProtectionEvents(
              facts.singleton_inventory.protection_events,
              expected.protectionEvents,
            )
      ) {
        return false;
      }
    } else if (
      !sameSingletonEvents(
        facts.singleton_inventory.events,
        expectedRigSingleton.get(facts.pass_id) ?? [],
      ) ||
      facts.singleton_inventory.protection_events.length > 0
    ) {
      return false;
    }
  }

  for (const [index, interaction] of input.result.interactions.entries()) {
    const expected: PolicyIdentityEvent[] = [];
    if (interaction.primary_lane === "stateless-bench") {
      // A historical unparseable Bench source has no source authority for this lane, so it may
      // only omit a zero-event Bench claim. Rig remains independently authoritative below.
      if (!bundle.success) {
        if (interaction.identity_inventory.events.length > 0) return false;
        continue;
      }
      if (profileById === undefined || baselineProfile === undefined) return false;
      const profile = profileById.get(`interaction:${index + 1}`);
      const normalizedProfile =
        profile === undefined ? undefined : normalizeBenchBinding(profile.artifact);
      if (
        profile === undefined ||
        normalizedProfile === undefined ||
        normalizedProfile.ref !== interaction.artifact.ref ||
        normalizedProfile.sha256 !== interaction.artifact.sha256 ||
        !hasCopiedSource(profile.artifact)
      ) {
        return false;
      }
      for (const repeat of profile.data.repeats) {
        const baselineRepeat = baselineProfile.data.repeats.find(
          (candidate) => candidate.repeat === repeat.repeat,
        );
        if (baselineRepeat === undefined) return false;
        const baseline = readRepeat(baselineRepeat.result);
        const ablated = readRepeat(repeat.result);
        if (baseline === undefined || ablated === undefined || baseline.repeat !== ablated.repeat)
          return false;
        if (
          !hasCopiedSource(repeat.response_manifest) ||
          !hasCopiedSource(repeat.result) ||
          !hasCopiedSource(repeat.policy_trace_set) ||
          !hasCopiedSource(baselineRepeat.response_manifest) ||
          !hasCopiedSource(baselineRepeat.result) ||
          !hasCopiedSource(baselineRepeat.policy_trace_set) ||
          !hasCopiedSource(ablated.source_result) ||
          !hasCopiedSource(baseline.source_result) ||
          ablated.cases.some(
            (row) =>
              row.policy_trace?.trace_ref === undefined ||
              row.policy_trace.trace_sha256 === undefined ||
              !hasCopiedSource({
                ref: row.policy_trace.trace_ref,
                sha256: row.policy_trace.trace_sha256,
              }),
          ) ||
          baseline.cases.some(
            (row) =>
              row.policy_trace?.trace_ref === undefined ||
              row.policy_trace.trace_sha256 === undefined ||
              !hasCopiedSource({
                ref: row.policy_trace.trace_ref,
                sha256: row.policy_trace.trace_sha256,
              }),
          )
        ) {
          return false;
        }
        const baselineByCase = new Map(baseline.cases.map((row) => [row.id, row]));
        for (const row of ablated.cases) {
          const base = baselineByCase.get(row.id);
          const trace = base?.policy_trace?.trace;
          if (base === undefined || trace === undefined) return false;
          const carriers = trace.evaluations.filter(
            (evaluation) =>
              interaction.pass_ids.includes(evaluation.pass_id) &&
              evaluation.result !== "no-opportunity",
          );
          if (carriers.length === 0) continue;
          const baselineErrors = benchErrorIdentities(base);
          const ablatedErrors = benchErrorIdentities(row);
          if (baselineErrors === undefined || ablatedErrors === undefined) return false;
          for (const identity of ablatedErrors) {
            if (baselineErrors.has(identity)) continue;
            expected.push({
              lane: "stateless-bench",
              unit: `bench:${row.id}:repeat-${repeat.repeat}`,
              identity: `bench:${row.id}:${identity}`,
              direction: "worsened",
              count: 1,
              source: normalizedProfile,
            });
          }
          for (const identity of baselineErrors) {
            if (ablatedErrors.has(identity)) continue;
            expected.push({
              lane: "stateless-bench",
              unit: `bench:${row.id}:repeat-${repeat.repeat}`,
              identity: `bench:${row.id}:${identity}`,
              direction: "improved",
              count: 1,
              source: normalizedProfile,
            });
          }
        }
      }
    } else {
      if (
        interaction.artifact.ref !== input.rigBinding.ref ||
        interaction.artifact.sha256 !== input.rigBinding.sha256
      ) {
        return false;
      }
      for (const sequence of input.rig.sequences) {
        const group = sequence.history_interaction;
        if (group === null) continue;
        const sequenceIdentity = sequence.scenario_id.startsWith(`${sequence.pass_id}-`)
          ? sequence.scenario_id.slice(sequence.pass_id.length + 1)
          : sequence.scenario_id;
        for (const turn of group.turns) {
          const baseline = new Set(
            turn.baseline.errors.map((row) => `${row.kind}:${row.identity}`),
          );
          const ablated = new Set(
            turn.counterfactual.errors.map((row) => `${row.kind}:${row.identity}`),
          );
          for (const identity of ablated) {
            if (baseline.has(identity)) continue;
            expected.push({
              lane: "stateful-rig",
              unit: `rig:${sequenceIdentity}:turn-${turn.turn_index}`,
              identity: `rig:${sequenceIdentity}:turn-${turn.turn_index}:${identity}`,
              direction: "worsened",
              count: 1,
              source: input.rigBinding,
              member_pass_id: sequence.pass_id,
            });
          }
          for (const identity of baseline) {
            if (ablated.has(identity)) continue;
            expected.push({
              lane: "stateful-rig",
              unit: `rig:${sequenceIdentity}:turn-${turn.turn_index}`,
              identity: `rig:${sequenceIdentity}:turn-${turn.turn_index}:${identity}`,
              direction: "improved",
              count: 1,
              source: input.rigBinding,
              member_pass_id: sequence.pass_id,
            });
          }
        }
      }
    }
    const persisted = sortIdentityEvents(interaction.identity_inventory.events);
    if (
      canonicalJson(sortIdentityEvents(expected).map(identityEventKey)) !==
      canonicalJson(persisted.map(identityEventKey))
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Recompute the C5 Bench case-effect projection from the copied, byte-verified source records.
 * This remains outside the persisted schema: matching raw/mean/median fields alone is not source
 * authority, and the final verifier must reject a marker-rebound self-consistent substitution.
 */
function samePublishedC5Statistics(
  persisted: PolicyMeasurement["passes"][number]["evidence"]["statistics"],
  expected: PolicyMeasurement["passes"][number]["evidence"]["statistics"],
): boolean {
  return canonicalJson(persisted) === canonicalJson(expected);
}

function expectedC5AdjustedPValues(result: PolicyMeasurement): {
  singleton: readonly number[];
  interaction: readonly number[];
} {
  return holmAdjustPolicyFamilies({
    singleton: result.passes.map((pass) => pass.evidence.statistics.p_value),
    interaction: result.interactions.map((interaction) => interaction.evidence.statistics.p_value),
  });
}

function verifyPublishedBenchC5StatisticsClosure(input: {
  root: string;
  attemptDir: string;
  preregistration: PolicyMeasurementPreregistration;
  result: PolicyMeasurement;
  benchBundle: unknown;
  sources: readonly PublishedPolicySource[];
}): boolean {
  const bundle = PolicyBenchBundleSchema.safeParse(input.benchBundle);
  const sourceByRef = new Map(input.sources.map((source) => [source.ref, source]));
  const normalizeBenchBinding = (binding: { ref: string; sha256: string }):
    | { ref: string; sha256: string }
    | undefined => {
    const parts = binding.ref.split("/");
    if (
      binding.ref.length === 0 ||
      isAbsolute(binding.ref) ||
      parts.some((part) => part.length === 0 || part === "." || part === "..")
    ) {
      return undefined;
    }
    return binding.ref.startsWith(`${input.attemptDir}/`)
      ? binding
      : { ...binding, ref: `${input.attemptDir}/${binding.ref}` };
  };
  const copiedBinding = (binding: { ref: string; sha256: string }):
    | { ref: string; sha256: string }
    | undefined => {
    const normalized = normalizeBenchBinding(binding);
    const source = normalized === undefined ? undefined : sourceByRef.get(normalized.ref);
    return source?.material === "file" &&
      source.sha256 === normalized?.sha256 &&
      source.copy_ref !== undefined
      ? normalized
      : undefined;
  };
  const readRepeat = (binding: { ref: string; sha256: string }):
    | BenchPolicyRepeatResult
    | undefined => {
    const normalized = copiedBinding(binding);
    const source = normalized === undefined ? undefined : sourceByRef.get(normalized.ref);
    if (normalized === undefined || source?.material !== "file" || source.copy_ref === undefined) {
      return undefined;
    }
    const parsed = verifyNamedCanonicalJsonBytes({
      root: input.root,
      ref: source.copy_ref,
      sha256: normalized.sha256,
      schema: BenchPolicyRepeatResultSchema,
      maxBytes: MAX_POLICY_SOURCE_BYTES,
      privateMode: true,
    });
    return parsed.ok ? parsed.value : undefined;
  };
  const dossier = (row: CaseResult): { ref: string; sha256: string } | undefined => {
    const trace = row.policy_trace;
    if (trace?.trace_ref === undefined || trace.trace_sha256 === undefined) return undefined;
    return copiedBinding({ ref: trace.trace_ref, sha256: trace.trace_sha256 });
  };
  const empty = (seed: number) => policyBenchStatistics([], seed).statistics;
  if (!bundle.success) {
    return [
      ...input.result.passes.map((pass, index) => ({
        persisted: pass.evidence.lane_summaries.find(
          (summary) => summary.lane === "stateless-bench",
        )?.statistics,
        expected: empty(input.preregistration.analysis.seed + index),
      })),
      ...input.result.interactions.map((interaction, index) => ({
        persisted: interaction.lane_summaries.find((summary) => summary.lane === "stateless-bench")
          ?.statistics,
        expected: empty(input.preregistration.analysis.seed + index),
      })),
    ].every(
      (row) =>
        row.persisted !== undefined && samePublishedC5Statistics(row.persisted, row.expected),
    );
  }
  const profileById = new Map(bundle.data.profiles.map((profile) => [profile.id, profile]));
  const baselineProfile = profileById.get("baseline");
  if (baselineProfile === undefined || copiedBinding(baselineProfile.artifact) === undefined)
    return false;
  const derive = (inputProfileId: string, passIds: readonly PolicyPassId[], seed: number) => {
    const profile = profileById.get(inputProfileId);
    if (profile === undefined || copiedBinding(profile.artifact) === undefined) return undefined;
    const effects: PolicyBenchCaseEffect[] = [];
    for (const repeat of profile.data.repeats) {
      const baselineRepeat = baselineProfile.data.repeats.find(
        (candidate) => candidate.repeat === repeat.repeat,
      );
      if (baselineRepeat === undefined) return undefined;
      const baseline = readRepeat(baselineRepeat.result);
      const ablated = readRepeat(repeat.result);
      if (baseline === undefined || ablated === undefined || baseline.repeat !== ablated.repeat) {
        return undefined;
      }
      const baselineByCase = new Map(baseline.cases.map((row) => [row.id, row]));
      for (const row of ablated.cases) {
        const base = baselineByCase.get(row.id);
        const baselineTrace = base?.policy_trace?.trace;
        if (base === undefined || baselineTrace === undefined) return undefined;
        const carriers = baselineTrace.evaluations.filter(
          (evaluation) =>
            passIds.includes(evaluation.pass_id) && evaluation.result !== "no-opportunity",
        );
        if (carriers.length === 0) continue;
        const baselineDossier = dossier(base);
        const ablatedDossier = dossier(row);
        if (baselineDossier === undefined || ablatedDossier === undefined) return undefined;
        const baselineTruth = base.policy_truth;
        const ablatedTruth = row.policy_truth;
        if (baselineTruth === undefined || ablatedTruth === undefined) return undefined;
        const baselineError =
          baselineTruth.findings.filter(
            (finding) => finding.outcome === "FP" && finding.severity !== "INFO",
          ).length + baselineTruth.fn_label_indexes.length;
        const ablatedError =
          ablatedTruth.findings.filter(
            (finding) => finding.outcome === "FP" && finding.severity !== "INFO",
          ).length + ablatedTruth.fn_label_indexes.length;
        effects.push({
          caseId: row.id,
          repeat: repeat.repeat,
          errorReduction: ablatedError - baselineError,
          baseline: base,
          ablated: row,
          baselineDossier,
          ablatedDossier,
        });
      }
    }
    try {
      return policyBenchStatistics(effects, seed).statistics;
    } catch {
      return undefined;
    }
  };
  for (const [index, pass] of input.result.passes.entries()) {
    const persisted = pass.evidence.lane_summaries.find(
      (summary) => summary.lane === "stateless-bench",
    )?.statistics;
    const expected = derive(
      `single:${pass.pass_id}`,
      [pass.pass_id],
      input.preregistration.analysis.seed + index,
    );
    if (expected !== undefined && pass.evidence.lane === "stateless-bench") {
      expected.adjusted_p_value = expectedC5AdjustedPValues(input.result).singleton[index] ?? 1;
    }
    if (
      persisted === undefined ||
      expected === undefined ||
      !samePublishedC5Statistics(persisted, expected)
    ) {
      return false;
    }
  }
  for (const [index, interaction] of input.result.interactions.entries()) {
    const persisted = interaction.lane_summaries.find(
      (summary) => summary.lane === "stateless-bench",
    )?.statistics;
    const expected = derive(
      `interaction:${index + 1}`,
      interaction.pass_ids,
      input.preregistration.analysis.seed + index,
    );
    if (expected !== undefined && interaction.primary_lane === "stateless-bench") {
      expected.adjusted_p_value = expectedC5AdjustedPValues(input.result).interaction[index] ?? 1;
    }
    if (
      persisted === undefined ||
      expected === undefined ||
      !samePublishedC5Statistics(persisted, expected)
    ) {
      return false;
    }
  }
  return true;
}

/** Recompute every stateful Rig C5 lane from the already verified Rig evidence. */
function verifyPublishedRigC5StatisticsClosure(input: {
  preregistration: PolicyMeasurementPreregistration;
  result: PolicyMeasurement;
  rig: z.infer<typeof PolicyRigEvidenceSchema>;
}): boolean {
  const addTruth = (
    total: { blocking_fp: number; blocking_fn: number; blocking_tp: number },
    next: { blocking_fp: number; blocking_fn: number; blocking_tp: number },
  ) => ({
    blocking_fp: total.blocking_fp + next.blocking_fp,
    blocking_fn: total.blocking_fn + next.blocking_fn,
    blocking_tp: total.blocking_tp + next.blocking_tp,
  });
  const derive = (
    values: readonly number[],
    rows: readonly {
      truth_effects: {
        baseline: { blocking_fp: number; blocking_fn: number; blocking_tp: number };
        ablated: { blocking_fp: number; blocking_fn: number; blocking_tp: number };
      };
    }[],
    seed: number,
  ) => {
    const truth = rows.reduce(
      (total, row) => ({
        baseline: addTruth(total.baseline, row.truth_effects.baseline),
        ablated: addTruth(total.ablated, row.truth_effects.ablated),
      }),
      {
        baseline: { blocking_fp: 0, blocking_fn: 0, blocking_tp: 0 },
        ablated: { blocking_fp: 0, blocking_fn: 0, blocking_tp: 0 },
      },
    );
    return policyIndependentSequenceStatistics(values, seed, truth);
  };
  for (const [index, pass] of input.result.passes.entries()) {
    if (POLICY_MEASUREMENT_LANES[pass.pass_id] !== "stateful-rig") continue;
    const sequences = input.rig.sequences.filter((sequence) => sequence.pass_id === pass.pass_id);
    const persisted = pass.evidence.lane_summaries.find(
      (summary) => summary.lane === "stateful-rig",
    )?.statistics;
    const expected = derive(
      sequences.map((sequence) => sequence.truth_effects.error_reduction),
      sequences,
      input.preregistration.analysis.seed + index,
    );
    if (pass.evidence.lane === "stateful-rig") {
      expected.adjusted_p_value = expectedC5AdjustedPValues(input.result).singleton[index] ?? 1;
    }
    if (
      sequences.length !== 3 ||
      persisted === undefined ||
      !samePublishedC5Statistics(persisted, expected)
    ) {
      return false;
    }
  }
  for (const [index, interaction] of input.result.interactions.entries()) {
    if (interaction.primary_lane !== "stateful-rig") continue;
    const groups = input.rig.sequences.flatMap((sequence) =>
      sequence.history_interaction === null ? [] : [sequence.history_interaction],
    );
    const persisted = interaction.lane_summaries.find(
      (summary) => summary.lane === "stateful-rig",
    )?.statistics;
    const expected = derive(
      groups.map((group) => group.truth_effects.error_reduction),
      groups,
      input.preregistration.analysis.seed + index,
    );
    expected.adjusted_p_value = expectedC5AdjustedPValues(input.result).interaction[index] ?? 1;
    if (
      groups.length !== 12 ||
      persisted === undefined ||
      !samePublishedC5Statistics(persisted, expected)
    ) {
      return false;
    }
  }
  return true;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function publishedDogfoodExclusions(input: z.infer<typeof PolicyDogfoodSnapshotSchema>) {
  const rows: Array<{ lane: "dogfood"; code: string; count: number }> = [];
  const add = (code: string, count: number): void => {
    if (count > 0) rows.push({ lane: "dogfood", code, count });
  };
  add("missing-decision", input.exclusions["missing-decision"] ?? 0);
  add("incomplete-trace", input.exclusions["incomplete-trace"] ?? 0);
  add("ambiguous-run-iter", input.exclusions["ambiguous-run-iter"] ?? 0);
  add("signature-absent-lineage", input.exclusions["signature-absent-lineage"] ?? 0);
  add("declined", input.declined);
  add("post-registered-at", input.exclusions["post-registered-at"] ?? 0);
  add(
    "historical-unsigned-decision",
    (input.exclusions["agent-only-decision"] ?? 0) + (input.exclusions["missing-attestation"] ?? 0),
  );
  return rows;
}

/**
 * Reconstruct the complete descriptive Dogfood lane from the already reverified snapshot. This
 * deliberately consumes values, not paths: the snapshot harvest above is the only copied-source
 * read boundary in final publication verification.
 */
function publishedDogfoodLaneProjection(input: {
  snapshot: z.infer<typeof PolicyDogfoodSnapshotSchema>;
  manifest: z.infer<typeof PolicyDogfoodInputManifestSchema>;
  passId: PolicyPassId;
  seed: number;
}) {
  const labels = input.snapshot.labels.filter((label) => label.pass_id === input.passId);
  const grouped = new Map<string, typeof labels>();
  const signatures = new Set<string>();
  const rawEvidenceRefs = new Set<string>([
    input.snapshot.input_manifest.ref,
    input.snapshot.attestation.ref,
  ]);
  const traceTotals = { applied: 0, would_apply: 0, protected: 0, no_opportunity: 0 };
  for (const label of labels) {
    const key = `${label.run_id}\u0000${label.iter}\u0000${label.finding_signature}`;
    const rows = grouped.get(key) ?? [];
    rows.push(label);
    grouped.set(key, rows);
    for (const signature of label.source_signatures) signatures.add(signature);
    if (label.evaluation_result === "applied") traceTotals.applied += 1;
    else if (label.evaluation_result === "would-apply") traceTotals.would_apply += 1;
    else if (label.evaluation_result === "protected") traceTotals.protected += 1;
    else traceTotals.no_opportunity += 1;
    for (const entry of input.manifest.entries) {
      const ownsRun =
        entry.kind === "audit"
          ? entry.runs.some((run) => run.run_id === label.run_id && run.iter === label.iter)
          : entry.run_id === label.run_id && entry.iter === label.iter;
      if (ownsRun) rawEvidenceRefs.add(entry.ref);
    }
  }
  const groupedRows = [...grouped.entries()].sort(([left], [right]) =>
    compareCodeUnits(left, right),
  );
  const effects = groupedRows.map(([, rows]) =>
    rows.some((row) => row.effect === "suppressed")
      ? -1
      : rows.some((row) => row.effect === "preserved")
        ? 1
        : 0,
  );
  const runs = new Set(
    groupedRows.map(([, rows]) => {
      const label = rows[0];
      return label === undefined ? "" : `${label.run_id}\u0000${label.iter}`;
    }),
  );
  const statistics = policyIndependentSequenceStatistics(effects, input.seed);
  const opportunities = {
    cases: groupedRows.length,
    signatures: signatures.size,
    turns: 0,
    runs: runs.size,
  };
  return {
    lane: "dogfood" as const,
    primary: false,
    descriptive: true,
    eligible: true,
    authoritative: true,
    opportunities,
    exclusions: publishedDogfoodExclusions(input.snapshot),
    truth_effects: {
      baseline: { blocking_fp: 0, blocking_fn: 0, blocking_tp: 0 },
      ablated: { blocking_fp: 0, blocking_fn: 0, blocking_tp: 0 },
      error_reduction: 0,
    },
    trace_totals: traceTotals,
    statistics,
    limitations: [
      "run-level-effects-are-descriptive",
      ...(statistics.precision_delta.baseline === null
        ? ["precision-denominator-unavailable"]
        : []),
      ...(statistics.recall_delta.baseline === null ? ["recall-denominator-unavailable"] : []),
      "secondary-lane-does-not-classify",
      ...(opportunities.cases === 0 && opportunities.turns === 0 && opportunities.runs === 0
        ? ["no-opportunities-observed"]
        : []),
    ].sort(compareCodeUnits),
    raw_evidence_refs: [...rawEvidenceRefs].sort(compareCodeUnits),
  };
}

/** Recompute the frozen Dogfood snapshot and each complete lane projection from copied source bytes. */
function verifyPublishedDogfoodC5Closure(input: {
  root: string;
  preregistration: PolicyMeasurementPreregistration;
  result: PolicyMeasurement;
  snapshot: z.infer<typeof PolicyDogfoodSnapshotSchema>;
  sources: readonly PublishedPolicySource[];
}): boolean {
  const sourceByRef = new Map(input.sources.map((source) => [source.ref, source]));
  const readCopiedBytes = (binding: { ref: string; sha256: string }): Buffer | undefined => {
    const source = sourceByRef.get(binding.ref);
    if (
      source?.material !== "file" ||
      source.sha256 !== binding.sha256 ||
      source.copy_ref === undefined
    ) {
      return undefined;
    }
    const verified = verifyNamedBytes({
      root: input.root,
      ref: source.copy_ref,
      sha256: source.sha256,
      maxBytes: MAX_POLICY_SOURCE_BYTES,
      privateMode: true,
    });
    return verified.ok ? verified.bytes : undefined;
  };
  const readCopiedCanonical = <T>(inputBinding: {
    ref: string;
    sha256: string;
    schema: z.ZodType<T>;
  }): T | undefined => {
    const source = sourceByRef.get(inputBinding.ref);
    if (
      source?.material !== "file" ||
      source.sha256 !== inputBinding.sha256 ||
      source.copy_ref === undefined
    ) {
      return undefined;
    }
    const parsed = verifyNamedCanonicalJsonBytes({
      root: input.root,
      ref: source.copy_ref,
      sha256: source.sha256,
      schema: inputBinding.schema,
      maxBytes: MAX_POLICY_SOURCE_BYTES,
      privateMode: true,
    });
    return parsed.ok ? parsed.value : undefined;
  };
  const manifest = readCopiedCanonical({
    ref: input.preregistration.dogfood.input_manifest_ref,
    sha256: input.preregistration.dogfood.input_manifest_sha256,
    schema: PolicyDogfoodInputManifestSchema,
  });
  const attestation = readCopiedCanonical({
    ref: input.preregistration.dogfood.attestation_ref,
    sha256: input.preregistration.dogfood.attestation_sha256,
    schema: PolicyDogfoodAttestationSchema,
  });
  if (manifest === undefined || attestation === undefined) {
    return false;
  }
  let expected: z.infer<typeof PolicyDogfoodSnapshotSchema>;
  try {
    expected = harvestPolicyDogfoodFromVerifiedSources({
      preregistration: input.preregistration,
      inputManifest: manifest,
      attestation,
      readFrozenSource: (entry) => readCopiedBytes(entry),
    });
  } catch {
    return false;
  }
  if (canonicalJson(input.snapshot) !== canonicalJson(expected)) {
    return false;
  }
  for (const [index, pass] of input.result.passes.entries()) {
    const summary = pass.evidence.lane_summaries.find((row) => row.lane === "dogfood");
    const projection = publishedDogfoodLaneProjection({
      snapshot: expected,
      manifest,
      passId: pass.pass_id,
      seed: input.preregistration.analysis.seed + index,
    });
    if (
      summary === undefined ||
      canonicalJson(pass.evidence.exclusions) !== canonicalJson(projection.exclusions) ||
      canonicalJson(summary) !== canonicalJson(projection)
    ) {
      return false;
    }
  }
  return true;
}

function verifyPublishedPolicyBundle(output: string): boolean {
  const marker = verifyUnboundNamedCanonicalJsonBytes({
    root: output,
    ref: "complete.json",
    schema: PolicyMeasurementCompleteSchema,
    maxBytes: MAX_POLICY_SOURCE_BYTES,
    privateMode: true,
  });
  if (!marker.ok) return false;
  const result = verifyNamedCanonicalJsonBytes({
    root: output,
    ref: marker.value.result.ref,
    sha256: marker.value.result.sha256,
    schema: PolicyMeasurementSchema,
    maxBytes: MAX_POLICY_SOURCE_BYTES,
    privateMode: true,
  });
  if (!result.ok) return false;
  const preregSource = marker.value.sources.find(
    (source) =>
      source.ref === result.value.preregistration.ref &&
      source.sha256 === result.value.preregistration.sha256,
  );
  if (
    preregSource === undefined ||
    preregSource.material !== "file" ||
    preregSource.copy_ref === undefined
  )
    return false;
  const preregistration = verifyNamedCanonicalJsonBytes({
    root: output,
    ref: preregSource.copy_ref,
    sha256: preregSource.sha256,
    schema: PolicyMeasurementPreregistrationSchema,
    maxBytes: MAX_POLICY_SOURCE_BYTES,
    privateMode: true,
  });
  if (!preregistration.ok) return false;
  const report = verifyNamedTextBytes({
    root: output,
    ref: marker.value.report.ref,
    sha256: marker.value.report.sha256,
    maxBytes: MAX_POLICY_SOURCE_BYTES,
    privateMode: true,
  });
  if (!report.ok || report.text !== renderPolicyMeasurement(result.value)) return false;
  const outputs = marker.value.outputs;
  const benchBundle = verifyNamedCanonicalJsonBytes({
    root: output,
    ref: outputs.bench_bundle.ref,
    sha256: outputs.bench_bundle.sha256,
    schema: z.unknown(),
    maxBytes: MAX_POLICY_SOURCE_BYTES,
    privateMode: true,
  });
  const rigBundle = verifyNamedCanonicalJsonBytes({
    root: output,
    ref: outputs.rig_bundle.ref,
    sha256: outputs.rig_bundle.sha256,
    schema: PolicyRigEvidenceSchema,
    maxBytes: MAX_POLICY_SOURCE_BYTES,
    privateMode: true,
  });
  const dogfoodSnapshot = verifyNamedCanonicalJsonBytes({
    root: output,
    ref: outputs.dogfood_snapshot.ref,
    sha256: outputs.dogfood_snapshot.sha256,
    schema: PolicyDogfoodSnapshotSchema,
    maxBytes: MAX_POLICY_SOURCE_BYTES,
    privateMode: true,
  });
  const registeredRef = (
    key: Exclude<keyof PolicyMeasurementPreregistration["outputs"], "attempt_dir">,
  ): string | undefined => {
    const attempt = preregistration.value.outputs.attempt_dir;
    const path = preregistration.value.outputs[key];
    return path.startsWith(`${attempt}/`) ? path.slice(attempt.length + 1) : undefined;
  };
  if (
    outputs.result_json.ref !== marker.value.result.ref ||
    outputs.result_json.sha256 !== marker.value.result.sha256 ||
    outputs.report_md.ref !== marker.value.report.ref ||
    outputs.report_md.sha256 !== marker.value.report.sha256 ||
    outputs.bench_bundle.ref !== registeredRef("bench_bundle") ||
    outputs.rig_bundle.ref !== registeredRef("rig_bundle") ||
    outputs.dogfood_snapshot.ref !== registeredRef("dogfood_snapshot") ||
    outputs.result_json.ref !== registeredRef("result_json") ||
    outputs.report_md.ref !== registeredRef("report_md") ||
    !benchBundle.ok ||
    !rigBundle.ok ||
    !dogfoodSnapshot.ok ||
    marker.value.sources.length !== result.value.artifacts.inventory.length
  )
    return false;
  const sourceByRef = new Map(marker.value.sources.map((source) => [source.ref, source]));
  const benchInventory = result.value.artifacts.inventory.find(
    (source) => source.ref === preregistration.value.outputs.bench_bundle,
  );
  if (benchInventory?.sha256 !== outputs.bench_bundle.sha256) return false;
  const sourcesValid = marker.value.sources.every((source, index) => {
    const inventory = result.value.artifacts.inventory[index];
    if (source.ref !== inventory?.ref || source.sha256 !== inventory.sha256) return false;
    if (source.material === "file") {
      const expectedCopy = sourceCopyRef({ ...source, kind: "bench", material: "file" });
      return (
        source.copy_ref === expectedCopy &&
        verifyNamedBytes({
          root: output,
          ref: source.copy_ref,
          sha256: source.sha256,
          maxBytes: MAX_POLICY_SOURCE_BYTES,
          privateMode: true,
        }).ok
      );
    }
    if (source.copy_ref !== undefined || source.members === undefined) return false;
    const entries = source.members.map((member) => {
      const child = sourceByRef.get(member.ref);
      if (
        child?.material !== "file" ||
        child.sha256 !== member.sha256 ||
        !member.ref.startsWith(`${source.ref}/`) ||
        child.copy_ref === undefined
      ) {
        return undefined;
      }
      const verified = verifyNamedBytes({
        root: output,
        ref: child.copy_ref,
        sha256: child.sha256,
        maxBytes: MAX_POLICY_SOURCE_BYTES,
        privateMode: true,
      });
      return verified.ok
        ? {
            path: member.ref.slice(source.ref.length + 1),
            size: verified.bytes.length,
            sha256: member.sha256,
          }
        : undefined;
    });
    return (
      entries.every((entry) => entry !== undefined) &&
      policyStateTreeDigest(entries as never) === source.sha256
    );
  });
  return (
    sourcesValid &&
    verifyPublishedIdentityEventClosure({
      root: output,
      attemptDir: preregistration.value.outputs.attempt_dir,
      rigBinding: {
        ref: preregistration.value.stateful.manifest_ref,
        sha256: preregistration.value.stateful.manifest_sha256,
      },
      result: result.value,
      benchBundle: benchBundle.value,
      rig: rigBundle.value,
      sources: marker.value.sources,
    }) &&
    verifyPublishedBenchC5StatisticsClosure({
      root: output,
      attemptDir: preregistration.value.outputs.attempt_dir,
      preregistration: preregistration.value,
      result: result.value,
      benchBundle: benchBundle.value,
      sources: marker.value.sources,
    }) &&
    verifyPublishedRigC5StatisticsClosure({
      preregistration: preregistration.value,
      result: result.value,
      rig: rigBundle.value,
    }) &&
    verifyPublishedDogfoodC5Closure({
      root: output,
      preregistration: preregistration.value,
      result: result.value,
      snapshot: dogfoodSnapshot.value,
      sources: marker.value.sources,
    })
  );
}

function verifyPublishedPolicyBundleWithoutMarker(
  output: string,
  resultRef: string,
  resultSha256: string,
  reportRef: string,
  reportSha256: string,
  sources: readonly PublishedSource[],
): boolean {
  const result = verifyNamedCanonicalJsonBytes({
    root: output,
    ref: resultRef,
    sha256: resultSha256,
    schema: PolicyMeasurementSchema,
    maxBytes: MAX_POLICY_SOURCE_BYTES,
    privateMode: true,
  });
  const report = verifyNamedTextBytes({
    root: output,
    ref: reportRef,
    sha256: reportSha256,
    maxBytes: MAX_POLICY_SOURCE_BYTES,
    privateMode: true,
  });
  if (!result.ok || !report.ok || report.text !== renderPolicyMeasurement(result.value))
    return false;
  return sources.every(
    (source) =>
      source.material === "state-tree" ||
      verifyNamedBytes({
        root: output,
        ref: source.copy_ref,
        sha256: source.sha256,
        maxBytes: MAX_POLICY_SOURCE_BYTES,
        privateMode: true,
      }).ok,
  );
}

/** Complete the Bench-reserved capture root without treating an unmarked directory as authoritative. */
async function runPolicyStatsWithRuntime(
  input: RunPolicyStatsInput,
  runtime: PolicyStatsRuntime,
): Promise<RunPolicyStatsOutput> {
  const repoRoot = resolve(input.repoRoot);
  const output = resolve(repoRoot, input.out);
  const parent = dirname(output);
  const prefix = `.${basename(output)}.staging-`;
  let stage: string | undefined;
  let stageIdentity: ReservedOutput | undefined;
  let publicationLock: ReservedOutput | undefined;
  let captureIdentity: ReservedOutput | undefined;
  const ownedFinal: OwnedFile[] = [];
  const ownedDirectories: OwnedDirectory[] = [];
  if (!contained(repoRoot, output)) {
    return {
      exitCode: 4,
      stdout: "",
      stderr:
        "policy measurement: artifact-ref-invalid — policy output escapes the repository root\n",
    };
  }
  try {
    const assembled = await runtime.assemble({
      repoRoot,
      preregistrationPath: input.preregistration,
      benchBundlePath: input.bench,
      rigManifestPath: input.rig,
    });
    const preregSource = assembled.sources.find((source) => source.kind === "preregistration");
    if (preregSource === undefined)
      policyAuthority("partial-inventory", "preregistration source is absent");
    const prereg =
      runtime.rereadPreregistration?.(preregSource) ??
      (() => {
        const verified = verifyNamedCanonicalJsonBytes({
          root: repoRoot,
          ref: preregSource.ref,
          sha256: preregSource.sha256,
          schema: PolicyMeasurementPreregistrationSchema,
          maxBytes: MAX_POLICY_SOURCE_BYTES,
          privateMode: false,
        });
        if (!verified.ok)
          policyAuthority(
            "preregistration-mismatch",
            `cannot reverify preregistration: ${verified.reason}`,
          );
        return verified.value;
      })();
    const outputRefs = prereg.outputs;
    if (
      resolve(repoRoot, outputRefs.attempt_dir) !== output ||
      input.bench !== outputRefs.bench_bundle
    )
      policyAuthority(
        "preregistration-mismatch",
        "policy output paths differ from preregistration",
      );
    const registered = registeredOutputRefs(prereg, repoRoot, output);
    const capture = lstatSync(output);
    if (!capture.isDirectory() || capture.isSymbolicLink() || (capture.mode & 0o7777) !== 0o700) {
      policyAuthority("artifact-ref-invalid", "Bench capture root is absent or unsafe");
    }
    captureIdentity = { dev: capture.dev, ino: capture.ino };
    publicationLock = reserveOutput(join(output, ".policy-stats-publish"), output);
    if (publicationLock === undefined)
      return {
        exitCode: 2,
        stdout: "",
        stderr: `stats policy: output already exists (immutable): ${output}\n`,
      };
    for (const ref of [
      "complete.json",
      registered.rig_bundle,
      registered.dogfood_snapshot,
      registered.result_json,
      registered.report_md,
    ]) {
      if (existsSync(join(output, ref))) {
        safeRemoveReservedOutput(join(output, ".policy-stats-publish"), output, publicationLock);
        publicationLock = undefined;
        return {
          exitCode: 2,
          stdout: "",
          stderr: `stats policy: output already exists (immutable): ${output}\n`,
        };
      }
    }
    ensurePrivateDirectory(repoRoot, parent);
    stage = join(parent, `${prefix}${process.pid}-${Math.random().toString(36).slice(2, 10)}`);
    mkdirSync(stage, { mode: 0o700 });
    const stageStat = lstatSync(stage);
    if (!stageStat.isDirectory() || stageStat.isSymbolicLink())
      policyAuthority("artifact-ref-invalid", "policy staging directory is unsafe");
    stageIdentity = { dev: stageStat.dev, ino: stageStat.ino };
    const result = PolicyMeasurementSchema.parse(assembled.result);
    if (
      assembled.sources.length !== result.artifacts.inventory.length ||
      assembled.sources.some(
        (source, index) =>
          source.ref !== result.artifacts.inventory[index]?.ref ||
          source.sha256 !== result.artifacts.inventory[index]?.sha256,
      )
    ) {
      policyAuthority(
        "partial-inventory",
        "publication sources differ from the closed result inventory",
      );
    }
    const copiedSources = copyPolicySourcesToStage(repoRoot, stage, assembled.sources);
    const resultText = canonicalJson(result);
    const reportText = renderPolicyMeasurement(result);
    const rigText = canonicalJson(assembled.publication.rig_bundle);
    const dogfoodText = canonicalJson(assembled.publication.dogfood_snapshot);
    const staged = [
      {
        ref: registered.result_json,
        text: resultText,
        schema: PolicyMeasurementSchema as z.ZodType<unknown>,
      },
      { ref: registered.report_md, text: reportText, schema: undefined },
      {
        ref: registered.rig_bundle,
        text: rigText,
        schema: z.unknown(),
      },
      {
        ref: registered.dogfood_snapshot,
        text: dogfoodText,
        schema: z.unknown(),
      },
    ] as const;
    for (const artifact of staged) {
      const path = join(stage, artifact.ref);
      ensurePrivateDirectory(stage, dirname(path));
      const ok =
        writeFileIfAbsent(path, artifact.text, { mode: 0o600 }) &&
        (artifact.schema === undefined
          ? verifyNamedTextBytes({
              root: stage,
              ref: artifact.ref,
              sha256: sha256(artifact.text),
              maxBytes: MAX_POLICY_SOURCE_BYTES,
              privateMode: true,
            }).ok
          : verifyNamedCanonicalJsonBytes({
              root: stage,
              ref: artifact.ref,
              sha256: sha256(artifact.text),
              schema: artifact.schema,
              maxBytes: MAX_POLICY_SOURCE_BYTES,
              privateMode: true,
            }).ok);
      if (!ok) policyAuthority("artifact-ref-invalid", `cannot publish ${artifact.ref}`);
    }
    runtime.beforeRename?.(stage, output);
    if (
      !verifyNamedCanonicalJsonBytes({
        root: output,
        ref: registered.bench_bundle,
        sha256: assembled.sources.find((source) => source.ref === input.bench)?.sha256 ?? "",
        schema: z.unknown(),
        maxBytes: MAX_POLICY_SOURCE_BYTES,
        privateMode: true,
      }).ok
    ) {
      policyAuthority("artifact-ref-invalid", "Bench capture changed before publication");
    }
    if (!sameDirectoryIdentity(output, captureIdentity)) {
      policyAuthority("artifact-ref-invalid", "Bench capture root changed before publication");
    }
    const install = (ref: string, expectedSha256: string): void => {
      const verified = verifyNamedBytes({
        root: stage as string,
        ref,
        sha256: expectedSha256,
        maxBytes: MAX_POLICY_SOURCE_BYTES,
        privateMode: true,
      });
      if (!verified.ok) policyAuthority("artifact-ref-invalid", `staged output is invalid: ${ref}`);
      if (!sameDirectoryIdentity(output, captureIdentity as ReservedOutput)) {
        policyAuthority("artifact-ref-invalid", "Bench capture root changed during publication");
      }
      const destination = join(output, ref);
      ownedDirectories.push(...ensurePrivateDirectory(output, dirname(destination)));
      if (!writeFileIfAbsent(destination, verified.bytes, { mode: 0o600 })) {
        policyAuthority("artifact-ref-invalid", `policy output already exists: ${ref}`);
      }
      const installed = verifyNamedBytes({
        root: output,
        ref,
        sha256: expectedSha256,
        maxBytes: MAX_POLICY_SOURCE_BYTES,
        privateMode: true,
      });
      if (!installed.ok)
        policyAuthority("artifact-ref-invalid", `installed output is invalid: ${ref}`);
      const stat = lstatSync(destination);
      ownedFinal.push({ path: destination, dev: stat.dev, ino: stat.ino });
    };
    for (const source of copiedSources) {
      if (source.material === "file") install(source.copy_ref, source.sha256);
    }
    for (const artifact of staged) install(artifact.ref, sha256(artifact.text));
    safeRemoveStage(stage, parent, prefix, stageIdentity);
    stage = undefined;
    const outputs = {
      bench_bundle: {
        ref: relative(output, resolve(repoRoot, outputRefs.bench_bundle)),
        sha256:
          assembled.sources.find((source) => source.ref === input.bench)?.sha256 ??
          policyAuthority("partial-inventory", "Bench bundle is absent from source inventory"),
      },
      rig_bundle: { ref: staged[2].ref, sha256: sha256(rigText) },
      dogfood_snapshot: { ref: staged[3].ref, sha256: sha256(dogfoodText) },
      result_json: { ref: registered.result_json, sha256: sha256(resultText) },
      report_md: { ref: registered.report_md, sha256: sha256(reportText) },
    };
    if (
      !verifyPublishedPolicyBundleWithoutMarker(
        output,
        outputs.result_json.ref,
        outputs.result_json.sha256,
        outputs.report_md.ref,
        outputs.report_md.sha256,
        copiedSources,
      )
    )
      policyAuthority("artifact-ref-invalid", "published policy bundle failed final verification");
    runtime.beforeComplete?.(output);
    if (!sameDirectoryIdentity(output, captureIdentity)) {
      policyAuthority("artifact-ref-invalid", "Bench capture root changed before completion");
    }
    const completeText = canonicalJson({
      schema: "reviewgate.policy-measurement-complete.v1",
      result: outputs.result_json,
      report: outputs.report_md,
      outputs,
      sources: copiedSources,
    });
    const markerPath = join(output, "complete.json");
    if (!writeFileIfAbsent(markerPath, completeText, { mode: 0o600 })) {
      policyAuthority("artifact-ref-invalid", "policy completion marker already exists");
    }
    const markerStat = lstatSync(markerPath);
    ownedFinal.push({ path: markerPath, dev: markerStat.dev, ino: markerStat.ino });
    if (!verifyPublishedPolicyBundle(output))
      policyAuthority("artifact-ref-invalid", "policy completion marker is invalid");
    safeRemoveReservedOutput(join(output, ".policy-stats-publish"), output, publicationLock);
    publicationLock = undefined;
    return { exitCode: 0, stdout: `${reportText}`, stderr: "" };
  } catch (error) {
    if (stage !== undefined && stageIdentity !== undefined)
      safeRemoveStage(stage, parent, prefix, stageIdentity);
    for (const file of [...ownedFinal].reverse()) removeOwnedFile(file);
    for (const directory of [...ownedDirectories].reverse()) removeOwnedDirectory(directory);
    if (publicationLock !== undefined)
      safeRemoveReservedOutput(join(output, ".policy-stats-publish"), output, publicationLock);
    if (error instanceof PolicyMeasurementAuthorityError)
      return { exitCode: 4, stdout: "", stderr: `${error.message}\n` };
    throw error;
  }
}

export async function runPolicyStats(input: RunPolicyStatsInput): Promise<RunPolicyStatsOutput> {
  return runPolicyStatsWithRuntime(input, { assemble: assemblePolicyMeasurement });
}

export const __policyStatsTest = {
  run: runPolicyStatsWithRuntime,
  verifyPublishedPolicyBundle,
  copyPolicySourcesToStage,
};

export interface RunPolicyDogfoodAttestationInput {
  repoRoot: string;
  inputManifest: string;
  adjudication: string;
  actor: string;
  out: string;
  now?: Date;
}

export interface PolicyDogfoodAttestationIo {
  isTTY: boolean;
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
  confirm: (challenge: string) => Promise<string | null>;
}

function policyDogfoodIo(): PolicyDogfoodAttestationIo {
  return {
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    writeStdout: (text) => process.stdout.write(text),
    writeStderr: (text) => process.stderr.write(text),
    async confirm(challenge) {
      const { createInterface } = await import("node:readline/promises");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await new Promise<string | null>((resolveAnswer) => {
          let settled = false;
          const finish = (value: string | null) => {
            if (settled) return;
            settled = true;
            resolveAnswer(value);
          };
          rl.on("close", () => finish(null));
          rl.question(`Type exactly "${challenge}" to attest: `).then(
            (value) => finish(value),
            () => finish(null),
          );
        });
      } finally {
        rl.close();
      }
    },
  };
}

export async function runPolicyDogfoodAttestation(
  input: RunPolicyDogfoodAttestationInput,
  io: PolicyDogfoodAttestationIo = policyDogfoodIo(),
): Promise<{ exitCode: 0 | 1; artifact?: { ref: string; sha256: string } }> {
  if (!io.isTTY) {
    io.writeStderr(
      "Error: dogfood attestation requires a real interactive terminal (TTY); no non-interactive override exists.\n",
    );
    return { exitCode: 1 };
  }
  const manifestSha = /^artifacts\/policy-dogfood-input\/([0-9a-f]{64})\.json$/.exec(
    input.inputManifest,
  )?.[1];
  if (manifestSha === undefined) {
    io.writeStderr(
      "Error: --input-manifest must be a content-addressed policy-dogfood-input artifact.\n",
    );
    return { exitCode: 1 };
  }
  const readCandidate = () => {
    const manifest = verifyCanonicalJsonArtifact({
      root: input.repoRoot,
      directory: "policy-dogfood-input",
      schema: PolicyDogfoodInputManifestSchema,
      ref: input.inputManifest,
      sha256: manifestSha,
      maxBytes: 1_048_576,
    });
    if (!manifest.ok) throw new Error(`invalid frozen input manifest: ${manifest.reason}`);
    let rows: unknown;
    try {
      rows = JSON.parse(readFileSync(resolve(input.repoRoot, input.adjudication), "utf8"));
    } catch {
      throw new Error("invalid adjudication draft JSON");
    }
    return {
      manifest: manifest.value,
      rows: PolicyDogfoodAdjudicationSchema.array().min(1).parse(rows),
      actor: input.actor,
    };
  };
  let initial: ReturnType<typeof readCandidate>;
  try {
    initial = readCandidate();
  } catch (error) {
    io.writeStderr(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    return { exitCode: 1 };
  }
  const preflight = policyDogfoodAttestationPreflight(initial);
  io.writeStdout(`${preflight.rendered}\n\n`);
  const confirmation = await io.confirm(preflight.challenge);
  if (confirmation === null || confirmation.trim() !== preflight.challenge) {
    io.writeStderr("Error: Confirmation did not match — no dogfood attestation was created.\n");
    return { exitCode: 1 };
  }
  let current: ReturnType<typeof readCandidate>;
  try {
    current = readCandidate();
  } catch (error) {
    io.writeStderr(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    return { exitCode: 1 };
  }
  const currentPreflight = policyDogfoodAttestationPreflight(current);
  if (currentPreflight.challenge !== preflight.challenge) {
    io.writeStderr(
      "Error: frozen attestation inputs changed; no dogfood attestation was created.\n",
    );
    return { exitCode: 1 };
  }
  const attestation = attestPolicyDogfood({
    ...current,
    confirmation,
    now: input.now ?? new Date(),
  });
  const stored = writeCanonicalJsonArtifact({
    root: resolve(input.repoRoot, input.out),
    directory: "policy-dogfood-attestation",
    schema: PolicyDogfoodAttestationSchema,
    value: attestation,
    maxBytes: 1_048_576,
  });
  if (!stored.ok) {
    io.writeStderr(`Error: failed to write dogfood attestation: ${stored.reason}\n`);
    return { exitCode: 1 };
  }
  return { exitCode: 0, artifact: { ref: stored.ref, sha256: stored.sha256 } };
}

export interface RunStatsInput {
  repoRoot: string;
  since?: string;
  last?: number;
  json?: boolean;
}

export async function runStats(input: RunStatsInput): Promise<string> {
  // `loadAuditWindow` filters runs with a *lexical* string compare (`r.ts >= since`)
  // against ISO timestamps. A raw non-ISO value (e.g. "yesterday", "05/27/2026")
  // is therefore silently mis-compared — it either excludes every real run or
  // matches the wrong window, leaving the user believing they filtered correctly.
  // Reject unparseable input outright and normalize parseable input to an ISO
  // string so the lexical compare is always meaningful.
  let since: string | undefined;
  if (input.since !== undefined) {
    const parsed = new Date(input.since);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(
        `Invalid --since value "${input.since}": expected an ISO date like 2026-05-01 or 2026-05-01T00:00:00Z`,
      );
    }
    since = parsed.toISOString();
  }

  const window = loadAuditWindow(input.repoRoot, {
    ...(since !== undefined ? { since } : {}),
    ...(input.last !== undefined ? { last: input.last } : {}),
  });
  const fpSnap = await new FpLedgerStore(input.repoRoot).snapshot();
  const brainSnap = await new BrainStore(input.repoRoot).snapshot();
  const fpEntries = fpSnap.entries.map((e) => ({
    stage: e.stage,
    rejects: e.rejects.map((r) => ({ provider: r.provider })),
  }));
  const brainEntries = brainSnap.entries.map((e) => ({ status: e.status, type: e.type }));
  const report = aggregate(
    window.runs,
    window.escalationCount,
    fpEntries,
    brainEntries,
    window.decisions,
  );
  return input.json === true ? JSON.stringify(report, null, 2) : renderStats(report);
}
