import { createHash } from "node:crypto";
// src/cli/commands/stats.ts
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
  verifyCanonicalJsonArtifact,
  verifyNamedCanonicalJsonBytes,
  verifyNamedTextBytes,
  verifyUnboundNamedCanonicalJsonBytes,
  writeCanonicalJsonArtifact,
} from "../../artifacts/canonical-json.ts";
import { canonicalJson } from "../../audit/canonical.ts";
import { BrainStore } from "../../core/brain/store.ts";
import { FpLedgerStore } from "../../core/fp-ledger/store.ts";
import {
  type PolicyMeasurementPreregistration,
  PolicyMeasurementPreregistrationSchema,
} from "../../schemas/policy-measurement-preregistration.ts";
import {
  PolicyDogfoodAdjudicationSchema,
  PolicyDogfoodAttestationSchema,
  PolicyDogfoodInputManifestSchema,
  PolicyMeasurementSchema,
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
import { renderPolicyMeasurement } from "../../stats/policy/render.ts";
import { renderStats } from "../../stats/render.ts";
import { writeFileIfAbsent } from "../../utils/atomic-write.ts";

const MAX_POLICY_SOURCE_BYTES = 128 * 1024 * 1024;
const PolicyMeasurementCompleteSchema = z
  .object({
    schema: z.literal("reviewgate.policy-measurement-complete.v1"),
    result: z
      .object({ ref: z.literal("result.json"), sha256: z.string().regex(/^[0-9a-f]{64}$/) })
      .strict(),
    report: z
      .object({ ref: z.literal("report.md"), sha256: z.string().regex(/^[0-9a-f]{64}$/) })
      .strict(),
    sources: z
      .array(
        z.object({ ref: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
      )
      .min(1),
  })
  .strict();

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

function ensurePrivateDirectory(root: string, target: string): void {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  if (!contained(resolvedRoot, resolvedTarget)) {
    policyAuthority("artifact-ref-invalid", "policy output escapes the repository root");
  }
  let cursor = resolvedRoot;
  try {
    const rootStat = lstatSync(cursor);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("unsafe root");
    const suffix = relative(resolvedRoot, resolvedTarget).split(sep).filter(Boolean);
    for (const component of suffix) {
      cursor = join(cursor, component);
      if (!existsSync(cursor)) mkdirSync(cursor, { mode: 0o700 });
      const stat = lstatSync(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe directory");
    }
  } catch {
    policyAuthority("artifact-ref-invalid", "policy output directory is unsafe");
  }
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
  const report = verifyNamedTextBytes({
    root: output,
    ref: marker.value.report.ref,
    sha256: marker.value.report.sha256,
    maxBytes: MAX_POLICY_SOURCE_BYTES,
    privateMode: true,
  });
  if (!report.ok || marker.value.sources.length !== result.value.artifacts.inventory.length)
    return false;
  return marker.value.sources.every((source, index) => {
    const inventory = result.value.artifacts.inventory[index];
    return (
      source.ref === inventory?.ref &&
      source.sha256 === inventory.sha256 &&
      verifyCanonicalJsonArtifact({
        root: output,
        directory: "policy-measurement-sources",
        schema: z.unknown(),
        ref: `artifacts/policy-measurement-sources/${source.sha256}.json`,
        sha256: source.sha256,
        maxBytes: MAX_POLICY_SOURCE_BYTES,
      }).ok
    );
  });
}

function verifyPublishedPolicyBundleWithoutMarker(
  output: string,
  resultSha256: string,
  reportSha256: string,
  sources: readonly { ref: string; sha256: string }[],
): boolean {
  const result = verifyNamedCanonicalJsonBytes({
    root: output,
    ref: "result.json",
    sha256: resultSha256,
    schema: PolicyMeasurementSchema,
    maxBytes: MAX_POLICY_SOURCE_BYTES,
    privateMode: true,
  });
  const report = verifyNamedTextBytes({
    root: output,
    ref: "report.md",
    sha256: reportSha256,
    maxBytes: MAX_POLICY_SOURCE_BYTES,
    privateMode: true,
  });
  if (!result.ok || !report.ok) return false;
  return sources.every(
    (source) =>
      verifyCanonicalJsonArtifact({
        root: output,
        directory: "policy-measurement-sources",
        schema: z.unknown(),
        ref: `artifacts/policy-measurement-sources/${source.sha256}.json`,
        sha256: source.sha256,
        maxBytes: MAX_POLICY_SOURCE_BYTES,
      }).ok,
  );
}

/** Assemble first, then copy the already-authoritative sources into one immutable output bundle. */
async function runPolicyStatsWithRuntime(
  input: RunPolicyStatsInput,
  runtime: PolicyStatsRuntime,
): Promise<RunPolicyStatsOutput> {
  const repoRoot = resolve(input.repoRoot);
  const output = resolve(repoRoot, input.out);
  if (!contained(repoRoot, output)) {
    return {
      exitCode: 4,
      stdout: "",
      stderr:
        "policy measurement: artifact-ref-invalid — policy output escapes the repository root\n",
    };
  }
  if (existsSync(output)) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `stats policy: output already exists (immutable): ${output}\n`,
    };
  }
  const parent = dirname(output);
  const prefix = `.${basename(output)}.staging-`;
  let stage: string | undefined;
  let stageIdentity: ReservedOutput | undefined;
  let reservation: ReservedOutput | undefined;
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
    if (
      resolve(repoRoot, prereg.outputs.attempt_dir) !== output ||
      resolve(repoRoot, prereg.outputs.result_json) !== join(output, "result.json") ||
      resolve(repoRoot, prereg.outputs.report_md) !== join(output, "report.md")
    ) {
      policyAuthority(
        "preregistration-mismatch",
        "policy output paths differ from preregistration",
      );
    }
    ensurePrivateDirectory(repoRoot, parent);
    stage = join(parent, `${prefix}${process.pid}-${Math.random().toString(36).slice(2, 10)}`);
    mkdirSync(stage, { mode: 0o700 });
    const stageStat = lstatSync(stage);
    if (!stageStat.isDirectory() || stageStat.isSymbolicLink()) {
      policyAuthority("artifact-ref-invalid", "policy staging directory is unsafe");
    }
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
    for (const source of assembled.sources) {
      // This is a publication-only reread. Classification has already completed above.
      const verified = verifyNamedCanonicalJsonBytes({
        root: repoRoot,
        ref: source.ref,
        sha256: source.sha256,
        schema: z.unknown(),
        maxBytes: MAX_POLICY_SOURCE_BYTES,
        privateMode: source.kind !== "preregistration",
      });
      if (!verified.ok)
        policyAuthority(
          "artifact-ref-invalid",
          `cannot reverify source ${source.ref}: ${verified.reason}`,
        );
      const copied = writeCanonicalJsonArtifact({
        root: stage,
        directory: "policy-measurement-sources",
        schema: z.unknown(),
        value: verified.value,
        maxBytes: MAX_POLICY_SOURCE_BYTES,
      });
      if (!copied.ok || copied.sha256 !== source.sha256) {
        policyAuthority("artifact-ref-invalid", `cannot publish source ${source.ref}`);
      }
      const checked = verifyCanonicalJsonArtifact({
        root: stage,
        directory: "policy-measurement-sources",
        schema: z.unknown(),
        ref: copied.ref,
        sha256: copied.sha256,
        maxBytes: MAX_POLICY_SOURCE_BYTES,
      });
      if (!checked.ok)
        policyAuthority("artifact-ref-invalid", `cannot reverify staged source ${source.ref}`);
    }
    const resultText = canonicalJson(result);
    const reportText = renderPolicyMeasurement(result);
    const resultPath = join(stage, "result.json");
    const reportPath = join(stage, "report.md");
    if (
      !writeFileIfAbsent(resultPath, resultText, { mode: 0o600 }) ||
      !verifyNamedCanonicalJsonBytes({
        root: stage,
        ref: "result.json",
        sha256: sha256(resultText),
        schema: PolicyMeasurementSchema,
        maxBytes: MAX_POLICY_SOURCE_BYTES,
        privateMode: true,
      }).ok
    ) {
      policyAuthority("artifact-ref-invalid", "cannot publish result.json");
    }
    if (
      !writeFileIfAbsent(reportPath, reportText, { mode: 0o600 }) ||
      !verifyNamedTextBytes({
        root: stage,
        ref: "report.md",
        sha256: sha256(reportText),
        maxBytes: MAX_POLICY_SOURCE_BYTES,
        privateMode: true,
      }).ok
    ) {
      policyAuthority("artifact-ref-invalid", "cannot publish report.md");
    }
    runtime.beforeRename?.(stage, output);
    reservation = reserveOutput(output, parent);
    if (reservation === undefined) {
      safeRemoveStage(stage, parent, prefix, stageIdentity);
      stage = undefined;
      return {
        exitCode: 2,
        stdout: "",
        stderr: `stats policy: output already exists (immutable): ${output}\n`,
      };
    }
    renameSync(join(stage, "artifacts"), join(output, "artifacts"));
    renameSync(resultPath, join(output, "result.json"));
    renameSync(reportPath, join(output, "report.md"));
    safeRemoveStage(stage, parent, prefix, stageIdentity);
    stage = undefined;
    if (
      !verifyPublishedPolicyBundleWithoutMarker(
        output,
        sha256(resultText),
        sha256(reportText),
        result.artifacts.inventory,
      )
    ) {
      policyAuthority("artifact-ref-invalid", "published policy bundle failed final verification");
    }
    runtime.beforeComplete?.(output);
    const completeText = canonicalJson({
      schema: "reviewgate.policy-measurement-complete.v1",
      result: { ref: "result.json", sha256: sha256(resultText) },
      report: { ref: "report.md", sha256: sha256(reportText) },
      sources: result.artifacts.inventory,
    });
    if (!writeFileIfAbsent(join(output, "complete.json"), completeText, { mode: 0o600 })) {
      policyAuthority("artifact-ref-invalid", "policy completion marker already exists");
    }
    if (!verifyPublishedPolicyBundle(output)) {
      policyAuthority("artifact-ref-invalid", "policy completion marker is invalid");
    }
    reservation = undefined;
    return { exitCode: 0, stdout: `${reportText}`, stderr: "" };
  } catch (error) {
    if (stage !== undefined && stageIdentity !== undefined)
      safeRemoveStage(stage, parent, prefix, stageIdentity);
    if (reservation !== undefined) safeRemoveReservedOutput(output, parent, reservation);
    if (error instanceof PolicyMeasurementAuthorityError) {
      return { exitCode: 4, stdout: "", stderr: `${error.message}\n` };
    }
    throw error;
  }
}

export async function runPolicyStats(input: RunPolicyStatsInput): Promise<RunPolicyStatsOutput> {
  return runPolicyStatsWithRuntime(input, { assemble: assemblePolicyMeasurement });
}

export const __policyStatsTest = {
  run: runPolicyStatsWithRuntime,
  verifyPublishedPolicyBundle,
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
