// reviewgate bench — per-case runner (spec §12 P1b).
//
// Executes ONE labelled case through the real Orchestrator one-shot path, then
// scores the result. State isolation is by construction: every `.reviewgate/` path
// derives from `repoRoot`, so pointing `repoRoot` at a fresh empty sandbox means
// no FP-ledger / reputation / cache / brain can leak in or out (spec §12). Corpus
// diffs are UNTRUSTED, so the case is hydrated defensively (path-safety + git apply
// to an empty tree) and anything unparseable / unsafe / non-applyable is `invalid`.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAdapters } from "../cli/build-adapters.ts";
import { defaultConfig } from "../config/defaults.ts";
import { ConfigSchema, type ReviewgateConfig } from "../config/define-config.ts";
import { Orchestrator } from "../core/orchestrator.ts";
import type { ProviderAdapter, ReviewStatus } from "../providers/adapter-base.ts";
import type { ProviderId } from "../providers/registry.ts";
import type { BenchCase } from "../schemas/bench-case.ts";
import type { Finding } from "../schemas/finding.ts";
import { PendingReportSchema } from "../schemas/pending-report.ts";
import type { GitInfo } from "../utils/git.ts";
import { planReviewJsonPath, reviewgateDir } from "../utils/paths.ts";
import { spawnCapture } from "../utils/spawn-capture.ts";
import { collectChangedHunks, parseUnifiedDiff, validateDiffPaths } from "./diff-hunks.ts";
import {
  type ExpectedLabel,
  type MatchInput,
  type MatchResult,
  type MatcherFinding,
  matchCase,
} from "./matcher.ts";

// The sandbox is not the user's repo, so bench never calls collectGitInfo on it
// (that would read ambient state). A CONSTANT GitInfo keeps reviewer prompts stable
// and comparable across cases and runs (spec §12 P1b step 3).
export const FIXED_SYNTHETIC_GIT_INFO: GitInfo = {
  sha: "0000000000000000000000000000000000000000",
  branch: "bench",
  dirtyFiles: [],
};

// Walk the hydrated sandbox (skipping the .git we created) and return the first
// path that is NOT a regular file or directory — i.e. a symlink / fifo / device an
// untrusted diff planted. Uses lstatSync so it never follows a link. Returns the
// offending repo-relative path, or null when the tree is clean.
function findNonRegularFile(root: string, rel = ""): string | null {
  const abs = rel ? join(root, rel) : root;
  for (const name of readdirSync(abs)) {
    if (rel === "" && name === ".git") continue; // our own git init, not from the diff
    const childRel = rel ? join(rel, name) : name;
    const st = lstatSync(join(root, childRel));
    if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory())) return childRel;
    if (st.isDirectory()) {
      const nested = findNonRegularFile(root, childRel);
      if (nested) return nested;
    }
  }
  return null;
}

export interface BenchConfigOptions {
  /** `--providers` subset: restrict the reviewer roster to these providers. */
  providers?: ProviderId[];
}

/**
 * Build the effective bench config from the shipped defaults (spec §12 P1b step 2):
 * `deepClone(defaults)` + overrides, then `ConfigSchema.parse`. NEVER
 * `loadEffectiveConfig(cwd=sandbox)` — a case-supplied `reviewgate.config.ts` would
 * execute case-controlled code. The cache is force-disabled because a cache-hit
 * early-return omits `rawReviews` (bench needs the per-provider layer every time).
 */
export function buildBenchConfig(opts: BenchConfigOptions = {}): ReviewgateConfig {
  const base = ConfigSchema.parse(structuredClone(defaultConfig));
  base.cache.enabled = false;
  if (opts.providers && opts.providers.length > 0) {
    const want = new Set<ProviderId>(opts.providers);
    const filtered = base.phases.review.reviewers.filter((r) => want.has(r.provider));
    if (filtered.length === 0) {
      throw new Error(`--providers matched no configured reviewer: ${opts.providers.join(",")}`);
    }
    base.phases.review.reviewers = filtered;
  }
  return ConfigSchema.parse(base);
}

export interface PerProviderRaw {
  provider: ProviderId;
  persona: string;
  status: ReviewStatus;
  /** null for a non-ok reviewer (no findings to score). */
  match: MatchResult | null;
}

export interface ProviderCaseCost {
  provider: ProviderId;
  runs: number;
  costUsd: number;
  /** runs billed against an OAuth quota (a real cost even at $0 billed, spec §5.3). */
  oauthQuotaRuns: number;
}

