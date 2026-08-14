import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { z } from "zod";
import { verifyCanonicalJsonArtifact } from "../../artifacts/canonical-json.ts";
import { canonicalJson } from "../../audit/canonical.ts";
import { policyBenchRequestIdentity } from "../../bench/runner.ts";
import {
  type VerifiedPolicyBenchProfileArtifacts,
  policyBenchConfigurationHashes,
  policyBenchEffectiveConfiguration,
  verifyPolicyBenchBundleArtifacts,
} from "../../cli/commands/bench.ts";
import type { ReviewgateConfig } from "../../config/define-config.ts";
import {
  POLICY_CATALOG_VERSION,
  POLICY_PASSES,
  POLICY_PASS_IDS,
  type PolicyPassId,
} from "../../core/policy/catalog.ts";
import {
  POLICY_MEASUREMENT_INTERACTIONS,
  POLICY_MEASUREMENT_LANES,
} from "../../core/policy/measurement-contract.ts";
import { type BenchCase, BenchCaseSchema } from "../../schemas/bench-case.ts";
import type { CaseResult } from "../../schemas/bench-result.ts";
import {
  type PolicyMeasurementPreregistration,
  PolicyMeasurementPreregistrationSchema,
} from "../../schemas/policy-measurement-preregistration.ts";
import {
  PolicyBenchBundleSchema,
  PolicyDogfoodAttestationSchema,
  type PolicyDogfoodInputManifest,
  PolicyDogfoodInputManifestSchema,
  type PolicyDogfoodSnapshot,
  type PolicyMeasurement,
  type PolicyMeasurementInvalidityCode,
  PolicyMeasurementSchema,
  type PolicyPassEvidence,
  type PolicyRigEvidence,
  PolicyRigScenarioManifestSchema,
} from "../../schemas/policy-measurement.ts";
import { safeReadContainedBytes } from "../../utils/safe-read.ts";
import { type PolicyPassClassificationFacts, classifyPolicyPasses } from "./classify.ts";
import { harvestPolicyDogfood } from "./dogfood.ts";
import { collectPolicyRigEvidence } from "./rig.ts";
import {
  collapseCaseRepeats,
  exactTwoSidedSignTest,
  holmAdjustPolicyFamilies,
  percentileBootstrap95,
} from "./statistics.ts";

const MAX_NAMED_INPUT_BYTES = 128 * 1024 * 1024;

export class PolicyMeasurementAuthorityError extends Error {
  readonly exitCode = 4;

  constructor(
    readonly code: PolicyMeasurementInvalidityCode,
    message: string,
  ) {
    super(`policy measurement: ${code} — ${message}`);
    this.name = "PolicyMeasurementAuthorityError";
  }
}

export interface CanonicalSourceArtifact {
  kind: "preregistration" | "bench" | "rig" | "dogfood" | "trace" | "state" | "cassette";
  ref: string;
  sha256: string;
  /** File bytes and virtual state-tree bindings have different publication contracts. */
  material: "file" | "state-tree";
}

export interface PolicyMeasurementAssembly {
  result: PolicyMeasurement;
  sources: CanonicalSourceArtifact[];
  /** Canonical derived artifacts that must be published with the final measurement bundle. */
  publication: {
    rig_bundle: PolicyRigEvidence;
    dogfood_snapshot: PolicyDogfoodSnapshot;
  };
}

interface Binding {
  ref: string;
  sha256: string;
}

interface NamedArtifact<T> extends Binding {
  value: T;
  bytes: Buffer;
}

interface TruthCounts {
  blocking_fp: number;
  blocking_fn: number;
  blocking_tp: number;
}

interface RegisteredCorpusCase {
  id: string;
  kind: CaseResult["kind"];
  content_hash: string;
  expected_label_count: number;
  bench_case: BenchCase;
  diff_patch: string;
}

interface ProfileAnalysis {
  evidence: PolicyPassEvidence;
  facts: PolicyPassClassificationFacts;
  laneSummary: PolicyLaneSummary;
}

interface DogfoodPassEvidence {
  readonly dispositions: PolicyPassClassificationFacts["dogfood_dispositions"];
  readonly refs: readonly Binding[];
  readonly runs: number;
  readonly labels: readonly PolicyDogfoodSnapshot["labels"][number][];
}

type PolicyLaneSummary = PolicyPassEvidence["lane_summaries"][number];
type TraceTotals = PolicyPassEvidence["trace_totals"];

function laneSummary(input: {
  lane: PolicyLaneSummary["lane"];
  primary: boolean;
  opportunities: PolicyPassEvidence["opportunities"];
  exclusions: PolicyPassEvidence["exclusions"];
  truthEffects: PolicyPassEvidence["truth_effects"];
  traceTotals: TraceTotals;
  statistics: PolicyPassEvidence["statistics"];
  rawEvidenceRefs: readonly string[];
}): PolicyLaneSummary {
  return {
    lane: input.lane,
    primary: input.primary,
    descriptive: !input.primary,
    eligible: true,
    authoritative: true,
    opportunities: input.opportunities,
    exclusions: input.exclusions,
    truth_effects: input.truthEffects,
    trace_totals: input.traceTotals,
    statistics: input.statistics,
    raw_evidence_refs: [...new Set(input.rawEvidenceRefs)].sort(compareCodeUnits),
  };
}

function dogfoodExclusions(snapshot: PolicyDogfoodSnapshot): PolicyPassEvidence["exclusions"] {
  const rows: PolicyPassEvidence["exclusions"] = [];
  const add = (code: PolicyPassEvidence["exclusions"][number]["code"], count: number): void => {
    if (count > 0) rows.push({ lane: "dogfood", code, count });
  };
  add("missing-decision", snapshot.exclusions["missing-decision"] ?? 0);
  add("incomplete-trace", snapshot.exclusions["incomplete-trace"] ?? 0);
  add("ambiguous-run-iter", snapshot.exclusions["ambiguous-run-iter"] ?? 0);
  add("signature-absent-lineage", snapshot.exclusions["signature-absent-lineage"] ?? 0);
  add("post-registered-at", snapshot.exclusions["post-registered-at"] ?? 0);
  add(
    "historical-unsigned-decision",
    (snapshot.exclusions["agent-only-decision"] ?? 0) +
      (snapshot.exclusions["missing-attestation"] ?? 0),
  );
  return rows;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function authority(code: PolicyMeasurementInvalidityCode, message: string): never {
  throw new PolicyMeasurementAuthorityError(code, message);
}

function validRelativeRef(ref: string): boolean {
  return (
    ref.length > 0 &&
    !isAbsolute(ref) &&
    !ref.includes("\\") &&
    !ref.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  );
}

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function inputRef(repoRoot: string, path: string): string {
  if (!validRelativeRef(path)) authority("artifact-ref-invalid", `invalid input ref: ${path}`);
  const root = resolve(repoRoot);
  const target = resolve(root, ...path.split("/"));
  if (!contained(root, target)) authority("artifact-ref-invalid", `input escapes root: ${path}`);
  return path;
}

function readNamedCanonical<T>(input: {
  root: string;
  ref: string;
  schema: z.ZodType<T>;
  code: PolicyMeasurementInvalidityCode;
  privateMode: boolean;
}): NamedArtifact<T> {
  const ref = inputRef(input.root, input.ref);
  const path = resolve(input.root, ...ref.split("/"));
  let fd: number | undefined;
  try {
    const realRoot = realpathSync(input.root);
    const before = lstatSync(path);
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size > MAX_NAMED_INPUT_BYTES ||
      (input.privateMode && (before.mode & 0o7777) !== 0o600) ||
      !contained(realRoot, realpathSync(path))
    ) {
      authority(input.code, `unsafe named artifact: ${ref}`);
    }
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size > MAX_NAMED_INPUT_BYTES ||
      (input.privateMode && (opened.mode & 0o7777) !== 0o600)
    ) {
      authority(input.code, `named artifact changed before read: ${ref}`);
    }
    const bounded = Buffer.allocUnsafe(MAX_NAMED_INPUT_BYTES + 1);
    const bytesRead = readSync(fd, bounded, 0, bounded.length, null);
    if (bytesRead > MAX_NAMED_INPUT_BYTES) authority(input.code, `artifact too large: ${ref}`);
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
      pathAfter.dev !== after.dev ||
      pathAfter.ino !== after.ino
    ) {
      authority(input.code, `named artifact changed during read: ${ref}`);
    }
    let text: string;
    let decoded: unknown;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      decoded = JSON.parse(text);
    } catch {
      authority(input.code, `invalid UTF-8 JSON: ${ref}`);
    }
    const parsed = input.schema.safeParse(decoded);
    if (
      !parsed.success &&
      input.code === "preregistration-mismatch" &&
      typeof decoded === "object" &&
      decoded !== null &&
      "catalog_version" in decoded &&
      decoded.catalog_version !== POLICY_CATALOG_VERSION
    ) {
      authority("catalog-mismatch", `preregistration catalog differs: ${ref}`);
    }
    if (!parsed.success || canonicalJson(parsed.data) !== text) {
      authority(input.code, `non-canonical or schema-invalid artifact: ${ref}`);
    }
    return { ref, sha256: sha256(bytes), value: parsed.data, bytes };
  } catch (error) {
    if (error instanceof PolicyMeasurementAuthorityError) throw error;
    authority(input.code, `cannot verify named artifact: ${ref}`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return authority(input.code, `cannot complete named artifact verification: ${ref}`);
}

function git(repoRoot: string, args: readonly string[]): string {
  try {
    return execFileSync("git", [...args], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15_000,
    }).trim();
  } catch {
    authority("source-not-clean", `git ${args.join(" ")} failed`);
  }
}

