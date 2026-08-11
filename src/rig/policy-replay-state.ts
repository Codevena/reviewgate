import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { canonicalJson } from "../audit/canonical.ts";
import { POLICY_CATALOG_VERSION } from "../core/policy/catalog.ts";
import { verifyPolicyReplayEnvelope } from "../core/policy/replay-capture.ts";
import { CassetteEntrySchema } from "../schemas/cassette.ts";
import type { PolicyReplayEnvelope } from "../schemas/policy-replay.ts";
import type { RigManifest } from "../schemas/rig-manifest.ts";
import { writeFileIfAbsent } from "../utils/atomic-write.ts";

const STATE_MAX_FILE_BYTES = 8 * 1024 * 1024;
const STATE_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const STATE_MAX_FILES = 10_000;
const CASSETTE_MAX_BYTES = 64 * 1024 * 1024;
const STATE_MANIFEST_REF = /^policy-state\/[0-9a-f]{64}\.json$/;
const STATE_TREE_REF = /^policy-state\/[0-9a-f]{64}\/\.reviewgate$/;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

interface StateEntry {
  path: string;
  size: number;
  sha256: string;
  bytes: Buffer;
}

const PolicyStateManifestSchema = z
  .object({
    schema: z.literal("reviewgate.policy-state-snapshot.v1"),
    catalog_version: z.literal(POLICY_CATALOG_VERSION),
    state_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    files: z.array(
      z
        .object({
          path: z.string().min(1),
          size: z.number().int().nonnegative(),
          sha256: z.string().regex(/^[0-9a-f]{64}$/),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (let index = 0; index < value.files.length; index += 1) {
      const entry = value.files[index];
      try {
        validateRelativeStatePath(entry?.path ?? "");
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["files", index, "path"],
          message: "invalid state path",
        });
      }
      if (index > 0 && (value.files[index - 1]?.path ?? "") >= (entry?.path ?? "")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["files", index, "path"],
          message: "state paths must be uniquely sorted",
        });
      }
    }
  });

type PolicyStateManifest = z.infer<typeof PolicyStateManifestSchema>;

export interface PolicyStateSnapshot {
  ref: string;
  sha256: string;
  stateRef: string;
  stateSha256: string;
}

export interface ReplayBranch {
  checkoutRoot: string;
  startingStateSha256: string;
}

export interface ReplayBranches {
  root: string;
  baseline: ReplayBranch;
  counterfactual: ReplayBranch;
}

export type RigAuthorityInvalidity =
  | "missing-trace"
  | "trace-status"
  | "trace-overflow"
  | "non-canonical-trace"
  | "invalid-trace"
  | "lossy-trace"
  | "catalog-mismatch"
  | "source-commit-mismatch"
  | "state-digest-mismatch"
  | "response-hash-mismatch"
  | "missing-cassette"
  | "cassette-hash-mismatch"
  | "invalid-cassette"
  | "source-state-alias"
  | "live-provider-call";

export class RigAuthorityError extends Error {
  readonly exitCode = 4;

  constructor(
    readonly code: RigAuthorityInvalidity,
    message: string,
  ) {
    super(`rig policy replay invalid (${code}): ${message}`);
    this.name = "RigAuthorityError";
  }
}

export interface ValidatedRigPolicyReplay {
  sourceCommit: string;
  initialStateRoot: string;
  initialStateSha256: string;
  cassettePath: string;
  turns: Map<
    number,
    Array<{ ref: string; sha256: string; envelope: PolicyReplayEnvelope; stateRoot: string }>
  >;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function validateRelativeStatePath(value: string): void {
  if (
    value.length === 0 ||
    value.includes("\\") ||
    value.includes("\0") ||
    isAbsolute(value) ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`invalid policy state path: ${value}`);
  }
}