export interface CaseRunOutcome {
  status: "scored" | "review-error" | "invalid";
  error: string | null;
  counts: { tp: number; fp: number; fn: number; neutral: number };
  latencyMs: number | null;
  panelOk: number;
  panelConfigured: number;
  perProvider: PerProviderRaw[];
  providerCosts: ProviderCaseCost[];
  /** aggregated-panel match; null on invalid / review-error. */
  aggregatedMatch: MatchResult | null;
}

export interface RunBenchCaseInput {
  benchCase: BenchCase;
  diffPatch: string;
  config: ReviewgateConfig;
  window: number;
  includeAdvisory: boolean;
  /** in-process stub adapters injected by tests; production omits (real CLIs). */
  adapters?: Partial<Record<ProviderId, ProviderAdapter>>;
  hostTier?: "opus" | "sonnet" | "haiku" | "unknown";
  /** Injectable quota-failover availability probe. Tests pass a deterministic map
   * so failover doesn't depend on which reviewer CLIs happen to be installed;
   * production omits it and the Orchestrator probes the real binaries/keys. */
  providerAvailable?: (id: ProviderId, apiKeyEnv?: string) => boolean;
}

/** Adapt a persisted Finding to the matcher's shape. Index-derived id guarantees
 * uniqueness within the scored set (raw reviewer ids can collide across findings). */
function toMatcherFindings(findings: Finding[]): MatcherFinding[] {
  return findings.map((f, i) => ({
    id: String(i).padStart(5, "0"),
    file: f.file,
    lineStart: f.line_start,
    lineEnd: f.line_end,
    severity: f.severity,
    text: `${f.message} ${f.details}`,
  }));
}

function invalid(reason: string, panelConfigured: number): CaseRunOutcome {
  return {
    status: "invalid",
    error: reason,
    counts: { tp: 0, fp: 0, fn: 0, neutral: 0 },
    latencyMs: null,
    panelOk: 0,
    panelConfigured,
    perProvider: [],
    providerCosts: [],
    aggregatedMatch: null,
  };
}