function gitSucceeds(repoRoot: string, args: readonly string[]): boolean {
  try {
    execFileSync("git", [...args], {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 15_000,
    });
    return true;
  } catch {
    return false;
  }
}

function verifySource(
  repoRoot: string,
  prereg: PolicyMeasurementPreregistration,
  preregArtifact: NamedArtifact<PolicyMeasurementPreregistration>,
): string {
  const head = git(repoRoot, ["rev-parse", "HEAD"]);
  const source = git(repoRoot, ["rev-parse", prereg.source.ref]);
  if (
    head !== source ||
    !gitSucceeds(repoRoot, ["diff", "--quiet", "--ignore-submodules", "--"]) ||
    !gitSucceeds(repoRoot, ["diff", "--cached", "--quiet", "--ignore-submodules", "--"])
  ) {
    authority("source-not-clean", "source is dirty or HEAD differs from the registered ref");
  }
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", preregArtifact.ref], {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 15_000,
    });
    const committed = execFileSync("git", ["show", `HEAD:${preregArtifact.ref}`], {
      cwd: repoRoot,
      encoding: "buffer",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15_000,
      maxBuffer: MAX_NAMED_INPUT_BYTES + 1,
    });
    if (!Buffer.from(committed).equals(preregArtifact.bytes)) {
      authority("preregistration-mismatch", "HEAD contains different preregistration bytes");
    }
  } catch (error) {
    if (error instanceof PolicyMeasurementAuthorityError) throw error;
    authority("preregistration-mismatch", "preregistration is not tracked in HEAD");
  }
  return head;
}

function verifyClosedUntrackedInputs(
  repoRoot: string,
  inventory: readonly Binding[],
  generatedBoundaryRefs: ReadonlySet<string>,
): void {
  let status: string;
  try {
    status = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15_000,
      maxBuffer: MAX_NAMED_INPUT_BYTES + 1,
    });
  } catch {
    authority("source-not-clean", "cannot verify generated input closure");
  }
  const declared = new Set(inventory.map((row) => row.ref));
  for (const entry of status.split("\0").filter(Boolean)) {
    if (!entry.startsWith("?? ")) {
      authority("source-not-clean", "tracked source changed during measurement assembly");
    }
    const ref = entry.slice(3);
    if (!declared.has(ref)) {
      authority("source-not-clean", `undeclared generated input: ${ref}`);
    }
  }
  const boundaries = [...generatedBoundaryRefs].sort(compareCodeUnits);
  if (boundaries.length === 0) return;
  let otherFiles: string;
  try {
    // Unlike `git status`, `ls-files --others` deliberately includes ignored files. Restricting
    // it to the preregistered/generated boundaries catches a hidden sibling without making
    // unrelated ignored developer state part of measurement authority.
    otherFiles = execFileSync("git", ["ls-files", "--others", "-z", "--", ...boundaries], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15_000,
      maxBuffer: MAX_NAMED_INPUT_BYTES + 1,
    });
  } catch {
    authority("source-not-clean", "cannot verify ignored generated input closure");
  }
  for (const ref of otherFiles.split("\0").filter(Boolean)) {
    if (!declared.has(ref)) {
      authority("source-not-clean", `undeclared generated input: ${ref}`);
    }
  }
}

function generatedBoundary(ref: string): string {
  const parent = dirname(ref).split(sep).join("/");
  return parent === "." ? ref : parent;
}

function verifyCorpus(
  repoRoot: string,
  prereg: PolicyMeasurementPreregistration,
): readonly RegisteredCorpusCase[] {
  const content: Record<string, string> = {};
  const cases: RegisteredCorpusCase[] = [];
  for (const ref of Object.keys(prereg.corpus.content_sha256).sort(compareCodeUnits)) {
    const id = ref.match(/^cases\/(clean|seeded)-(\d{2})\.json$/)?.[0];
    if (id === undefined) authority("corpus-mismatch", `invalid corpus identity: ${ref}`);
    const caseId = ref.slice("cases/".length, -".json".length);
    const caseJson = safeReadContainedBytes(
      repoRoot,
      `${prereg.corpus.path}/${caseId}/case.json`,
      1_048_576,
    );
    const diff = safeReadContainedBytes(
      repoRoot,
      `${prereg.corpus.path}/${caseId}/diff.patch`,
      8 * 1_048_576,
    );
    if (caseJson === null || diff === null) {
      authority("corpus-mismatch", `missing corpus bytes for ${caseId}`);
    }
    let benchCase: ReturnType<typeof BenchCaseSchema.parse>;
    try {
      benchCase = BenchCaseSchema.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(caseJson)),
      );
    } catch {
      authority("corpus-mismatch", `invalid truth manifest for ${caseId}`);
    }
    const kind = caseId.startsWith("clean-") ? "clean" : "seeded-bug";
    if (benchCase.id !== caseId || benchCase.kind !== kind) {
      authority("corpus-mismatch", `truth manifest identity differs for ${caseId}`);
    }
    content[ref] = sha256(`${sha256(caseJson)}${sha256(diff)}`);
    cases.push({
      id: caseId,
      kind,
      content_hash: content[ref],
      expected_label_count: benchCase.expected.length,
      bench_case: benchCase,
      diff_patch: new TextDecoder("utf-8", { fatal: true }).decode(diff),
    });
  }
  if (
    canonicalJson(content) !== canonicalJson(prereg.corpus.content_sha256) ||
    sha256(JSON.stringify(content)) !== prereg.corpus.manifest_sha256
  ) {
    authority("corpus-mismatch", "frozen corpus hashes differ from preregistration");
  }
  return cases;
}

function verifyBenchCorpusIdentity(input: {
  profileId: string;
  repeat: 1 | 2 | 3;
  cases: readonly CaseResult[];
  registered: readonly RegisteredCorpusCase[];
  config: ReviewgateConfig;
}): void {
  if (
    input.cases.length !== input.registered.length ||
    input.cases.some((row, index) => {
      const registered = input.registered[index];
      return (
        registered === undefined ||
        row.id !== registered.id ||
        row.kind !== registered.kind ||
        row.content_hash !== registered.content_hash ||
        row.policy_truth?.expected_label_count !== registered.expected_label_count ||
        row.policy_trace?.request_identity_sha256 !==
          policyBenchRequestIdentity({
            benchCase: registered.bench_case,
            diffPatch: registered.diff_patch,
            config: input.config,
          })
      );
    })
  ) {
    authority(
      "corpus-mismatch",
      `${input.profileId} repeat ${input.repeat} differs from the registered corpus inventory`,
    );
  }
}