function readStableFile(
  path: string,
  maxBytes = STATE_MAX_FILE_BYTES,
  requireMode0600 = false,
): Buffer {
  const before = lstatSync(path);
  if (before.isSymbolicLink()) throw new Error(`policy state contains symlink: ${path}`);
  if (!before.isFile()) throw new Error(`policy state contains special file: ${path}`);
  if (before.nlink !== 1) throw new Error(`policy state contains hardlink: ${path}`);
  if (requireMode0600 && (before.mode & 0o7777) !== 0o600) {
    throw new Error(`policy artifact mode is not 0600: ${path}`);
  }
  if (before.size > maxBytes) throw new Error(`policy artifact exceeds limit: ${path}`);
  const realBefore = realpathSync(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      (requireMode0600 && (opened.mode & 0o7777) !== 0o600)
    ) {
      throw new Error(`policy state contains non-regular file: ${path}`);
    }
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error(`policy state changed while opening: ${path}`);
    }
    const bytes = readFileSync(fd);
    if (bytes.length !== opened.size || bytes.length > maxBytes) {
      throw new Error(`policy state changed while reading: ${path}`);
    }
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
      (requireMode0600 && (pathAfter.mode & 0o7777) !== 0o600) ||
      pathAfter.dev !== after.dev ||
      pathAfter.ino !== after.ino ||
      realpathSync(path) !== realBefore
    ) {
      throw new Error(`policy state changed while reading: ${path}`);
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function collectStateEntries(stateRoot: string): StateEntry[] {
  const rootStat = lstatSync(stateRoot);
  if (rootStat.isSymbolicLink()) throw new Error(`policy state root is a symlink: ${stateRoot}`);
  if (!rootStat.isDirectory())
    throw new Error(`policy state root is not a directory: ${stateRoot}`);
  const rootReal = realpathSync(stateRoot);
  const entries: StateEntry[] = [];
  let totalBytes = 0;

  const visit = (directory: string): void => {
    const directoryStat = lstatSync(directory);
    if (directoryStat.isSymbolicLink())
      throw new Error(`policy state contains symlink: ${directory}`);
    if (!directoryStat.isDirectory()) {
      throw new Error(`policy state contains special directory entry: ${directory}`);
    }
    const directoryReal = realpathSync(directory);
    if (!isContained(rootReal, directoryReal)) {
      throw new Error(`policy state directory escapes root: ${directory}`);
    }
    const names = readdirSync(directory).sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`policy state contains symlink: ${path}`);
      if (stat.isDirectory()) {
        visit(path);
        continue;
      }
      if (!stat.isFile()) throw new Error(`policy state contains special file: ${path}`);
      const rel = relative(rootReal, realpathSync(path)).split(sep).join("/");
      validateRelativeStatePath(rel);
      const bytes = readStableFile(path);
      totalBytes += bytes.length;
      if (entries.length + 1 > STATE_MAX_FILES) throw new Error("policy state exceeds file limit");
      if (totalBytes > STATE_MAX_TOTAL_BYTES) throw new Error("policy state exceeds byte limit");
      entries.push({ path: rel, size: bytes.length, sha256: sha256(bytes), bytes });
    }
  };

  visit(rootReal);
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

function stateDigest(entries: StateEntry[]): string {
  return sha256(
    canonicalJson(
      entries.map(({ path, size, sha256: contentSha256 }) => ({
        path,
        size,
        sha256: contentSha256,
      })),
    ),
  );
}

export function digestPolicyState(stateRoot: string): string {
  return stateDigest(collectStateEntries(stateRoot));
}

function exactDirectory(path: string): string {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`expected an ordinary directory: ${path}`);
  }
  return realpathSync(path);
}

function copyEntries(entries: StateEntry[], destinationRoot: string): void {
  mkdirSync(destinationRoot, { recursive: true, mode: 0o700 });
  const destinationReal = realpathSync(destinationRoot);
  for (const entry of entries) {
    validateRelativeStatePath(entry.path);
    const destination = resolve(destinationReal, entry.path);
    if (!isContained(destinationReal, destination)) {
      throw new Error(`policy state copy escapes destination: ${entry.path}`);
    }
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(destination, entry.bytes, { flag: "wx", mode: 0o600 });
    const copied = lstatSync(destination);
    if (!copied.isFile() || copied.isSymbolicLink() || copied.nlink !== 1) {
      throw new Error(`policy state copy did not produce a private file: ${entry.path}`);
    }
  }
}

function sameStateEntry(left: StateEntry | undefined, right: StateEntry | undefined): boolean {
  return left?.path === right?.path && left?.size === right?.size && left?.sha256 === right?.sha256;
}

/**
 * Apply the recorded production-state transition without erasing branch-local writes.
 *
 * This is a file-level three-way merge: previous capture is the base, next capture supplies
 * exogenous production changes, and a branch-local change wins a same-file conflict. Store APIs
 * still own the bytes and schema; replay does not model or reinterpret any learning format.
 */
