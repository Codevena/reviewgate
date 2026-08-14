// src/cli/commands/bench.ts — `reviewgate bench run` (spec §6, §12 P1c).
//
// Loads a labelled corpus, runs every case through the runner (real Orchestrator
// one-shot + stub-injectable reviewers), aggregates Wilson-CI metrics over the
// SCORED cases, records per-provider RAW-layer metrics + cost + reproducibility
// provenance, enforces the exit-4 quality gate, and writes a BenchResult JSON.
//
// Exit codes (spec §6): 0 = scored + gate satisfied · 2 = usage/input error ·
// 3 = ERROR (no reviewer completed anywhere) · 4 = benchmark-invalid.
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  type CanonicalArtifactWriteResult,
  verifyCanonicalJsonArtifact,
  writeCanonicalJsonArtifact,
} from "../../artifacts/canonical-json.ts";
import { canonicalJson } from "../../audit/canonical.ts";
import { verifyPolicyTraceReference, writePolicyTrace } from "../../audit/policy-trace-store.ts";
import type { MatchResult } from "../../bench/matcher.ts";
import { makeMetric, summarizeSpread } from "../../bench/metrics.ts";
import { isAuthoritative, renderBenchMatrix, renderBenchReport } from "../../bench/report.ts";
import {
  type AuthoritativeTraceRun,
  type CaseRunOutcome,
  type SuppressorConfig,
  buildBenchConfig,
  runBenchCase,
  validateAuthoritativeTracePair,
  validateAuthoritativeTraceProfilePair,
} from "../../bench/runner.ts";
import type { ReviewgateConfig } from "../../config/define-config.ts";
import {
  POLICY_CATALOG_VERSION,
  POLICY_PASS_IDS,
  type PolicyPassId,
} from "../../core/policy/catalog.ts";
import { POLICY_MEASUREMENT_INTERACTIONS } from "../../core/policy/measurement-contract.ts";
import type { PolicyExecutionOptions } from "../../core/policy/replay.ts";
import type {
  OpenRouterProviderRouting,
  Preflight,
  ProviderAdapter,
  ProviderConfig,
  ReviewResult,
} from "../../providers/adapter-base.ts";
import type { ProviderId } from "../../providers/registry.ts";
import { SandboxUnavailableError } from "../../sandbox/errors.ts";
import { type BenchCase, BenchCaseSchema } from "../../schemas/bench-case.ts";
import {
  type BenchPreregistration,
  BenchPreregistrationSchema,
} from "../../schemas/bench-preregistration.ts";
import {
  type BenchMatrix,
  BenchMatrixSchema,
  type BenchPolicyProfileTraceSet,
  BenchPolicyProfileTraceSetSchema,
  type BenchPolicyRepeatResult,
  BenchPolicyRepeatResultSchema,
  type BenchPolicyTraceSet,
  BenchPolicyTraceSetSchema,
  type BenchResponseManifest,
  BenchResponseManifestSchema,
  type BenchResult,
  BenchResultSchema,
  CAPTURED_THROWABLE_FIELD_KEYS,
  type CapturedThrowableSnapshot,
  CapturedThrowableSnapshotSchema,
  type CaseResult,
  type Cost,
  type MatrixVariant,
  type Metric,
  type PolicyBenchProfileArtifact,
  PolicyBenchProfileArtifactSchema,
  type ProviderResult,
  isAuthoritativeThrowableString,
} from "../../schemas/bench-result.ts";
import {
  type PolicyMeasurementPreregistration,
  PolicyMeasurementPreregistrationSchema,
} from "../../schemas/policy-measurement-preregistration.ts";
import {
  type PolicyBenchBundle,
  PolicyBenchBundleSchema,
} from "../../schemas/policy-measurement.ts";
import { writeFileIfAbsent } from "../../utils/atomic-write.ts";
import { spawnCapture } from "../../utils/spawn-capture.ts";
import { RG_VERSION } from "../../version.ts";
import { buildAdapters } from "../build-adapters.ts";

// A provider's coverage / aggregate-panel coverage below this fraction makes the
// number non-authoritative (spec §5.1) and, for the panel, trips the quality gate.
const COVERAGE_FLOOR = 0.8;
const KNOWN_PROVIDERS: ReadonlySet<string> = new Set([
  "codex",
  "gemini",
  "claude-code",
  "openrouter",
  "opencode",
  "ollama",
]);

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("../") && rel !== ".." && !isAbsolute(rel));
}

function removeEmptyOwnedAttempt(root: string, identity: { dev: number; ino: number }): void {
  try {
    const stat = lstatSync(root);
    if (
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      stat.dev === identity.dev &&
      stat.ino === identity.ino &&
      readdirSync(root).length === 0
    ) {
      rmSync(root);
    }
  } catch {
    // Never remove a replacement or a partially produced capture.
  }
}

/** Parse `--provider-model opencode=alibaba-token-plan/qwen3.8-max,ollama=glm-5.2:cloud`.
 * Splits on the FIRST `=` only — model ids legitimately contain slashes, colons
 * and occasionally `=`. Validated against KNOWN_PROVIDERS rather than a second
 * hand-maintained list, so a new provider cannot be accepted here while being
 * rejected two functions down. */
export function parseProviderModels(raw: string): Partial<Record<ProviderId, string>> {
  const out: Partial<Record<ProviderId, string>> = {};
  const pairs = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      throw new Error(`--provider-model expects <provider>=<model>, got "${pair}"`);
    }
    const provider = pair.slice(0, eq).trim();
    const model = pair.slice(eq + 1).trim();
    if (!model) throw new Error(`--provider-model: empty model for "${provider}"`);
    if (!KNOWN_PROVIDERS.has(provider)) {
      throw new Error(`--provider-model: unknown provider "${provider}"`);
    }
    out[provider as ProviderId] = model;
  }
  return out;
}

export interface BenchRunInput {
  repoRoot: string;
  corpus: string;
  out: string;
  providers?: ProviderId[] | undefined;
  window?: number;
  includeAdvisory?: boolean;
  minClean?: number;
  minSeeded?: number;
  maxFailedFrac?: number;
  /** run the whole corpus K times and report mean ± spread per metric (default 1). */
  repeat?: number;
  /** suppressor-layer toggles (spec §8 class A) — threaded to buildBenchConfig. */
  suppressors?: SuppressorConfig;
  /** named ablation labels recorded in provenance.phases.ablations (set by `bench matrix`). */
  ablationLabels?: string[];
  criticModel?: string;
  criticOpenrouterProvider?: OpenRouterProviderRouting;
  /** Exact reviewer-side OpenRouter route for preregistered policy capture. */
  reviewerOpenrouterProvider?: OpenRouterProviderRouting;
  /** Pin a reviewer's upstream model, so provenance records what actually ran
   * instead of a "default" sentinel that resolves outside the repo. */
  providerModels?: Partial<Record<ProviderId, string>>;
  /** Benchmark-only physical critic completion limit; runtime default remains 1. */
  criticMaxAttempts?: number;
  /** Benchmark-only physical reviewer invocation limit per configured reviewer/case. */
  reviewerMaxAttempts?: number;
  /** Hard provider-call and OpenRouter output bounds (required for authoritative runs). */
  maxProviderCalls?: number;
  maxOutputTokens?: number;
  /** Fail closed on source/dirty/unregistered provenance and incomplete coverage. */
  authoritative?: boolean;
  preregistration?: string;
  /** Internal matrix plumbing: a single ceiling shared by every variant. */
  callBudget?: ProviderCallBudget;
  /** Replay variants reuse reviewer results, so their `review()` calls are not external. */
  countProviderCalls?: boolean;
  /** Replay variants still execute live critic/judge completions unless that phase is ablated. */
  countCompletionCalls?: boolean;
  /** Deterministic integrity injection for tests only. */
  runnerInfo?: BenchRunnerInfo;
  /** in-process stub adapters for tests; production omits (real CLIs). */
  adapters?: Partial<Record<ProviderId, ProviderAdapter>>;
  /** injectable clock for a deterministic provenance timestamp in tests. */
  now?: () => Date;
  /** injectable quota-failover availability probe (tests); production probes real CLIs. */
  providerAvailable?: (id: ProviderId, apiKeyEnv?: string) => boolean;
  /** Internal matrix-only policy trace/ablation options. */
  policyExecution?: PolicyExecutionOptions;
  /** Internal Matrix-owned real artifact sink for per-case policy traces. */
  policyTraceStore?: { root: string; refPrefix: string; now?: Date };
  /** Internal capture-owned repeat/case cursor; never accepted from the CLI boundary. */
  captureContext?: { repeat: number; caseId?: string };
}

export interface BenchRunnerInfo {
  sha256: string;
  kind: "compiled" | "source-runtime" | "test";
}

export interface ProviderCallBudget {
  max: number | null;
  used: number;
  byProvider: Map<string, number>;
  exceeded: boolean;
}

export interface BenchRunOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface LoadedCase {
  id: string;
  benchCase: BenchCase | null; // null when case.json is schema-invalid
  diffPatch: string;
  contentHash: string;
  invalidReason: string | null;
  rawKind: "seeded-bug" | "clean";
}

function usage(message: string): BenchRunOutput {
  return { exitCode: 2, stdout: "", stderr: `bench run: ${message}\n` };
}

export interface BenchReportInput {
  repoRoot: string;
  file: string;
  /** print only the paste-ready markdown block (default: the terminal table). */
  markdown?: boolean;
}

/** Render a saved results JSON to a terminal table (+ markdown). Exit 2 on a bad file. */
export async function runBenchReport(input: BenchReportInput): Promise<BenchRunOutput> {
  const path = resolve(input.repoRoot, input.file);
  if (!existsSync(path)) {
    return { exitCode: 2, stdout: "", stderr: `bench report: file not found: ${input.file}\n` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `bench report: not valid JSON: ${err instanceof Error ? err.message : err}\n`,
    };
  }
  const result = BenchResultSchema.safeParse(parsed);
  if (!result.success) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `bench report: not a valid bench result: ${result.error.issues[0]?.message ?? "?"}\n`,
    };
  }
  const { table, markdown } = renderBenchReport(result.data);
  const out = input.markdown ? `${markdown}\n` : `${table}\n\n${markdown}\n`;
  return { exitCode: 0, stdout: out, stderr: "" };
}

function sha256(s: string | Buffer): string {
  return createHash("sha256").update(s).digest("hex");
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function detectRunnerInfo(adapters: BenchRunInput["adapters"]): BenchRunnerInfo {
  if (adapters) return { sha256: sha256("in-process-test-adapters"), kind: "test" };
  try {
    const name = basename(process.execPath).toLowerCase();
    return {
      sha256: sha256File(process.execPath),
      kind: name === "bun" || name.startsWith("bun-") ? "source-runtime" : "compiled",
    };
  } catch {
    return { sha256: "unknown", kind: "source-runtime" };
  }
}

function createCallBudget(max: number | undefined): ProviderCallBudget {
  return {
    max: max !== undefined && Number.isFinite(max) && max > 0 ? Math.floor(max) : null,
    used: 0,
    byProvider: new Map(),
    exceeded: false,
  };
}

function consumeProviderCall(budget: ProviderCallBudget, provider: string): void {
  if (budget.max !== null && budget.used >= budget.max) {
    budget.exceeded = true;
    throw new Error(`benchmark provider-call ceiling ${budget.max} exhausted`);
  }
  budget.used++;
  budget.byProvider.set(provider, (budget.byProvider.get(provider) ?? 0) + 1);
}

function capOpenRouterConfig(cfg: ProviderConfig, cap: number | undefined): ProviderConfig {
  if (cap === undefined) return cfg;
  return { ...cfg, maxTokens: Math.min(cfg.maxTokens ?? cap, cap) };
}

function budgetAdapters(
  adapters: Partial<Record<ProviderId, ProviderAdapter>>,
  budget: ProviderCallBudget,
  countReviewCalls: boolean,
  countCompletionCalls: boolean,
  maxOutputTokens: number | undefined,
  reviewerMaxAttempts: number | undefined,
): Partial<Record<ProviderId, ProviderAdapter>> {
  const wrapped: Partial<Record<ProviderId, ProviderAdapter>> = {};
  const maxReviewAttempts =
    reviewerMaxAttempts !== undefined && Number.isFinite(reviewerMaxAttempts)
      ? Math.max(1, Math.floor(reviewerMaxAttempts))
      : 1;
  for (const [rawId, adapter] of Object.entries(adapters) as Array<
    [ProviderId, ProviderAdapter | undefined]
  >) {
    if (!adapter) continue;
    const complete = adapter.complete?.bind(adapter);
    const common = {
      id: adapter.id,
      preflight: (cfg: ProviderConfig) => adapter.preflight(cfg),
      review: async (input: Parameters<ProviderAdapter["review"]>[0]) => {
        let last: ReviewResult | null = null;
        for (let attempt = 1; attempt <= maxReviewAttempts; attempt++) {
          if (countReviewCalls) consumeProviderCall(budget, rawId);
          const result = await adapter.review({
            ...input,
            // One recorded benchmark attempt must equal one physical provider call.
            disableRetries: true,
            cfg:
              rawId === "openrouter" ? capOpenRouterConfig(input.cfg, maxOutputTokens) : input.cfg,
          });
          if (result.status === "ok") return result;
          last = result;
        }
        if (last) return last;
        throw new Error("benchmark reviewer attempt loop produced no result");
      },
      ...(complete
        ? {
            complete: async (
              prompt: string,
              opts: Parameters<NonNullable<ProviderAdapter["complete"]>>[1],
            ) => {
              if (countCompletionCalls) consumeProviderCall(budget, rawId);
              return complete(prompt, {
                ...opts,
                ...(rawId === "openrouter" && maxOutputTokens !== undefined
                  ? { maxTokens: Math.min(opts.maxTokens ?? maxOutputTokens, maxOutputTokens) }
                  : {}),
              });
            },
          }
        : {}),
    } satisfies ProviderAdapter;
    wrapped[rawId] = common;
  }
  return wrapped;
}

/** Discover case directories (each with a case.json) under the corpus root, sorted. */
function listCaseDirs(corpus: string): string[] {
  return readdirSync(corpus)
    .filter((name) => {
      const p = join(corpus, name);
      return statSync(p).isDirectory() && existsSync(join(p, "case.json"));
    })
    .sort();
}

function loadCase(corpus: string, id: string): LoadedCase {
  const dir = join(corpus, id);
  const casePath = join(dir, "case.json");
  const diffPath = join(dir, "diff.patch");
  const caseRaw = readFileSync(casePath, "utf8");
  const diffPatch = existsSync(diffPath) ? readFileSync(diffPath, "utf8") : "";
  const contentHash = sha256(`${sha256(caseRaw)}${sha256(diffPatch)}`);

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(caseRaw);
  } catch (err) {
    return {
      id,
      benchCase: null,
      diffPatch,
      contentHash,
      invalidReason: `case.json is not valid JSON: ${err instanceof Error ? err.message : err}`,
      rawKind: "seeded-bug",
    };
  }
  // Best-effort kind for the record even when the case is otherwise invalid.
  const rawKind =
    typeof parsedJson === "object" &&
    parsedJson !== null &&
    (parsedJson as { kind?: unknown }).kind === "clean"
      ? "clean"
      : "seeded-bug";

  const result = BenchCaseSchema.safeParse(parsedJson);
  if (!result.success) {
    return {
      id,
      benchCase: null,
      diffPatch,
      contentHash,
      invalidReason: `case.json failed schema validation: ${result.error.issues[0]?.message ?? "?"}`,
      rawKind,
    };
  }
  if (!existsSync(diffPath)) {
    return {
      id,
      benchCase: null,
      diffPatch,
      contentHash,
      invalidReason: "missing diff.patch",
      rawKind,
    };
  }
  return { id, benchCase: result.data, diffPatch, contentHash, invalidReason: null, rawKind };
}

function invalidCaseResult(
  loaded: LoadedCase,
  panelConfigured: number,
  repeat: number,
): CaseResult {
  return {
    id: loaded.id,
    kind: loaded.rawKind,
    status: "invalid",
    content_hash: loaded.contentHash,
    counts: { tp: 0, fp: 0, fn: 0, neutral: 0 },
    panel_ok: 0,
    panel_configured: panelConfigured,
    file_context: "full",
    repeat,
    latency_ms: null,
    error: loaded.invalidReason,
  };
}

function outcomeToCaseResult(
  loaded: LoadedCase,
  benchCase: BenchCase,
  out: CaseRunOutcome,
  repeat: number,
): CaseResult {
  return {
    id: loaded.id,
    kind: benchCase.kind,
    status: out.status,
    content_hash: loaded.contentHash,
    counts: out.counts,
    panel_ok: out.panelOk,
    panel_configured: out.panelConfigured,
    file_context: "full",
    repeat,
    latency_ms: out.latencyMs,
    error: out.error,
    ...(out.critic ? { critic: out.critic } : {}),
    ...(out.policyTruth
      ? {
          policy_truth: {
            expected_label_count: out.policyTruth.expectedLabelCount,
            findings: out.policyTruth.findings.map((finding) => ({
              signature: finding.signature,
              severity: finding.severity,
              outcome: finding.outcome,
              label_index: finding.labelIndex,
              near_miss: finding.nearMiss,
            })),
            fn_label_indexes: out.policyTruth.fnLabelIndexes,
          },
        }
      : {}),
    ...(out.policy
      ? {
          policy_trace: {
            authoritative: out.policy.authoritative,
            status: out.policy.status,
            catalog_version: out.policy.catalogVersion,
            requested_ablations: out.policy.requestedAblations,
            ...(out.policy.trace === undefined ? {} : { trace: out.policy.trace }),
            ...(out.policy.traceRef === undefined ? {} : { trace_ref: out.policy.traceRef }),
            ...(out.policy.traceSha256 === undefined
              ? {}
              : { trace_sha256: out.policy.traceSha256 }),
            request_identity_sha256: out.policy.requestIdentitySha256,
            effective_config_sha256: out.policy.effectiveConfigSha256,
            final_identity_sha256: out.policy.finalIdentitySha256,
            reason: out.policy.authoritative ? null : `policy trace status ${out.policy.status}`,
          },
        }
      : {}),
  };
}