function addInventory(
  inventory: Map<string, Binding>,
  binding: Binding,
  code: PolicyMeasurementInvalidityCode = "partial-inventory",
): void {
  if (!validRelativeRef(binding.ref) || !/^[0-9a-f]{64}$/.test(binding.sha256)) {
    authority("artifact-ref-invalid", `invalid artifact binding: ${binding.ref}`);
  }
  const previous = inventory.get(binding.ref);
  if (previous !== undefined && previous.sha256 !== binding.sha256) {
    authority(code, `artifact ref has conflicting hashes: ${binding.ref}`);
  }
  inventory.set(binding.ref, { ref: binding.ref, sha256: binding.sha256 });
}

function repoRelativeBinding(repoRoot: string, artifactRoot: string, binding: Binding): Binding {
  if (!validRelativeRef(binding.ref)) {
    authority("artifact-ref-invalid", `invalid artifact binding: ${binding.ref}`);
  }
  const absolute = resolve(artifactRoot, ...binding.ref.split("/"));
  if (!contained(repoRoot, absolute)) {
    authority("artifact-ref-invalid", `artifact escapes repository root: ${binding.ref}`);
  }
  const ref = relative(repoRoot, absolute).split(sep).join("/");
  inputRef(repoRoot, ref);
  return { ref, sha256: binding.sha256 };
}

function truthCounts(row: CaseResult): TruthCounts {
  if (row.policy_truth === undefined) authority("trace-mismatch", `case ${row.id} has no truth`);
  return {
    blocking_fp: row.policy_truth.findings.filter(
      (finding) => finding.outcome === "FP" && finding.severity !== "INFO",
    ).length,
    blocking_fn: row.policy_truth.fn_label_indexes.length,
    blocking_tp: row.policy_truth.findings.filter(
      (finding) => finding.outcome === "TP" && finding.severity !== "INFO",
    ).length,
  };
}

function benchErrorIdentities(row: CaseResult): Set<string> {
  if (row.policy_truth === undefined) authority("trace-mismatch", `case ${row.id} has no truth`);
  return new Set([
    ...row.policy_truth.findings.flatMap((finding) =>
      finding.outcome === "FP" && finding.severity !== "INFO"
        ? [`blocking-fp:${finding.signature}`]
        : [],
    ),
    ...row.policy_truth.fn_label_indexes.map((index) => `blocking-fn:label-${index}`),
  ]);
}

function sameObservedBenchOutcome(left: CaseResult, right: CaseResult): boolean {
  return (
    canonicalJson({
      status: left.status,
      error: left.error,
      counts: left.counts,
      policy_truth: left.policy_truth,
      final_identity_sha256: left.policy_trace?.final_identity_sha256,
    }) ===
    canonicalJson({
      status: right.status,
      error: right.error,
      counts: right.counts,
      policy_truth: right.policy_truth,
      final_identity_sha256: right.policy_trace?.final_identity_sha256,
    })
  );
}

function recordIdentityDirections(
  directions: Map<string, { benefit: number; harm: number }>,
  identityPrefix: string,
  baseline: ReadonlySet<string>,
  ablated: ReadonlySet<string>,
): void {
  for (const errorIdentity of ablated) {
    if (baseline.has(errorIdentity)) continue;
    const identity = `${identityPrefix}:${errorIdentity}`;
    const row = directions.get(identity) ?? { benefit: 0, harm: 0 };
    row.benefit += 1;
    directions.set(identity, row);
  }
  for (const errorIdentity of baseline) {
    if (ablated.has(errorIdentity)) continue;
    const identity = `${identityPrefix}:${errorIdentity}`;
    const row = directions.get(identity) ?? { benefit: 0, harm: 0 };
    row.harm += 1;
    directions.set(identity, row);
  }
}

function addTruth(left: TruthCounts, right: TruthCounts): TruthCounts {
  return {
    blocking_fp: left.blocking_fp + right.blocking_fp,
    blocking_fn: left.blocking_fn + right.blocking_fn,
    blocking_tp: left.blocking_tp + right.blocking_tp,
  };
}

function error(counts: TruthCounts): number {
  return counts.blocking_fp + counts.blocking_fn;
}

function zeroTruth(): TruthCounts {
  return { blocking_fp: 0, blocking_fn: 0, blocking_tp: 0 };
}

function catalogSnapshot(passId: PolicyPassId) {
  const pass = POLICY_PASSES.find((candidate) => candidate.id === passId);
  if (pass === undefined) authority("catalog-mismatch", `unknown pass: ${passId}`);
  return {
    order: pass.order,
    class: pass.class,
    overlaps_with: [...pass.overlaps_with],
    opportunity_sha256: sha256(pass.opportunity),
  };
}

function stats(
  caseEffects: readonly { caseId: string; repeat: 1 | 2 | 3; errorReduction: number }[],
  seed: number,
) {
  const collapsed = collapseCaseRepeats(caseEffects);
  const values = collapsed.map((row) => row.mean);
  const interval = percentileBootstrap95(values, 10_000, seed) ?? { lo: 0, hi: 0 };
  const repeatMeans = ([1, 2, 3] as const).map((repeat) => {
    const rows = caseEffects.filter((row) => row.repeat === repeat);
    return rows.length === 0
      ? 0
      : rows.reduce((total, row) => total + row.errorReduction, 0) / rows.length;
  }) as [number, number, number];
  return {
    collapsed,
    repeatMeans,
    statistics: {
      raw_effects: repeatMeans,
      interval,
      p_value: exactTwoSidedSignTest(values),
      adjusted_p_value: 1,
    },
  };
}

function independentSequenceStats(values: readonly number[], seed: number) {
  const interval = percentileBootstrap95(values, 10_000, seed) ?? { lo: 0, hi: 0 };
  return {
    raw_effects: [...values],
    interval,
    p_value: exactTwoSidedSignTest(values),
    adjusted_p_value: 1,
  };
}

function dogfoodForPass(input: {
  passId: PolicyPassId;
  snapshot: PolicyDogfoodSnapshot;
  manifest: PolicyDogfoodInputManifest;
  manifestBinding: Binding;
  attestationBinding: Binding;
}): DogfoodPassEvidence {
  const grouped = new Map<string, PolicyDogfoodSnapshot["labels"]>();
  for (const label of input.snapshot.labels) {
    if (label.pass_id !== input.passId) continue;
    const identity = `${label.run_id}\u0000${label.iter}\u0000${label.finding_signature}`;
    const rows = grouped.get(identity) ?? [];
    rows.push(label);
    grouped.set(identity, rows);
  }
  const refs = new Map<string, Binding>([
    [input.manifestBinding.ref, input.manifestBinding],
    [input.attestationBinding.ref, input.attestationBinding],
    ...input.manifest.entries.map(
      (entry) => [entry.ref, { ref: entry.ref, sha256: entry.sha256 }] as const,
    ),
  ]);
  const dispositions: Array<PolicyPassClassificationFacts["dogfood_dispositions"][number]> = [];
  for (const [identity, labels] of [...grouped].sort(([left], [right]) =>
    compareCodeUnits(left, right),
  )) {
    const label = labels[0];
    if (label === undefined) continue;
    const effect = labels.some((row) => row.effect === "suppressed")
      ? "suppressed"
      : labels.some((row) => row.effect === "preserved")
        ? "preserved"
        : "none";
    // A protected evaluation records context, not a pass-removal counterfactual. In particular,
    // the demoter and its ablated variant can both preserve the same finding, so this observation
    // alone must never manufacture a unique-retention veto for the demoter.
    dispositions.push({
      identity: `dogfood:${identity}`,
      run_id: label.run_id,
      iter: label.iter,
      disposition: label.disposition,
      effect,
      evidence_ref: input.manifestBinding.ref,
    });
    for (const entry of input.manifest.entries) {
      const ownsRun =
        entry.kind === "audit"
          ? entry.runs.some((run) => run.run_id === label.run_id && run.iter === label.iter)
          : entry.run_id === label.run_id && entry.iter === label.iter;
      if (ownsRun) refs.set(entry.ref, { ref: entry.ref, sha256: entry.sha256 });
    }
  }
  return {
    dispositions,
    refs: [...refs.values()].sort((left, right) => compareCodeUnits(left.ref, right.ref)),
    runs: new Set(dispositions.map((row) => `${row.run_id}\u0000${row.iter}`)).size,
    labels: input.snapshot.labels.filter((label) => label.pass_id === input.passId),
  };
}