function advanceBranchState(input: {
  checkoutRoot: string;
  previousStateSnapshotRoot: string;
  nextStateSnapshotRoot: string;
}): void {
  const previous = new Map(
    collectStateEntries(input.previousStateSnapshotRoot).map((entry) => [entry.path, entry]),
  );
  const next = new Map(
    collectStateEntries(input.nextStateSnapshotRoot).map((entry) => [entry.path, entry]),
  );
  const branchStateRoot = join(input.checkoutRoot, ".reviewgate");
  const branch = new Map(collectStateEntries(branchStateRoot).map((entry) => [entry.path, entry]));
  const paths = [...new Set([...previous.keys(), ...next.keys(), ...branch.keys()])].sort((a, b) =>
    a.localeCompare(b),
  );
  const merged: StateEntry[] = [];
  for (const path of paths) {
    const baseEntry = previous.get(path);
    const nextEntry = next.get(path);
    const branchEntry = branch.get(path);
    const branchChanged = !sameStateEntry(branchEntry, baseEntry);
    const productionChanged = !sameStateEntry(nextEntry, baseEntry);
    const selected =
      branchChanged && productionChanged && !sameStateEntry(branchEntry, nextEntry)
        ? branchEntry
        : branchChanged
          ? branchEntry
          : nextEntry;
    if (selected !== undefined) merged.push(selected);
  }
  rmSync(branchStateRoot, { recursive: true, force: true });
  copyEntries(merged, branchStateRoot);
}

function applyReplayDiff(input: {
  checkoutRoot: string;
  replayRoot: string;
  exactDiff: string;
  reverse: boolean;
  label: string;
}): void {
  if (input.exactDiff.length === 0) return;
  const patchPath = join(input.replayRoot, `.${input.label}.patch`);
  writeFileSync(patchPath, input.exactDiff, { flag: "wx", mode: 0o600 });
  try {
    execFileSync(
      "git",
      ["apply", "--whitespace=nowarn", ...(input.reverse ? ["--reverse"] : []), patchPath],
      { cwd: input.checkoutRoot, stdio: "pipe" },
    );
  } finally {
    rmSync(patchPath, { force: true });
  }
}

export function createPolicyStateSnapshot(input: {
  sourceRepoRoot: string;
  outputRoot: string;
}): PolicyStateSnapshot {
  const repoReal = exactDirectory(input.sourceRepoRoot);
  const outputReal = exactDirectory(input.outputRoot);
  if (isContained(repoReal, outputReal) || isContained(outputReal, repoReal)) {
    throw new Error("policy state output must be separate from the measured repository");
  }
  const sourceState = join(repoReal, ".reviewgate");
  const entries = collectStateEntries(sourceState);
  const stateSha256 = stateDigest(entries);
  const stateRef = `policy-state/${stateSha256}/.reviewgate`;
  if (!STATE_TREE_REF.test(stateRef)) throw new Error("invalid policy state reference");
  const stateDestination = resolve(outputReal, stateRef);
  if (!isContained(outputReal, stateDestination))
    throw new Error("policy state output escapes root");
  if (!existsSync(stateDestination)) copyEntries(entries, stateDestination);
  if (digestPolicyState(stateDestination) !== stateSha256) {
    throw new Error("policy state snapshot digest mismatch");
  }

  const manifest: PolicyStateManifest = {
    schema: "reviewgate.policy-state-snapshot.v1",
    catalog_version: POLICY_CATALOG_VERSION,
    state_sha256: stateSha256,
    files: entries.map(({ path, size, sha256: contentSha256 }) => ({
      path,
      size,
      sha256: contentSha256,
    })),
  };
  const bytes = canonicalJson(manifest);
  const manifestSha256 = sha256(bytes);
  const ref = `policy-state/${manifestSha256}.json`;
  if (!STATE_MANIFEST_REF.test(ref)) throw new Error("invalid policy state manifest reference");
  const destination = resolve(outputReal, ref);
  if (!isContained(outputReal, destination)) throw new Error("policy state manifest escapes root");
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  if (!writeFileIfAbsent(destination, bytes, { mode: 0o600 })) {
    const existing = readStableFile(destination, STATE_MAX_FILE_BYTES, true);
    if (!existing.equals(Buffer.from(bytes, "utf8"))) {
      throw new Error("policy state manifest collision");
    }
  }
  return { ref, sha256: manifestSha256, stateRef, stateSha256 };
}