interface RepositoryGitState {
  root: string | null;
  commit: string;
  repositoryDirty: boolean;
  corpusDirty: boolean;
}

async function repositoryGitState(repoRoot: string, corpus: string): Promise<RepositoryGitState> {
  const top = await spawnCapture("git", ["rev-parse", "--show-toplevel"], {
    cwd: repoRoot,
    timeoutMs: 15_000,
  });
  if (top.status !== 0) {
    return { root: null, commit: "unknown", repositoryDirty: true, corpusDirty: true };
  }
  // macOS exposes the same temporary directory through /var and /private/var.
  // Canonicalize both operands before path arithmetic or a clean in-repo corpus
  // looks outside the repository and `git status -- <path>` fails closed.
  let root: string;
  let canonicalCorpus: string;
  try {
    root = realpathSync(top.stdout.trim());
    canonicalCorpus = realpathSync(corpus);
  } catch {
    return { root: null, commit: "unknown", repositoryDirty: true, corpusDirty: true };
  }
  const head = await spawnCapture("git", ["rev-parse", "HEAD"], { cwd: root, timeoutMs: 15_000 });
  const status = await spawnCapture("git", ["status", "--porcelain", "--untracked-files=normal"], {
    cwd: root,
    timeoutMs: 15_000,
  });
  const corpusRelative = relative(root, canonicalCorpus);
  const corpusOutsideRepository =
    isAbsolute(corpusRelative) ||
    corpusRelative === ".." ||
    corpusRelative.startsWith("../") ||
    corpusRelative.startsWith("..\\");
  const corpusRel = corpusRelative || ".";
  if (corpusOutsideRepository) {
    return {
      root,
      commit: head.status === 0 ? head.stdout.trim() : "unknown",
      repositoryDirty: status.status !== 0 || status.stdout.trim().length > 0,
      corpusDirty: true,
    };
  }
  const corpusStatus = await spawnCapture(
    "git",
    ["status", "--porcelain", "--untracked-files=normal", "--", corpusRel],
    { cwd: root, timeoutMs: 15_000 },
  );
  return {
    root,
    commit: head.status === 0 ? head.stdout.trim() : "unknown",
    repositoryDirty: status.status !== 0 || status.stdout.trim().length > 0,
    corpusDirty: corpusStatus.status !== 0 || corpusStatus.stdout.trim().length > 0,
  };
}

async function preregistrationDigest(
  repoRoot: string,
  git: RepositoryGitState,
  preregistration: string | undefined,
): Promise<{ digest: string | null; tracked: boolean }> {
  if (!preregistration) return { digest: null, tracked: false };
  const unresolvedPath = resolve(repoRoot, preregistration);
  if (!existsSync(unresolvedPath) || !git.root) return { digest: null, tracked: false };
  const path = realpathSync(unresolvedPath);
  const rel = relative(git.root, path);
  const tracked = await spawnCapture("git", ["ls-files", "--error-unmatch", "--", rel], {
    cwd: git.root,
    timeoutMs: 15_000,
  });
  return { digest: sha256File(path), tracked: tracked.status === 0 };
}

export async function buildRoster(
  config: ReviewgateConfig,
  adapters: Partial<Record<ProviderId, ProviderAdapter>>,
): Promise<Array<{ id: string; cli_version: string; model: string; persona: string }>> {
  const roster: Array<{ id: string; cli_version: string; model: string; persona: string }> = [];
  for (const r of config.phases.review.reviewers) {
    const adapter = adapters[r.provider];
    // Cast mirrors the orchestrator: the zod-inferred config's optional props are
    // `T | undefined`, which exactOptionalPropertyTypes rejects against ProviderConfig.
    const providerCfg = config.providers[r.provider] as ProviderConfig | undefined;
    let cli_version = "unknown";
    if (adapter && providerCfg) {
      try {
        const pf = await adapter.preflight(providerCfg);
        cli_version = pf.version ?? "unknown";
      } catch {
        // best-effort: a provider that won't preflight is still recorded (unknown)
      }
    }
    roster.push({
      id: r.provider,
      cli_version,
      model: providerCfg?.model ?? "unknown",
      persona: r.persona,
    });
  }
  return roster;
}

/** Sum a set of per-case match results into one {tp,fp,fn}. */
function sumMatches(matches: Array<{ tp: number; fp: number; fn: number }>): {
  tp: number;
  fp: number;
  fn: number;
} {
  return matches.reduce((acc, m) => ({ tp: acc.tp + m.tp, fp: acc.fp + m.fp, fn: acc.fn + m.fn }), {
    tp: 0,
    fp: 0,
    fn: 0,
  });
}

export async function runBenchRun(input: BenchRunInput): Promise<BenchRunOutput> {
  if (input.authoritative) {
    return {
      exitCode: 4,
      stdout: "",
      stderr:
        "bench run: benchmark-invalid before provider calls — authoritative protocol is matrix-only; use bench matrix with a semantically validated preregistration\n",
    };
  }
  return runBenchRunInternal(input);
}

async function runBenchRunInternal(input: BenchRunInput): Promise<BenchRunOutput> {
  const corpus = resolve(input.repoRoot, input.corpus);
  const outputPath = resolve(input.repoRoot, input.out);
  if (existsSync(outputPath)) return usage(`output already exists (immutable): ${input.out}`);
  if (!existsSync(corpus) || !statSync(corpus).isDirectory()) {
    return usage(`corpus is not a directory: ${input.corpus}`);
  }
  if (input.providers) {
    const bad = input.providers.filter((p) => !KNOWN_PROVIDERS.has(p));
    if (bad.length > 0) return usage(`unknown provider(s): ${bad.join(",")}`);
  }
  if (
    input.maxProviderCalls !== undefined &&
    (!Number.isInteger(input.maxProviderCalls) || input.maxProviderCalls <= 0)
  ) {
    return usage("--max-provider-calls must be a positive integer");
  }
  if (
    input.maxOutputTokens !== undefined &&
    (!Number.isInteger(input.maxOutputTokens) || input.maxOutputTokens <= 0)
  ) {
    return usage("--max-output-tokens must be a positive integer");
  }
  if (
    input.criticMaxAttempts !== undefined &&
    (!Number.isInteger(input.criticMaxAttempts) || input.criticMaxAttempts <= 0)
  ) {
    return usage("--critic-max-attempts must be a positive integer");
  }
  if (
    input.reviewerMaxAttempts !== undefined &&
    (!Number.isInteger(input.reviewerMaxAttempts) || input.reviewerMaxAttempts <= 0)
  ) {
    return usage("--reviewer-max-attempts must be a positive integer");
  }
  const window = input.window ?? 5;
  const includeAdvisory = input.includeAdvisory ?? false;
  const maxFailedFrac = input.maxFailedFrac ?? 0.1;

  let config: ReviewgateConfig;
  try {
    config = buildBenchConfig({
      ...(input.providers ? { providers: input.providers } : {}),
      ...(input.suppressors ? { suppressors: input.suppressors } : {}),
      ...(input.criticModel ? { criticModel: input.criticModel } : {}),
      ...(input.criticOpenrouterProvider
        ? { criticOpenrouterProvider: input.criticOpenrouterProvider }
        : {}),
      ...(input.providerModels ? { providerModels: input.providerModels } : {}),
      ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
    });
    if (input.reviewerOpenrouterProvider !== undefined && config.providers.openrouter) {
      config.providers.openrouter.openrouterProvider = structuredClone(
        input.reviewerOpenrouterProvider,
      );
    }
  } catch (err) {
    return usage(err instanceof Error ? err.message : String(err));
  }
  const panelConfigured = config.phases.review.reviewers.length;

  const caseDirs = listCaseDirs(corpus);
  if (caseDirs.length === 0) return usage(`no cases found under ${input.corpus}`);

  const repeat = Math.max(1, Math.floor(input.repeat ?? 1));
  // Load + validate each case ONCE (schema/diff checks are deterministic); the
  // reviewer panel is what re-runs per repeat.
  const loadedCases = caseDirs.map((id) => loadCase(corpus, id));
  const validCaseRuns = loadedCases.filter((c) => c.benchCase !== null).length * repeat;

  // Provenance is collected and, for authoritative runs, validated BEFORE the
  // first paid/provider call. A dirty/source/unregistered attempt fails closed.
  const git = await repositoryGitState(input.repoRoot, corpus);
  const prereg = await preregistrationDigest(input.repoRoot, git, input.preregistration);
  const runner = input.runnerInfo ?? detectRunnerInfo(input.adapters);
  if (input.authoritative) {
    const integrityReasons: string[] = [];
    if (!/^[0-9a-f]{40}$/i.test(git.commit)) integrityReasons.push("no real Git commit");
    if (git.repositoryDirty) integrityReasons.push("repository is dirty");
    if (git.corpusDirty) integrityReasons.push("corpus is dirty");
    if (runner.kind !== "compiled" || !/^[0-9a-f]{64}$/i.test(runner.sha256)) {
      integrityReasons.push("runner is not a hashed compiled binary");
    }
    if (!prereg.digest || !prereg.tracked) {
      integrityReasons.push("preregistration is missing or not committed");
    }
    if (input.maxProviderCalls === undefined)
      integrityReasons.push("provider-call ceiling missing");
    if (input.maxOutputTokens === undefined) integrityReasons.push("output-token ceiling missing");
    if (integrityReasons.length > 0) {
      return {
        exitCode: 4,
        stdout: "",
        stderr: `bench run: benchmark-invalid before provider calls — ${integrityReasons.join("; ")}\n`,
      };
    }
  }

  const budget = input.callBudget ?? createCallBudget(input.maxProviderCalls);
  const budgetStart = budget.used;
  const budgetProviderStart = new Map(budget.byProvider);
  const rawAdapters = buildAdapters(config, input.adapters);
  const adapters = budgetAdapters(
    rawAdapters,
    budget,
    input.countProviderCalls !== false,
    input.countCompletionCalls ?? input.countProviderCalls !== false,
    input.maxOutputTokens,
    input.reviewerMaxAttempts,
  );

  // --- run every case, `repeat` times (repeats OUTER so per-repeat metrics group) ---
  const caseResults: CaseResult[] = [];
  // per-provider RAW accumulation POOLED across all case-runs (every repeat)
  const provScored = new Map<string, number>(); // # scored case-runs where provider was OK
  const provMatches = new Map<string, MatchResult[]>();
  let scoredCount = 0;

  for (let r = 1; r <= repeat; r++) {
    if (input.captureContext !== undefined) input.captureContext.repeat = r;
    for (const loaded of loadedCases) {
      if (loaded.benchCase === null) {
        caseResults.push(invalidCaseResult(loaded, panelConfigured, r));
        continue;
      }
      if (input.captureContext !== undefined) input.captureContext.caseId = loaded.benchCase.id;
      const outcome = await runBenchCase({
        benchCase: loaded.benchCase,
        diffPatch: loaded.diffPatch,
        config,
        window,
        includeAdvisory,
        adapters,
        ...(input.criticMaxAttempts !== undefined
          ? { criticMaxAttempts: input.criticMaxAttempts }
          : {}),
        ...(input.providerAvailable ? { providerAvailable: input.providerAvailable } : {}),
        ...(input.policyExecution === undefined ? {} : { policyExecution: input.policyExecution }),
        ...(input.policyTraceStore === undefined
          ? {}
          : { policyTraceStore: input.policyTraceStore }),
      });
      caseResults.push(outcomeToCaseResult(loaded, loaded.benchCase, outcome, r));

      if (outcome.status === "scored") {
        scoredCount++;
        // Count each provider AT MOST ONCE per case-run: coverage is the fraction
        // of scored case-runs a provider produced an OK review on, so a duplicated
        // provider entry (e.g. a failover poaching a panel member) must not push
        // coverage above 1 or double-count its findings.
        const seenOk = new Set<ProviderId>();
        for (const pp of outcome.perProvider) {
          if (pp.status === "ok" && pp.match && !seenOk.has(pp.provider)) {
            seenOk.add(pp.provider);
            provScored.set(pp.provider, (provScored.get(pp.provider) ?? 0) + 1);
            const list = provMatches.get(pp.provider) ?? [];
            list.push(pp.match);
            provMatches.set(pp.provider, list);
          }
        }
      }
    }
  }

  // --- aggregate (POOLED over all scored case-runs across every repeat) ---
  const scored = caseResults.filter((c) => c.status === "scored");
  const scoredClean = scored.filter((c) => c.kind === "clean");

  const tpSum = scored.reduce((s, c) => s + c.counts.tp, 0);
  const fpSum = scored.reduce((s, c) => s + c.counts.fp, 0);
  const fnSum = scored.reduce((s, c) => s + c.counts.fn, 0);
  const cleanWithFp = scoredClean.filter((c) => c.counts.fp > 0).length;

  const aggregate = {
    precision: makeMetric(tpSum, tpSum + fpSum),
    recall: makeMetric(tpSum, tpSum + fnSum),
    clean_fp_rate: makeMetric(cleanWithFp, scoredClean.length),
  };

  // Corpus-composition + floor counts are over DISTINCT case ids (not K× inflated).
  const kindById = new Map<string, "seeded-bug" | "clean">();
  for (const c of caseResults) if (c.status !== "invalid") kindById.set(c.id, c.kind);
  const seededCount = [...kindById.values()].filter((k) => k === "seeded-bug").length;
  const cleanCount = [...kindById.values()].filter((k) => k === "clean").length;
  const scoredSeededIds = new Set(scored.filter((c) => c.kind === "seeded-bug").map((c) => c.id));
  const scoredCleanIds = new Set(scoredClean.map((c) => c.id));

  // --- run-to-run stability (spec §10#3): per-repeat point metric → mean ± spread ---
  const point = (num: number, den: number): number | null => (den > 0 ? num / den : null);
  const stability =
    repeat > 1
      ? (() => {
          const precisions: Array<number | null> = [];
          const recalls: Array<number | null> = [];
          const cleanFps: Array<number | null> = [];
          for (let r = 1; r <= repeat; r++) {
            const rs = scored.filter((c) => (c.repeat ?? 1) === r);
            const tp = rs.reduce((s, c) => s + c.counts.tp, 0);
            const fp = rs.reduce((s, c) => s + c.counts.fp, 0);
            const fn = rs.reduce((s, c) => s + c.counts.fn, 0);
            const rc = rs.filter((c) => c.kind === "clean");
            precisions.push(point(tp, tp + fp));
            recalls.push(point(tp, tp + fn));
            cleanFps.push(point(rc.filter((c) => c.counts.fp > 0).length, rc.length));
          }
          return {
            repeats: repeat,
            precision: summarizeSpread(precisions),
            recall: summarizeSpread(recalls),
            clean_fp_rate: summarizeSpread(cleanFps),
          };
        })()
      : null;

  // --- per-provider RAW-layer metrics ---
  // Report the UNION of the configured roster AND the providers that actually
  // produced a review — otherwise a quota-failover reviewer (e.g. codex → gemini)
  // would have its real metrics silently dropped, while the never-run configured
  // slot shows a hollow 0-coverage entry. Both are informative; a provider that
  // never returned OK gets coverage 0 (→ non-authoritative).
  const providerIds = [
    ...new Set<string>([
      ...config.phases.review.reviewers.map((r) => r.provider),
      ...provMatches.keys(),
    ]),
  ].sort();
  const providers: ProviderResult[] = providerIds.map((provider) => {
    const okCases = provScored.get(provider) ?? 0;
    const matches = provMatches.get(provider) ?? [];
    const { tp, fp, fn } = sumMatches(matches);
    const coverage = makeMetric(okCases, validCaseRuns);
    const authoritative = coverage.value !== null && coverage.value >= COVERAGE_FLOOR;
    return {
      provider,
      coverage,
      precision: makeMetric(tp, tp + fp),
      recall: makeMetric(tp, tp + fn),
      authoritative,
    };
  });

  // --- critic coverage + honest cost accounting ---
  const criticCases = caseResults.flatMap((c) => (c.critic ? [c.critic] : []));
  const criticEligible = criticCases.filter((c) => c.eligible).length;
  const criticRan = criticCases.filter((c) => c.eligible && c.status === "ran").length;
  const critic = config.phases.critic
    ? {
        provider: config.phases.critic.provider,
        eligible: criticEligible,
        ran: criticRan,
        coverage: makeMetric(criticRan, criticEligible),
        authoritative: criticRan === criticEligible,
      }
    : null;

  const runCalls = new Map<string, number>();
  for (const [provider, calls] of budget.byProvider) {
    const delta = calls - (budgetProviderStart.get(provider) ?? 0);
    if (delta > 0) runCalls.set(provider, delta);
  }
  const cost: Cost[] = [...runCalls.entries()].map(([provider, calls]) => ({
    provider,
    calls,
    cache_hits: 0,
    // ReviewResult does not guarantee trustworthy token/billing telemetry across
    // CLI providers and complete() currently has no usage envelope.
    tokens_in: null,
    tokens_out: null,
    billed_usd: null,
    oauth_quota_calls: config.providers[provider as ProviderId]?.auth === "oauth" ? calls : 0,
  }));

  // --- provenance ---
  const roster = await buildRoster(config, adapters);
  const now = (input.now ?? (() => new Date()))();
  const result: BenchResult = {
    schema: "reviewgate.bench.result.v1",
    provenance: {
      reviewgate_version: RG_VERSION,
      corpus_commit: git.commit,
      corpus_dirty: git.corpusDirty,
      providers: roster,
      config_hash: sha256(JSON.stringify(config)),
      window,
      repeat,
      include_advisory: includeAdvisory,
      temperature: null,
      stores: "per-case-fresh",
      cache: "cold",
      file_context: "full",
      phases: {
        critic: config.phases.critic !== null,
        reputation: config.phases.reputation.enabled,
        fp_ledger: config.phases.fpLedger?.enabled ?? false,
        confidence_floor: config.phases.review.confidenceFloor ?? null,
        scope_to_diff: config.phases.review.scopeToDiff ?? false,
        ablations: input.ablationLabels ?? [],
      },
      host_os: `${process.platform}-${process.arch}`,
      timestamp: now.toISOString(),
      case_count: { seeded: seededCount, clean: cleanCount },
      case_run_count: {
        seeded: seededCount * repeat,
        clean: cleanCount * repeat,
        total: (seededCount + cleanCount) * repeat,
      },
      critic: config.phases.critic
        ? {
            provider: config.phases.critic.provider,
            model:
              config.phases.critic.model ??
              config.providers[config.phases.critic.provider]?.model ??
              "unknown",
            openrouter_provider:
              config.phases.critic.provider === "openrouter"
                ? (config.providers.openrouter?.openrouterProvider ?? null)
                : null,
            max_attempts: input.criticMaxAttempts ?? 1,
          }
        : null,
      integrity: {
        source_commit: git.commit,
        repository_dirty: git.repositoryDirty,
        runner_sha256: runner.sha256,
        runner_kind: runner.kind,
        preregistration_sha256: prereg.digest,
        authoritative_requested: input.authoritative ?? false,
        max_provider_calls: budget.max,
        provider_calls_used: budget.used - budgetStart,
        max_output_tokens: input.maxOutputTokens ?? null,
        reviewer_max_attempts: input.reviewerMaxAttempts ?? 1,
      },
    },
    cases: caseResults,
    providers,
    cost,
    critic,
    aggregate,
    stability,
  };

  // --- quality gate + exit code ---
  const invalidCount = caseResults.filter((c) => c.status === "invalid").length;
  const reviewErrorCount = caseResults.filter((c) => c.status === "review-error").length;
  const total = caseResults.length;
  const reviewErrorFrac = total > 0 ? reviewErrorCount / total : 0;
  // Coverage denominator includes review-error case-runs. Counting only scored
  // rows would hide outages by removing them from both numerator and denominator.
  const coverageCases = caseResults.filter((c) => c.status !== "invalid");
  const okSum = coverageCases.reduce((s, c) => s + c.panel_ok, 0);
  const configuredSum = coverageCases.reduce((s, c) => s + c.panel_configured, 0);
  const panelCoverage = configuredSum > 0 ? okSum / configuredSum : 1;
  const panelDegraded = coverageCases.length > 0 && panelCoverage < COVERAGE_FLOOR;

  // ERROR: no reviewer completed anywhere (pure provider outage, no corpus
  // problems). Precedence over benchmark-invalid, matching the historical order.
  const outage =
    scoredCount === 0 && reviewErrorCount > 0 && invalidCount === 0 && !budget.exceeded;

  const gateReasons: string[] = [];
  if (invalidCount > 0) gateReasons.push(`${invalidCount} invalid case(s)`);
  if (seededCount === 0) gateReasons.push("zero seeded cases");
  if (cleanCount === 0) gateReasons.push("zero clean cases");
  if (reviewErrorFrac > maxFailedFrac) {
    gateReasons.push(
      `review-error fraction ${(reviewErrorFrac * 100).toFixed(0)}% > ${(maxFailedFrac * 100).toFixed(0)}%`,
    );
  }
  if (input.minClean !== undefined && scoredCleanIds.size < input.minClean) {
    gateReasons.push(`scored clean ${scoredCleanIds.size} < --min-clean ${input.minClean}`);
  }
  if (input.minSeeded !== undefined && scoredSeededIds.size < input.minSeeded) {
    gateReasons.push(`scored seeded ${scoredSeededIds.size} < --min-seeded ${input.minSeeded}`);
  }
  if (panelDegraded) {
    gateReasons.push(
      `aggregate panel coverage ${(panelCoverage * 100).toFixed(0)}% < ${COVERAGE_FLOOR * 100}%`,
    );
  }
  if (budget.exceeded) gateReasons.push("provider-call ceiling exhausted");
  if (input.authoritative) {
    if (scoredCount !== validCaseRuns) {
      gateReasons.push(`full case-run coverage required (${scoredCount}/${validCaseRuns})`);
    }
    for (const reviewer of config.phases.review.reviewers) {
      const ok = provScored.get(reviewer.provider) ?? 0;
      if (ok !== validCaseRuns) {
        gateReasons.push(
          `reviewer ${reviewer.provider} coverage ${ok}/${validCaseRuns} (100% required)`,
        );
      }
    }
    if (critic && (critic.eligible === 0 || critic.ran !== critic.eligible)) {
      gateReasons.push(
        `critic coverage ${critic.ran}/${critic.eligible} eligible calls (100% and at least one required)`,
      );
    }
  }

  // Stamp the gate outcome INTO the artifact so a saved result is self-describing:
  // `authoritative` mirrors the exit-0 decision; a degraded run (e.g. a reviewer
  // quota-dry → 0% coverage) records `authoritative:false` with its reasons rather
  // than leaving the signal only in the ephemeral exit code. Computed before the
  // write; the write itself is unchanged (partial data stays legible).
  const gateExitCode: 0 | 3 | 4 = outage ? 3 : gateReasons.length > 0 ? 4 : 0;
  result.verdict = {
    authoritative: gateExitCode === 0,
    gate_exit_code: gateExitCode,
    reasons: outage ? ["no reviewer completed on any case (providers down / quota)"] : gateReasons,
  };

  // Validate + write the result regardless of verdict (partial data stays legible).
  BenchResultSchema.parse(result);
  // Delay directory creation until every provider call has completed: an output
  // path inside the repository must not make an authoritative clean-tree check
  // invalidate itself before the run starts.
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);

  if (outage) {
    return {
      exitCode: 3,
      stdout: "",
      stderr: "bench run: ERROR — no reviewer completed on any case (providers down / quota)\n",
    };
  }

  if (gateReasons.length > 0) {
    return {
      exitCode: 4,
      stdout: `${input.out}\n`,
      stderr: `bench run: benchmark-invalid — ${gateReasons.join("; ")}. Results are non-authoritative.\n`,
    };
  }

  return {
    exitCode: 0,
    stdout: `bench run: ${scoredCount}/${total} cases scored → precision ${aggregate.precision.value}, recall ${aggregate.recall.value}, clean-FP ${aggregate.clean_fp_rate.value}. Wrote ${input.out}\n`,
    stderr: "",
  };
}