function dogfoodLaneSummary(input: {
  dogfood: DogfoodPassEvidence;
  snapshot: PolicyDogfoodSnapshot;
  seed: number;
}): PolicyLaneSummary {
  const totals: TraceTotals = { applied: 0, would_apply: 0, protected: 0, no_opportunity: 0 };
  const signatures = new Set<string>();
  for (const label of input.dogfood.labels) {
    for (const signature of label.source_signatures) signatures.add(signature);
    if (label.evaluation_result === "applied") totals.applied += 1;
    else if (label.evaluation_result === "would-apply") totals.would_apply += 1;
    else if (label.evaluation_result === "protected") totals.protected += 1;
    else totals.no_opportunity += 1;
  }
  const effects = input.dogfood.dispositions.map((disposition) =>
    disposition.effect === "suppressed" ? -1 : disposition.effect === "preserved" ? 1 : 0,
  );
  return laneSummary({
    lane: "dogfood",
    primary: false,
    opportunities: {
      cases: input.dogfood.dispositions.length,
      signatures: signatures.size,
      turns: 0,
      runs: input.dogfood.runs,
    },
    exclusions: dogfoodExclusions(input.snapshot),
    truthEffects: {
      baseline: zeroTruth(),
      ablated: zeroTruth(),
      error_reduction: 0,
    },
    traceTotals: totals,
    statistics: independentSequenceStats(effects, input.seed),
    rawEvidenceRefs: input.dogfood.refs.map((binding) => binding.ref),
  });
}

function analyzeBenchProfile(input: {
  passId: PolicyPassId;
  baseline: CaseResult[];
  ablated: CaseResult[];
  profileBinding: Binding;
  profileBindings: Binding[];
  interactionBindings: Binding[];
  dogfood: DogfoodPassEvidence;
  dogfoodSnapshot: PolicyDogfoodSnapshot;
  seed: number;
}): ProfileAnalysis {
  const baselineByKey = new Map(
    input.baseline.map((row) => [`${row.id}\u0000${row.repeat ?? 1}`, row]),
  );
  let baselineTruth = zeroTruth();
  let ablatedTruth = zeroTruth();
  const effects: Array<{ caseId: string; repeat: 1 | 2 | 3; errorReduction: number }> = [];
  const opportunityCases = new Set<string>();
  const opportunitySignatures = new Set<string>();
  const identityDirections = new Map<string, { benefit: number; harm: number }>();
  const totals = { applied: 0, would_apply: 0, protected: 0, no_opportunity: 0 };
  for (const row of input.ablated) {
    const repeat = (row.repeat ?? 1) as 1 | 2 | 3;
    const baseline = baselineByKey.get(`${row.id}\u0000${repeat}`);
    if (baseline === undefined) authority("bench-profile-mismatch", `unpaired case ${row.id}`);
    const trace = baseline.policy_trace?.trace;
    if (trace === undefined) authority("trace-mismatch", `missing baseline trace ${row.id}`);
    const evaluations = trace.evaluations.filter(
      (evaluation) => evaluation.pass_id === input.passId,
    );
    const carrier = evaluations.filter((evaluation) => evaluation.result !== "no-opportunity");
    for (const evaluation of evaluations) {
      if (evaluation.result === "applied") totals.applied += 1;
      else if (evaluation.result === "would-apply") totals.would_apply += 1;
      else if (evaluation.result === "protected") totals.protected += 1;
      else if (evaluation.result === "no-opportunity") totals.no_opportunity += 1;
    }
    if (carrier.length === 0) {
      if (!sameObservedBenchOutcome(baseline, row)) {
        authority(
          "trace-mismatch",
          `no-opportunity singleton output differs for ${input.passId} case ${row.id}`,
        );
      }
      continue;
    }
    opportunityCases.add(row.id);
    for (const evaluation of carrier) {
      for (const signature of evaluation.source_signatures) opportunitySignatures.add(signature);
    }
    const baseCounts = truthCounts(baseline);
    const variantCounts = truthCounts(row);
    baselineTruth = addTruth(baselineTruth, baseCounts);
    ablatedTruth = addTruth(ablatedTruth, variantCounts);
    effects.push({
      caseId: row.id,
      repeat,
      errorReduction: error(variantCounts) - error(baseCounts),
    });
    recordIdentityDirections(
      identityDirections,
      `bench:${row.id}`,
      benchErrorIdentities(baseline),
      benchErrorIdentities(row),
    );
  }
  const computed = stats(effects, input.seed);
  const rawRefs = [
    ...input.profileBindings.map((row) => row.ref),
    ...input.interactionBindings.map((row) => row.ref),
    ...input.dogfood.refs.map((row) => row.ref),
  ].sort(compareCodeUnits);
  const beneficial = [...identityDirections.entries()]
    .filter(([, direction]) => direction.benefit >= 2 && direction.harm === 0)
    .map(([identity]) => ({
      identity,
      evidence_ref: input.profileBinding.ref,
      reproduced_by_pass_ids: [] as PolicyPassId[],
    }))
    .sort((left, right) => compareCodeUnits(left.identity, right.identity));
  const harms = [...identityDirections.entries()]
    .filter(([, direction]) => direction.harm >= 2 && direction.benefit === 0)
    .map(([identity]) => ({ identity, evidence_ref: input.profileBinding.ref }))
    .sort((left, right) => compareCodeUnits(left.identity, right.identity));
  const lane = POLICY_MEASUREMENT_LANES[input.passId];
  return {
    evidence: {
      pass_id: input.passId,
      lane,
      catalog_snapshot: catalogSnapshot(input.passId),
      eligibility: { stateless: true, stateful: false, dogfood: true },
      authority: { stateless: true, stateful: false, dogfood: true },
      opportunities: {
        cases: opportunityCases.size,
        signatures: opportunitySignatures.size,
        turns: 0,
        runs: input.dogfood.runs,
      },
      exclusions: dogfoodExclusions(input.dogfoodSnapshot),
      truth_effects: {
        baseline: baselineTruth,
        ablated: ablatedTruth,
        error_reduction: error(ablatedTruth) - error(baselineTruth),
      },
      trace_totals: totals,
      statistics: computed.statistics,
      unique_contributions: [],
      raw_evidence_refs: [...new Set(rawRefs)],
      lane_summaries: [],
    },
    laneSummary: laneSummary({
      lane: "stateless-bench",
      primary: POLICY_MEASUREMENT_LANES[input.passId] === "stateless-bench",
      opportunities: {
        cases: opportunityCases.size,
        signatures: opportunitySignatures.size,
        turns: 0,
        runs: 0,
      },
      exclusions: [],
      truthEffects: {
        baseline: baselineTruth,
        ablated: ablatedTruth,
        error_reduction: error(ablatedTruth) - error(baselineTruth),
      },
      traceTotals: totals,
      statistics: computed.statistics,
      rawEvidenceRefs: input.profileBindings.map((binding) => binding.ref),
    }),
    facts: {
      pass_id: input.passId,
      ground_truth_harms: harms,
      dogfood_dispositions: input.dogfood.dispositions,
      beneficial_effects: beneficial,
    },
  };
}