export function verifyPolicyStateSnapshot(input: {
  outputRoot: string;
  ref: string;
  sha256: string;
  expectedStateSha256: string;
}): { stateRoot: string; stateSha256: string } {
  if (
    !STATE_MANIFEST_REF.test(input.ref) ||
    !/^[0-9a-f]{64}$/.test(input.sha256) ||
    !/^[0-9a-f]{64}$/.test(input.expectedStateSha256)
  ) {
    throw new Error("invalid policy state snapshot reference");
  }
  const outputReal = exactDirectory(input.outputRoot);
  const manifestPath = resolve(outputReal, input.ref);
  if (!isContained(outputReal, manifestPath)) throw new Error("policy state manifest escapes root");
  const bytes = readStableFile(manifestPath, STATE_MAX_FILE_BYTES, true);
  if (sha256(bytes) !== input.sha256 || input.ref !== `policy-state/${input.sha256}.json`) {
    throw new Error("policy state manifest hash mismatch");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("policy state manifest has invalid encoding");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new Error("policy state manifest is corrupt");
  }
  const manifest = PolicyStateManifestSchema.parse(decoded);
  if (canonicalJson(manifest) !== text) throw new Error("policy state manifest is non-canonical");
  if (manifest.state_sha256 !== input.expectedStateSha256) {
    throw new Error("policy state manifest digest mismatch");
  }
  const stateRoot = resolve(outputReal, `policy-state/${manifest.state_sha256}/.reviewgate`);
  if (
    !isContained(outputReal, stateRoot) ||
    !STATE_TREE_REF.test(relative(outputReal, stateRoot).split(sep).join("/"))
  ) {
    throw new Error("policy state tree escapes root");
  }
  const entries = collectStateEntries(stateRoot);
  if (stateDigest(entries) !== manifest.state_sha256)
    throw new Error("policy state tree digest mismatch");
  const actualFiles = entries.map(({ path, size, sha256: contentSha256 }) => ({
    path,
    size,
    sha256: contentSha256,
  }));
  if (canonicalJson(actualFiles) !== canonicalJson(manifest.files)) {
    throw new Error("policy state tree does not match manifest");
  }
  return { stateRoot, stateSha256: manifest.state_sha256 };
}

function authority(code: RigAuthorityInvalidity, message: string): never {
  throw new RigAuthorityError(code, message);
}

function responseHashesFromCassette(bytes: Buffer): string[] {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return authority("invalid-cassette", "cassette is not valid UTF-8");
  }
  const hashes: string[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (line.trim().length === 0) continue;
    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch {
      return authority("invalid-cassette", `cassette line ${index + 1} is not JSON`);
    }
    const parsed = CassetteEntrySchema.safeParse(decoded);
    if (!parsed.success) {
      return authority("invalid-cassette", `cassette line ${index + 1} is malformed`);
    }
    const entry = parsed.data;
    let raw: string | undefined;
    if (entry.method === "review" && "rawText" in entry.result) raw = entry.result.rawText;
    if (entry.method === "complete" && "text" in entry.result) raw = entry.result.text;
    if (raw !== undefined) hashes.push(sha256(raw));
  }
  return hashes;
}

