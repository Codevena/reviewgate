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
import type { MatchResult } from "../../bench/matcher.ts";
import { makeMetric, summarizeSpread } from "../../bench/metrics.ts";
import { isAuthoritative, renderBenchMatrix, renderBenchReport } from "../../bench/report.ts";
import {
  type CaseRunOutcome,
  type SuppressorConfig,
  buildBenchConfig,
  runBenchCase,
} from "../../bench/runner.ts";
import type { ReviewgateConfig } from "../../config/define-config.ts";
import type {
  OpenRouterProviderRouting,
  ProviderAdapter,
  ProviderConfig,
  ReviewResult,
} from "../../providers/adapter-base.ts";
import type { ProviderId } from "../../providers/registry.ts";
import { type BenchCase, BenchCaseSchema } from "../../schemas/bench-case.ts";
import {
  type BenchPreregistration,
  BenchPreregistrationSchema,
} from "../../schemas/bench-preregistration.ts";
import {
  type BenchMatrix,
  BenchMatrixSchema,
  type BenchResult,
  BenchResultSchema,
  type CaseResult,
  type Cost,
  type MatrixVariant,
  type Metric,
  type ProviderResult,
} from "../../schemas/bench-result.ts";
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
  /** Benchmark-only physical critic completion limit; runtime default remains 1. */
  criticMaxAttempts?: number;
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