export async function runBenchCase(input: RunBenchCaseInput): Promise<CaseRunOutcome> {
  const { benchCase, diffPatch, config, window, includeAdvisory } = input;
  const panelConfigured = config.phases.review.reviewers.length;

  // --- 1. parse + validate the untrusted diff (before touching the filesystem) ---
  const parsed = parseUnifiedDiff(diffPatch);
  if (!parsed.ok) return invalid(`diff not parseable: ${parsed.reason}`, panelConfigured);
  const pathCheck = validateDiffPaths(parsed.files);
  if (!pathCheck.ok) return invalid(`unsafe diff path: ${pathCheck.reason}`, panelConfigured);
  const changedHunks = collectChangedHunks(parsed.files);

  // --- 2. hydrate a fresh sandbox (git init, no commit) and apply the diff ---
  const work = mkdtempSync(join(tmpdir(), "rg-bench-"));
  const sandbox = join(work, "checkout");
  const patchFile = join(work, "case.patch");
  try {
    mkdirSync(sandbox, { recursive: true });
    writeFileSync(patchFile, diffPatch);
    const init = await spawnCapture("git", ["init", "-q"], { cwd: sandbox, timeoutMs: 30_000 });
    if (init.status !== 0) {
      return invalid(
        `git init failed: ${init.stderr || init.spawnError?.message || "?"}`,
        panelConfigured,
      );
    }
    const apply = await spawnCapture("git", ["apply", "--whitespace=nowarn", patchFile], {
      cwd: sandbox,
      timeoutMs: 30_000,
    });
    if (apply.status !== 0) {
      return invalid(
        `diff does not apply to an empty tree: ${apply.stderr.trim()}`,
        panelConfigured,
      );
    }
    // Defence-in-depth: the case must not have smuggled a .reviewgate/ into the
    // sandbox (a control dir git apply would have populated). validateDiffPaths
    // already rejects it, so this is a belt-and-braces assertion.
    if (existsSync(reviewgateDir(sandbox))) {
      return invalid("case hydrated a .reviewgate/ control dir into the sandbox", panelConfigured);
    }
    // Defence-in-depth against an untrusted diff hydrating a SYMLINK (git mode
    // 120000) or other non-regular file that could make a later file-context read
    // follow a link out of the sandbox to a host file. The parser already rejects
    // symlink modes, but audit the actual hydrated tree with lstat so anything that
    // slipped through the parser is caught before the orchestrator reads files.
    const symlink = findNonRegularFile(sandbox);
    if (symlink) {
      return invalid(`case hydrated a non-regular file (symlink?): ${symlink}`, panelConfigured);
    }

    // --- 3. build adapters + run the Orchestrator one-shot ---
    const adapters = buildAdapters(config, input.adapters);
    const orch = new Orchestrator({
      repoRoot: sandbox,
      config,
      adapters,
      sandboxMode: "off",
      hostTier: input.hostTier ?? "opus",
      diff: diffPatch,
      gitInfo: FIXED_SYNTHETIC_GIT_INFO,
      reasonOnFailEnabled: true,
      reportMode: "one-shot",
      captureRawReviews: true,
      ...(input.providerAvailable ? { providerAvailable: input.providerAvailable } : {}),
    });
    // Sanitize the case id before embedding it in the run id: BenchCaseSchema
    // already restricts it to a safe slug and the Orchestrator re-sanitizes run
    // ids used as path components, but strip to [A-Za-z0-9_-] here too so runId is
    // provably path-safe regardless of any future schema loosening (defence in depth).
    const runId = `bench-${benchCase.id.replace(/[^A-Za-z0-9_-]/g, "-")}`;
    const result = await orch.runIteration({ runId, iter: 1 });

    const panelOk = (result.rawReviews ?? []).filter((r) => r.status === "ok").length;
    const providerCosts: ProviderCaseCost[] = result.summary.providers.map((p) => ({
      provider: p.provider,
      runs: p.runs,
      costUsd: p.cost_usd,
      oauthQuotaRuns: config.providers[p.provider]?.auth === "oauth" ? p.runs : 0,
    }));

    // --- 4. per-provider RAW-layer scoring (segment by status) ---
    const expected: ExpectedLabel[] = benchCase.expected.map((e) => ({
      tag: e.tag,
      file: e.file,
      line: e.line,
      minSeverity: e.min_severity,
    }));
    const allowed = benchCase.allowed.map((a) => ({ tag: a.tag, file: a.file, line: a.line }));
    const matchBase: Omit<MatchInput, "findings"> = {
      kind: benchCase.kind,
      expected,
      allowed,
      strictRegion: benchCase.strict_region,
      changedHunks,
      window,
      includeAdvisory,
    };
    const perProvider: PerProviderRaw[] = (result.rawReviews ?? []).map((rr) => ({
      provider: rr.provider,
      persona: rr.persona,
      status: rr.status,
      match:
        rr.status === "ok"
          ? matchCase({ ...matchBase, findings: toMatcherFindings(rr.findings) })
          : null,
    }));

    // --- 5. aggregated-panel scoring ---
    // verdict ERROR = no reviewer completed → this case is a review-error, not a
    // score (mixing it into precision/recall would silently deflate the number).
    if (result.verdict === "ERROR") {
      return {
        status: "review-error",
        error: "no reviewer completed (verdict ERROR)",
        counts: { tp: 0, fp: 0, fn: 0, neutral: 0 },
        latencyMs: result.durationMs,
        panelOk,
        panelConfigured,
        perProvider,
        providerCosts,
        aggregatedMatch: null,
      };
    }

    let aggregatedFindings: Finding[] = [];
    try {
      const report = PendingReportSchema.parse(
        JSON.parse(readFileSync(planReviewJsonPath(sandbox), "utf8")),
      );
      aggregatedFindings = report.findings;
    } catch (err) {
      return {
        status: "review-error",
        error: `could not read one-shot report: ${err instanceof Error ? err.message : String(err)}`,
        counts: { tp: 0, fp: 0, fn: 0, neutral: 0 },
        latencyMs: result.durationMs,
        panelOk,
        panelConfigured,
        perProvider,
        providerCosts,
        aggregatedMatch: null,
      };
    }

    const aggregatedMatch = matchCase({
      ...matchBase,
      findings: toMatcherFindings(aggregatedFindings),
    });

    return {
      status: "scored",
      error: null,
      counts: {
        tp: aggregatedMatch.tp,
        fp: aggregatedMatch.fp,
        fn: aggregatedMatch.fn,
        neutral: aggregatedMatch.neutral,
      },
      latencyMs: result.durationMs,
      panelOk,
      panelConfigured,
      perProvider,
      providerCosts,
      aggregatedMatch,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