function analyzeRigPass(input: {
  passId: PolicyPassId;
  rig: PolicyRigEvidence;
  scenarioBinding: Binding;
  rigBindings: Binding[];
  interactionBindings: Binding[];
  dogfood: DogfoodPassEvidence;
  dogfoodSnapshot: PolicyDogfoodSnapshot;
  seed: number;
}): ProfileAnalysis {
  const sequences = input.rig.sequences.filter((row) => row.pass_id === input.passId);
  if (sequences.length !== 3)
    authority("rig-state-mismatch", `incomplete ${input.passId} Rig lane`);
  let baseline = zeroTruth();
  let ablated = zeroTruth();
  const effects = sequences.map((sequence) => {
    baseline = addTruth(baseline, sequence.truth_effects.baseline);
    ablated = addTruth(ablated, sequence.truth_effects.ablated);
    return sequence.truth_effects.error_reduction;
  });
  const computed = independentSequenceStats(effects, input.seed);
  const rawRefs = [
    input.scenarioBinding.ref,
    ...input.rigBindings.map((row) => row.ref),
    ...input.interactionBindings.map((row) => row.ref),
    ...input.dogfood.refs.map((row) => row.ref),
    ...sequences.flatMap((sequence) => [
      sequence.manifest.ref,
      sequence.result.ref,
      sequence.script.ref,
      sequence.initial_state.ref,
    ]),
  ].sort(compareCodeUnits);
  const identityDirections = new Map<string, { benefit: number; harm: number }>();
  for (const sequence of sequences) {
    const sequenceIdentity = sequence.scenario_id.startsWith(`${sequence.pass_id}-`)
      ? sequence.scenario_id.slice(sequence.pass_id.length + 1)
      : sequence.scenario_id;
    for (const turn of sequence.turns) {
      recordIdentityDirections(
        identityDirections,
        `rig:${sequenceIdentity}:turn-${turn.turn_index}`,
        new Set(turn.baseline.errors.map((row) => `${row.kind}:${row.identity}`)),
        new Set(turn.counterfactual.errors.map((row) => `${row.kind}:${row.identity}`)),
      );
    }
  }
  const beneficial = [...identityDirections.entries()]
    .filter(([, direction]) => direction.benefit > 0 && direction.harm === 0)
    .map(([identity]) => ({
      identity,
      evidence_ref: input.scenarioBinding.ref,
      reproduced_by_pass_ids: [] as PolicyPassId[],
    }))
    .sort((left, right) => compareCodeUnits(left.identity, right.identity));
  return {
    evidence: {
      pass_id: input.passId,
      lane: "stateful-rig",
      catalog_snapshot: catalogSnapshot(input.passId),
      eligibility: { stateless: false, stateful: true, dogfood: true },
      authority: { stateless: false, stateful: true, dogfood: true },
      opportunities: {
        cases: sequences.length,
        signatures: 0,
        turns: sequences.reduce((total, sequence) => total + sequence.opportunity_turns, 0),
        runs: input.dogfood.runs,
      },
      exclusions: dogfoodExclusions(input.dogfoodSnapshot),
      truth_effects: {
        baseline,
        ablated,
        error_reduction: error(ablated) - error(baseline),
      },
      trace_totals: { applied: 0, would_apply: 0, protected: 0, no_opportunity: 0 },
      statistics: computed,
      unique_contributions: [],
      raw_evidence_refs: [...new Set(rawRefs)],
      lane_summaries: [],
    },
    laneSummary: laneSummary({
      lane: "stateful-rig",
      primary: true,
      opportunities: {
        cases: sequences.length,
        signatures: 0,
        turns: sequences.reduce((total, sequence) => total + sequence.opportunity_turns, 0),
        runs: 0,
      },
      exclusions: [],
      truthEffects: {
        baseline,
        ablated,
        error_reduction: error(ablated) - error(baseline),
      },
      traceTotals: { applied: 0, would_apply: 0, protected: 0, no_opportunity: 0 },
      statistics: computed,
      rawEvidenceRefs: [
        input.scenarioBinding.ref,
        ...input.rigBindings.map((binding) => binding.ref),
        ...sequences.flatMap((sequence) => [
          sequence.manifest.ref,
          sequence.result.ref,
          sequence.script.ref,
          sequence.initial_state.ref,
        ]),
      ],
    }),
    facts: {
      pass_id: input.passId,
      ground_truth_harms: [...identityDirections.entries()]
        .filter(([, direction]) => direction.harm > 0 && direction.benefit === 0)
        .map(([identity]) => ({ identity, evidence_ref: input.scenarioBinding.ref }))
        .sort((left, right) => compareCodeUnits(left.identity, right.identity)),
      dogfood_dispositions: input.dogfood.dispositions,
      beneficial_effects: beneficial,
    },
  };
}

function evidenceForInteraction(input: {
  binding: Binding;
  bindings: Binding[];
  passIds: readonly PolicyPassId[];
  baseline: CaseResult[];
  ablated: CaseResult[];
  seed: number;
}) {
  const baselineByKey = new Map(
    input.baseline.map((row) => [`${row.id}\u0000${row.repeat ?? 1}`, row]),
  );
  let baseline = zeroTruth();
  let ablated = zeroTruth();
  const opportunityCases = new Set<string>();
  const opportunitySignatures = new Set<string>();
  const effects: Array<{ caseId: string; repeat: 1 | 2 | 3; errorReduction: number }> = [];
  const totals: TraceTotals = { applied: 0, would_apply: 0, protected: 0, no_opportunity: 0 };
  for (const row of input.ablated) {
    const repeat = (row.repeat ?? 1) as 1 | 2 | 3;
    const base = baselineByKey.get(`${row.id}\u0000${repeat}`);
    if (base === undefined) authority("bench-profile-mismatch", `unpaired group case ${row.id}`);
    const trace = base.policy_trace?.trace;
    if (trace === undefined) authority("trace-mismatch", `missing group trace ${row.id}`);
    const evaluations = trace.evaluations.filter((evaluation) =>
      input.passIds.includes(evaluation.pass_id),
    );
    for (const evaluation of evaluations) {
      if (evaluation.result === "applied") totals.applied += 1;
      else if (evaluation.result === "would-apply") totals.would_apply += 1;
      else if (evaluation.result === "protected") totals.protected += 1;
      else totals.no_opportunity += 1;
    }
    const carriers = evaluations.filter((evaluation) => evaluation.result !== "no-opportunity");
    if (carriers.length === 0) {
      if (!sameObservedBenchOutcome(base, row)) {
        authority(
          "trace-mismatch",
          `no-opportunity interaction output differs for ${input.passIds.join("/")} case ${row.id}`,
        );
      }
      continue;
    }
    opportunityCases.add(row.id);
    for (const evaluation of carriers) {
      for (const signature of evaluation.source_signatures) {
        opportunitySignatures.add(signature);
      }
    }
    const baseTruth = truthCounts(base);
    const variantTruth = truthCounts(row);
    baseline = addTruth(baseline, baseTruth);
    ablated = addTruth(ablated, variantTruth);
    effects.push({
      caseId: row.id,
      repeat,
      errorReduction: error(variantTruth) - error(baseTruth),
    });
  }
  const computed = stats(effects, input.seed);
  return {
    evidence: {
      authoritative: true,
      eligibility: { stateless: true, stateful: false, dogfood: false },
      authority: { stateless: true, stateful: false, dogfood: false },
      opportunities: {
        cases: opportunityCases.size,
        signatures: opportunitySignatures.size,
        turns: 0,
        runs: 0,
      },
      exclusions: [],
      truth_effects: {
        baseline,
        ablated,
        error_reduction: error(ablated) - error(baseline),
      },
      statistics: computed.statistics,
      raw_evidence_refs: input.bindings.map((row) => row.ref).sort(compareCodeUnits),
    },
    traceTotals: totals,
  };
}