function sha256(s: string): string {
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
): Partial<Record<ProviderId, ProviderAdapter>> {
  const wrapped: Partial<Record<ProviderId, ProviderAdapter>> = {};
  for (const [rawId, adapter] of Object.entries(adapters) as Array<
    [ProviderId, ProviderAdapter | undefined]
  >) {
    if (!adapter) continue;
    const complete = adapter.complete?.bind(adapter);
    const common = {
      id: adapter.id,
      preflight: (cfg: ProviderConfig) => adapter.preflight(cfg),
      review: async (input: Parameters<ProviderAdapter["review"]>[0]) => {
        if (countReviewCalls) consumeProviderCall(budget, rawId);
        return adapter.review({
          ...input,
          // One recorded benchmark call must equal one physical provider call.
          disableRetries: true,
          cfg: rawId === "openrouter" ? capOpenRouterConfig(input.cfg, maxOutputTokens) : input.cfg,
        });
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

async function buildRoster(
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
      ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
    });
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
  );

  // --- run every case, `repeat` times (repeats OUTER so per-repeat metrics group) ---
  const caseResults: CaseResult[] = [];
  // per-provider RAW accumulation POOLED across all case-runs (every repeat)
  const provScored = new Map<string, number>(); // # scored case-runs where provider was OK
  const provMatches = new Map<string, MatchResult[]>();
  let scoredCount = 0;

  for (let r = 1; r <= repeat; r++) {
    for (const loaded of loadedCases) {
      if (loaded.benchCase === null) {
        caseResults.push(invalidCaseResult(loaded, panelConfigured, r));
        continue;
      }
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

/** The ablatable layers → the suppressor override that turns each OFF, tagged by
 * class (A = post-review suppressor; B = input/prompt-stage). `scopeToDiff` is
 * applied by the aggregator after raw reviews, so it is class A in production. */
const MATRIX_ABLATIONS: Record<string, { klass: "A" | "B"; off: SuppressorConfig }> = {
  critic: { klass: "A", off: { critic: null } },
  "confidence-floor": { klass: "A", off: { confidenceFloor: 0 } },
  reputation: { klass: "A", off: { reputation: false } },
  "scope-to-diff": { klass: "A", off: { scopeToDiff: false } },
};

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
  criticMaxAttempts?: number;
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
  if (prereg.release !== `v${RG_VERSION}`) reasons.push("release version differs");

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

interface CapturedReviewEntry {
  provider: ProviderId;
  reviewer_id: string;
  ordinal: number;
  request_sha256: string;
  response_sha256: string;
}

interface ReviewCaptureState {
  entries: CapturedReviewEntry[];
  responses: Map<string, ReviewResult>;
  ordinals: Map<ProviderId, number>;
  mismatch: string | null;
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
    status: result.status,
    ...(result.statusDetail ? { statusDetail: result.statusDetail } : {}),
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

function captureReviewerAdapters(
  adapters: Partial<Record<ProviderId, ProviderAdapter>>,
  reviewers: ReadonlySet<ProviderId>,
  state: ReviewCaptureState,
): Partial<Record<ProviderId, ProviderAdapter>> {
  const out: Partial<Record<ProviderId, ProviderAdapter>> = { ...adapters };
  for (const provider of reviewers) {
    const adapter = adapters[provider];
    if (!adapter) continue;
    const complete = adapter.complete?.bind(adapter);
    out[provider] = {
      id: adapter.id,
      preflight: (cfg) => adapter.preflight(cfg),
      async review(input) {
        const ordinal = (state.ordinals.get(provider) ?? 0) + 1;
        state.ordinals.set(provider, ordinal);
        const requestHash = reviewRequestHash(provider, ordinal, input);
        const response = normalizedReview(await adapter.review(input));
        const responseHash = sha256(stableJson(response));
        state.responses.set(requestHash, response);
        state.entries.push({
          provider,
          reviewer_id: input.reviewerId,
          ordinal,
          request_sha256: requestHash,
          response_sha256: responseHash,
        });
        return structuredClone(response);
      },
      ...(complete ? { complete: (prompt, opts) => complete(prompt, opts) } : {}),
    };
  }
  return out;
}

function replayReviewerAdapters(
  adapters: Partial<Record<ProviderId, ProviderAdapter>>,
  reviewers: ReadonlySet<ProviderId>,
  capture: ReviewCaptureState,
): Partial<Record<ProviderId, ProviderAdapter>> {
  const out: Partial<Record<ProviderId, ProviderAdapter>> = { ...adapters };
  const ordinals = new Map<ProviderId, number>();
  for (const provider of reviewers) {
    const adapter = adapters[provider];
    if (!adapter) continue;
    const complete = adapter.complete?.bind(adapter);
    out[provider] = {
      id: adapter.id,
      preflight: (cfg) => adapter.preflight(cfg),
      async review(input) {
        const ordinal = (ordinals.get(provider) ?? 0) + 1;
        ordinals.set(provider, ordinal);
        const requestHash = reviewRequestHash(provider, ordinal, input);
        const expected = capture.entries.find(
          (entry) => entry.provider === provider && entry.ordinal === ordinal,
        );
        const response = expected ? capture.responses.get(expected.request_sha256) : undefined;
        if (!expected || expected.request_sha256 !== requestHash || !response) {
          capture.mismatch = `${provider} reviewer request ${ordinal} did not match baseline`;
          return {
            reviewerId: input.reviewerId,
            verdict: "ERROR",
            findings: [],
            usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, quotaUsedPct: null },
            durationMs: 0,
            exitCode: 1,
            rawEventsPath: "",
            status: "error",
            statusDetail: capture.mismatch,
          };
        }
        return structuredClone(response);
      },
      ...(complete ? { complete: (prompt, opts) => complete(prompt, opts) } : {}),
    };
  }
  return out;
}

function relativeArtifact(fromDir: string, path: string): string {
  return relative(fromDir, path).split("\\").join("/");
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
  const unknown = input.ablate.filter((a) => !(a in MATRIX_ABLATIONS));
  if (unknown.length > 0) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `bench matrix: unknown ablation(s): ${unknown.join(",")} (known: ${Object.keys(MATRIX_ABLATIONS).join(",")})\n`,
    };
  }
  if (input.authoritative && (input.ablate.length !== 1 || input.ablate[0] !== "critic")) {
    return {
      exitCode: 2,
      stdout: "",
      stderr:
        "bench matrix: authoritative paired mode currently supports exactly --ablate critic\n",
    };
  }
  if (input.ablate.includes("critic") && !input.criticProvider) {
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
  const baselinePath = join(artifactDir, "baseline.result.json");
  const responseManifestPath = join(artifactDir, "reviewer-responses.sha256.json");
  const variantPaths = new Map(
    input.ablate.map((layer) => [layer, join(artifactDir, `no-${layer}.result.json`)]),
  );
  for (const path of [matrixPath, baselinePath, responseManifestPath, ...variantPaths.values()]) {
    if (existsSync(path)) {
      return {
        exitCode: 2,
        stdout: "",
        stderr: `bench matrix: output already exists (immutable): ${path}\n`,
      };
    }
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
  // Capture the whole declared slot chain, not just primaries. A quota response
  // from a primary can make a fallback the actual reviewer; replaying only the
  // primary would silently call that fallback live in every matrix variant.
  const reviewerIds = new Set(
    baselineConfig.phases.review.reviewers.flatMap((reviewer) => [
      reviewer.provider,
      ...(reviewer.fallback ?? []),
    ]),
  );
  const underlying = buildAdapters(baselineConfig, input.adapters);
  const capture: ReviewCaptureState = {
    entries: [],
    responses: new Map(),
    ordinals: new Map(),
    mismatch: null,
  };
  const capturingAdapters = captureReviewerAdapters(underlying, reviewerIds, capture);
  const budget = createCallBudget(input.maxProviderCalls);
  const runnerInfo = input.runnerInfo ?? detectRunnerInfo(input.adapters);
  const work = mkdtempSync(join(tmpdir(), "rg-bench-matrix-"));
  try {
    const runVariant = async (
      label: string,
      suppressors: SuppressorConfig,
      ablationLabels: string[],
      adapters: Partial<Record<ProviderId, ProviderAdapter>>,
      countProviderCalls: boolean,
    ): Promise<{ result?: BenchResult; output: BenchRunOutput; tempPath: string }> => {
      const out = join(work, `${label}.json`);
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
        ...(input.criticMaxAttempts !== undefined
          ? { criticMaxAttempts: input.criticMaxAttempts }
          : {}),
        ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
        ...(input.maxProviderCalls !== undefined
          ? { maxProviderCalls: input.maxProviderCalls }
          : {}),
        ...(input.preregistration ? { preregistration: input.preregistration } : {}),
        authoritative: input.authoritative ?? false,
        callBudget: budget,
        countProviderCalls,
        // Reviewer samples are replayed in-memory, but non-critic variants still
        // make live critic calls and those must consume the shared hard ceiling.
        countCompletionCalls: true,
        runnerInfo,
        suppressors,
        ablationLabels,
      });
      if (!existsSync(out)) return { output, tempPath: out };
      return {
        result: BenchResultSchema.parse(JSON.parse(readFileSync(out, "utf8"))),
        output,
        tempPath: out,
      };
    };

    const baselineRun = await runVariant(
      "baseline",
      baselineSuppressors,
      [],
      capturingAdapters,
      true,
    );
    if (baselineRun.output.exitCode !== 0 || !baselineRun.result) {
      if (existsSync(baselineRun.tempPath)) {
        mkdirSync(artifactDir, { recursive: true });
        writeFileSync(baselinePath, readFileSync(baselineRun.tempPath));
      }
      return baselineRun.output;
    }
    const baseline = baselineRun.result;

    const manifest = {
      schema: "reviewgate.bench.reviewer-response-hashes.v1",
      entries: [...capture.entries].sort(
        (a, b) => a.provider.localeCompare(b.provider) || a.ordinal - b.ordinal,
      ),
    };
    const responseManifestTempPath = join(work, "reviewer-responses.sha256.json");
    writeFileSync(responseManifestTempPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const dv = (b: Metric, v: Metric): number => (b.value ?? 0) - (v.value ?? 0);
    const baselineHash = sha256File(baselineRun.tempPath);
    const variants: MatrixVariant[] = [
      {
        label: "baseline",
        ablation: "",
        class: "baseline",
        precision: baseline.aggregate.precision,
        recall: baseline.aggregate.recall,
        clean_fp_rate: baseline.aggregate.clean_fp_rate,
        delta: null,
        authoritative: isAuthoritative(baseline).ok,
        result_ref: relativeArtifact(artifactDir, baselinePath),
        result_sha256: baselineHash,
      },
    ];
    const variantArtifactRefs: Array<{ path: string; sha256: string }> = [];
    const completedVariantArtifacts: Array<{ tempPath: string; finalPath: string }> = [];

    for (const layer of input.ablate) {
      const spec = MATRIX_ABLATIONS[layer];
      if (!spec) continue; // validated above
      const replayAdapters = replayReviewerAdapters(underlying, reviewerIds, capture);
      const variantRun = await runVariant(
        `no-${layer}`,
        { ...baselineSuppressors, ...spec.off },
        [layer],
        replayAdapters,
        false,
      );
      const finalPath = variantPaths.get(layer);
      if (!finalPath) throw new Error(`missing artifact path for ${layer}`);
      if (variantRun.output.exitCode !== 0 || !variantRun.result || capture.mismatch) {
        mkdirSync(artifactDir, { recursive: true });
        writeFileSync(baselinePath, readFileSync(baselineRun.tempPath));
        writeFileSync(responseManifestPath, readFileSync(responseManifestTempPath));
        if (existsSync(variantRun.tempPath)) {
          writeFileSync(finalPath, readFileSync(variantRun.tempPath));
        }
        return {
          exitCode: variantRun.output.exitCode === 0 ? 4 : variantRun.output.exitCode,
          stdout: variantRun.output.stdout,
          stderr: `${variantRun.output.stderr}${capture.mismatch ? `bench matrix: ${capture.mismatch}\n` : ""}`,
        };
      }
      const r = variantRun.result;
      const resultHash = sha256File(variantRun.tempPath);
      completedVariantArtifacts.push({ tempPath: variantRun.tempPath, finalPath });
      variantArtifactRefs.push({
        path: relativeArtifact(artifactDir, finalPath),
        sha256: resultHash,
      });
      variants.push({
        label: `-${layer}`,
        ablation: layer,
        class: spec.klass,
        precision: r.aggregate.precision,
        recall: r.aggregate.recall,
        clean_fp_rate: r.aggregate.clean_fp_rate,
        delta: {
          precision: dv(baseline.aggregate.precision, r.aggregate.precision),
          recall: dv(baseline.aggregate.recall, r.aggregate.recall),
          clean_fp_rate: dv(baseline.aggregate.clean_fp_rate, r.aggregate.clean_fp_rate),
        },
        authoritative: isAuthoritative(r).ok,
        result_ref: relativeArtifact(artifactDir, finalPath),
        result_sha256: resultHash,
      });
    }

    const allAuthoritative = variants.every((variant) => variant.authoritative === true);
    const matrix: BenchMatrix = {
      schema: "reviewgate.bench.matrix.v1",
      provenance: baseline.provenance,
      variants,
      authoritative: allAuthoritative,
      artifacts: {
        baseline: {
          path: relativeArtifact(artifactDir, baselinePath),
          sha256: baselineHash,
        },
        variants: variantArtifactRefs,
        reviewer_responses: {
          path: relativeArtifact(artifactDir, responseManifestPath),
          sha256: sha256File(responseManifestTempPath),
        },
      },
    };
    BenchMatrixSchema.parse(matrix);
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(baselinePath, readFileSync(baselineRun.tempPath));
    writeFileSync(responseManifestPath, readFileSync(responseManifestTempPath));
    for (const artifact of completedVariantArtifacts) {
      writeFileSync(artifact.finalPath, readFileSync(artifact.tempPath));
    }
    writeFileSync(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`);
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