/** Validate every artifact before authoritative harvest/replay is allowed to count anything. */
export function validateRigPolicyReplayArtifacts(input: {
  manifest: RigManifest;
  manifestPath: string;
}): ValidatedRigPolicyReplay | null {
  const metadata = input.manifest.policyReplay;
  if (metadata === undefined) return null;
  if (metadata.catalogVersion !== POLICY_CATALOG_VERSION) {
    return authority(
      "catalog-mismatch",
      `recorded ${metadata.catalogVersion}, runtime ${POLICY_CATALOG_VERSION}`,
    );
  }

  let outputRoot: string;
  try {
    outputRoot = exactDirectory(dirname(resolve(input.manifestPath)));
  } catch (error) {
    return authority("invalid-trace", `invalid Rig output root: ${String(error)}`);
  }
  let initial: { stateRoot: string; stateSha256: string };
  try {
    initial = verifyPolicyStateSnapshot({
      outputRoot,
      ref: metadata.initialStateRef,
      sha256: metadata.initialStateSha256,
      expectedStateSha256: metadata.initialStateDigest,
    });
  } catch (error) {
    return authority("state-digest-mismatch", String(error));
  }

  const cassettePath = resolve(outputRoot, metadata.cassetteRef);
  if (!isContained(outputRoot, cassettePath) || !existsSync(cassettePath)) {
    return authority("missing-cassette", `missing ${metadata.cassetteRef}`);
  }
  let cassetteBytes: Buffer;
  try {
    cassetteBytes = readStableFile(cassettePath, CASSETTE_MAX_BYTES, true);
  } catch (error) {
    return authority("invalid-cassette", String(error));
  }
  if (sha256(cassetteBytes) !== metadata.cassetteSha256) {
    return authority("cassette-hash-mismatch", "cassette bytes do not match the manifest");
  }
  const cassetteResponseHashes = responseHashesFromCassette(cassetteBytes);
  const requiredResponseHashes: string[] = [];
  const turns = new Map<
    number,
    Array<{ ref: string; sha256: string; envelope: PolicyReplayEnvelope; stateRoot: string }>
  >();
  const identities = new Set<string>();
  const captureDir = resolve(outputRoot, metadata.captureDir);
  if (!isContained(outputRoot, captureDir)) {
    return authority("invalid-trace", "capture directory escapes the Rig output root");
  }

  for (const turn of input.manifest.turns) {
    const replay = turn.policyReplay;
    if (replay === undefined || replay.status === "missing") {
      return authority("missing-trace", `turn ${turn.index} has no policy replay trace`);
    }
    if (replay.status === "overflow") {
      return authority("trace-overflow", `turn ${turn.index} capture overflowed`);
    }
    if (replay.status !== "complete") {
      return authority("trace-status", `turn ${turn.index} capture status is ${replay.status}`);
    }
    const validated: Array<{
      ref: string;
      sha256: string;
      envelope: PolicyReplayEnvelope;
      stateRoot: string;
    }> = [];
    for (const trace of replay.traces) {
      const verified = verifyPolicyReplayEnvelope({
        sinkDir: captureDir,
        ref: trace.ref,
        sha256: trace.sha256,
        authoritative: true,
        expectedCatalogVersion: POLICY_CATALOG_VERSION,
      });
      if (!verified.ok) {
        const code: RigAuthorityInvalidity =
          verified.reason === "lossy"
            ? "lossy-trace"
            : verified.reason === "catalog-mismatch"
              ? "catalog-mismatch"
              : verified.reason === "non-canonical"
                ? "non-canonical-trace"
                : verified.reason === "too-large"
                  ? "trace-overflow"
                  : "invalid-trace";
        return authority(code, `turn ${turn.index} ${trace.ref}: ${verified.reason}`);
      }
      const envelope = verified.envelope;
      if (envelope.source_commit !== metadata.sourceCommit) {
        return authority(
          "source-commit-mismatch",
          `turn ${turn.index} trace ${trace.ref} names another source commit`,
        );
      }
      if (envelope.policy_trace.ablated.length > 0) {
        return authority("invalid-trace", `turn ${turn.index} baseline trace is already ablated`);
      }
      const identity = `${envelope.run_id}:${envelope.iter}`;
      if (identities.has(identity)) {
        return authority("invalid-trace", `duplicate replay identity ${identity}`);
      }
      identities.add(identity);
      const stateRoot = resolve(outputRoot, `policy-state/${envelope.state_sha256}/.reviewgate`);
      try {
        if (
          !isContained(outputRoot, stateRoot) ||
          digestPolicyState(stateRoot) !== envelope.state_sha256
        ) {
          return authority(
            "state-digest-mismatch",
            `turn ${turn.index} trace ${trace.ref} state does not match`,
          );
        }
      } catch (error) {
        return authority("state-digest-mismatch", String(error));
      }
      requiredResponseHashes.push(...envelope.raw_response_sha256);
      validated.push({ ...trace, envelope, stateRoot });
    }
    const sequenceRunId = validated[0]?.envelope.run_id;
    if (
      sequenceRunId === undefined ||
      validated.some(
        (trace, index) =>
          trace.envelope.run_id !== sequenceRunId || trace.envelope.iter !== index + 1,
      )
    ) {
      return authority(
        "invalid-trace",
        `turn ${turn.index} replay inventory is not one complete ordered iteration sequence`,
      );
    }
    turns.set(turn.index, validated);
  }

  if (
    cassetteResponseHashes.length !== requiredResponseHashes.length ||
    requiredResponseHashes.some((hash, index) => hash !== cassetteResponseHashes[index])
  ) {
    return authority(
      "response-hash-mismatch",
      "cassette response hashes do not exactly match the captured order",
    );
  }

  return {
    sourceCommit: metadata.sourceCommit,
    initialStateRoot: initial.stateRoot,
    initialStateSha256: initial.stateSha256,
    cassettePath,
    turns,
  };
}

