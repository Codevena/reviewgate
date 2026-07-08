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
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { MatchResult } from "../../bench/matcher.ts";
import { makeMetric, summarizeSpread } from "../../bench/metrics.ts";
import { renderBenchMatrix, renderBenchReport } from "../../bench/report.ts";
import {
  type CaseRunOutcome,
  type SuppressorConfig,
  buildBenchConfig,
  runBenchCase,
} from "../../bench/runner.ts";
import type { ReviewgateConfig } from "../../config/define-config.ts";
import type { ProviderAdapter, ProviderConfig } from "../../providers/adapter-base.ts";
import type { ProviderId } from "../../providers/registry.ts";
import { type BenchCase, BenchCaseSchema } from "../../schemas/bench-case.ts";
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
  /** in-process stub adapters for tests; production omits (real CLIs). */
  adapters?: Partial<Record<ProviderId, ProviderAdapter>>;
  /** injectable clock for a deterministic provenance timestamp in tests. */
  now?: () => Date;
  /** injectable quota-failover availability probe (tests); production probes real CLIs. */
  providerAvailable?: (id: ProviderId, apiKeyEnv?: string) => boolean;
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
  };
}

async function corpusGitState(corpus: string): Promise<{ commit: string; dirty: boolean }> {
  const head = await spawnCapture("git", ["rev-parse", "HEAD"], { cwd: corpus, timeoutMs: 15_000 });
  if (head.status !== 0) return { commit: "unknown", dirty: false };
  const status = await spawnCapture("git", ["status", "--porcelain", "--", "."], {
    cwd: corpus,
    timeoutMs: 15_000,
  });
  return {
    commit: head.stdout.trim(),
    dirty: status.status === 0 && status.stdout.trim().length > 0,
  };
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
  const corpus = resolve(input.repoRoot, input.corpus);
  if (!existsSync(corpus) || !statSync(corpus).isDirectory()) {
    return usage(`corpus is not a directory: ${input.corpus}`);
  }
  if (input.providers) {
    const bad = input.providers.filter((p) => !KNOWN_PROVIDERS.has(p));
    if (bad.length > 0) return usage(`unknown provider(s): ${bad.join(",")}`);
  }
  const window = input.window ?? 5;
  const includeAdvisory = input.includeAdvisory ?? false;
  const maxFailedFrac = input.maxFailedFrac ?? 0.1;

  let config: ReviewgateConfig;
  try {
    config = buildBenchConfig({
      ...(input.providers ? { providers: input.providers } : {}),
      ...(input.suppressors ? { suppressors: input.suppressors } : {}),
    });
  } catch (err) {
    return usage(err instanceof Error ? err.message : String(err));
  }
  const adapters = buildAdapters(config, input.adapters);
  const panelConfigured = config.phases.review.reviewers.length;

  const caseDirs = listCaseDirs(corpus);
  if (caseDirs.length === 0) return usage(`no cases found under ${input.corpus}`);

  const repeat = Math.max(1, Math.floor(input.repeat ?? 1));
  // Load + validate each case ONCE (schema/diff checks are deterministic); the
  // reviewer panel is what re-runs per repeat.
  const loadedCases = caseDirs.map((id) => loadCase(corpus, id));

  // --- run every case, `repeat` times (repeats OUTER so per-repeat metrics group) ---
  const caseResults: CaseResult[] = [];
  // per-provider RAW accumulation POOLED across all case-runs (every repeat)
  const provScored = new Map<string, number>(); // # scored case-runs where provider was OK
  const provMatches = new Map<string, MatchResult[]>();
  const provCost = new Map<string, { runs: number; costUsd: number; oauthQuotaRuns: number }>();
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
        ...(input.adapters ? { adapters: input.adapters } : {}),
        ...(input.providerAvailable ? { providerAvailable: input.providerAvailable } : {}),
      });
      caseResults.push(outcomeToCaseResult(loaded, loaded.benchCase, outcome, r));

      for (const pc of outcome.providerCosts) {
        const acc = provCost.get(pc.provider) ?? { runs: 0, costUsd: 0, oauthQuotaRuns: 0 };
        acc.runs += pc.runs;
        acc.costUsd += pc.costUsd;
        acc.oauthQuotaRuns += pc.oauthQuotaRuns;
        provCost.set(pc.provider, acc);
      }

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
    const coverage = makeMetric(okCases, scoredCount);
    const authoritative = coverage.value !== null && coverage.value >= COVERAGE_FLOOR;
    return {
      provider,
      coverage,
      precision: makeMetric(tp, tp + fp),
      recall: makeMetric(tp, tp + fn),
      authoritative,
    };
  });

  // --- cost ---
  const cost: Cost[] = [...provCost.entries()].map(([provider, c]) => ({
    provider,
    calls: c.runs,
    cache_hits: 0, // cache force-disabled for bench (cold measurement)
    tokens_in: 0, // per-case token accounting deferred to P5 cost polish
    tokens_out: 0,
    billed_usd: c.costUsd,
    oauth_quota_calls: c.oauthQuotaRuns,
  }));

  // --- provenance ---
  const git = await corpusGitState(corpus);
  const roster = await buildRoster(config, adapters);
  const now = (input.now ?? (() => new Date()))();
  const result: BenchResult = {
    schema: "reviewgate.bench.result.v1",
    provenance: {
      reviewgate_version: RG_VERSION,
      corpus_commit: git.commit,
      corpus_dirty: git.dirty,
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
    },
    cases: caseResults,
    providers,
    cost,
    aggregate,
    stability,
  };

  // --- quality gate + exit code ---
  const invalidCount = caseResults.filter((c) => c.status === "invalid").length;
  const reviewErrorCount = caseResults.filter((c) => c.status === "review-error").length;
  const total = caseResults.length;
  const reviewErrorFrac = total > 0 ? reviewErrorCount / total : 0;
  // Aggregate panel coverage over scored cases (a mostly-degraded panel is untrustworthy).
  const okSum = scored.reduce((s, c) => s + c.panel_ok, 0);
  const configuredSum = scored.reduce((s, c) => s + c.panel_configured, 0);
  const panelCoverage = configuredSum > 0 ? okSum / configuredSum : 1;
  const panelDegraded = scored.length > 0 && panelCoverage < COVERAGE_FLOOR;

  // Validate + write the result regardless of verdict (partial data stays legible).
  BenchResultSchema.parse(result);
  writeFileSync(resolve(input.repoRoot, input.out), `${JSON.stringify(result, null, 2)}\n`);

  // ERROR: no reviewer completed anywhere (pure provider outage, no corpus problems).
  if (scoredCount === 0 && reviewErrorCount > 0 && invalidCount === 0) {
    return {
      exitCode: 3,
      stdout: "",
      stderr: "bench run: ERROR — no reviewer completed on any case (providers down / quota)\n",
    };
  }

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
 * class (A = post-review suppressor; B = input/prompt-stage). */