// --- bench matrix (spec §8 ablation) ---------------------------------------

/** Legacy CLI labels accepted at the boundary and normalized to the closed policy catalog. */
const MATRIX_ABLATION_ALIASES: Readonly<Record<string, PolicyPassId>> = {
  critic: "judgment.critic",
  "confidence-floor": "judgment.confidence",
  reputation: "judgment.reputation",
  "scope-to-diff": "scope.diff",
};

function normalizeMatrixAblation(value: string): PolicyPassId | null {
  const alias = MATRIX_ABLATION_ALIASES[value];
  if (alias !== undefined) return alias;
  return (POLICY_PASS_IDS as readonly string[]).includes(value) ? (value as PolicyPassId) : null;
}

export interface BenchMatrixInput {
  repoRoot: string;
  corpus: string;
  out: string;
  ablate: string[];
  providers?: ProviderId[] | undefined;
  /** enable the critic in the baseline (required to ablate `critic` meaningfully). */
  criticProvider?: ProviderId;
  criticModel?: string;
  criticOpenrouterProvider?: OpenRouterProviderRouting;
  reviewerOpenrouterProvider?: OpenRouterProviderRouting;
  providerModels?: Partial<Record<ProviderId, string>>;
  criticMaxAttempts?: number;
  reviewerMaxAttempts?: number;
  maxProviderCalls?: number;
  maxOutputTokens?: number;
  authoritative?: boolean;
  preregistration?: string;
  runnerInfo?: BenchRunnerInfo;
  repeat?: number;
  window?: number;
  includeAdvisory?: boolean;
  minClean?: number;
  minSeeded?: number;
  maxFailedFrac?: number;
  adapters?: Partial<Record<ProviderId, ProviderAdapter>>;
  providerAvailable?: (id: ProviderId, apiKeyEnv?: string) => boolean;
  now?: () => Date;
}

export interface BenchPolicyInput {
  repoRoot: string;
  preregistration: string;
  out: string;
  adapters?: Partial<Record<ProviderId, ProviderAdapter>>;
  providerAvailable?: (id: ProviderId, apiKeyEnv?: string) => boolean;
  now?: () => Date;
  /** Internal deterministic test seam; production derives the compiled binary identity. */
  runnerInfo?: BenchRunnerInfo;
  /** Internal boundary spy; semantic validation must finish before this is invoked. */
  adapterFactory?: typeof buildAdapters;
}

function canonicalMatrixCommand(input: BenchMatrixInput): string[] {
  const command = [
    "./dist/reviewgate",
    "bench",
    "matrix",
    "--corpus",
    input.corpus,
    "--providers",
    (input.providers ?? []).join(","),
    "--ablate",
    input.ablate.join(","),
    "--critic",
    input.criticProvider ?? "",
    "--critic-model",
    input.criticModel ?? "",
    "--critic-openrouter-provider",
    input.criticOpenrouterProvider?.only?.[0] ?? "",
    "--repeat",
    String(input.repeat ?? 1),
    "--min-clean",
    String(input.minClean ?? ""),
    "--min-seeded",
    String(input.minSeeded ?? ""),
    "--max-failed-frac",
    String(input.maxFailedFrac ?? 0.1),
  ];
  if (input.criticMaxAttempts !== undefined) {
    command.push("--critic-max-attempts", String(input.criticMaxAttempts));
  }
  if (input.reviewerMaxAttempts !== undefined) {
    command.push("--reviewer-max-attempts", String(input.reviewerMaxAttempts));
  }
  command.push(
    "--max-provider-calls",
    String(input.maxProviderCalls ?? ""),
    "--max-output-tokens",
    String(input.maxOutputTokens ?? ""),
  );
  if (input.window !== undefined) command.push("--window", String(input.window));
  if (input.includeAdvisory) command.push("--include-advisory");
  if (input.authoritative) command.push("--authoritative");
  command.push("--preregistration", input.preregistration ?? "", "--out", input.out);
  return command;
}

/** Compare every result-affecting matrix input with the committed preregistration.
 * Returns reasons only; the caller fails before building/calling provider adapters. */
export function validateMatrixPreregistration(
  input: BenchMatrixInput,
  config: ReviewgateConfig,
  preregistration: unknown,
  corpus: string,
  expectedRelease = `v${RG_VERSION}`,
): string[] {
  const parsed = BenchPreregistrationSchema.safeParse(preregistration);
  if (!parsed.success) {
    return [
      `invalid preregistration: ${parsed.error.issues[0]?.path.join(".") || "root"} ${parsed.error.issues[0]?.message ?? "schema mismatch"}`,
    ];
  }
  const prereg: BenchPreregistration = parsed.data;
  const reasons: string[] = [];
  const expectedCommand = canonicalMatrixCommand(input);
  if (stableJson(prereg.command) !== stableJson(expectedCommand)) {
    reasons.push("command differs from preregistration");
  }
  if (prereg.release !== expectedRelease) reasons.push("release version differs");

  const corpusRoot = resolve(input.repoRoot, corpus);
  let actualCases: LoadedCase[];
  try {
    actualCases = listCaseDirs(corpusRoot).map((id) => loadCase(corpusRoot, id));
  } catch (err) {
    return [
      `cannot verify preregistered corpus: ${err instanceof Error ? err.message : String(err)}`,
    ];
  }
  const actualContent = Object.fromEntries(
    actualCases.map((entry) => [entry.id, entry.contentHash] as const),
  );
  const actualManifest = sha256(JSON.stringify(actualContent));
  const clean = actualCases.filter((entry) => entry.rawKind === "clean").length;
  const seeded = actualCases.filter((entry) => entry.rawKind === "seeded-bug").length;
  const corpusPath = relative(resolve(input.repoRoot), corpusRoot).split("\\").join("/") || ".";
  if (prereg.corpus.path !== corpusPath) reasons.push("corpus path differs");
  if (stableJson(prereg.corpus.content_sha256) !== stableJson(actualContent)) {
    reasons.push("corpus content hashes differ");
  }
  if (prereg.corpus.manifest_sha256 !== actualManifest) reasons.push("corpus manifest differs");
  if (
    prereg.corpus.unique_cases !== actualCases.length ||
    prereg.corpus.clean !== clean ||
    prereg.corpus.seeded_bug !== seeded
  ) {
    reasons.push("corpus composition differs");
  }
  const repeat = input.repeat ?? 1;
  if (
    prereg.corpus.repeats !== repeat ||
    prereg.corpus.correlated_case_runs !== actualCases.length * repeat
  ) {
    reasons.push("repeat/case-run count differs");
  }

  const reviewers = config.phases.review.reviewers.map((reviewer) => ({
    provider: reviewer.provider,
    model: reviewer.model ?? config.providers[reviewer.provider]?.model ?? "unknown",
    persona: reviewer.persona,
  }));
  if (stableJson(prereg.roster.reviewers) !== stableJson(reviewers)) {
    reasons.push("reviewer roster/model/persona differs");
  }
  const critic = config.phases.critic
    ? {
        provider: config.phases.critic.provider,
        model:
          config.phases.critic.model ??
          config.providers[config.phases.critic.provider]?.model ??
          "unknown",
        persona: config.phases.critic.persona,
        openrouter_provider:
          config.phases.critic.provider === "openrouter"
            ? (config.providers.openrouter?.openrouterProvider ?? null)
            : null,
      }
    : null;
  if (stableJson(prereg.roster.critic) !== stableJson(critic)) {
    reasons.push("critic model/route/persona differs");
  }

  if (prereg.hard_gates.maximum_provider_calls !== input.maxProviderCalls) {
    reasons.push("provider-call ceiling differs");
  }
  if (
    (prereg.hard_gates.maximum_critic_attempts_per_eligible_case ?? 1) !==
    (input.criticMaxAttempts ?? 1)
  ) {
    reasons.push("critic-attempt limit differs");
  }
  if (
    (prereg.hard_gates.maximum_reviewer_attempts_per_case ?? 1) !== (input.reviewerMaxAttempts ?? 1)
  ) {
    reasons.push("reviewer-attempt limit differs");
  }
  if (prereg.hard_gates.maximum_openrouter_output_tokens_per_call !== input.maxOutputTokens) {
    reasons.push("output-token ceiling differs");
  }
  if (prereg.hard_gates.maximum_failed_fraction !== (input.maxFailedFrac ?? 0.1)) {
    reasons.push("maximum failed fraction differs");
  }
  if (input.minClean !== prereg.corpus.clean || input.minSeeded !== prereg.corpus.seeded_bug) {
    reasons.push("minimum clean/seeded gates differ");
  }
  if (basename(dirname(input.out)) !== prereg.attempt) {
    reasons.push("output attempt differs from preregistration");
  }
  return reasons;
}

type ThrowableCaptureFailureReason =
  | "unsupported-error-type"
  | "unsupported-thrown-value"
  | "unsupported-field"
  | "sensitive-field"
  | "unsafe-string"
  | "cyclic-value";

export type ThrowableCaptureResult =
  | { ok: true; snapshot: CapturedThrowableSnapshot; sha256: string }
  | { ok: false; reason: ThrowableCaptureFailureReason };

const SENSITIVE_THROW_FIELD =
  /(?:authorization|cookie|credential|password|passwd|secret|token|api[_-]?key|private[_-]?key)/i;
const CAPTURED_THROWABLE_FIELD_KEY_SET = new Set<string>(CAPTURED_THROWABLE_FIELD_KEYS);
const OMITTED_STANDARD_THROWABLE_FIELD_KEYS = new Set([
  "cause",
  "column",
  "line",
  "message",
  "name",
  "originalColumn",
  "originalLine",
  "sourceURL",
  "stack",
]);

type SafeValueCapture =
  | { ok: true; value: import("../../schemas/bench-result.ts").ThrowableSafeValue }
  | { ok: false; reason: ThrowableCaptureFailureReason };

function captureSafeThrowableValue(
  value: unknown,
  seen: Set<object>,
  depth: number,
): SafeValueCapture {
  if (depth > 12) return { ok: false, reason: "unsupported-field" };
  if (value === null || typeof value === "boolean") return { ok: true, value };
  if (typeof value === "string") {
    return isAuthoritativeThrowableString(value)
      ? { ok: true, value }
      : { ok: false, reason: "unsafe-string" };
  }
  if (typeof value === "number" && Number.isFinite(value)) return { ok: true, value };
  if (typeof value !== "object") return { ok: false, reason: "unsupported-field" };
  if (seen.has(value)) return { ok: false, reason: "cyclic-value" };
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const ownKeys = Reflect.ownKeys(value);
      if (
        ownKeys.some((key) => {
          if (typeof key === "symbol") return true;
          if (key === "length") return false;
          const index = Number(key);
          return (
            !Number.isInteger(index) || index < 0 || index >= value.length || String(index) !== key
          );
        })
      ) {
        return { ok: false, reason: "unsupported-field" };
      }
      const captured: import("../../schemas/bench-result.ts").ThrowableSafeValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !("value" in descriptor)) {
          return { ok: false, reason: "unsupported-field" };
        }
        const next = captureSafeThrowableValue(descriptor.value, seen, depth + 1);
        if (!next.ok) return next;
        captured.push(next.value);
      }
      return { ok: true, value: captured };
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return { ok: false, reason: "unsupported-field" };
    }
    const captured: Record<string, import("../../schemas/bench-result.ts").ThrowableSafeValue> = {};
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key === "symbol")) {
      return { ok: false, reason: "unsupported-field" };
    }
    for (const key of (ownKeys as string[]).sort()) {
      if (SENSITIVE_THROW_FIELD.test(key)) return { ok: false, reason: "sensitive-field" };
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        return { ok: false, reason: "unsupported-field" };
      }
      const next = captureSafeThrowableValue(descriptor.value, seen, depth + 1);
      if (!next.ok) return next;
      captured[key] = next.value;
    }
    return { ok: true, value: captured };
  } finally {
    seen.delete(value);
  }
}