function evidenceForRigInteraction(input: {
  binding: Binding;
  rig: PolicyRigEvidence;
  rigBindings: readonly Binding[];
  seed: number;
}) {
  const sequences = input.rig.sequences.filter((row) => row.history_interaction !== null);
  if (sequences.length !== 12) {
    authority("rig-state-mismatch", "history interaction requires all twelve seeded sequences");
  }
  let baseline = zeroTruth();
  let ablated = zeroTruth();
  const effects = sequences.flatMap((sequence) => {
    const group = sequence.history_interaction;
    if (group === null) return [];
    baseline = addTruth(baseline, group.truth_effects.baseline);
    ablated = addTruth(ablated, group.truth_effects.ablated);
    return [group.truth_effects.error_reduction];
  });
  const computed = independentSequenceStats(effects, input.seed);
  const refs = [input.binding.ref, ...input.rigBindings.map((binding) => binding.ref)];
  return {
    evidence: {
      authoritative: true,
      eligibility: { stateless: false, stateful: true, dogfood: false },
      authority: { stateless: false, stateful: true, dogfood: false },
      opportunities: {
        cases: sequences.length,
        signatures: 0,
        turns: sequences.reduce(
          (total, sequence) => total + (sequence.history_interaction?.opportunity_turns ?? 0),
          0,
        ),
        runs: 0,
      },
      exclusions: [],
      truth_effects: {
        baseline,
        ablated,
        error_reduction: error(ablated) - error(baseline),
      },
      statistics: computed,
      raw_evidence_refs: [...new Set(refs)].sort(compareCodeUnits),
    },
    traceTotals: { applied: 0, would_apply: 0, protected: 0, no_opportunity: 0 },
  };
}

function verifyBenchProvenance(input: {
  profile: VerifiedPolicyBenchProfileArtifacts;
  prereg: PolicyMeasurementPreregistration;
  preregSha256: string;
  sourceHead: string;
  runnerSha256: string | null;
}): string {
  const configurationHashes = policyBenchConfigurationHashes(input.prereg);
  if (configurationHashes === null) {
    authority("bench-profile-mismatch", "preregistration cannot derive a Bench configuration");
  }
  let runnerSha256 = input.runnerSha256;
  for (const repeat of input.profile.repeats) {
    const provenance = repeat.source_result.value.provenance;
    const integrity = provenance.integrity;
    const reviewers = provenance.providers.map(({ id, model, persona }) => ({
      provider: id,
      model,
      persona,
    }));
    const expectedReviewers = input.prereg.roster.reviewers.map(({ provider, model, persona }) => ({
      provider,
      model,
      persona,
    }));
    const critic = provenance.critic;
    const expectedCritic = input.prereg.roster.critic;
    const releaseMatches =
      input.prereg.release === provenance.reviewgate_version ||
      input.prereg.release === `v${provenance.reviewgate_version}`;
    if (
      !releaseMatches ||
      provenance.corpus_commit !== input.sourceHead ||
      provenance.corpus_dirty ||
      provenance.config_hash !== configurationHashes.provenance ||
      provenance.repeat !== input.prereg.corpus.repeats ||
      provenance.case_count.seeded !== input.prereg.corpus.seeded_bug ||
      provenance.case_count.clean !== input.prereg.corpus.clean ||
      provenance.case_run_count?.seeded !==
        input.prereg.corpus.seeded_bug * input.prereg.corpus.repeats ||
      provenance.case_run_count.clean !== input.prereg.corpus.clean * input.prereg.corpus.repeats ||
      provenance.case_run_count.total !==
        input.prereg.corpus.unique_cases * input.prereg.corpus.repeats ||
      canonicalJson(reviewers) !== canonicalJson(expectedReviewers) ||
      canonicalJson(provenance.phases.ablations) !==
        canonicalJson(input.profile.ablated_pass_ids) ||
      integrity === undefined ||
      integrity.source_commit !== input.sourceHead ||
      integrity.repository_dirty ||
      integrity.runner_kind !== "compiled" ||
      !/^[0-9a-f]{64}$/.test(integrity.runner_sha256) ||
      integrity.preregistration_sha256 !== input.preregSha256 ||
      integrity.authoritative_requested !== true ||
      integrity.max_provider_calls !== input.prereg.hard_gates.maximum_provider_calls ||
      integrity.max_output_tokens !== input.prereg.execution.max_output_tokens ||
      integrity.reviewer_max_attempts !== input.prereg.execution.reviewer_max_attempts ||
      (expectedCritic === null) !== (critic === null || critic === undefined) ||
      (expectedCritic !== null &&
        (critic === null ||
          critic === undefined ||
          critic.provider !== expectedCritic.provider ||
          critic.model !== expectedCritic.model ||
          critic.max_attempts !== input.prereg.execution.critic_max_attempts ||
          canonicalJson(critic.openrouter_provider) !==
            canonicalJson(expectedCritic.openrouter_provider)))
    ) {
      authority(
        "bench-profile-mismatch",
        `${input.profile.id} repeat ${repeat.authority.repeat} provenance differs`,
      );
    }
    if (
      repeat.repeat_result.value.cases.some(
        (row) => row.policy_trace?.effective_config_sha256 !== configurationHashes.effective,
      )
    ) {
      authority(
        "bench-profile-mismatch",
        `${input.profile.id} repeat ${repeat.authority.repeat} trace configuration differs`,
      );
    }
    if (runnerSha256 !== null && runnerSha256 !== integrity.runner_sha256) {
      authority("bench-profile-mismatch", "Bench profiles name different compiled runners");
    }
    runnerSha256 = integrity.runner_sha256;
  }
  if (runnerSha256 === null) authority("bench-profile-mismatch", "Bench runner identity is absent");
  return runnerSha256;
}