const MATRIX_ABLATIONS: Record<string, { klass: "A" | "B"; off: SuppressorConfig }> = {
  critic: { klass: "A", off: { critic: null } },
  "confidence-floor": { klass: "A", off: { confidenceFloor: 0 } },
  reputation: { klass: "A", off: { reputation: false } },
  "scope-to-diff": { klass: "B", off: { scopeToDiff: false } },
};

export interface BenchMatrixInput {
  repoRoot: string;
  corpus: string;
  out: string;
  ablate: string[];
  providers?: ProviderId[] | undefined;
  /** enable the critic in the baseline (required to ablate `critic` meaningfully). */
  criticProvider?: ProviderId;
  repeat?: number;
  window?: number;
  includeAdvisory?: boolean;
  adapters?: Partial<Record<ProviderId, ProviderAdapter>>;
  providerAvailable?: (id: ProviderId, apiKeyEnv?: string) => boolean;
  now?: () => Date;
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
  const baselineSuppressors: SuppressorConfig = {
    ...(input.criticProvider ? { critic: input.criticProvider } : {}),
  };
  const work = mkdtempSync(join(tmpdir(), "rg-bench-matrix-"));
  try {
    const runVariant = async (
      label: string,
      suppressors: SuppressorConfig,
      ablationLabels: string[],
    ): Promise<BenchResult | { error: BenchRunOutput }> => {
      const out = join(work, `${label}.json`);
      const res = await runBenchRun({
        repoRoot: input.repoRoot,
        corpus: input.corpus,
        out,
        ...(input.providers ? { providers: input.providers } : {}),
        ...(input.repeat !== undefined ? { repeat: input.repeat } : {}),
        ...(input.window !== undefined ? { window: input.window } : {}),
        includeAdvisory: input.includeAdvisory ?? false,
        ...(input.adapters ? { adapters: input.adapters } : {}),
        ...(input.providerAvailable ? { providerAvailable: input.providerAvailable } : {}),
        ...(input.now ? { now: input.now } : {}),
        suppressors,
        ablationLabels,
      });
      if (!existsSync(out)) return { error: res }; // exit 2 before any write
      return BenchResultSchema.parse(JSON.parse(readFileSync(out, "utf8")));
    };

    const baseline = await runVariant("baseline", baselineSuppressors, []);
    if ("error" in baseline) return baseline.error;

    const dv = (b: Metric, v: Metric): number => (b.value ?? 0) - (v.value ?? 0);
    const variants: MatrixVariant[] = [
      {
        label: "baseline",
        ablation: "",
        class: "baseline",
        precision: baseline.aggregate.precision,
        recall: baseline.aggregate.recall,
        clean_fp_rate: baseline.aggregate.clean_fp_rate,
        delta: null,
      },
    ];

    for (const layer of input.ablate) {
      const spec = MATRIX_ABLATIONS[layer];
      if (!spec) continue; // validated above
      const r = await runVariant(`no-${layer}`, { ...baselineSuppressors, ...spec.off }, [layer]);
      if ("error" in r) return r.error;
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
      });
    }

    const matrix: BenchMatrix = {
      schema: "reviewgate.bench.matrix.v1",
      provenance: baseline.provenance,
      variants,
    };
    BenchMatrixSchema.parse(matrix);
    writeFileSync(resolve(input.repoRoot, input.out), `${JSON.stringify(matrix, null, 2)}\n`);
    return { exitCode: 0, stdout: `${renderBenchMatrix(matrix)}\n`, stderr: "" };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