function assertNoAliasedFiles(
  leftRoot: string,
  rightRoot: string,
  requireEqualDigest = true,
): void {
  const left = collectStateEntries(leftRoot);
  const right = collectStateEntries(rightRoot);
  if (requireEqualDigest && stateDigest(left) !== stateDigest(right)) {
    throw new Error("policy state digest mismatch");
  }
  const rightPaths = new Set(right.map((entry) => entry.path));
  for (const entry of left) {
    if (!rightPaths.has(entry.path)) continue;
    const leftStat = statSync(join(leftRoot, entry.path));
    const rightStat = statSync(join(rightRoot, entry.path));
    if (leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino) {
      throw new Error(`policy state source alias detected: ${entry.path}`);
    }
  }
}

function prepareBranch(input: {
  destination: string;
  sourceRepoRoot: string;
  sourceCommit: string;
  stateSnapshotRoot: string;
  expectedStateSha256: string;
  exactDiff: string;
}): ReplayBranch {
  execFileSync("git", [
    "clone",
    "--quiet",
    "--no-hardlinks",
    "--no-checkout",
    input.sourceRepoRoot,
    input.destination,
  ]);
  execFileSync("git", ["checkout", "--quiet", "--detach", input.sourceCommit], {
    cwd: input.destination,
  });
  const stateDestination = join(input.destination, ".reviewgate");
  if (existsSync(stateDestination)) rmSync(stateDestination, { recursive: true, force: true });
  const entries = collectStateEntries(input.stateSnapshotRoot);
  if (stateDigest(entries) !== input.expectedStateSha256) {
    throw new Error("policy state snapshot digest mismatch");
  }
  copyEntries(entries, stateDestination);
  if (digestPolicyState(stateDestination) !== input.expectedStateSha256) {
    throw new Error("policy replay branch state digest mismatch");
  }
  assertNoAliasedFiles(input.stateSnapshotRoot, stateDestination);

  applyReplayDiff({
    checkoutRoot: input.destination,
    replayRoot: dirname(input.destination),
    exactDiff: input.exactDiff,
    reverse: false,
    label: basename(input.destination),
  });
  return { checkoutRoot: input.destination, startingStateSha256: input.expectedStateSha256 };
}