export async function assemblePolicyMeasurement(input: {
  repoRoot: string;
  preregistrationPath: string;
  benchBundlePath: string;
  rigManifestPath: string;
}): Promise<PolicyMeasurementAssembly> {
  const repoRoot = resolve(input.repoRoot);
  inputRef(repoRoot, input.preregistrationPath);
  inputRef(repoRoot, input.benchBundlePath);
  inputRef(repoRoot, input.rigManifestPath);

  const preregArtifact = readNamedCanonical({
    root: repoRoot,
    ref: input.preregistrationPath,
    schema: PolicyMeasurementPreregistrationSchema,
    code: "preregistration-mismatch",
    privateMode: false,
  });
  const prereg = preregArtifact.value;
  const sourceHead = verifySource(repoRoot, prereg, preregArtifact);
  if (prereg.catalog_version !== POLICY_CATALOG_VERSION) {
    authority("catalog-mismatch", "preregistration catalog differs");
  }
  const registeredCorpusCases = verifyCorpus(repoRoot, prereg);

  const benchArtifact = readNamedCanonical({
    root: repoRoot,
    ref: input.benchBundlePath,
    schema: PolicyBenchBundleSchema,
    code: "bench-profile-mismatch",
    privateMode: true,
  });
  if (
    input.benchBundlePath !== prereg.outputs.bench_bundle ||
    benchArtifact.value.preregistration.ref !== input.preregistrationPath ||
    benchArtifact.value.preregistration.sha256 !== preregArtifact.sha256
  ) {
    authority("preregistration-mismatch", "Bench bundle binds another preregistration");
  }
  const artifactRoot = resolve(repoRoot, prereg.outputs.attempt_dir);
  const verifiedBundle = verifyPolicyBenchBundleArtifacts(artifactRoot, benchArtifact.value);
  if (!verifiedBundle.ok) {
    authority(
      verifiedBundle.reason.includes("trace") ? "trace-mismatch" : "response-pair-mismatch",
      verifiedBundle.reason,
    );
  }

  const inventory = new Map<string, Binding>();
  const generatedBoundaries = new Set<string>([prereg.outputs.attempt_dir]);
  const policyConfig = policyBenchEffectiveConfiguration(prereg);
  if (policyConfig === null) {
    authority("bench-profile-mismatch", "preregistration cannot derive a Bench configuration");
  }
  addInventory(inventory, { ref: preregArtifact.ref, sha256: preregArtifact.sha256 });
  addInventory(inventory, { ref: benchArtifact.ref, sha256: benchArtifact.sha256 });
  let runnerSha256: string | null = null;
  const profiles = verifiedBundle.profiles.map((profile) => {
    runnerSha256 = verifyBenchProvenance({
      profile,
      prereg,
      preregSha256: preregArtifact.sha256,
      sourceHead,
      runnerSha256,
    });
    const artifact = repoRelativeBinding(repoRoot, artifactRoot, profile.profile.binding);
    addInventory(inventory, artifact);
    const rawBindings = new Map<string, Binding>([[artifact.ref, artifact]]);
    const cases: CaseResult[] = [];
    for (const repeat of profile.repeats) {
      verifyBenchCorpusIdentity({
        profileId: profile.id,
        repeat: repeat.authority.repeat,
        cases: repeat.repeat_result.value.cases,
        registered: registeredCorpusCases,
        config: policyConfig,
      });
      for (const verified of [
        repeat.response_manifest,
        repeat.repeat_result,
        repeat.source_result,
        repeat.trace_set,
        ...repeat.traces,
      ]) {
        const binding = repoRelativeBinding(repoRoot, artifactRoot, verified.binding);
        addInventory(inventory, binding);
        rawBindings.set(binding.ref, binding);
      }
      cases.push(...repeat.repeat_result.value.cases);
    }
    return {
      id: profile.id,
      ablated_pass_ids: profile.ablated_pass_ids,
      artifact,
      data: profile.profile.value,
      cases,
      rawBindings: [...rawBindings.values()].sort((left, right) =>
        compareCodeUnits(left.ref, right.ref),
      ),
    };
  });

  const rigNamed = readNamedCanonical({
    root: repoRoot,
    ref: input.rigManifestPath,
    schema: PolicyRigScenarioManifestSchema,
    code: "rig-state-mismatch",
    privateMode: true,
  });
  if (
    input.rigManifestPath !== prereg.stateful.manifest_ref ||
    rigNamed.sha256 !== prereg.stateful.manifest_sha256
  ) {
    authority("rig-state-mismatch", "Rig scenario manifest differs from preregistration");
  }
  let rig: PolicyRigEvidence;
  try {
    rig = await collectPolicyRigEvidence({
      preregistration: prereg,
      manifest: rigNamed.value,
      sourceRepoRoot: repoRoot,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Rig evidence collection failed";
    authority(
      /(?:state|digest|snapshot)/i.test(message) ? "rig-state-mismatch" : "rig-not-authoritative",
      message,
    );
  }
  if (!rig.authoritative) authority("rig-not-authoritative", "Rig evidence is not authoritative");
  if (rig.source_commit !== sourceHead) {
    authority("rig-not-authoritative", "Rig replay source commit differs from registered HEAD");
  }
  for (const artifact of rig.artifacts) {
    addInventory(inventory, artifact);
    generatedBoundaries.add(generatedBoundary(artifact.ref));
  }

  const dogfoodManifest = verifyCanonicalJsonArtifact({
    root: repoRoot,
    directory: "policy-dogfood-input",
    schema: PolicyDogfoodInputManifestSchema,
    ref: prereg.dogfood.input_manifest_ref,
    sha256: prereg.dogfood.input_manifest_sha256,
    maxBytes: 1_048_576,
  });
  const dogfoodAttestation = verifyCanonicalJsonArtifact({
    root: repoRoot,
    directory: "policy-dogfood-attestation",
    schema: PolicyDogfoodAttestationSchema,
    ref: prereg.dogfood.attestation_ref,
    sha256: prereg.dogfood.attestation_sha256,
    maxBytes: 1_048_576,
  });
  if (!dogfoodManifest.ok || !dogfoodAttestation.ok) {
    authority("dogfood-mismatch", "frozen dogfood manifest or attestation is invalid");
  }
  let dogfood: PolicyDogfoodSnapshot;
  try {
    dogfood = harvestPolicyDogfood({
      preregistration: prereg,
      inputManifest: dogfoodManifest.value,
      attestation: dogfoodAttestation.value,
      artifactRoot: repoRoot,
      sourceRoot: repoRoot,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "frozen dogfood harvest failed";
    authority("dogfood-mismatch", message);
  }
  if (
    (dogfood.exclusions["changed-source-file"] ?? 0) > 0 ||
    (dogfood.exclusions["malformed-chain"] ?? 0) > 0 ||
    (dogfood.exclusions["attestation-input-manifest-mismatch"] ?? 0) > 0
  ) {
    authority("dogfood-mismatch", "frozen dogfood source authority failed");
  }
  addInventory(inventory, dogfood.input_manifest);
  addInventory(inventory, dogfood.attestation);
  generatedBoundaries.add(generatedBoundary(dogfood.input_manifest.ref));
  generatedBoundaries.add(generatedBoundary(dogfood.attestation.ref));
  for (const entry of dogfoodManifest.value.entries) {
    addInventory(inventory, entry);
    generatedBoundaries.add(generatedBoundary(entry.ref));
  }

  if (profiles.length !== 23) authority("partial-inventory", "Bench profile inventory is partial");
  const baselineProfile = profiles[0];
  if (baselineProfile === undefined) authority("partial-inventory", "Bench baseline is absent");
  const baselineCases = baselineProfile.cases;
  const interactions = POLICY_MEASUREMENT_INTERACTIONS.map((passIds, index) => {
    const profile = profiles[POLICY_PASS_IDS.length + 1 + index];
    if (profile === undefined) authority("partial-inventory", `interaction ${index + 1} absent`);
    const bench = evidenceForInteraction({
      binding: profile.artifact,
      bindings: profile.rawBindings,
      passIds,
      baseline: baselineCases,
      ablated: profile.cases,
      seed: prereg.analysis.seed + index,
    });
    const rigArtifact = { ref: rigNamed.ref, sha256: rigNamed.sha256 };
    const rigInteraction =
      index === 2
        ? evidenceForRigInteraction({
            binding: rigArtifact,
            rig,
            rigBindings: rig.artifacts,
            seed: prereg.analysis.seed + index,
          })
        : undefined;
    return {
      pass_ids: [...passIds],
      artifact: rigInteraction === undefined ? profile.artifact : rigArtifact,
      primary_lane:
        rigInteraction === undefined ? ("stateless-bench" as const) : ("stateful-rig" as const),
      evidence: rigInteraction?.evidence ?? bench.evidence,
      lane_summaries: [
        laneSummary({
          lane: "stateless-bench",
          primary: rigInteraction === undefined,
          opportunities: bench.evidence.opportunities,
          exclusions: bench.evidence.exclusions,
          truthEffects: bench.evidence.truth_effects,
          traceTotals: bench.traceTotals,
          statistics: bench.evidence.statistics,
          rawEvidenceRefs: bench.evidence.raw_evidence_refs,
        }),
        ...(rigInteraction === undefined
          ? []
          : [
              laneSummary({
                lane: "stateful-rig",
                primary: true,
                opportunities: rigInteraction.evidence.opportunities,
                exclusions: rigInteraction.evidence.exclusions,
                truthEffects: rigInteraction.evidence.truth_effects,
                traceTotals: rigInteraction.traceTotals,
                statistics: rigInteraction.evidence.statistics,
                rawEvidenceRefs: rigInteraction.evidence.raw_evidence_refs,
              }),
            ]),
      ],
    };
  });

  const analyses = POLICY_PASS_IDS.map((passId, index) => {
    const dogfoodEvidence = dogfoodForPass({
      passId,
      snapshot: dogfood,
      manifest: dogfoodManifest.value,
      manifestBinding: dogfood.input_manifest,
      attestationBinding: dogfood.attestation,
    });
    const interactionRefs = interactions
      .filter((row) => row.pass_ids.some((candidate) => candidate === passId))
      .flatMap((row) => [
        row.artifact.ref,
        ...row.evidence.raw_evidence_refs,
        ...row.lane_summaries.flatMap((summary) => summary.raw_evidence_refs),
      ]);
    const interactionBindings = [...new Set(interactionRefs)].map((ref) => {
      const bound = inventory.get(ref);
      if (bound === undefined) authority("partial-inventory", `interaction ref is absent: ${ref}`);
      return bound;
    });
    const profile = profiles[index + 1];
    if (profile === undefined) authority("partial-inventory", `singleton ${passId} absent`);
    const bench = analyzeBenchProfile({
      passId,
      baseline: baselineCases,
      ablated: profile.cases,
      profileBinding: profile.artifact,
      profileBindings: profile.rawBindings,
      interactionBindings,
      dogfood: dogfoodEvidence,
      dogfoodSnapshot: dogfood,
      seed: prereg.analysis.seed + index,
    });
    const rigAnalysis =
      POLICY_MEASUREMENT_LANES[passId] === "stateful-rig"
        ? analyzeRigPass({
            passId,
            rig,
            scenarioBinding: { ref: rigNamed.ref, sha256: rigNamed.sha256 },
            rigBindings: rig.artifacts,
            interactionBindings,
            dogfood: dogfoodEvidence,
            dogfoodSnapshot: dogfood,
            seed: prereg.analysis.seed + index,
          })
        : undefined;
    const primary = rigAnalysis ?? bench;
    primary.evidence.lane_summaries = [
      bench.laneSummary,
      ...(rigAnalysis === undefined ? [] : [rigAnalysis.laneSummary]),
      dogfoodLaneSummary({
        dogfood: dogfoodEvidence,
        snapshot: dogfood,
        seed: prereg.analysis.seed + index,
      }),
    ];
    primary.evidence.raw_evidence_refs = [
      ...new Set([
        ...primary.evidence.lane_summaries.flatMap((summary) => summary.raw_evidence_refs),
        ...interactionRefs,
      ]),
    ].sort(compareCodeUnits);
    return primary;
  });
  const adjusted = holmAdjustPolicyFamilies({
    singleton: analyses.map((row) => row.evidence.statistics.p_value),
    interaction: interactions.map((row) => row.evidence.statistics.p_value),
  });
  if (
    adjusted.singleton.length !== POLICY_PASS_IDS.length ||
    adjusted.interaction.length !== POLICY_MEASUREMENT_INTERACTIONS.length
  ) {
    authority("correction-mismatch", "Holm families must remain separate at 18 and 4 rows");
  }
  for (const [index, analysis] of analyses.entries()) {
    analysis.evidence.statistics.adjusted_p_value = adjusted.singleton[index] ?? 1;
  }
  for (const [index, interaction] of interactions.entries()) {
    interaction.evidence.statistics.adjusted_p_value = adjusted.interaction[index] ?? 1;
  }
  for (const analysis of analyses) {
    const pass = POLICY_PASSES.find((candidate) => candidate.id === analysis.facts.pass_id);
    if (pass === undefined) authority("catalog-mismatch", `unknown pass ${analysis.facts.pass_id}`);
    analysis.facts = {
      ...analysis.facts,
      beneficial_effects: analysis.facts.beneficial_effects.map((benefit) => ({
        ...benefit,
        reproduced_by_pass_ids: analyses
          .filter(
            (candidate) =>
              candidate.facts.pass_id !== analysis.facts.pass_id &&
              (pass.overlaps_with as readonly PolicyPassId[]).includes(candidate.facts.pass_id) &&
              candidate.facts.beneficial_effects.some(
                (candidateBenefit) => candidateBenefit.identity === benefit.identity,
              ),
          )
          .map((candidate) => candidate.facts.pass_id)
          .sort(compareCodeUnits),
      })),
    };
    analysis.evidence.unique_contributions = analysis.facts.beneficial_effects
      .filter((benefit) => benefit.reproduced_by_pass_ids.length === 0)
      .map((benefit) => ({
        kind: benefit.identity.includes(":blocking-fp:")
          ? ("prevented-blocking-fp" as const)
          : benefit.identity.includes(":blocking-fn:")
            ? ("preserved-blocking-tp" as const)
            : authority(
                "bench-profile-mismatch",
                `unknown Bench error identity: ${benefit.identity}`,
              ),
        evidence: {
          ref: benefit.evidence_ref,
          sha256:
            inventory.get(benefit.evidence_ref)?.sha256 ??
            authority(
              "partial-inventory",
              `unique contribution ref is absent: ${benefit.evidence_ref}`,
            ),
        },
      }));
  }
  const passes = classifyPolicyPasses(
    analyses.map((row) => row.evidence),
    { passFacts: analyses.map((row) => row.facts), interactions },
  );

  for (const row of [
    ...passes.map((pass) => ({
      evidence: pass.evidence,
      laneSummaries: pass.evidence.lane_summaries,
    })),
    ...interactions.map((interaction) => ({
      evidence: interaction.evidence,
      laneSummaries: interaction.lane_summaries,
    })),
  ]) {
    for (const ref of [
      ...row.evidence.raw_evidence_refs,
      ...row.laneSummaries.flatMap((summary) => summary.raw_evidence_refs),
    ]) {
      if (!inventory.has(ref)) authority("partial-inventory", `raw evidence ref is absent: ${ref}`);
    }
  }
  const inventoryRows = [...inventory.values()].sort((left, right) =>
    compareCodeUnits(left.ref, right.ref),
  );
  verifyClosedUntrackedInputs(repoRoot, inventoryRows, generatedBoundaries);
  const parsedResult = PolicyMeasurementSchema.safeParse({
    schema: "reviewgate.policy-measurement.v1",
    preregistration: { ref: preregArtifact.ref, sha256: preregArtifact.sha256 },
    catalog_version: POLICY_CATALOG_VERSION,
    passes,
    interactions,
    identity_evidence: analyses.map((row) => row.facts),
    artifacts: {
      authoritative: true,
      sources: inventoryRows,
      exclusions: [],
      evidence: [
        ...profiles.slice(1).map((profile) => profile.artifact),
        { ref: rigNamed.ref, sha256: rigNamed.sha256 },
        dogfood.input_manifest,
      ],
      inventory: inventoryRows,
    },
  });
  if (!parsedResult.success) {
    const issue = parsedResult.error.issues[0];
    authority(
      "partial-inventory",
      `assembled result failed the final authority schema${issue === undefined ? "" : ` at ${issue.path.join(".")}: ${issue.message}`}`,
    );
  }
  const result = parsedResult.data;
  const rigKinds = new Map(rig.artifacts.map((artifact) => [artifact.ref, artifact.kind] as const));
  const dogfoodKinds = new Map(
    dogfoodManifest.value.entries.map((entry) => [
      entry.ref,
      entry.kind === "trace" ? ("trace" as const) : ("dogfood" as const),
    ]),
  );
  const sources: CanonicalSourceArtifact[] = inventoryRows.map((row) => {
    const kind =
      row.ref === preregArtifact.ref
        ? "preregistration"
        : rigKinds.has(row.ref)
          ? (rigKinds.get(row.ref) ?? "rig")
          : (dogfoodKinds.get(row.ref) ??
            (row.ref === dogfood.input_manifest.ref || row.ref === dogfood.attestation.ref
              ? "dogfood"
              : row.ref.includes("policy-traces/")
                ? "trace"
                : "bench"));
    // Authoritative production paths have already been verified above. The test
    // assembly harness intentionally virtualizes some files, so only a real
    // directory changes the publication representation here.
    let material: CanonicalSourceArtifact["material"] = "file";
    try {
      const stat = lstatSync(resolve(repoRoot, ...row.ref.split("/")));
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
        authority(
          "artifact-ref-invalid",
          `publication source is not a regular file/tree: ${row.ref}`,
        );
      }
      if (stat.isDirectory()) {
        if (kind !== "state") {
          authority(
            "artifact-ref-invalid",
            `non-state publication source is a directory: ${row.ref}`,
          );
        }
        material = "state-tree";
      }
    } catch (error) {
      if (error instanceof PolicyMeasurementAuthorityError) throw error;
    }
    return { kind, ...row, material };
  });
  return { result, sources, publication: { rig_bundle: rig, dogfood_snapshot: dogfood } };
}