function captureThrowableSnapshotInner(
  thrown: unknown,
  seen: Set<object>,
  depth: number,
): ThrowableCaptureResult {
  if (typeof thrown === "string") {
    if (!isAuthoritativeThrowableString(thrown)) {
      return { ok: false, reason: "unsafe-string" };
    }
    const snapshot = {
      kind: "primitive" as const,
      primitive_type: "string" as const,
      value: thrown,
    };
    return { ok: true, snapshot, sha256: sha256(canonicalJson(snapshot)) };
  }
  if (thrown === undefined || thrown === null) {
    const snapshot = {
      kind: "primitive" as const,
      primitive_type: thrown === undefined ? ("undefined" as const) : ("null" as const),
    };
    return { ok: true, snapshot, sha256: sha256(canonicalJson(snapshot)) };
  }
  if (!(thrown instanceof Error)) return { ok: false, reason: "unsupported-thrown-value" };
  if (depth > 12 || seen.has(thrown)) return { ok: false, reason: "cyclic-value" };
  const errorType =
    thrown.constructor === Error
      ? "Error"
      : thrown.constructor === SandboxUnavailableError
        ? "SandboxUnavailableError"
        : null;
  if (errorType === null) return { ok: false, reason: "unsupported-error-type" };
  if (
    !isAuthoritativeThrowableString(thrown.name) ||
    !isAuthoritativeThrowableString(thrown.message)
  ) {
    return { ok: false, reason: "unsafe-string" };
  }
  seen.add(thrown);
  try {
    let cause: CapturedThrowableSnapshot | undefined;
    if (Object.hasOwn(thrown, "cause")) {
      const causeDescriptor = Object.getOwnPropertyDescriptor(thrown, "cause");
      if (causeDescriptor === undefined || !("value" in causeDescriptor)) {
        return { ok: false, reason: "unsupported-field" };
      }
      const capturedCause = captureThrowableSnapshotInner(causeDescriptor.value, seen, depth + 1);
      if (!capturedCause.ok) return capturedCause;
      cause = capturedCause.snapshot;
    }
    const fields: Array<{
      key: string;
      value: import("../../schemas/bench-result.ts").ThrowableSafeValue;
      enumerable: boolean;
    }> = [];
    const ownKeys = Reflect.ownKeys(thrown);
    if (ownKeys.some((key) => typeof key === "symbol")) {
      return { ok: false, reason: "unsupported-field" };
    }
    for (const key of (ownKeys as string[]).sort()) {
      if (OMITTED_STANDARD_THROWABLE_FIELD_KEYS.has(key)) continue;
      if (SENSITIVE_THROW_FIELD.test(key)) return { ok: false, reason: "sensitive-field" };
      const descriptor = Object.getOwnPropertyDescriptor(thrown, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        return { ok: false, reason: "unsupported-field" };
      }
      if (!CAPTURED_THROWABLE_FIELD_KEY_SET.has(key)) {
        return { ok: false, reason: "unsupported-field" };
      }
      const captured = captureSafeThrowableValue(descriptor.value, seen, depth + 1);
      if (!captured.ok) return captured;
      fields.push({ key, value: captured.value, enumerable: descriptor.enumerable ?? false });
    }
    const snapshot: CapturedThrowableSnapshot = {
      kind: "error",
      error_type: errorType,
      name: thrown.name,
      message: thrown.message,
      ...(cause === undefined ? {} : { cause }),
      fields,
    };
    const parsed = CapturedThrowableSnapshotSchema.safeParse(snapshot);
    if (!parsed.success) {
      return { ok: false, reason: "unsupported-field" };
    }
    return { ok: true, snapshot: parsed.data, sha256: sha256(canonicalJson(parsed.data)) };
  } finally {
    seen.delete(thrown);
  }
}

function freezeThrowableSnapshot<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      freezeThrowableSnapshot(child);
    }
    Object.freeze(value);
  }
  return value;
}

export function captureThrowableSnapshot(thrown: unknown): ThrowableCaptureResult {
  const captured = captureThrowableSnapshotInner(thrown, new Set(), 0);
  if (!captured.ok) return captured;
  freezeThrowableSnapshot(captured.snapshot);
  return captured;
}

function cloneThrowableSafeValue<T>(value: T): T {
  return structuredClone(value);
}

export function replayThrowableSnapshot(snapshot: CapturedThrowableSnapshot): unknown {
  if (snapshot.kind === "primitive") {
    if (snapshot.primitive_type === "string") return snapshot.value;
    if (snapshot.primitive_type === "undefined") return undefined;
    return null;
  }
  const error: Error =
    snapshot.error_type === "SandboxUnavailableError"
      ? new SandboxUnavailableError(snapshot.message)
      : new Error(snapshot.message);
  error.name = snapshot.name;
  if (snapshot.cause !== undefined) {
    Object.defineProperty(error, "cause", {
      value: replayThrowableSnapshot(snapshot.cause),
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  for (const field of snapshot.fields) {
    Object.defineProperty(error, field.key, {
      value: cloneThrowableSafeValue(field.value),
      enumerable: field.enumerable,
      configurable: true,
      writable: true,
    });
  }
  return error;
}

export type BenchArtifactKind =
  | "policy-trace"
  | "policy-trace-set"
  | "bench-result"
  | "response-manifest";

export type BenchArtifactVerification =
  | { ok: true; value: unknown }
  | {
      ok: false;
      reason:
        | "invalid-reference"
        | "path-escape"
        | "missing"
        | "not-a-file"
        | "too-large"
        | "hash-mismatch"
        | "invalid-encoding"
        | "invalid-json"
        | "invalid-trace"
        | "invalid-schema"
        | "non-canonical"
        | "identity-mismatch"
        | "read-error";
    };

const BENCH_ARTIFACT_MAX_BYTES = 128 * 1024 * 1024;
const FULL_SHA256 = /^[0-9a-f]{64}$/;

const BENCH_ARTIFACT_TYPES = {
  "bench-result": { directory: "results", schema: BenchResultSchema },
  "response-manifest": { directory: "responses", schema: BenchResponseManifestSchema },
  "policy-trace-set": { directory: "policy-trace-sets", schema: BenchPolicyTraceSetSchema },
} as const;

export function verifyBenchArtifactReference(input: {
  root: string;
  ref: string;
  sha256: string;
  kind: BenchArtifactKind;
}): BenchArtifactVerification {
  if (
    !FULL_SHA256.test(input.sha256) ||
    isAbsolute(input.ref) ||
    input.ref.includes("\\") ||
    input.ref
      .split("/")
      .some((component) => component === "" || component === "." || component === "..")
  ) {
    return { ok: false, reason: "invalid-reference" };
  }
  if (input.kind === "policy-trace") {
    const prefix = "artifacts/policy-traces/";
    if (!input.ref.startsWith(prefix)) return { ok: false, reason: "invalid-reference" };
    const verified = verifyPolicyTraceReference({
      auditDir: join(input.root, "artifacts", "policy-traces"),
      ref: input.ref.slice(prefix.length),
      sha256: input.sha256,
    });
    return verified.ok ? { ok: true, value: verified.trace } : verified;
  }
  if (input.kind === "bench-result") {
    const artifactType = BENCH_ARTIFACT_TYPES["bench-result"];
    return verifyCanonicalJsonArtifact({
      root: input.root,
      directory: artifactType.directory,
      schema: artifactType.schema,
      ref: input.ref,
      sha256: input.sha256,
      maxBytes: BENCH_ARTIFACT_MAX_BYTES,
    });
  }
  if (input.kind === "response-manifest") {
    const artifactType = BENCH_ARTIFACT_TYPES["response-manifest"];
    return verifyCanonicalJsonArtifact({
      root: input.root,
      directory: artifactType.directory,
      schema: artifactType.schema,
      ref: input.ref,
      sha256: input.sha256,
      maxBytes: BENCH_ARTIFACT_MAX_BYTES,
    });
  }
  const artifactType = BENCH_ARTIFACT_TYPES["policy-trace-set"];
  return verifyCanonicalJsonArtifact({
    root: input.root,
    directory: artifactType.directory,
    schema: artifactType.schema,
    ref: input.ref,
    sha256: input.sha256,
    maxBytes: BENCH_ARTIFACT_MAX_BYTES,
  });
}

function ensureDirectoryWithoutSymlinks(path: string): boolean {
  const target = resolve(path);
  const missing: string[] = [];
  let cursor = target;
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) return false;
    missing.unshift(basename(cursor));
    cursor = parent;
  }
  try {
    const existing = lstatSync(cursor);
    if (existing.isSymbolicLink() || !existing.isDirectory()) return false;
    for (const component of missing) {
      cursor = join(cursor, component);
      try {
        mkdirSync(cursor, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
      }
      const created = lstatSync(cursor);
      if (created.isSymbolicLink() || !created.isDirectory()) return false;
    }
    return true;
  } catch {
    return false;
  }
}

type PersistedBenchArtifact = CanonicalArtifactWriteResult;

function persistBenchArtifact(
  input:
    | { root: string; kind: "bench-result"; value: BenchResult }
    | { root: string; kind: "response-manifest"; value: BenchResponseManifest }
    | { root: string; kind: "policy-trace-set"; value: BenchPolicyTraceSet },
): PersistedBenchArtifact {
  if (input.kind === "bench-result") {
    const artifactType = BENCH_ARTIFACT_TYPES["bench-result"];
    return writeCanonicalJsonArtifact({
      root: input.root,
      directory: artifactType.directory,
      schema: artifactType.schema,
      value: input.value,
      maxBytes: BENCH_ARTIFACT_MAX_BYTES,
    });
  }
  if (input.kind === "response-manifest") {
    const artifactType = BENCH_ARTIFACT_TYPES["response-manifest"];
    return writeCanonicalJsonArtifact({
      root: input.root,
      directory: artifactType.directory,
      schema: artifactType.schema,
      value: input.value,
      maxBytes: BENCH_ARTIFACT_MAX_BYTES,
    });
  }
  const artifactType = BENCH_ARTIFACT_TYPES["policy-trace-set"];
  return writeCanonicalJsonArtifact({
    root: input.root,
    directory: artifactType.directory,
    schema: artifactType.schema,
    value: input.value,
    maxBytes: BENCH_ARTIFACT_MAX_BYTES,
  });
}

interface CapturedReviewEntry {
  provider: ProviderId;
  kind: "review" | "complete";
  ordinal: number;
  repeat: number;
  case_id?: string;
  request_sha256: string;
  response_sha256: string;
  raw_response_sha256?: string;
  outcome: "return" | "throw";
  throw_snapshot?: CapturedThrowableSnapshot;
}

type CapturedPreflightEntry =
  | {
      repeat: number;
      request_sha256: string;
      response_sha256: string;
      outcome: "return";
      value: Preflight;
    }
  | {
      repeat: number;
      request_sha256: string;
      response_sha256: string;
      outcome: "throw";
      throw_snapshot: CapturedThrowableSnapshot;
    };

interface ReviewCaptureState {
  entries: CapturedReviewEntry[];
  preflights: Map<ProviderId, CapturedPreflightEntry[]>;
  responses: Map<
    number,
    { kind: "review"; value: ReviewResult } | { kind: "complete"; value: string }
  >;
  throws: Map<number, CapturedThrowableSnapshot>;
  nextOrdinal: number;
  mismatch: string | null;
  context: { repeat: number; caseId?: string };
}

function normalizedReview(result: ReviewResult): ReviewResult {
  return {
    reviewerId: result.reviewerId,
    verdict: result.verdict,
    findings: structuredClone(result.findings),
    usage: structuredClone(result.usage),
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    rawEventsPath: "",
    ...(result.rawText === undefined ? {} : { rawText: result.rawText }),
    status: result.status,
    ...(result.statusDetail ? { statusDetail: result.statusDetail } : {}),
    ...(result.quotaInferred === undefined ? {} : { quotaInferred: result.quotaInferred }),
  };
}

function reviewRequestHash(
  provider: ProviderId,
  ordinal: number,
  input: Parameters<ProviderAdapter["review"]>[0],
): string {
  const prompt = input.promptText ?? readFileSync(input.promptFile, "utf8");
  const diff = readFileSync(input.diffPath, "utf8");
  return sha256(
    stableJson({
      provider,
      ordinal,
      reviewer_id: input.reviewerId,
      persona: input.persona,
      prompt_sha256: sha256(prompt),
      diff_sha256: sha256(diff),
      config: {
        auth: input.cfg.auth,
        model: input.cfg.model,
        reasoningEffort: input.cfg.reasoningEffort ?? null,
        maxTokens: input.cfg.maxTokens ?? null,
        timeoutMs: input.cfg.timeoutMs,
        openrouterProvider: input.cfg.openrouterProvider ?? null,
      },
    }),
  );
}

function completionRequestHash(
  provider: ProviderId,
  ordinal: number,
  prompt: string,
  opts: Parameters<NonNullable<ProviderAdapter["complete"]>>[1],
): string {
  return sha256(
    stableJson({
      provider,
      kind: "complete",
      ordinal,
      prompt_sha256: sha256(prompt),
      options: {
        model: opts.model,
        apiKeyEnv: opts.apiKeyEnv ?? null,
        timeoutMs: opts.timeoutMs ?? null,
        maxTokens: opts.maxTokens ?? null,
        auth: opts.auth ?? null,
        openrouterProvider: opts.openrouterProvider ?? null,
        baseUrl: opts.baseUrl ?? null,
        disableReasoning: opts.disableReasoning ?? null,
      },
    }),
  );
}

function preflightRequestHash(provider: ProviderId, ordinal: number, cfg: ProviderConfig): string {
  return sha256(stableJson({ provider, ordinal, config: cfg }));
}

function captureReviewerAdapters(
  adapters: Partial<Record<ProviderId, ProviderAdapter>>,
  state: ReviewCaptureState,
): Partial<Record<ProviderId, ProviderAdapter>> {
  const out: Partial<Record<ProviderId, ProviderAdapter>> = {};
  for (const [provider, adapter] of Object.entries(adapters) as Array<
    [ProviderId, ProviderAdapter | undefined]
  >) {
    if (!adapter) continue;
    const complete = adapter.complete?.bind(adapter);
    out[provider] = {
      id: adapter.id,
      async preflight(cfg) {
        const entries = state.preflights.get(provider) ?? [];
        state.preflights.set(provider, entries);
        const requestHash = preflightRequestHash(provider, entries.length, cfg);
        try {
          const value = structuredClone(await adapter.preflight(cfg));
          entries.push({
            repeat: state.context.repeat,
            request_sha256: requestHash,
            response_sha256: sha256(stableJson(value)),
            outcome: "return",
            value,
          });
          return structuredClone(value);
        } catch (error) {
          const captured = captureThrowableSnapshot(error);
          if (!captured.ok) {
            state.mismatch ??= `${provider} preflight throw ${entries.length} is not safely reconstructable: ${captured.reason}`;
            throw error;
          }
          entries.push({
            repeat: state.context.repeat,
            request_sha256: requestHash,
            response_sha256: captured.sha256,
            outcome: "throw",
            throw_snapshot: captured.snapshot,
          });
          throw error;
        }
      },
      async review(input) {
        const ordinal = state.nextOrdinal++;
        const requestHash = reviewRequestHash(provider, ordinal, input);
        try {
          const response = normalizedReview(await adapter.review(input));
          const responseHash = sha256(stableJson(response));
          state.responses.set(ordinal, { kind: "review", value: response });
          state.entries.push({
            provider,
            kind: "review",
            ordinal,
            repeat: state.context.repeat,
            ...(state.context.caseId === undefined ? {} : { case_id: state.context.caseId }),
            request_sha256: requestHash,
            response_sha256: responseHash,
            ...(response.rawText === undefined
              ? {}
              : { raw_response_sha256: sha256(response.rawText) }),
            outcome: "return",
          });
          return structuredClone(response);
        } catch (error) {
          const captured = captureThrowableSnapshot(error);
          if (!captured.ok) {
            state.mismatch ??= `${provider} review throw ${ordinal} is not safely reconstructable: ${captured.reason}`;
            throw error;
          }
          state.throws.set(ordinal, captured.snapshot);
          state.entries.push({
            provider,
            kind: "review",
            ordinal,
            repeat: state.context.repeat,
            ...(state.context.caseId === undefined ? {} : { case_id: state.context.caseId }),
            request_sha256: requestHash,
            response_sha256: captured.sha256,
            outcome: "throw",
            throw_snapshot: captured.snapshot,
          });
          throw error;
        }
      },
      ...(complete
        ? {
            async complete(prompt, opts) {
              const ordinal = state.nextOrdinal++;
              const requestHash = completionRequestHash(provider, ordinal, prompt, opts);
              try {
                const response = await complete(prompt, opts);
                state.responses.set(ordinal, { kind: "complete", value: response });
                state.entries.push({
                  provider,
                  kind: "complete",
                  ordinal,
                  repeat: state.context.repeat,
                  ...(state.context.caseId === undefined ? {} : { case_id: state.context.caseId }),
                  request_sha256: requestHash,
                  response_sha256: sha256(response),
                  raw_response_sha256: sha256(response),
                  outcome: "return",
                });
                return response;
              } catch (error) {
                const captured = captureThrowableSnapshot(error);
                if (!captured.ok) {
                  state.mismatch ??= `${provider} complete throw ${ordinal} is not safely reconstructable: ${captured.reason}`;
                  throw error;
                }
                state.throws.set(ordinal, captured.snapshot);
                state.entries.push({
                  provider,
                  kind: "complete",
                  ordinal,
                  repeat: state.context.repeat,
                  ...(state.context.caseId === undefined ? {} : { case_id: state.context.caseId }),
                  request_sha256: requestHash,
                  response_sha256: captured.sha256,
                  outcome: "throw",
                  throw_snapshot: captured.snapshot,
                });
                throw error;
              }
            },
          }
        : {}),
    };
  }
  return out;
}

function replayReviewerAdapters(
  adapters: Partial<Record<ProviderId, ProviderAdapter>>,
  capture: ReviewCaptureState,
): { adapters: Partial<Record<ProviderId, ProviderAdapter>>; consumed: () => boolean } {
  const out: Partial<Record<ProviderId, ProviderAdapter>> = {};
  let cursor = 0;
  const preflightCursors = new Map<ProviderId, number>();
  const mismatch = (message: string): void => {
    capture.mismatch ??= message;
  };
  for (const [provider, adapter] of Object.entries(adapters) as Array<
    [ProviderId, ProviderAdapter | undefined]
  >) {
    if (!adapter) continue;
    out[provider] = {
      id: adapter.id,
      async preflight(cfg) {
        const ordinal = preflightCursors.get(provider) ?? 0;
        preflightCursors.set(provider, ordinal + 1);
        const expected = capture.preflights.get(provider)?.[ordinal];
        const requestHash = preflightRequestHash(provider, ordinal, cfg);
        if (expected === undefined || expected.request_sha256 !== requestHash) {
          mismatch(`${provider} preflight request ${ordinal} did not match baseline identity`);
          throw new Error(capture.mismatch ?? "preflight replay mismatch");
        }
        if (expected.outcome === "throw") {
          if (sha256(canonicalJson(expected.throw_snapshot)) !== expected.response_sha256) {
            mismatch(`${provider} preflight throw ${ordinal} failed snapshot hash validation`);
            throw new Error(capture.mismatch ?? "preflight replay mismatch");
          }
          throw replayThrowableSnapshot(expected.throw_snapshot);
        }
        if (sha256(stableJson(expected.value)) !== expected.response_sha256) {
          mismatch(`${provider} preflight response ${ordinal} failed baseline hash validation`);
          throw new Error(capture.mismatch ?? "preflight replay mismatch");
        }
        return structuredClone(expected.value);
      },
      async review(input) {
        const ordinal = cursor++;
        const requestHash = reviewRequestHash(provider, ordinal, input);
        const expected = capture.entries[ordinal];
        const stored = capture.responses.get(ordinal);
        if (
          !expected ||
          expected.kind !== "review" ||
          expected.provider !== provider ||
          expected.request_sha256 !== requestHash
        ) {
          mismatch(`${provider} review request ${ordinal} did not match baseline order/identity`);
          return {
            reviewerId: input.reviewerId,
            verdict: "ERROR",
            findings: [],
            usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, quotaUsedPct: null },
            durationMs: 0,
            exitCode: 1,
            rawEventsPath: "",
            status: "error",
            statusDetail: capture.mismatch ?? "replay mismatch",
          };
        }
        if (expected.outcome === "throw") {
          const snapshot = capture.throws.get(ordinal);
          if (
            snapshot === undefined ||
            expected.throw_snapshot === undefined ||
            sha256(canonicalJson(snapshot)) !== expected.response_sha256 ||
            canonicalJson(snapshot) !== canonicalJson(expected.throw_snapshot)
          ) {
            mismatch(`${provider} review throw ${ordinal} failed snapshot hash validation`);
            throw new Error(capture.mismatch ?? "replay throw mismatch");
          }
          throw replayThrowableSnapshot(snapshot);
        }
        if (
          stored?.kind !== "review" ||
          sha256(stableJson(stored.value)) !== expected.response_sha256
        ) {
          mismatch(`${provider} review response ${ordinal} failed baseline hash validation`);
          return {
            reviewerId: input.reviewerId,
            verdict: "ERROR",
            findings: [],
            usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, quotaUsedPct: null },
            durationMs: 0,
            exitCode: 1,
            rawEventsPath: "",
            status: "error",
            statusDetail: capture.mismatch ?? "replay response mismatch",
          };
        }
        return structuredClone(stored.value);
      },
      ...(adapter.complete
        ? {
            async complete(prompt, opts) {
              const ordinal = cursor++;
              const requestHash = completionRequestHash(provider, ordinal, prompt, opts);
              const expected = capture.entries[ordinal];
              const stored = capture.responses.get(ordinal);
              if (
                !expected ||
                expected.kind !== "complete" ||
                expected.provider !== provider ||
                expected.request_sha256 !== requestHash
              ) {
                mismatch(
                  `${provider} complete request ${ordinal} did not match baseline order/identity`,
                );
                throw new Error(capture.mismatch ?? "replay mismatch");
              }
              if (expected.outcome === "throw") {
                const snapshot = capture.throws.get(ordinal);
                if (
                  snapshot === undefined ||
                  expected.throw_snapshot === undefined ||
                  sha256(canonicalJson(snapshot)) !== expected.response_sha256 ||
                  canonicalJson(snapshot) !== canonicalJson(expected.throw_snapshot)
                ) {
                  mismatch(`${provider} complete throw ${ordinal} failed snapshot hash validation`);
                  throw new Error(capture.mismatch ?? "replay throw mismatch");
                }
                throw replayThrowableSnapshot(snapshot);
              }
              if (
                stored?.kind !== "complete" ||
                sha256(stored.value) !== expected.response_sha256
              ) {
                mismatch(
                  `${provider} complete response ${ordinal} failed baseline hash validation`,
                );
                throw new Error(capture.mismatch ?? "replay response mismatch");
              }
              return stored.value;
            },
          }
        : {}),
    };
  }
  return {
    adapters: out,
    consumed: () => {
      if (cursor !== capture.entries.length) {
        mismatch(`replay consumed ${cursor}/${capture.entries.length} captured provider responses`);
        return false;
      }
      for (const [provider, preflights] of capture.preflights) {
        const consumed = preflightCursors.get(provider) ?? 0;
        if (consumed !== preflights.length) {
          mismatch(
            `replay consumed ${consumed}/${preflights.length} captured ${provider} preflights`,
          );
          return false;
        }
      }
      return true;
    },
  };
}