export function createReplayBranches(input: {
  sourceRepoRoot: string;
  sourceCommit: string;
  stateSnapshotRoot: string;
  expectedStateSha256: string;
  exactDiff: string;
}): ReplayBranches {
  if (!GIT_OBJECT_ID.test(input.sourceCommit)) throw new Error("invalid source commit");
  if (!/^[0-9a-f]{64}$/.test(input.expectedStateSha256)) {
    throw new Error("invalid expected policy state digest");
  }
  const sourceReal = exactDirectory(input.sourceRepoRoot);
  const stateReal = exactDirectory(input.stateSnapshotRoot);
  if (isContained(sourceReal, stateReal) || isContained(stateReal, sourceReal)) {
    throw new Error("policy state snapshot must not alias the measured repository");
  }
  const resolvedCommit = execFileSync(
    "git",
    ["rev-parse", "--verify", `${input.sourceCommit}^{commit}`],
    {
      cwd: sourceReal,
      encoding: "utf8",
    },
  ).trim();
  if (resolvedCommit !== input.sourceCommit) throw new Error("source commit identity mismatch");
  if (digestPolicyState(stateReal) !== input.expectedStateSha256) {
    throw new Error("policy state snapshot digest mismatch");
  }

  const root = mkdtempSync(join(tmpdir(), "reviewgate-policy-replay-"));
  try {
    const baseline = prepareBranch({
      ...input,
      sourceRepoRoot: sourceReal,
      destination: join(root, "baseline"),
    });
    const counterfactual = prepareBranch({
      ...input,
      sourceRepoRoot: sourceReal,
      destination: join(root, "counterfactual"),
    });
    assertNoAliasedFiles(
      join(baseline.checkoutRoot, ".reviewgate"),
      join(counterfactual.checkoutRoot, ".reviewgate"),
    );
    return { root, baseline, counterfactual };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

/** Move one persistent replay pair to the next captured iteration. */
export function advanceReplayBranches(input: {
  branches: ReplayBranches;
  sourceRepoRoot: string;
  sourceCommit: string;
  previousExactDiff: string;
  nextExactDiff: string;
  previousStateSnapshotRoot: string;
  previousStateSha256: string;
  nextStateSnapshotRoot: string;
  nextStateSha256: string;
}): void {
  if (!GIT_OBJECT_ID.test(input.sourceCommit)) throw new Error("invalid source commit");
  if (
    !/^[0-9a-f]{64}$/.test(input.previousStateSha256) ||
    !/^[0-9a-f]{64}$/.test(input.nextStateSha256)
  ) {
    throw new Error("invalid policy state transition digest");
  }
  const sourceReal = exactDirectory(input.sourceRepoRoot);
  const replayReal = exactDirectory(input.branches.root);
  for (const snapshotRoot of [input.previousStateSnapshotRoot, input.nextStateSnapshotRoot]) {
    const snapshotReal = exactDirectory(snapshotRoot);
    if (
      isContained(sourceReal, snapshotReal) ||
      isContained(snapshotReal, sourceReal) ||
      isContained(replayReal, snapshotReal) ||
      isContained(snapshotReal, replayReal)
    ) {
      throw new Error("policy state transition snapshot aliases source or replay state");
    }
  }
  if (digestPolicyState(input.previousStateSnapshotRoot) !== input.previousStateSha256) {
    throw new Error("previous policy state snapshot digest mismatch");
  }
  if (digestPolicyState(input.nextStateSnapshotRoot) !== input.nextStateSha256) {
    throw new Error("next policy state snapshot digest mismatch");
  }
  for (const [label, branch] of [
    ["baseline", input.branches.baseline],
    ["counterfactual", input.branches.counterfactual],
  ] as const) {
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: branch.checkoutRoot,
      encoding: "utf8",
    }).trim();
    if (head !== input.sourceCommit) throw new Error(`${label} source commit drifted`);
    applyReplayDiff({
      checkoutRoot: branch.checkoutRoot,
      replayRoot: input.branches.root,
      exactDiff: input.previousExactDiff,
      reverse: true,
      label: `${label}-previous`,
    });
    applyReplayDiff({
      checkoutRoot: branch.checkoutRoot,
      replayRoot: input.branches.root,
      exactDiff: input.nextExactDiff,
      reverse: false,
      label: `${label}-next`,
    });
    advanceBranchState({
      checkoutRoot: branch.checkoutRoot,
      previousStateSnapshotRoot: input.previousStateSnapshotRoot,
      nextStateSnapshotRoot: input.nextStateSnapshotRoot,
    });
  }
  if (
    digestPolicyState(join(input.branches.baseline.checkoutRoot, ".reviewgate")) !==
    input.nextStateSha256
  ) {
    throw new Error("baseline replay state does not reproduce the next captured digest");
  }
  assertNoAliasedFiles(
    join(input.branches.baseline.checkoutRoot, ".reviewgate"),
    join(input.branches.counterfactual.checkoutRoot, ".reviewgate"),
    false,
  );
}

export function cleanupReplayBranches(branches: ReplayBranches): void {
  const temporaryRoot = realpathSync(tmpdir());
  const unresolved = resolve(branches.root);
  const stat = lstatSync(unresolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("refusing to remove non-directory replay branch root");
  }
  const candidate = realpathSync(unresolved);
  if (
    !isContained(temporaryRoot, candidate) ||
    dirname(candidate) !== temporaryRoot ||
    !basename(candidate).startsWith("reviewgate-policy-replay-")
  ) {
    throw new Error("refusing to remove untrusted replay branch root");
  }
  rmSync(candidate, { recursive: true, force: true });
}