function matrixVariantProvenanceMismatch(baseline: BenchResult, variant: BenchResult): string[] {
  const reasons: string[] = [];
  const baseIntegrity = baseline.provenance.integrity;
  const variantIntegrity = variant.provenance.integrity;
  if (baseline.provenance.corpus_commit !== variant.provenance.corpus_commit) {
    reasons.push("variant corpus commit differs from baseline");
  }
  if (baseIntegrity?.source_commit !== variantIntegrity?.source_commit) {
    reasons.push("variant source commit differs from baseline");
  }
  if (baseIntegrity?.repository_dirty !== variantIntegrity?.repository_dirty) {
    reasons.push("variant repository dirty state differs from baseline");
  }
  if (baseIntegrity?.runner_sha256 !== variantIntegrity?.runner_sha256) {
    reasons.push("variant runner hash differs from baseline");
  }
  if (baseIntegrity?.preregistration_sha256 !== variantIntegrity?.preregistration_sha256) {
    reasons.push("variant preregistration hash differs from baseline");
  }
  return reasons;
}

function authoritativeTraceRunFromCase(caseResult: CaseResult): AuthoritativeTraceRun | null {
  const policy = caseResult.policy_trace;
  if (policy === undefined) return null;
  return {
    authoritative: policy.authoritative,
    status: policy.status,
    catalogVersion: policy.catalog_version,
    requestedAblations: [...policy.requested_ablations],
    ...(policy.trace === undefined ? {} : { trace: policy.trace }),
    ...(policy.trace_ref === undefined ? {} : { traceRef: policy.trace_ref }),
    ...(policy.trace_sha256 === undefined ? {} : { traceSha256: policy.trace_sha256 }),
    requestIdentitySha256: policy.request_identity_sha256,
    effectiveConfigSha256: policy.effective_config_sha256,
    finalIdentitySha256: policy.final_identity_sha256,
  };
}

function validateBenchResultTracePairs(
  baseline: BenchResult,
  counterfactual: BenchResult,
  expectedAblations?: readonly PolicyPassId[],
): { ok: true } | { ok: false; reason: string } {
  if (baseline.cases.length !== counterfactual.cases.length) {
    return { ok: false, reason: "case identity mismatch: result cardinality differs" };
  }
  for (const [index, baselineCase] of baseline.cases.entries()) {
    const counterfactualCase = counterfactual.cases[index];
    if (
      counterfactualCase === undefined ||
      baselineCase.id !== counterfactualCase.id ||
      (baselineCase.repeat ?? 1) !== (counterfactualCase.repeat ?? 1) ||
      baselineCase.content_hash !== counterfactualCase.content_hash
    ) {
      return { ok: false, reason: `case identity mismatch at row ${index}` };
    }
    const baselineTrace = authoritativeTraceRunFromCase(baselineCase);
    const counterfactualTrace = authoritativeTraceRunFromCase(counterfactualCase);
    if (baselineTrace === null || counterfactualTrace === null) {
      return { ok: false, reason: `missing-trace: case ${baselineCase.id}` };
    }
    const validation =
      expectedAblations === undefined
        ? validateAuthoritativeTracePair(baselineTrace, counterfactualTrace)
        : validateAuthoritativeTraceProfilePair(
            baselineTrace,
            counterfactualTrace,
            expectedAblations,
          );
    if (!validation.ok) {
      return {
        ok: false,
        reason: `${validation.code}: case ${baselineCase.id}: ${validation.reason}`,
      };
    }
  }
  return { ok: true };
}

function matrixPolicyProvenance(
  result: BenchResult,
  ablatedPassId: PolicyPassId | null,
  traceSet: { ref: string; sha256: string } | null,
) {
  const policyRows = result.cases.map((caseResult) => caseResult.policy_trace);
  const complete =
    traceSet !== null &&
    policyRows.length > 0 &&
    policyRows.every((row) => row?.authoritative === true);
  const rawResponseSha256 = policyRows.flatMap((row) => row?.trace?.raw_response_sha256 ?? []);
  return {
    catalog_version: POLICY_CATALOG_VERSION,
    ablated_pass_id: ablatedPassId,
    trace_status: complete ? ("complete" as const) : ("not-run" as const),
    ...(complete
      ? {
          trace_ref: traceSet.ref,
          trace_sha256: traceSet.sha256,
        }
      : {}),
    raw_response_sha256: rawResponseSha256,
    authoritative: complete,
    reason: complete ? null : "one or more case traces are non-authoritative",
  };
}

function verifyResultTraceArtifacts(
  root: string,
  result: BenchResult,
): { ok: true } | { ok: false; reason: string } {
  for (const row of result.cases) {
    const policy = row.policy_trace;
    if (
      policy?.authoritative !== true ||
      policy.trace === undefined ||
      policy.trace_ref === undefined ||
      policy.trace_sha256 === undefined
    ) {
      return { ok: false, reason: `case ${row.id} has no authoritative persisted trace` };
    }
    const verified = verifyBenchArtifactReference({
      root,
      ref: policy.trace_ref,
      sha256: policy.trace_sha256,
      kind: "policy-trace",
    });
    if (!verified.ok) {
      return { ok: false, reason: `case ${row.id} trace ${verified.reason}` };
    }
    if (canonicalJson(verified.value) !== canonicalJson(policy.trace)) {
      return { ok: false, reason: `case ${row.id} trace embedded identity mismatch` };
    }
  }
  return { ok: true };
}

function publishResultTraces(
  stagingRoot: string,
  outputRoot: string,
  results: readonly BenchResult[],
): { ok: true } | { ok: false; reason: string } {
  if (!ensureDirectoryWithoutSymlinks(join(outputRoot, "artifacts"))) {
    return { ok: false, reason: "trace output path is unsafe" };
  }
  for (const result of results) {
    const staged = verifyResultTraceArtifacts(stagingRoot, result);
    if (!staged.ok) return staged;
    for (const row of result.cases) {
      const policy = row.policy_trace;
      if (
        policy?.trace === undefined ||
        policy.trace_ref === undefined ||
        policy.trace_sha256 === undefined
      ) {
        return { ok: false, reason: `case ${row.id} trace missing before publish` };
      }
      const dateMatch = policy.trace_ref.match(
        /^artifacts\/policy-traces\/(\d{4})\/(\d{2})\/(\d{2})\//,
      );
      if (dateMatch === null) return { ok: false, reason: `case ${row.id} trace ref invalid` };
      const stored = writePolicyTrace({
        auditDir: join(outputRoot, "artifacts", "policy-traces"),
        trace: policy.trace,
        now: new Date(`${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}T00:00:00.000Z`),
      });
      if (
        stored.status !== "complete" ||
        `artifacts/policy-traces/${stored.ref}` !== policy.trace_ref ||
        stored.sha256 !== policy.trace_sha256
      ) {
        return { ok: false, reason: `case ${row.id} trace publish failed` };
      }
    }
  }
  for (const result of results) {
    const published = verifyResultTraceArtifacts(outputRoot, result);
    if (!published.ok) return published;
  }
  return { ok: true };
}

function traceSetRun(
  label: string,
  ablatedPassId: PolicyPassId | null,
  result: BenchResult,
  artifact: { ref: string; sha256: string },
) {
  return {
    label,
    ablated_pass_id: ablatedPassId,
    result: { path: artifact.ref, sha256: artifact.sha256 },
    traces: result.cases.map((row) => {
      const policy = row.policy_trace;
      if (
        policy?.trace === undefined ||
        policy.trace_ref === undefined ||
        policy.trace_sha256 === undefined
      ) {
        throw new Error(`missing persisted policy trace for ${row.id}`);
      }
      return {
        case_id: row.id,
        repeat: row.repeat ?? 1,
        trace_ref: policy.trace_ref,
        trace_sha256: policy.trace_sha256,
        effective_config_sha256: policy.effective_config_sha256,
        request_identity_sha256: policy.request_identity_sha256,
        final_identity_sha256: policy.final_identity_sha256,
        raw_response_sha256: policy.trace.raw_response_sha256,
      };
    }),
  };
}

interface BenchExecutionProfile {
  id: "baseline" | `single:${PolicyPassId}` | `interaction:${number}`;
  ablatedPassIds: readonly PolicyPassId[];
}

const POLICY_BENCH_EXECUTION_PROFILES: readonly BenchExecutionProfile[] = [
  { id: "baseline", ablatedPassIds: [] },
  ...POLICY_PASS_IDS.map((passId) => ({
    id: `single:${passId}` as const,
    ablatedPassIds: [passId] as const,
  })),
  ...POLICY_MEASUREMENT_INTERACTIONS.map((group, index) => ({
    id: `interaction:${index + 1}` as const,
    ablatedPassIds: group,
  })),
];

interface CapturedProfileRun {
  profile: BenchExecutionProfile;
  result: BenchResult;
}

type CapturedProfilesResult =
  | { ok: false; output: BenchRunOutput }
  | { ok: true; runs: CapturedProfileRun[]; capture: ReviewCaptureState };

async function executeCapturedProfileSchedule<T>(input: {
  profiles: readonly BenchExecutionProfile[];
  underlying: Partial<Record<ProviderId, ProviderAdapter>>;
  execute: (
    profile: BenchExecutionProfile,
    adapters: Partial<Record<ProviderId, ProviderAdapter>>,
    live: boolean,
    index: number,
    context: { repeat: number; caseId?: string },
  ) => Promise<T>;
}): Promise<{ values: T[]; capture: ReviewCaptureState }> {
  const firstProfile = input.profiles[0];
  if (firstProfile?.id !== "baseline" || firstProfile.ablatedPassIds.length !== 0) {
    throw new Error("schedule must start with baseline");
  }
  const capture: ReviewCaptureState = {
    entries: [],
    preflights: new Map(),
    responses: new Map(),
    throws: new Map(),
    nextOrdinal: 0,
    mismatch: null,
    context: { repeat: 1 },
  };
  const values = [
    await input.execute(
      firstProfile,
      captureReviewerAdapters(input.underlying, capture),
      true,
      0,
      capture.context,
    ),
  ];
  capture.entries.sort((left, right) => left.ordinal - right.ordinal);
  if (capture.mismatch !== null) throw new Error(capture.mismatch);
  for (const [index, profile] of input.profiles.slice(1).entries()) {
    const replay = replayReviewerAdapters(input.underlying, capture);
    values.push(await input.execute(profile, replay.adapters, false, index + 1, capture.context));
    if (!replay.consumed() || capture.mismatch !== null) {
      throw new Error(capture.mismatch ?? "profile replay was not fully consumed");
    }
  }
  return { values, capture };
}

export const __benchPolicyTest = {
  profiles: POLICY_BENCH_EXECUTION_PROFILES,
  executeCapturedProfileSchedule,
  responseManifestForRepeat,
};

/** Shared live-baseline/offline-profile engine used by legacy Matrix and policy measurement. */
async function runCapturedProfiles(
  input: BenchMatrixInput,
  profiles: readonly BenchExecutionProfile[],
  underlying: Partial<Record<ProviderId, ProviderAdapter>>,
  budget: ProviderCallBudget,
  runnerInfo: BenchRunnerInfo,
  work: string,
  stagingArtifactRoot: string,
): Promise<CapturedProfilesResult> {
  const firstProfile = profiles[0];
  if (firstProfile?.id !== "baseline" || firstProfile.ablatedPassIds.length !== 0) {
    return {
      ok: false,
      output: {
        exitCode: 4,
        stdout: "",
        stderr: "bench profiles: benchmark-invalid — schedule must start with baseline\n",
      },
    };
  }
  const runVariant = async (
    profile: BenchExecutionProfile,
    adapters: Partial<Record<ProviderId, ProviderAdapter>>,
    countProviderCalls: boolean,
    index: number,
    captureContext: { repeat: number; caseId?: string },
  ): Promise<{ result?: BenchResult; output: BenchRunOutput }> => {
    const out = join(work, `profile-${String(index).padStart(2, "0")}.json`);
    const output = await runBenchRunInternal({
      repoRoot: input.repoRoot,
      corpus: input.corpus,
      out,
      ...(input.providers ? { providers: input.providers } : {}),
      ...(input.repeat !== undefined ? { repeat: input.repeat } : {}),
      ...(input.window !== undefined ? { window: input.window } : {}),
      includeAdvisory: input.includeAdvisory ?? false,
      ...(input.minClean !== undefined ? { minClean: input.minClean } : {}),
      ...(input.minSeeded !== undefined ? { minSeeded: input.minSeeded } : {}),
      ...(input.maxFailedFrac !== undefined ? { maxFailedFrac: input.maxFailedFrac } : {}),
      adapters,
      ...(input.providerAvailable ? { providerAvailable: input.providerAvailable } : {}),
      ...(input.now ? { now: input.now } : {}),
      ...(input.criticModel ? { criticModel: input.criticModel } : {}),
      ...(input.criticOpenrouterProvider
        ? { criticOpenrouterProvider: input.criticOpenrouterProvider }
        : {}),
      ...(input.reviewerOpenrouterProvider
        ? { reviewerOpenrouterProvider: input.reviewerOpenrouterProvider }
        : {}),
      ...(input.providerModels ? { providerModels: input.providerModels } : {}),
      ...(input.criticMaxAttempts !== undefined
        ? { criticMaxAttempts: input.criticMaxAttempts }
        : {}),
      ...(input.reviewerMaxAttempts !== undefined
        ? { reviewerMaxAttempts: input.reviewerMaxAttempts }
        : {}),
      ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
      ...(input.maxProviderCalls !== undefined ? { maxProviderCalls: input.maxProviderCalls } : {}),
      ...(input.preregistration ? { preregistration: input.preregistration } : {}),
      authoritative: input.authoritative ?? false,
      callBudget: budget,
      countProviderCalls,
      countCompletionCalls: countProviderCalls,
      runnerInfo,
      suppressors: {
        ...(input.criticProvider ? { critic: input.criticProvider } : {}),
      },
      ablationLabels: [...profile.ablatedPassIds],
      policyExecution: {
        trace: "memory",
        policyAblations: new Set(profile.ablatedPassIds),
        authoritative: true,
      },
      policyTraceStore: {
        root: join(stagingArtifactRoot, "artifacts", "policy-traces"),
        refPrefix: "artifacts/policy-traces",
        ...(input.now === undefined ? {} : { now: input.now() }),
      },
      captureContext,
    });
    if (!existsSync(out)) return { output };
    return {
      result: BenchResultSchema.parse(JSON.parse(readFileSync(out, "utf8"))),
      output,
    };
  };

  let scheduled: {
    values: Array<{ result?: BenchResult; output: BenchRunOutput }>;
    capture: ReviewCaptureState;
  };
  try {
    scheduled = await executeCapturedProfileSchedule({
      profiles,
      underlying,
      execute: runVariant,
    });
  } catch (error) {
    return {
      ok: false,
      output: {
        exitCode: 4,
        stdout: "",
        stderr: `bench profiles: benchmark-invalid — ${error instanceof Error ? error.message : String(error)}\n`,
      },
    };
  }
  const baselineRun = scheduled.values[0];
  if (baselineRun === undefined) {
    return {
      ok: false,
      output: {
        exitCode: 4,
        stdout: "",
        stderr: "bench profiles: benchmark-invalid — baseline output is missing\n",
      },
    };
  }
  if (baselineRun.output.exitCode !== 0 || baselineRun.result === undefined) {
    return { ok: false, output: baselineRun.output };
  }
  const baseline = baselineRun.result;
  const capture = scheduled.capture;
  const runs: CapturedProfileRun[] = [{ profile: firstProfile, result: baseline }];
  for (const [index, profile] of profiles.slice(1).entries()) {
    const variantRun = scheduled.values[index + 1];
    if (
      variantRun === undefined ||
      variantRun.output.exitCode !== 0 ||
      variantRun.result === undefined
    ) {
      return {
        ok: false,
        output: {
          exitCode: variantRun?.output.exitCode === 0 ? 4 : (variantRun?.output.exitCode ?? 4),
          stdout: variantRun?.output.stdout ?? "",
          stderr: variantRun?.output.stderr ?? "bench profiles: missing variant output\n",
        },
      };
    }
    const provenanceMismatch = matrixVariantProvenanceMismatch(baseline, variantRun.result);
    if (provenanceMismatch.length > 0) {
      return {
        ok: false,
        output: {
          exitCode: 4,
          stdout: "",
          stderr: `bench profiles: benchmark-invalid — ${provenanceMismatch.join("; ")}\n`,
        },
      };
    }
    const traceValidation = validateBenchResultTracePairs(
      baseline,
      variantRun.result,
      profile.ablatedPassIds,
    );
    if (!traceValidation.ok) {
      return {
        ok: false,
        output: {
          exitCode: 4,
          stdout: "",
          stderr: `bench profiles: benchmark-invalid — ${traceValidation.reason}\n`,
        },
      };
    }
    runs.push({ profile, result: variantRun.result });
  }
  return { ok: true, runs, capture };
}

function policyInvalid(reasons: readonly string[]): BenchRunOutput {
  return {
    exitCode: 4,
    stdout: "",
    stderr: `bench policy: benchmark-invalid before provider calls — ${reasons.join("; ")}\n`,
  };
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function responseManifestForRepeat(
  capture: ReviewCaptureState,
  repeat: 1 | 2 | 3,
): BenchResponseManifest {
  const preflights = [...capture.preflights.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .flatMap(([provider, entries]) =>
      entries
        .filter((entry) => entry.repeat === repeat)
        .map((entry) => ({
          provider,
          ordinal: 0,
          repeat: entry.repeat,
          request_sha256: entry.request_sha256,
          response_sha256: entry.response_sha256,
          outcome: entry.outcome,
        })),
    )
    .map((entry, ordinal) => ({ ...entry, ordinal }));
  const entries = capture.entries
    .filter((entry) => entry.repeat === repeat)
    .map((entry, ordinal) => ({ ...entry, ordinal }));
  return BenchResponseManifestSchema.parse({
    schema: "reviewgate.bench.provider-response-hashes.v2",
    repeat,
    preflights,
    entries,
  });
}

function policyTraceSetRun(
  run: CapturedProfileRun,
  result: { ref: string; sha256: string },
  repeat: 1 | 2 | 3,
) {
  return {
    profile_id: run.profile.id,
    ablated_pass_ids: [...run.profile.ablatedPassIds],
    result,
    traces: run.result.cases
      .filter((row) => row.repeat === repeat)
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      .map((row) => {
        const policy = row.policy_trace;
        if (
          policy?.trace === undefined ||
          policy.trace_ref === undefined ||
          policy.trace_sha256 === undefined
        ) {
          throw new Error(`missing persisted policy trace for ${row.id} repeat ${repeat}`);
        }
        return {
          case_id: row.id,
          repeat,
          trace_ref: policy.trace_ref,
          trace_sha256: policy.trace_sha256,
          effective_config_sha256: policy.effective_config_sha256,
          request_identity_sha256: policy.request_identity_sha256,
          final_identity_sha256: policy.final_identity_sha256,
          raw_response_sha256: policy.trace.raw_response_sha256,
        };
      }),
  };
}

function profileRepeatAuthority(input: {
  run: CapturedProfileRun;
  repeat: 1 | 2 | 3;
  responseManifest: { ref: string; sha256: string };
  response: BenchResponseManifest;
  result: { ref: string; sha256: string };
  traceSet: { ref: string; sha256: string };
}): PolicyBenchProfileArtifact["repeats"][number] {
  const cases = input.run.result.cases
    .filter((row) => row.repeat === input.repeat)
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const requestedPasses = input.run.profile.ablatedPassIds.map((passId) => {
    let ranCases = 0;
    let opportunities = 0;
    for (const row of cases) {
      const pass = row.policy_trace?.trace?.passes.find(
        (candidate) => candidate.pass_id === passId,
      );
      if (pass?.status === "ran") {
        ranCases += 1;
        opportunities += pass.opportunities;
      }
    }
    return { pass_id: passId, ran_cases: ranCases, opportunities };
  });
  return {
    repeat: input.repeat,
    authoritative: true,
    fully_consumed: true,
    response_manifest: input.responseManifest,
    result: input.result,
    policy_trace_set: input.traceSet,
    ordered_response_sha256: input.response.entries.map((entry) => entry.response_sha256),
    requested_passes: requestedPasses,
    cases: (() => {
      let cursor = 0;
      const authorityCases = cases.map((row) => {
        if (row.policy_truth === undefined) {
          throw new Error(`missing policy truth for ${row.id} repeat ${input.repeat}`);
        }
        const firstOrdinal = cursor;
        while (input.response.entries[cursor]?.case_id === row.id) cursor += 1;
        const entries = input.response.entries.slice(firstOrdinal, cursor);
        const policy = row.policy_trace;
        if (
          entries.length === 0 ||
          policy?.trace === undefined ||
          entries.some(
            (entry) =>
              entry.outcome !== "return" ||
              entry.case_id !== row.id ||
              entry.raw_response_sha256 === undefined,
          ) ||
          !sameCanonical(
            entries.map((entry) => entry.raw_response_sha256),
            policy.trace.raw_response_sha256,
          )
        ) {
          throw new Error(`response manifest does not close ${row.id} repeat ${input.repeat}`);
        }
        return {
          case_id: row.id,
          repeat: input.repeat,
          content_sha256: row.content_hash,
          policy_truth_sha256: sha256(canonicalJson(row.policy_truth)),
          request_identity_sha256: policy.request_identity_sha256,
          response_span: { first_ordinal: firstOrdinal, entry_count: entries.length },
        };
      });
      if (cursor !== input.response.entries.length) {
        throw new Error(`response manifest is not fully consumed for repeat ${input.repeat}`);
      }
      return authorityCases;
    })(),
  };
}

function verifyPolicyBenchResponseClosure(input: {
  profileId: string;
  repeat: 1 | 2 | 3;
  manifest: BenchResponseManifest;
  cases: readonly CaseResult[];
  authorityCases: readonly PolicyBenchProfileArtifact["repeats"][number]["cases"][number][];
}): { ok: true } | { ok: false; reason: string } {
  let cursor = 0;
  for (const [index, row] of input.cases.entries()) {
    const authority = input.authorityCases[index];
    const span = authority?.response_span;
    const policy = row.policy_trace;
    if (
      authority === undefined ||
      authority.request_identity_sha256 === undefined ||
      span === undefined ||
      policy?.trace === undefined ||
      authority.request_identity_sha256 !== policy.request_identity_sha256 ||
      span.first_ordinal !== cursor
    ) {
      return {
        ok: false,
        reason: `${input.profileId} repeat ${input.repeat} response case authority mismatch`,
      };
    }
    const entries = input.manifest.entries.slice(cursor, cursor + span.entry_count);
    if (
      entries.length !== span.entry_count ||
      entries.some(
        (entry, entryIndex) =>
          entry.ordinal !== cursor + entryIndex ||
          entry.case_id !== row.id ||
          entry.outcome !== "return" ||
          entry.raw_response_sha256 === undefined,
      ) ||
      !sameCanonical(
        entries.map((entry) => entry.raw_response_sha256),
        policy.trace.raw_response_sha256,
      )
    ) {
      return {
        ok: false,
        reason: `${input.profileId} repeat ${input.repeat} response manifest case closure mismatch`,
      };
    }
    cursor += span.entry_count;
  }
  return cursor === input.manifest.entries.length
    ? { ok: true }
    : {
        ok: false,
        reason: `${input.profileId} repeat ${input.repeat} response manifest is not fully consumed`,
      };
}

export interface VerifiedPolicyBenchBinding<T> {
  readonly binding: { readonly ref: string; readonly sha256: string };
  readonly value: T;
}

export interface VerifiedPolicyBenchRepeatArtifacts {
  readonly authority: PolicyBenchProfileArtifact["repeats"][number];
  readonly response_manifest: VerifiedPolicyBenchBinding<BenchResponseManifest>;
  readonly repeat_result: VerifiedPolicyBenchBinding<BenchPolicyRepeatResult>;
  readonly source_result: VerifiedPolicyBenchBinding<BenchResult>;
  readonly trace_set: VerifiedPolicyBenchBinding<BenchPolicyProfileTraceSet>;
  readonly traces: readonly VerifiedPolicyBenchBinding<
    NonNullable<CaseResult["policy_trace"]>["trace"]
  >[];
}

export interface VerifiedPolicyBenchProfileArtifacts {
  readonly id: string;
  readonly ablated_pass_ids: readonly PolicyPassId[];
  readonly profile: VerifiedPolicyBenchBinding<PolicyBenchProfileArtifact>;
  readonly repeats: readonly VerifiedPolicyBenchRepeatArtifacts[];
}

export type VerifiedPolicyBenchBundleArtifacts =
  | { ok: true; profiles: readonly VerifiedPolicyBenchProfileArtifacts[] }
  | { ok: false; reason: string };

export function verifyPolicyBenchBundleArtifacts(
  root: string,
  bundle: PolicyBenchBundle,
): VerifiedPolicyBenchBundleArtifacts {
  const profiles: VerifiedPolicyBenchProfileArtifacts[] = [];
  for (const profile of bundle.profiles) {
    const verifiedProfile = verifyCanonicalJsonArtifact({
      root,
      directory: "policy-profiles",
      schema: PolicyBenchProfileArtifactSchema,
      ref: profile.artifact.ref,
      sha256: profile.artifact.sha256,
      maxBytes: BENCH_ARTIFACT_MAX_BYTES,
    });
    if (!verifiedProfile.ok || !sameCanonical(verifiedProfile.value, profile.data)) {
      return {
        ok: false,
        reason: `${profile.id} profile ${verifiedProfile.ok ? "identity-mismatch" : verifiedProfile.reason}`,
      };
    }
    const repeats: VerifiedPolicyBenchRepeatArtifacts[] = [];
    for (const repeat of profile.data.repeats) {
      const response = verifyCanonicalJsonArtifact({
        root,
        directory: "responses",
        schema: BenchResponseManifestSchema,
        ref: repeat.response_manifest.ref,
        sha256: repeat.response_manifest.sha256,
        maxBytes: BENCH_ARTIFACT_MAX_BYTES,
      });
      if (
        !response.ok ||
        response.value.repeat !== repeat.repeat ||
        !sameCanonical(
          response.value.entries.map((entry) => entry.response_sha256),
          repeat.ordered_response_sha256,
        )
      ) {
        return {
          ok: false,
          reason: `${profile.id} repeat ${repeat.repeat} response manifest mismatch`,
        };
      }
      const result = verifyCanonicalJsonArtifact({
        root,
        directory: "policy-repeat-results",
        schema: BenchPolicyRepeatResultSchema,
        ref: repeat.result.ref,
        sha256: repeat.result.sha256,
        maxBytes: BENCH_ARTIFACT_MAX_BYTES,
      });
      if (
        !result.ok ||
        result.value.profile_id !== profile.id ||
        result.value.repeat !== repeat.repeat
      ) {
        return { ok: false, reason: `${profile.id} repeat ${repeat.repeat} result mismatch` };
      }
      const sourceResult = verifyCanonicalJsonArtifact({
        root,
        directory: "results",
        schema: BenchResultSchema,
        ref: result.value.source_result.ref,
        sha256: result.value.source_result.sha256,
        maxBytes: BENCH_ARTIFACT_MAX_BYTES,
      });
      const resultCases = result.value.cases;
      const sourceCases = sourceResult.ok
        ? sourceResult.value.cases
            .filter((row) => row.repeat === repeat.repeat)
            .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
        : [];
      if (
        !sourceResult.ok ||
        sourceResult.value.verdict?.authoritative !== true ||
        !sameCanonical(sourceCases, resultCases) ||
        resultCases.length !== repeat.cases.length ||
        resultCases.some((row, index) => {
          const authority = repeat.cases[index];
          return authority === undefined || !verifyPolicyBenchCaseAuthority(row, authority);
        })
      ) {
        return { ok: false, reason: `${profile.id} repeat ${repeat.repeat} case/truth mismatch` };
      }
      const responseClosure = verifyPolicyBenchResponseClosure({
        profileId: profile.id,
        repeat: repeat.repeat,
        manifest: response.value,
        cases: resultCases,
        authorityCases: repeat.cases,
      });
      if (!responseClosure.ok) return responseClosure;
      for (const requested of repeat.requested_passes) {
        let ran = 0;
        let opportunities = 0;
        for (const row of resultCases) {
          const pass = row.policy_trace?.trace?.passes.find(
            (candidate) => candidate.pass_id === requested.pass_id,
          );
          if (pass?.status === "ran") {
            ran += 1;
            opportunities += pass.opportunities;
          }
        }
        if (ran !== requested.ran_cases || opportunities !== requested.opportunities) {
          return {
            ok: false,
            reason: `${profile.id} repeat ${repeat.repeat} requested-pass authority mismatch`,
          };
        }
      }
      const traceSet = verifyCanonicalJsonArtifact({
        root,
        directory: "policy-trace-sets",
        schema: BenchPolicyProfileTraceSetSchema,
        ref: repeat.policy_trace_set.ref,
        sha256: repeat.policy_trace_set.sha256,
        maxBytes: BENCH_ARTIFACT_MAX_BYTES,
      });
      if (
        !traceSet.ok ||
        traceSet.value.repeat !== repeat.repeat ||
        traceSet.value.response_manifest.sha256 !== repeat.response_manifest.sha256 ||
        !traceSet.value.runs.some(
          (run) =>
            run.profile_id === profile.id &&
            run.result.sha256 === repeat.result.sha256 &&
            sameCanonical(run.ablated_pass_ids, profile.ablated_pass_ids),
        )
      ) {
        return { ok: false, reason: `${profile.id} repeat ${repeat.repeat} trace-set mismatch` };
      }
      const traceSetRun = traceSet.value.runs.find(
        (run) =>
          run.profile_id === profile.id &&
          run.result.sha256 === repeat.result.sha256 &&
          sameCanonical(run.ablated_pass_ids, profile.ablated_pass_ids),
      );
      if (
        traceSetRun === undefined ||
        traceSetRun.traces.length !== resultCases.length ||
        traceSetRun.traces.some((trace, index) => {
          const row = resultCases[index];
          return (
            row === undefined ||
            trace.case_id !== row.id ||
            trace.repeat !== row.repeat ||
            trace.trace_ref !== row.policy_trace?.trace_ref ||
            trace.trace_sha256 !== row.policy_trace?.trace_sha256 ||
            trace.effective_config_sha256 !== row.policy_trace?.effective_config_sha256 ||
            trace.request_identity_sha256 !== row.policy_trace?.request_identity_sha256 ||
            trace.final_identity_sha256 !== row.policy_trace?.final_identity_sha256 ||
            !sameCanonical(trace.raw_response_sha256, row.policy_trace?.trace?.raw_response_sha256)
          );
        })
      ) {
        return { ok: false, reason: `${profile.id} repeat ${repeat.repeat} trace-set mismatch` };
      }
      const traces: VerifiedPolicyBenchRepeatArtifacts["traces"][number][] = [];
      for (const row of resultCases) {
        const policy = row.policy_trace;
        if (
          policy?.trace === undefined ||
          policy.trace_ref === undefined ||
          policy.trace_sha256 === undefined
        ) {
          return { ok: false, reason: `${profile.id} repeat ${repeat.repeat} trace missing` };
        }
        const trace = verifyBenchArtifactReference({
          root,
          ref: policy.trace_ref,
          sha256: policy.trace_sha256,
          kind: "policy-trace",
        });
        if (!trace.ok || !sameCanonical(trace.value, policy.trace)) {
          return { ok: false, reason: `${profile.id} repeat ${repeat.repeat} trace mismatch` };
        }
        traces.push({
          binding: { ref: policy.trace_ref, sha256: policy.trace_sha256 },
          value: policy.trace,
        });
      }
      repeats.push({
        authority: repeat,
        response_manifest: { binding: repeat.response_manifest, value: response.value },
        repeat_result: { binding: repeat.result, value: result.value },
        source_result: { binding: result.value.source_result, value: sourceResult.value },
        trace_set: { binding: repeat.policy_trace_set, value: traceSet.value },
        traces,
      });
    }
    profiles.push({
      id: profile.id,
      ablated_pass_ids: profile.ablated_pass_ids,
      profile: { binding: profile.artifact, value: verifiedProfile.value },
      repeats,
    });
  }
  return { ok: true, profiles };
}

export function verifyPolicyBenchCaseAuthority(
  row: CaseResult,
  authority: PolicyBenchProfileArtifact["repeats"][number]["cases"][number],
): boolean {
  return (
    row.id === authority.case_id &&
    row.repeat === authority.repeat &&
    row.content_hash === authority.content_sha256 &&
    row.policy_truth !== undefined &&
    sha256(canonicalJson(row.policy_truth)) === authority.policy_truth_sha256 &&
    (authority.request_identity_sha256 === undefined ||
      row.policy_trace?.request_identity_sha256 === authority.request_identity_sha256) &&
    row.policy_trace?.authoritative === true
  );
}

function buildPolicyConfig(
  preregistration: PolicyMeasurementPreregistration,
): { config: ReviewgateConfig; matrix: Omit<BenchMatrixInput, "repoRoot" | "out"> } | null {
  const reviewerProviders: ProviderId[] = [];
  const providerModels: Partial<Record<ProviderId, string>> = {};
  for (const reviewer of preregistration.roster.reviewers) {
    if (!KNOWN_PROVIDERS.has(reviewer.provider)) return null;
    const provider = reviewer.provider as ProviderId;
    if (reviewerProviders.includes(provider)) return null;
    reviewerProviders.push(provider);
    providerModels[provider] = reviewer.model;
  }
  const critic = preregistration.roster.critic;
  if (critic !== null && !KNOWN_PROVIDERS.has(critic.provider)) return null;
  const criticProvider = critic?.provider as ProviderId | undefined;
  if (criticProvider !== undefined && critic !== null)
    providerModels[criticProvider] = critic.model;
  const reviewerRoutes = preregistration.roster.reviewers
    .filter((reviewer) => reviewer.provider === "openrouter")
    .map((reviewer) => reviewer.openrouter_provider);
  const reviewerRoute = reviewerRoutes[0] ?? null;
  const criticRoute = critic?.provider === "openrouter" ? critic.openrouter_provider : null;
  if (
    reviewerRoute !== null &&
    criticRoute !== null &&
    !sameCanonical(reviewerRoute, criticRoute)
  ) {
    return null;
  }
  const config = buildBenchConfig({
    providers: reviewerProviders,
    suppressors: { ...(criticProvider === undefined ? {} : { critic: criticProvider }) },
    providerModels,
    ...(critic?.model === undefined ? {} : { criticModel: critic.model }),
    ...(criticRoute === null ? {} : { criticOpenrouterProvider: criticRoute }),
    maxOutputTokens: preregistration.execution.max_output_tokens,
  });
  if (reviewerRoute !== null && config.providers.openrouter) {
    config.providers.openrouter.openrouterProvider = structuredClone(reviewerRoute);
  }
  return {
    config,
    matrix: {
      corpus: preregistration.corpus.path,
      ablate: [],
      providers: reviewerProviders,
      ...(criticProvider === undefined ? {} : { criticProvider }),
      ...(critic?.model === undefined ? {} : { criticModel: critic.model }),
      ...(criticRoute === null ? {} : { criticOpenrouterProvider: criticRoute }),
      ...(reviewerRoute === null ? {} : { reviewerOpenrouterProvider: reviewerRoute }),
      providerModels,
      criticMaxAttempts: preregistration.execution.critic_max_attempts,
      reviewerMaxAttempts: preregistration.execution.reviewer_max_attempts,
      maxProviderCalls: preregistration.hard_gates.maximum_provider_calls,
      maxOutputTokens: preregistration.execution.max_output_tokens,
      authoritative: true,
      repeat: 3,
      minClean: 16,
      minSeeded: 14,
      maxFailedFrac: 0,
    },
  };
}

/**
 * The two persisted configuration identities use their historical encodings: Bench provenance
 * records `JSON.stringify(config)`, whereas every authoritative case trace records canonical JSON.
 * Keep their derivation beside `buildPolicyConfig` so policy assembly can verify both against the
 * exact preregistered execution configuration without reconstructing a competing config authority.
 */
export function policyBenchConfigurationHashes(
  preregistration: PolicyMeasurementPreregistration,
): { provenance: string; effective: string } | null {
  const config = policyBenchEffectiveConfiguration(preregistration);
  if (config === null) return null;
  return {
    provenance: sha256(JSON.stringify(config)),
    effective: sha256(canonicalJson(config)),
  };
}

/** The one preregistration-derived effective config shared by policy execution and assembly. */
export function policyBenchEffectiveConfiguration(
  preregistration: PolicyMeasurementPreregistration,
): ReviewgateConfig | null {
  return buildPolicyConfig(preregistration)?.config ?? null;
}

export function validatePolicyEffectiveConfiguration(
  preregistration: PolicyMeasurementPreregistration,
  config: ReviewgateConfig,
  runtime: {
    reviewerMaxAttempts: number;
    criticMaxAttempts: number;
    maxOutputTokens: number;
    out: string;
  },
): string[] {
  const reasons: string[] = [];
  const effectiveReviewers = config.phases.review.reviewers.map((reviewer) => ({
    provider: reviewer.provider,
    model: config.providers[reviewer.provider]?.model ?? "unknown",
    persona: reviewer.persona,
    openrouter_provider:
      reviewer.provider === "openrouter"
        ? (config.providers.openrouter?.openrouterProvider ?? null)
        : null,
  }));
  const effectiveCritic = config.phases.critic
    ? {
        provider: config.phases.critic.provider,
        model:
          config.phases.critic.model ??
          config.providers[config.phases.critic.provider]?.model ??
          "unknown",
        persona: config.phases.critic.persona,
        openrouter_provider:
          config.phases.critic.provider === "openrouter"
            ? (config.providers.openrouter?.openrouterProvider ?? null)
            : null,
      }
    : null;
  if (!sameCanonical(effectiveReviewers, preregistration.roster.reviewers)) {
    reasons.push("reviewer roster/model/persona/route differs");
  }
  if (!sameCanonical(effectiveCritic, preregistration.roster.critic)) {
    reasons.push("critic model/persona/route differs");
  }
  if (runtime.reviewerMaxAttempts !== preregistration.execution.reviewer_max_attempts) {
    reasons.push("reviewer-attempt limit differs");
  }
  if (runtime.criticMaxAttempts !== preregistration.execution.critic_max_attempts) {
    reasons.push("critic-attempt limit differs");
  }
  if (runtime.maxOutputTokens !== preregistration.execution.max_output_tokens) {
    reasons.push("output-token ceiling differs");
  }
  if (runtime.out !== preregistration.outputs.bench_bundle) {
    reasons.push("Bench output path differs");
  }
  return reasons;
}

/** Execute the exact committed 30×3×23 Slice-2A stateless policy schedule. */
export async function runBenchPolicy(input: BenchPolicyInput): Promise<BenchRunOutput> {
  const repoRoot = resolve(input.repoRoot);
  const outPath = resolve(repoRoot, input.out);
  const outRel = relative(repoRoot, outPath).split("\\").join("/");
  if (outRel === ".." || outRel.startsWith("../") || isAbsolute(outRel)) {
    return policyInvalid(["policy attempt root escapes repository"]);
  }
  if (existsSync(outPath)) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `bench policy: output already exists (immutable): ${outPath}\n`,
    };
  }
  const preregPath = resolve(input.repoRoot, input.preregistration);
  let preregBytes: string;
  let preregistration: PolicyMeasurementPreregistration;
  try {
    const stat = lstatSync(preregPath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
      return policyInvalid(["preregistration is not a regular single-link file"]);
    }
    preregBytes = readFileSync(preregPath, "utf8");
    preregistration = PolicyMeasurementPreregistrationSchema.parse(JSON.parse(preregBytes));
  } catch (error) {
    return policyInvalid([
      `invalid preregistration: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  const reasons: string[] = [];
  if (preregBytes !== canonicalJson(preregistration))
    reasons.push("preregistration is non-canonical");
  if (preregistration.release !== RG_VERSION && preregistration.release !== `v${RG_VERSION}`) {
    reasons.push("release version differs");
  }
  const preregRel = relative(repoRoot, preregPath).split("\\").join("/");
  if (outRel !== preregistration.outputs.bench_bundle) reasons.push("Bench output path differs");
  const expectedCommand = [
    preregistration.source.runner,
    "bench",
    "policy",
    "--preregistration",
    preregRel,
    "--out",
    outRel,
  ];
  if (!sameCanonical(preregistration.commands.bench, expectedCommand)) {
    reasons.push("Bench command differs");
  }
  const corpusRoot = resolve(input.repoRoot, preregistration.corpus.path);
  let loadedCases: LoadedCase[] = [];
  try {
    loadedCases = listCaseDirs(corpusRoot).map((id) => loadCase(corpusRoot, id));
  } catch (error) {
    reasons.push(`cannot verify corpus: ${error instanceof Error ? error.message : String(error)}`);
  }
  const content = Object.fromEntries(
    loadedCases.map((row) => [`cases/${row.id}.json`, row.contentHash] as const),
  );
  if (!sameCanonical(content, preregistration.corpus.content_sha256)) {
    reasons.push("corpus content hashes differ");
  }
  if (sha256(JSON.stringify(content)) !== preregistration.corpus.manifest_sha256) {
    reasons.push("corpus manifest differs");
  }
  if (
    loadedCases.length !== 30 ||
    loadedCases.filter((row) => row.rawKind === "clean").length !== 16 ||
    loadedCases.filter((row) => row.rawKind === "seeded-bug").length !== 14
  ) {
    reasons.push("corpus composition differs");
  }
  const built = buildPolicyConfig(preregistration);
  if (built === null) {
    reasons.push("provider roster or OpenRouter route cannot be represented exactly");
  } else {
    reasons.push(
      ...validatePolicyEffectiveConfiguration(preregistration, built.config, {
        reviewerMaxAttempts: built.matrix.reviewerMaxAttempts ?? 1,
        criticMaxAttempts: built.matrix.criticMaxAttempts ?? 1,
        maxOutputTokens: built.matrix.maxOutputTokens ?? 0,
        out: outRel,
      }),
    );
  }
  const git = await repositoryGitState(input.repoRoot, corpusRoot);
  const preregDigest = await preregistrationDigest(input.repoRoot, git, preregRel);
  const runnerInfo = input.runnerInfo ?? detectRunnerInfo(input.adapters);
  const sourceRef = await spawnCapture("git", ["rev-parse", preregistration.source.ref], {
    cwd: input.repoRoot,
    timeoutMs: 15_000,
  });
  if (
    git.root === null ||
    git.repositoryDirty ||
    git.corpusDirty ||
    !preregDigest.tracked ||
    sourceRef.status !== 0 ||
    sourceRef.stdout.trim() !== git.commit ||
    runnerInfo.kind !== "compiled" ||
    !FULL_SHA256.test(runnerInfo.sha256)
  ) {
    reasons.push("source must be an exact clean tracked HEAD with a compiled runner hash");
  }
  if (reasons.length > 0 || built === null) return policyInvalid(reasons);

  // Reservation begins only after the closed, no-provider preregistration and
  // source/configuration preflight has established the exact registered root.
  const artifactRoot = resolve(repoRoot, preregistration.outputs.attempt_dir);
  if (
    !contained(repoRoot, artifactRoot) ||
    resolve(repoRoot, preregistration.outputs.bench_bundle) !== outPath
  ) {
    return policyInvalid(["registered policy attempt root or Bench output is unsafe"]);
  }
  if (!ensureDirectoryWithoutSymlinks(dirname(artifactRoot))) {
    return policyInvalid(["policy attempt parent path is unsafe"]);
  }
  try {
    mkdirSync(artifactRoot, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return {
        exitCode: 2,
        stdout: "",
        stderr: `bench policy: attempt root already exists (immutable): ${artifactRoot}\n`,
      };
    }
    return policyInvalid(["cannot exclusively reserve policy attempt root"]);
  }
  const reservation = lstatSync(artifactRoot);
  if (
    !reservation.isDirectory() ||
    reservation.isSymbolicLink() ||
    (reservation.mode & 0o7777) !== 0o700
  ) {
    return policyInvalid(["policy attempt root reservation is unsafe"]);
  }
  if (!ensureDirectoryWithoutSymlinks(dirname(outPath))) {
    removeEmptyOwnedAttempt(artifactRoot, reservation);
    return policyInvalid(["registered Bench output parent is unsafe"]);
  }

  const adapterFactory = input.adapterFactory ?? buildAdapters;
  const underlying = adapterFactory(built.config, input.adapters);
  const budget = createCallBudget(preregistration.hard_gates.maximum_provider_calls);
  const work = mkdtempSync(join(tmpdir(), "rg-bench-policy-"));
  const stagingArtifactRoot = join(work, "artifact-root");
  let captureProduced = false;
  try {
    if (!ensureDirectoryWithoutSymlinks(join(stagingArtifactRoot, "artifacts"))) {
      return policyInvalid(["trace staging path is unsafe"]);
    }
    const matrixInput: BenchMatrixInput = {
      repoRoot: input.repoRoot,
      out: input.out,
      preregistration: preregRel,
      ...(input.adapters === undefined ? {} : { adapters: input.adapters }),
      ...(input.providerAvailable ? { providerAvailable: input.providerAvailable } : {}),
      ...(input.now ? { now: input.now } : {}),
      runnerInfo,
      ...built.matrix,
    };
    const captured = await runCapturedProfiles(
      matrixInput,
      POLICY_BENCH_EXECUTION_PROFILES,
      underlying,
      budget,
      runnerInfo,
      work,
      stagingArtifactRoot,
    );
    if (!captured.ok) return captured.output;
    const currentReservation = lstatSync(artifactRoot);
    if (
      !currentReservation.isDirectory() ||
      currentReservation.isSymbolicLink() ||
      currentReservation.dev !== reservation.dev ||
      currentReservation.ino !== reservation.ino
    ) {
      return policyInvalid(["policy attempt root changed before capture publication"]);
    }
    captureProduced = true;
    const publishedTraces = publishResultTraces(
      stagingArtifactRoot,
      artifactRoot,
      captured.runs.map((run) => run.result),
    );
    if (!publishedTraces.ok) return policyInvalid([`policy trace ${publishedTraces.reason}`]);

    const responseArtifacts = new Map<number, { ref: string; sha256: string }>();
    const responseManifests = new Map<number, BenchResponseManifest>();
    for (const repeat of [1, 2, 3] as const) {
      const manifest = responseManifestForRepeat(captured.capture, repeat);
      const artifact = persistBenchArtifact({
        root: artifactRoot,
        kind: "response-manifest",
        value: manifest,
      });
      if (!artifact.ok) return policyInvalid([`response manifest ${artifact.reason}`]);
      responseArtifacts.set(repeat, { ref: artifact.ref, sha256: artifact.sha256 });
      responseManifests.set(repeat, manifest);
    }
    const resultArtifacts = new Map<string, { ref: string; sha256: string }>();
    for (const run of captured.runs) {
      const artifact = persistBenchArtifact({
        root: artifactRoot,
        kind: "bench-result",
        value: run.result,
      });
      if (!artifact.ok) return policyInvalid([`result ${run.profile.id} ${artifact.reason}`]);
      const verified = verifyResultTraceArtifacts(artifactRoot, run.result);
      if (!verified.ok) return policyInvalid([`result ${run.profile.id} ${verified.reason}`]);
      resultArtifacts.set(run.profile.id, { ref: artifact.ref, sha256: artifact.sha256 });
    }
    const repeatResultArtifacts = new Map<
      string,
      Map<1 | 2 | 3, { ref: string; sha256: string }>
    >();
    for (const run of captured.runs) {
      const sourceResult = resultArtifacts.get(run.profile.id);
      if (sourceResult === undefined) throw new Error(`missing source result ${run.profile.id}`);
      const byRepeat = new Map<1 | 2 | 3, { ref: string; sha256: string }>();
      for (const repeat of [1, 2, 3] as const) {
        const repeatResult: BenchPolicyRepeatResult = BenchPolicyRepeatResultSchema.parse({
          schema: "reviewgate.bench.policy-repeat-result.v1",
          profile_id: run.profile.id,
          repeat,
          source_result: sourceResult,
          cases: run.result.cases
            .filter((row) => row.repeat === repeat)
            .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
        });
        const artifact = writeCanonicalJsonArtifact({
          root: artifactRoot,
          directory: "policy-repeat-results",
          schema: BenchPolicyRepeatResultSchema,
          value: repeatResult,
          maxBytes: BENCH_ARTIFACT_MAX_BYTES,
        });
        if (!artifact.ok) {
          return policyInvalid([`repeat result ${run.profile.id}/${repeat} ${artifact.reason}`]);
        }
        byRepeat.set(repeat, { ref: artifact.ref, sha256: artifact.sha256 });
      }
      repeatResultArtifacts.set(run.profile.id, byRepeat);
    }
    const traceSetArtifacts = new Map<number, { ref: string; sha256: string }>();
    for (const repeat of [1, 2, 3] as const) {
      const responseManifest = responseArtifacts.get(repeat);
      if (responseManifest === undefined) throw new Error(`missing response repeat ${repeat}`);
      const traceSet: BenchPolicyProfileTraceSet = BenchPolicyProfileTraceSetSchema.parse({
        schema: "reviewgate.bench.policy-profile-trace-set.v1",
        catalog_version: POLICY_CATALOG_VERSION,
        repeat,
        response_manifest: responseManifest,
        runs: captured.runs.map((run) => {
          const result = repeatResultArtifacts.get(run.profile.id)?.get(repeat);
          if (result === undefined) throw new Error(`missing result ${run.profile.id}`);
          return policyTraceSetRun(run, result, repeat);
        }),
      });
      const artifact = writeCanonicalJsonArtifact({
        root: artifactRoot,
        directory: "policy-trace-sets",
        schema: BenchPolicyProfileTraceSetSchema,
        value: traceSet,
        maxBytes: BENCH_ARTIFACT_MAX_BYTES,
      });
      if (!artifact.ok) return policyInvalid([`policy trace set ${artifact.reason}`]);
      traceSetArtifacts.set(repeat, { ref: artifact.ref, sha256: artifact.sha256 });
    }

    const profiles: PolicyBenchBundle["profiles"] = [];
    for (const run of captured.runs) {
      const data: PolicyBenchProfileArtifact = PolicyBenchProfileArtifactSchema.parse({
        schema: "reviewgate.policy-bench-profile.v1",
        profile_id: run.profile.id,
        ablated_pass_ids: [...run.profile.ablatedPassIds],
        repeats: ([1, 2, 3] as const).map((repeat) => {
          const responseManifest = responseArtifacts.get(repeat);
          const response = responseManifests.get(repeat);
          const traceSet = traceSetArtifacts.get(repeat);
          const result = repeatResultArtifacts.get(run.profile.id)?.get(repeat);
          if (
            responseManifest === undefined ||
            response === undefined ||
            traceSet === undefined ||
            result === undefined
          ) {
            throw new Error(`missing repeat authority ${repeat}`);
          }
          return profileRepeatAuthority({
            run,
            repeat,
            responseManifest,
            response,
            result,
            traceSet,
          });
        }),
      });
      const artifact = writeCanonicalJsonArtifact({
        root: artifactRoot,
        directory: "policy-profiles",
        schema: PolicyBenchProfileArtifactSchema,
        value: data,
        maxBytes: BENCH_ARTIFACT_MAX_BYTES,
      });
      if (!artifact.ok)
        return policyInvalid([`policy profile ${run.profile.id} ${artifact.reason}`]);
      profiles.push({
        id: run.profile.id,
        ablated_pass_ids: [...run.profile.ablatedPassIds],
        artifact: { ref: artifact.ref, sha256: artifact.sha256 },
        data,
      });
    }
    const bundle: PolicyBenchBundle = PolicyBenchBundleSchema.parse({
      schema: "reviewgate.policy-bench-bundle.v1",
      preregistration: { ref: preregRel, sha256: sha256(preregBytes) },
      profiles,
    });
    const verifiedBundle = verifyPolicyBenchBundleArtifacts(artifactRoot, bundle);
    if (!verifiedBundle.ok) return policyInvalid([verifiedBundle.reason]);
    const bundleArtifact = writeCanonicalJsonArtifact({
      root: artifactRoot,
      directory: "policy-bundles",
      schema: PolicyBenchBundleSchema,
      value: bundle,
      maxBytes: BENCH_ARTIFACT_MAX_BYTES,
    });
    if (!bundleArtifact.ok) return policyInvalid([`policy bundle ${bundleArtifact.reason}`]);
    if (!ensureDirectoryWithoutSymlinks(artifactRoot)) {
      return policyInvalid(["output path is not a safe directory"]);
    }
    if (!writeFileIfAbsent(outPath, canonicalJson(bundle), { mode: 0o600 })) {
      return {
        exitCode: 2,
        stdout: "",
        stderr: `bench policy: output already exists (immutable): ${outPath}\n`,
      };
    }
    return { exitCode: 0, stdout: `${input.out}\n`, stderr: "" };
  } catch (error) {
    return policyInvalid([
      `execution artifact mismatch: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  } finally {
    if (!captureProduced) removeEmptyOwnedAttempt(artifactRoot, reservation);
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Ablation matrix (spec §8): run the corpus once as a BASELINE (full suppression)
 * and once per `--ablate` layer with that ONE layer turned off, then report the
 * per-layer Δ (baseline − ablated). Reuses `runBenchRun` per variant (each to a
 * temp file) so the scoring path is identical.
 */
export async function runBenchMatrix(input: BenchMatrixInput): Promise<BenchRunOutput> {
  if (input.ablate.length === 0) {
    return { exitCode: 2, stdout: "", stderr: "bench matrix: --ablate needs at least one layer\n" };
  }
  const normalizedAblations = input.ablate.map(normalizeMatrixAblation);
  const unknown = input.ablate.filter((_value, index) => normalizedAblations[index] === null);
  if (unknown.length > 0) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `bench matrix: unknown ablation(s): ${unknown.join(",")} (known catalog IDs plus aliases: ${Object.keys(MATRIX_ABLATION_ALIASES).join(",")})\n`,
    };
  }
  const ablatedPassIds = normalizedAblations.filter(
    (value): value is PolicyPassId => value !== null,
  );
  if (new Set(ablatedPassIds).size !== ablatedPassIds.length) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: "bench matrix: duplicate ablations resolve to the same policy catalog ID\n",
    };
  }
  if (ablatedPassIds.includes("judgment.critic") && !input.criticProvider) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: "bench matrix: --ablate critic requires --critic\n",
    };
  }
  const baselineSuppressors: SuppressorConfig = {
    ...(input.criticProvider ? { critic: input.criticProvider } : {}),
  };
  const matrixPath = resolve(input.repoRoot, input.out);
  const artifactDir = dirname(matrixPath);
  if (existsSync(matrixPath)) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `bench matrix: output already exists (immutable): ${matrixPath}\n`,
    };
  }

  let baselineConfig: ReviewgateConfig;
  try {
    baselineConfig = buildBenchConfig({
      ...(input.providers ? { providers: input.providers } : {}),
      suppressors: baselineSuppressors,
      ...(input.criticModel ? { criticModel: input.criticModel } : {}),
      ...(input.criticOpenrouterProvider
        ? { criticOpenrouterProvider: input.criticOpenrouterProvider }
        : {}),
      ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
    });
  } catch (err) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `bench matrix: ${err instanceof Error ? err.message : String(err)}\n`,
    };
  }
  if (input.authoritative) {
    if (!input.preregistration) {
      return {
        exitCode: 4,
        stdout: "",
        stderr:
          "bench matrix: benchmark-invalid before provider calls — preregistration mismatch: no preregistration supplied\n",
      };
    }
    let preregistration: unknown;
    try {
      preregistration = JSON.parse(
        readFileSync(resolve(input.repoRoot, input.preregistration), "utf8"),
      );
    } catch (err) {
      return {
        exitCode: 4,
        stdout: "",
        stderr: `bench matrix: benchmark-invalid before provider calls — preregistration mismatch: ${err instanceof Error ? err.message : String(err)}\n`,
      };
    }
    const preregistrationReasons = validateMatrixPreregistration(
      input,
      baselineConfig,
      preregistration,
      input.corpus,
    );
    if (preregistrationReasons.length > 0) {
      return {
        exitCode: 4,
        stdout: "",
        stderr: `bench matrix: benchmark-invalid before provider calls — preregistration mismatch: ${preregistrationReasons.join("; ")}\n`,
      };
    }
  }
  const underlying = buildAdapters(baselineConfig, input.adapters);
  const budget = createCallBudget(input.maxProviderCalls);
  const runnerInfo = input.runnerInfo ?? detectRunnerInfo(input.adapters);
  const work = mkdtempSync(join(tmpdir(), "rg-bench-matrix-"));
  const stagingArtifactRoot = join(work, "artifact-root");
  try {
    if (!ensureDirectoryWithoutSymlinks(join(stagingArtifactRoot, "artifacts"))) {
      return {
        exitCode: 4,
        stdout: "",
        stderr: "bench matrix: benchmark-invalid — trace staging path is unsafe\n",
      };
    }
    const profiles: BenchExecutionProfile[] = [
      { id: "baseline", ablatedPassIds: [] },
      ...ablatedPassIds.map((passId) => ({
        id: `single:${passId}` as const,
        ablatedPassIds: [passId] as const,
      })),
    ];
    const captured = await runCapturedProfiles(
      input,
      profiles,
      underlying,
      budget,
      runnerInfo,
      work,
      stagingArtifactRoot,
    );
    if (!captured.ok) return captured.output;
    const capture = captured.capture;
    const baseline = captured.runs[0]?.result;
    if (baseline === undefined) throw new Error("captured Matrix is missing its baseline");
    const manifest = BenchResponseManifestSchema.parse({
      schema: "reviewgate.bench.provider-response-hashes.v2",
      entries: [...capture.entries],
    });
    const executed: Array<{
      label: string;
      passId: PolicyPassId | null;
      result: BenchResult;
    }> = captured.runs.map((run, index) => ({
      label: index === 0 ? "baseline" : `-${run.profile.ablatedPassIds[0]}`,
      passId: index === 0 ? null : (run.profile.ablatedPassIds[0] ?? null),
      result: run.result,
    }));

    const publishedTraces = publishResultTraces(
      stagingArtifactRoot,
      artifactDir,
      executed.map((run) => run.result),
    );
    if (!publishedTraces.ok) {
      return {
        exitCode: 4,
        stdout: "",
        stderr: `bench matrix: benchmark-invalid — policy trace artifact ${publishedTraces.reason}\n`,
      };
    }
    const responseArtifact = persistBenchArtifact({
      root: artifactDir,
      kind: "response-manifest",
      value: manifest,
    });
    if (!responseArtifact.ok) {
      return {
        exitCode: 4,
        stdout: "",
        stderr: `bench matrix: benchmark-invalid — response manifest ${responseArtifact.reason}\n`,
      };
    }
    const resultArtifacts = new Map<string, { ref: string; sha256: string }>();
    for (const run of executed) {
      const artifact = persistBenchArtifact({
        root: artifactDir,
        kind: "bench-result",
        value: run.result,
      });
      if (!artifact.ok) {
        return {
          exitCode: 4,
          stdout: "",
          stderr: `bench matrix: benchmark-invalid — result ${run.label} ${artifact.reason}\n`,
        };
      }
      const traceVerification = verifyResultTraceArtifacts(artifactDir, run.result);
      if (!traceVerification.ok) {
        return {
          exitCode: 4,
          stdout: "",
          stderr: `bench matrix: benchmark-invalid — ${traceVerification.reason}\n`,
        };
      }
      resultArtifacts.set(run.label, { ref: artifact.ref, sha256: artifact.sha256 });
    }
    const traceSet = BenchPolicyTraceSetSchema.parse({
      schema: "reviewgate.bench.policy-trace-set.v1",
      catalog_version: POLICY_CATALOG_VERSION,
      response_manifest: {
        path: responseArtifact.ref,
        sha256: responseArtifact.sha256,
      },
      runs: executed.map((run) => {
        const artifact = resultArtifacts.get(run.label);
        if (artifact === undefined) throw new Error(`missing result artifact for ${run.label}`);
        return traceSetRun(run.label, run.passId, run.result, artifact);
      }),
    });
    const traceSetArtifact = persistBenchArtifact({
      root: artifactDir,
      kind: "policy-trace-set",
      value: traceSet,
    });
    if (!traceSetArtifact.ok) {
      return {
        exitCode: 4,
        stdout: "",
        stderr: `bench matrix: benchmark-invalid — policy trace set ${traceSetArtifact.reason}\n`,
      };
    }
    const finalResponseVerification = verifyBenchArtifactReference({
      root: artifactDir,
      ref: responseArtifact.ref,
      sha256: responseArtifact.sha256,
      kind: "response-manifest",
    });
    if (
      !finalResponseVerification.ok ||
      canonicalJson(finalResponseVerification.value) !== canonicalJson(manifest)
    ) {
      return {
        exitCode: 4,
        stdout: "",
        stderr: `bench matrix: benchmark-invalid — response manifest final verification ${finalResponseVerification.ok ? "identity-mismatch" : finalResponseVerification.reason}\n`,
      };
    }
    for (const run of executed) {
      const artifact = resultArtifacts.get(run.label);
      if (artifact === undefined) throw new Error(`missing result artifact for ${run.label}`);
      const finalResultVerification = verifyBenchArtifactReference({
        root: artifactDir,
        ref: artifact.ref,
        sha256: artifact.sha256,
        kind: "bench-result",
      });
      const finalTraceVerification = verifyResultTraceArtifacts(artifactDir, run.result);
      if (
        !finalResultVerification.ok ||
        canonicalJson(finalResultVerification.value) !== canonicalJson(run.result) ||
        !finalTraceVerification.ok
      ) {
        const reason = !finalResultVerification.ok
          ? finalResultVerification.reason
          : !finalTraceVerification.ok
            ? finalTraceVerification.reason
            : "identity-mismatch";
        return {
          exitCode: 4,
          stdout: "",
          stderr: `bench matrix: benchmark-invalid — result ${run.label} final verification ${reason}\n`,
        };
      }
    }
    const finalTraceSetVerification = verifyBenchArtifactReference({
      root: artifactDir,
      ref: traceSetArtifact.ref,
      sha256: traceSetArtifact.sha256,
      kind: "policy-trace-set",
    });
    if (
      !finalTraceSetVerification.ok ||
      canonicalJson(finalTraceSetVerification.value) !== canonicalJson(traceSet)
    ) {
      return {
        exitCode: 4,
        stdout: "",
        stderr: `bench matrix: benchmark-invalid — policy trace set final verification ${finalTraceSetVerification.ok ? "identity-mismatch" : finalTraceSetVerification.reason}\n`,
      };
    }
    const traceSetIdentity = { ref: traceSetArtifact.ref, sha256: traceSetArtifact.sha256 };
    const dv = (b: Metric, v: Metric): number => (b.value ?? 0) - (v.value ?? 0);
    const variants: MatrixVariant[] = executed.map((run) => {
      const artifact = resultArtifacts.get(run.label);
      if (artifact === undefined) throw new Error(`missing result artifact for ${run.label}`);
      const baselineRow = run.passId === null;
      return {
        label: run.label,
        ablation: run.passId ?? "",
        class: baselineRow ? "baseline" : "A",
        precision: run.result.aggregate.precision,
        recall: run.result.aggregate.recall,
        clean_fp_rate: run.result.aggregate.clean_fp_rate,
        delta: baselineRow
          ? null
          : {
              precision: dv(baseline.aggregate.precision, run.result.aggregate.precision),
              recall: dv(baseline.aggregate.recall, run.result.aggregate.recall),
              clean_fp_rate: dv(
                baseline.aggregate.clean_fp_rate,
                run.result.aggregate.clean_fp_rate,
              ),
            },
        authoritative: isAuthoritative(run.result).ok,
        result_ref: artifact.ref,
        result_sha256: artifact.sha256,
        policy: matrixPolicyProvenance(run.result, run.passId, traceSetIdentity),
      };
    });
    const allAuthoritative = variants.every((variant) => variant.authoritative === true);
    const baselineArtifact = resultArtifacts.get("baseline");
    if (baselineArtifact === undefined) throw new Error("missing baseline result artifact");
    const matrix: BenchMatrix = {
      schema: "reviewgate.bench.matrix.v1",
      provenance: baseline.provenance,
      variants,
      authoritative: allAuthoritative,
      artifacts: {
        baseline: {
          path: baselineArtifact.ref,
          sha256: baselineArtifact.sha256,
        },
        variants: executed.slice(1).map((run) => {
          const artifact = resultArtifacts.get(run.label);
          if (artifact === undefined) throw new Error(`missing result artifact for ${run.label}`);
          return { path: artifact.ref, sha256: artifact.sha256 };
        }),
        reviewer_responses: {
          path: responseArtifact.ref,
          sha256: responseArtifact.sha256,
        },
        policy_trace_set: {
          path: traceSetArtifact.ref,
          sha256: traceSetArtifact.sha256,
        },
      },
    };
    BenchMatrixSchema.parse(matrix);
    if (!ensureDirectoryWithoutSymlinks(artifactDir)) {
      return {
        exitCode: 4,
        stdout: "",
        stderr: "bench matrix: benchmark-invalid — output path is not a safe directory\n",
      };
    }
    const matrixCreated = writeFileIfAbsent(matrixPath, canonicalJson(matrix), { mode: 0o600 });
    if (!matrixCreated) {
      return {
        exitCode: 2,
        stdout: "",
        stderr: `bench matrix: output already exists (immutable): ${matrixPath}\n`,
      };
    }
    if (input.authoritative && !allAuthoritative) {
      return {
        exitCode: 4,
        stdout: `${input.out}\n`,
        stderr: "bench matrix: benchmark-invalid — one or more variants are non-authoritative\n",
      };
    }
    return { exitCode: 0, stdout: `${renderBenchMatrix(matrix)}\n`, stderr: "" };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
