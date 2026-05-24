// src/core/orchestrator.ts
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeBehaviorHash } from "../cache/behavior-hash.ts";
import { computeCacheKey, getCachedReview, putCachedReview } from "../cache/cache.ts";
import { cassetteFromEnv } from "../cassette/store.ts";
import type { ReviewgateConfig } from "../config/define-config.ts";
import { parseChangedRanges } from "../diff/hunks.ts";
import { sanitizeDiff } from "../diff/sanitizer.ts";
import { computeSignature } from "../diff/signature.ts";
import type { ProviderAdapter, ProviderConfig, ReviewResult } from "../providers/adapter-base.ts";
import { isProviderAvailable } from "../providers/availability.ts";
import type { ProviderId } from "../providers/registry.ts";
import { parseReviewOutput } from "../providers/review-output.ts";
import { type RenderedContextDocs, fetchLibraryDocs } from "../research/context7.ts";
import { loadConventions } from "../research/conventions.ts";
import { computeDiffFacts } from "../research/diff-facts.ts";
import { extractImportedLibs } from "../research/imports.ts";
import { researchPath, writeResearch } from "../research/research-writer.ts";
import { buildSymbolGraph, enclosingSymbol } from "../research/symbol-graph.ts";
import type { RunSummary } from "../schemas/audit-event.ts";
import { type MemoryProposal, VALID_EVIDENCE_KINDS } from "../schemas/brain.ts";
import type { Finding, FindingCategory } from "../schemas/finding.ts";
import { triageFromFacts } from "../triage/matrix.ts";
import { refineTriage } from "../triage/triage-engine.ts";
import { collectChangedFileContents } from "../utils/git.ts";
import type { HostTier } from "../utils/host-model.ts";
import { modelIdForTier, reviewerTierFor } from "../utils/host-model.ts";
import { withTimeout } from "../utils/with-timeout.ts";
import { aggregate } from "./aggregator.ts";
import { runCurator } from "./brain/curator.ts";
import type { Embedder } from "./brain/embeddings.ts";
import { BrainEngine } from "./brain/engine.ts";
import { enrichProposal } from "./brain/enrich.ts";
import { type ContradictionJudge, pairActiveFpEntries } from "./brain/fp-coupling.ts";
import { decayPass } from "./brain/lifecycle.ts";
import { BrainStore } from "./brain/store.ts";
import { type CriticVerdict, runCritic } from "./critic.ts";
import { buildFpFewShot } from "./fp-ledger/few-shot.ts";
import { learnFromDecisions } from "./fp-ledger/learn.ts";
import { FpLedgerStore } from "./fp-ledger/store.ts";
import { DEFAULT_COOLDOWN_MS, QuotaCooldownStore, parseQuotaResetAt } from "./quota-cooldown.ts";
import { ReportWriter } from "./report-writer.ts";
import { buildRunSummary } from "./run-summary.ts";

export interface OrchestratorInput {
  repoRoot: string;
  config: ReviewgateConfig;
  adapters: Partial<Record<ProviderId, ProviderAdapter>>;
  sandboxMode: "strict" | "permissive" | "off";
  hostTier: HostTier;
  diff: string;
  // Real git metadata for the report. Optional so tests can omit it (falls back
  // to env vars / placeholders). The gate always supplies it.
  gitInfo?: { sha: string; branch: string; dirtyFiles: string[] };
  reasonOnFailEnabled: boolean;
  // Doc/plan review hooks. forcePersona (set by the `review-plan` CLI) forces a
  // review even when triage would skip, and pins the reviewer persona. reportMode
  // "one-shot" tells the report writer to omit the decisions-loop instructions.
  forcePersona?: string;
  reportMode?: "gate" | "one-shot";
  // Optional injection for the Curator's web-fetch evidence enrichment. Lets
  // tests drive the deterministic-source path with no real network/DNS. In
  // production this is omitted and safeFetch uses global fetch + node DNS.
  fetchOverrides?: { fetchImpl?: typeof fetch; resolve?: (host: string) => Promise<string[]> };
  // Whether a fallback provider can actually run (CLI/key reachable). Injected
  // for tests; production omits it and uses the real binary/key probe.
  providerAvailable?: (id: ProviderId, apiKeyEnv?: string) => boolean;
  // Clock for quota-cooldown decisions. Injected for tests; production omits it.
  now?: () => Date;
  // The review base (pre-batch HEAD from dirty.flag) the diff was collected
  // against, so full-file FP-suppression context covers committed-mid-batch files
  // too. Omitted → HEAD (working-tree only).
  reviewBaseSha?: string | null;
}

export interface IterationResult {
  verdict: "PASS" | "SOFT-PASS" | "FAIL" | "ERROR";
  costUsd: number;
  durationMs: number;
  signaturesThisIter: string[];
  summary: RunSummary;
}

// Structural contract the LoopDriver depends on — lets the driver race a run
// against its deadline (and tests inject a slow/fast stub) without coupling to
// the concrete Orchestrator. `signal` aborts the in-flight reviewers on timeout.
export interface IterationRunner {
  runIteration(opts: {
    runId: string;
    iter: number;
    signal?: AbortSignal;
  }): Promise<IterationResult>;
}

const REVIEW_PROMPT_PREAMBLE = [
  "You are reviewing a code diff. Output ONLY a single JSON object — no prose, no",
  "markdown fences — of exactly this shape:",
  '{"verdict":"PASS|FAIL","findings":[{"severity":"CRITICAL|WARN|INFO",',
  '"category":"security|correctness|quality|architecture|performance|testing|docs",',
  '"rule_id":"<short-kebab-id>","file":"<repo-relative path>","line":<integer>,',
  '"message":"<one line>","details":"<explanation>","confidence":<number 0..1>}]}',
  "Report every real issue you find. Use verdict PASS with an empty findings array",
  "only if there are genuinely no issues.",
  'You MAY also include an optional "memory_proposals" array of repo-knowledge you',
  'are confident about (≥0.5). Each: {"type":"convention|anti-pattern|external-knowledge|disagreement",',
  '"scope":"this-repo|language-<x>|framework-<x>","title":"<=80","body":"<=500","confidence":0..1,',
  '"tags":[...],"evidence":[{"kind":"reviewer-observation","snippet":"..."}|{"kind":"reviewer-observation","source_url":"https://..."}]}.',
  "Cite a source_url for external facts; do NOT fabricate hashes.",
  "Full content of every changed file is provided after the diff for reference.",
  "Before reporting any symbol as undefined or missing, verify it against that",
  "full-file content — failure to do so produces false-positive findings.",
  "Report issues INTRODUCED OR AFFECTED BY THIS diff. Pre-existing issues in",
  "unchanged code (outside the changed lines) are out of scope — do not report them.",
].join("\n");

const DOC_REVIEW_PROMPT_PREAMBLE = [
  "You are reviewing an implementation plan / spec document (prose, not code).",
  "Output ONLY a single JSON object — no prose, no markdown fences — of exactly",
  "this shape:",
  '{"verdict":"PASS|FAIL","findings":[{"severity":"CRITICAL|WARN|INFO",',
  '"category":"security|correctness|quality|architecture|performance|testing|docs",',
  '"rule_id":"<short-kebab-id>","file":"<repo-relative path>","line":<integer>,',
  '"message":"<one line>","details":"<explanation>","confidence":<number 0..1>}]}',
  "Judge the plan on: completeness, internal contradictions, missing edge cases,",
  "verifiability/testability, unrealistic assumptions, missing migration/rollback,",
  "and wrong file/symbol references. Report every real issue. Use verdict PASS",
  "with an empty findings array only if the plan is genuinely sound.",
].join("\n");

const PERSONA_REAFFIRM: Record<string, string> = {
  security:
    "You are a hostile senior security auditor. Assume the author was overconfident. Find real bugs.",
  architecture: "You are a senior software architect. Judge design, coupling, and maintainability.",
  adversarial: "You are an adversarial critic. Attack assumptions; find what others miss.",
  plan: "You are a meticulous staff engineer reviewing an implementation plan. Find gaps, contradictions, untestable steps, and unstated assumptions before code is written.",
};
const DEFAULT_REAFFIRM = PERSONA_REAFFIRM.security as string;

const RG_VERSION = "0.1.0-m1";

// M6: per-request timeout for a single Context7 search/context call (NOT the
// cache ttlDays). Best-effort — a slow API never stalls a review.
const DOCS_REQUEST_TIMEOUT_MS = 15_000;
// M6: overall deadline for the WHOLE docs phase (extraction + every per-lib
// fetch), so a pre-cache stall can never block the review regardless of lib count.
const DOCS_TOTAL_TIMEOUT_MS = 30_000;

// M6: best-effort diagnostic — per-lib docs outcomes for "why no docs". Written
// under .reviewgate/ (excluded from the reviewed diff). Never throws.
function writeDocsDebugArtifact(repoRoot: string, docs: RenderedContextDocs): void {
  try {
    const dir = join(repoRoot, ".reviewgate", "cache", "docs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "last-run.json"),
      JSON.stringify(
        {
          ts: new Date().toISOString(),
          libs: docs.libs.map((l) => ({ name: l.name, outcome: l.outcome })),
          corpus: docs.corpus.map((c) => ({
            name: c.name,
            libraryId: c.libraryId,
            version: c.version,
          })),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  } catch {
    // diagnostic only — ignore failures
  }
}

type RawEvidenceItem = {
  kind: string;
  source_url?: string | null;
  snippet?: string | null;
  reviewer_id?: string | null;
  from_diff?: { file: string; line_start: number; line_end: number } | null;
};

// Build a proposal's evidence, ALWAYS stamping the EMITTING run + reviewer
// (anti-collusion: whatever reviewer_id the LLM claimed is discarded). Items with
// an unusable `kind` are dropped here. When that leaves NO usable evidence (the
// reviewer proposed a memory with none, or only invalid items), synthesize a
// single reviewer-observation so the proposal survives the curator's
// evidence.min(1) gate and still counts as exactly ONE provider's voice toward
// cross-provider quorum. The synthesized item is intentionally NOT from_diff —
// it's general knowledge, not the stricter diff-derived quorum tier.
export function buildProposalEvidence(
  rawEvidence: RawEvidenceItem[] | undefined,
  runId: string,
  reviewerId: string,
): MemoryProposal["evidence"] {
  const mapped = (Array.isArray(rawEvidence) ? rawEvidence : [])
    .filter((ev) => VALID_EVIDENCE_KINDS.has(ev.kind))
    .map((ev) => ({
      kind: ev.kind as MemoryProposal["evidence"][number]["kind"],
      run_id: runId,
      reviewer_id: reviewerId,
      ...(ev.source_url != null ? { source_url: ev.source_url } : {}),
      ...(ev.snippet != null ? { snippet: ev.snippet } : {}),
      ...(ev.from_diff != null ? { from_diff: ev.from_diff } : {}),
    })) as MemoryProposal["evidence"];
  if (mapped.length === 0) {
    return [{ kind: "reviewer-observation", run_id: runId, reviewer_id: reviewerId }];
  }
  return mapped;
}

interface ReviewerRun {
  res: ReviewResult;
  provider: ProviderId;
  persona: string;
  model: string;
}

export class Orchestrator {
  constructor(private readonly input: OrchestratorInput) {}

  async runIteration(opts: {
    runId: string;
    iter: number;
    signal?: AbortSignal;
  }): Promise<IterationResult> {
    const start = Date.now();
    const repo = this.input.repoRoot;

    // --- M5 Part B1 — FP-ledger learn (opt-in, non-blocking): fold the previous
    // iteration's reviewer_was_wrong rejections into the signature ledger BEFORE
    // this run's panel/aggregate, so a freshly-learned FP can demote this run.
    // Runs ahead of the sandbox-mode early return: that path overwrites
    // pending.json with an empty ERROR report, which would destroy the prior
    // report learnFromDecisions reads to map rejected finding ids → signatures,
    // making the rejected FP unrecoverable on later runs. ---
    const fpCfg = this.input.config.phases.fpLedger;
    const fpStore = fpCfg?.enabled ? new FpLedgerStore(repo) : null;
    if (fpStore) {
      const nowIso = new Date().toISOString();
      await learnFromDecisions({ repoRoot: repo, prevIter: opts.iter - 1, store: fpStore, nowIso })
        // Decay AFTER learning so freshly-touched entries (last_seen = now) are
        // never reaped; mirrors the brain curator's per-run decayPass. Both are
        // non-blocking — a ledger error must never fail the gate.
        .then(() => fpStore.decayPass(nowIso))
        .catch(() => undefined);
    }

    if (this.input.sandboxMode !== "off") {
      await this.writeReport(opts, start, [], [], "ERROR");
      return {
        verdict: "ERROR",
        costUsd: 0,
        durationMs: Date.now() - start,
        signaturesThisIter: [],
        summary: buildRunSummary({
          verdict: "ERROR",
          source: "skipped",
          counts: { critical: 0, warn: 0, info: 0 },
          durationMs: Date.now() - start,
          criticCostUsd: 0,
          findings: [],
          runs: [],
        }),
      };
    }

    // --- Triage (deterministic; optional LLM refinement that can only narrow) ---
    const facts = computeDiffFacts(this.input.diff);
    const triage = await refineTriage(triageFromFacts(facts, this.input.config.docReview), {
      llm: null,
    });

    const docPersona =
      this.input.forcePersona ??
      (triage.riskClass === "docs" ? this.input.config.docReview.persona : null);

    if (!triage.runReview && !this.input.forcePersona) {
      // Doc-only / trivial diff: pass without spawning any reviewer ($0).
      await this.writeReport(opts, start, [], [], "PASS");
      return {
        verdict: "PASS",
        costUsd: 0,
        durationMs: Date.now() - start,
        signaturesThisIter: [],
        summary: buildRunSummary({
          verdict: "PASS",
          source: "skipped",
          counts: { critical: 0, warn: 0, info: 0 },
          durationMs: Date.now() - start,
          criticCostUsd: 0,
          findings: [],
          runs: [],
        }),
      };
    }

    // --- Brain read path: pin an immutable snapshot once per run, compute the
    // token-budgeted injection text (tags = diff sensitivity tags, changedFiles =
    // the diff's file paths). The pinned snapshot's active-entry identity also
    // feeds the cache key below, so brain mutations deterministically invalidate
    // previously-cached verdicts. Curator mutations land after this pin and are
    // only visible to the NEXT run. ---
    const brainCfg = this.input.config.phases.brain;
    let brainText = "";
    let brainEngine: BrainEngine | undefined;
    if (brainCfg?.enabled) {
      brainEngine = new BrainEngine(new BrainStore(repo), { maxTokens: brainCfg.maxPromptTokens });
      await brainEngine.pin();
      brainText = brainEngine.inject({
        tags: facts.sensitivityTags,
        changedFiles: facts.files.map((file) => file.path),
        categories: [],
      });
    }
    // M5 Part B1: the active/sticky FP-ledger snapshot decides which findings get
    // demoted (reactive) AND which few-shot lines are injected (proactive), so its
    // identity must invalidate the cache exactly like the brain's — otherwise a
    // cached PASS/SOFT-PASS could be served BEFORE either runs (e.g. a SOFT-PASS
    // under a block/ask-once policy). Read post-learn/decay so a freshly promoted
    // entry forces a re-review. Reused below for few-shot + the aggregate stage so
    // the ledger is read exactly once.
    const fpActiveSnapshot = fpStore ? await fpStore.activeSnapshot() : undefined;

    // M6: Context7 library docs. Fetched PRE-CACHE — before the behavior-hash —
    // so the docs-corpus identity feeds the cache key (a docs change must
    // invalidate a cached verdict; the B2a cache-bug class). This is a deliberate
    // ordering decision: the corpus identity (responseHash) is only knowable AFTER
    // the fetch, and the fetch is docs-cache-backed (warm runs do no `context`
    // network — only a cheap per-lib `search`), so a cache-hit run pays a small
    // search cost but still skips the expensive reviewer panel. Best-effort:
    // wrapped in catch → never blocks the review. Per-lib outcomes are written to
    // a debug artifact for "why no docs" diagnosis (the orchestrator has no audit
    // logger; the hash-chained audit schema is not extended for this best-effort
    // diagnostic).
    const docsCfg = this.input.config.phases.contextDocs;
    let contextDocs: RenderedContextDocs | undefined;
    if (docsCfg?.enabled) {
      // Bound the ENTIRE docs phase (extraction + all per-lib fetches) by one
      // overall deadline, on top of the per-request timeout, so the pre-cache
      // docs step can never block the review regardless of lib count / a stall.
      contextDocs = await withTimeout(
        (async () => {
          const libs = await extractImportedLibs(
            repo,
            facts.files.map((f) => f.path),
          ).catch(() => []);
          return fetchLibraryDocs(libs, {
            repoRoot: repo,
            host: docsCfg.host,
            apiKeyEnv: docsCfg.apiKeyEnv,
            timeoutMs: DOCS_REQUEST_TIMEOUT_MS,
            ttlDays: docsCfg.ttlDays,
            perLibBytes: docsCfg.perLibBytes,
            maxLibs: docsCfg.maxLibs,
            fetchImpl: this.input.fetchOverrides?.fetchImpl,
            resolve: this.input.fetchOverrides?.resolve,
          });
        })(),
        DOCS_TOTAL_TIMEOUT_MS,
        "context-docs",
      ).catch(() => undefined);
      if (contextDocs) writeDocsDebugArtifact(repo, contextDocs);
    }

    // M5 Part B2a: brain + FP identities flow through ONE structured behavior-hash
    // (not an ad-hoc append). FP is keyed on {signature, stage} (the behavior-
    // affecting fields; pattern_id is cosmetic). With no FP entries the result is
    // byte-identical to the legacy brain-only `id:status` hash, so existing cache
    // keys are preserved when fpLedger is off or has no active entries. M6: the
    // docs corpus identity is folded in too (only when non-empty → continuity).
    const behaviorHash = computeBehaviorHash({
      brain: brainEngine
        ? brainEngine.snapshotEntries().map((e) => ({ id: e.id, status: e.status }))
        : [],
      fp: fpActiveSnapshot
        ? [...fpActiveSnapshot.values()].map((e) => ({ signature: e.signature, stage: e.stage }))
        : [],
      docs: contextDocs?.corpus,
    });

    // --- Cache short-circuit (only for previously-passing verdicts) ---
    // When a cassette is active (record OR replay), bypass the verdict cache: a
    // cached PASS would short-circuit BEFORE the (Recording/Replay)Adapter runs —
    // record mode would write an empty cassette, replay mode would ignore the
    // cassette's recorded verdict/findings. The cassette IS the source of truth.
    const cacheEnabled = this.input.config.cache.enabled && cassetteFromEnv() === null;
    const cacheKey = computeCacheKey({
      diff: this.input.diff,
      configHash: createHash("sha256").update(JSON.stringify(this.input.config)).digest("hex"),
      // M3: provider versions not queried; cache invalidates on config/version/
      // schema change. M4+M5: the combined brain+FP behavior-hash is folded in
      // here so any brain OR active-ledger change re-runs the panel deterministically.
      providerVersions: behaviorHash,
      reviewgateVersion: RG_VERSION,
      schemaVersion: "reviewgate.pending.v1",
    });

    if (cacheEnabled) {
      const cached = await getCachedReview(repo, cacheKey);
      if (cached && (cached.verdict === "PASS" || cached.verdict === "SOFT-PASS")) {
        await this.writeReport(opts, start, [], [], cached.verdict, cached.counts);
        return {
          verdict: cached.verdict,
          costUsd: 0,
          durationMs: Date.now() - start,
          signaturesThisIter: [],
          summary: buildRunSummary({
            verdict: cached.verdict,
            source: "cache",
            counts: cached.counts,
            durationMs: Date.now() - start,
            criticCostUsd: 0,
            findings: [],
            runs: [],
          }),
        };
      }
    }

    // M5 Part B2a — proactive negative few-shot: tell the panel which findings
    // this repo's maintainers have already confirmed as false positives for the
    // changed files, so they are not re-reported (complements the reactive
    // aggregator demote). Trusted context, injected before the untrusted diff
    // fence like brain context. Derived from the same active snapshot folded into
    // the behavior-hash. Built AFTER the cache short-circuit so a cache hit does
    // no wasted work (the cache key already accounts for the active snapshot).
    const fpFewShot = fpActiveSnapshot
      ? buildFpFewShot({
          active: fpActiveSnapshot,
          changedFiles: facts.files.map((file) => file.path),
        })
      : "";

    // --- Research: symbol graph + research.md ---
    const changedAbs = facts.files.map((f) => join(repo, f.path));
    const symbolGraph = await buildSymbolGraph({ files: changedAbs, repoRoot: repo }).catch(() => ({
      symbols: [],
      callers: {},
    }));
    await writeResearch({
      repoRoot: repo,
      facts,
      triage,
      symbolGraph,
      conventions: loadConventions(repo),
      contextDocs,
      contextDocsBudgetBytes: docsCfg?.budgetBytes,
    }).catch(() => "");
    let researchText = "";
    try {
      researchText = readFileSync(researchPath(repo), "utf8");
    } catch {
      researchText = "";
    }

    // --- Adaptive reviewer set: intersect configured reviewers with triage hint ---
    const configured = this.input.config.phases.review.reviewers;
    const reviewers =
      triage.reviewerHint.length > 0
        ? configured.filter((r) => triage.reviewerHint.includes(r.provider))
        : configured;
    const activeReviewers = reviewers.length > 0 ? reviewers : configured;

    // Compute once per run: full content of every changed file, for false-positive
    // suppression. Reviewers can consult this before reporting a symbol as missing.
    const fileContext = collectChangedFileContents(
      repo,
      this.input.config.phases.review.fileContextBudgetBytes ?? 32_000,
      this.input.reviewBaseSha,
    );

    // Resolve the effective model for a provider, applying the host-tier override
    // for claude-code (returns null when that tier is disabled → the slot/fallback
    // candidate is skipped). Other providers use the configured model as-is.
    const resolveReviewerModel = (provider: ProviderId, baseModel: string): string | null => {
      if (provider === "claude-code") {
        const tier = reviewerTierFor(this.input.hostTier);
        if (tier === "disabled") return null;
        return modelIdForTier(tier) ?? baseModel;
      }
      return baseModel;
    };

    const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, costUsd: 0, quotaUsedPct: null } as const;
    // Run one provider for a slot, catch-wrapped so a THROWING adapter becomes a
    // synthetic error run (not a Promise rejection allSettled would drop). okRuns
    // still filters status==="ok", so a thrown/errored adapter never counts as a
    // usable result — it only surfaces in `settled` (and the RunSummary).
    const runProvider = async (
      provider: ProviderId,
      persona: string,
      model: string,
      providerCfg: ProviderConfig,
      promptFile: string,
      findingsPath: string,
      diffPath: string,
    ): Promise<ReviewerRun> => {
      const adapter = this.input.adapters[provider];
      const reviewStart = Date.now();
      if (!adapter) {
        return {
          res: {
            reviewerId: `${provider}-${persona}`,
            verdict: "ERROR",
            findings: [],
            usage: { ...ZERO_USAGE },
            durationMs: 0,
            exitCode: -1,
            rawEventsPath: "",
            status: "error",
            statusDetail: "adapter not registered",
          },
          provider,
          persona,
          model,
        };
      }
      try {
        const res = await adapter.review({
          cfg: { ...providerCfg, model },
          reviewerId: `${provider}-${persona}`,
          promptFile,
          workingDir: repo,
          findingsPath,
          persona,
          diffPath,
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
        return { res, provider, persona, model };
      } catch (err) {
        return {
          res: {
            reviewerId: `${provider}-${persona}`,
            verdict: "ERROR",
            findings: [],
            usage: { ...ZERO_USAGE },
            durationMs: Date.now() - reviewStart,
            exitCode: -1,
            rawEventsPath: "",
            status: "error",
            statusDetail: `threw: ${(err as Error).message}`.slice(0, 200),
          },
          provider,
          persona,
          model,
        };
      }
    };

    // Quota cooldown: if the primary hit its cap on a prior review and the reset
    // time hasn't passed, skip the (futile, ~7s) primary attempt and go straight
    // to the fallback. A cooldown is only ACTED ON when the slot has a fallback —
    // otherwise we still try the primary (its quota may have recovered). Every
    // REPROBE_INTERVAL the provider is re-probed once (skipUntil returns null) to
    // catch an early recovery before its quoted reset. The clock is injectable for
    // tests. Effects are collected and applied AFTER the panel (one writer; the
    // panel runs in parallel).
    const now = this.input.now?.() ?? new Date();
    const cooldownStore = new QuotaCooldownStore(repo);
    type CooldownEffect =
      | { provider: ProviderId; resetAt: string; source: "parsed" | "default" }
      | { provider: ProviderId; clear: true };

    const tasks = activeReviewers.map(
      async (r): Promise<{ run: ReviewerRun; effects: CooldownEffect[] } | null> => {
        const adapter = this.input.adapters[r.provider];
        const providerCfg = this.input.config.providers[r.provider] as ProviderConfig | undefined;
        if (!adapter || !providerCfg || !providerCfg.enabled) return null;

        const model = resolveReviewerModel(r.provider, r.model ?? providerCfg.model);
        if (model === null) return null; // claude-code host-tier disabled

        const persona = docPersona ?? r.persona;
        const reaffirm = PERSONA_REAFFIRM[persona] ?? DEFAULT_REAFFIRM;
        const sanitised = sanitizeDiff({ diff: this.input.diff, personaReaffirm: reaffirm });
        const sanitisedCtx = fileContext
          ? sanitizeDiff({ diff: fileContext, personaReaffirm: reaffirm }).text
          : "";
        const runDir = mkdtempSync(join(tmpdir(), `rg-rev-${r.provider}-`));
        const promptFile = join(runDir, "prompt.txt");
        const findingsPath = join(runDir, "findings.md");
        const diffPath = join(runDir, "diff.patch");
        // research.md goes BEFORE the untrusted-diff fence (trusted context).
        const promptParts = [docPersona ? DOC_REVIEW_PROMPT_PREAMBLE : REVIEW_PROMPT_PREAMBLE, ""];
        if (researchText) promptParts.push("## Research context", researchText, "");
        if (brainText) promptParts.push("## Brain context", brainText, "");
        if (fpFewShot)
          promptParts.push("## Known false positives (do not re-report)", fpFewShot, "");
        promptParts.push(sanitised.text);
        if (sanitisedCtx)
          promptParts.push(
            "",
            "## Full content of changed files (reference only — review the DIFF above; consult this to confirm a symbol exists before reporting it undefined/missing)",
            sanitisedCtx,
          );
        writeFileSync(promptFile, promptParts.join("\n"));
        writeFileSync(diffPath, this.input.diff);

        // Quota cooldown skip: if the primary is still capped (reset not reached
        // AND within the re-probe window) AND this slot has a fallback, don't waste
        // the futile primary attempt — synthesize a quota-exhausted result so the
        // failover below runs. Past the re-probe window (or with no fallback) we try
        // the primary, so an EARLY recovery is detected and clears the cooldown.
        // The cooldown effect a finished run implies: record on quota-exhausted
        // (parsed reset, else a default window), else clear (the provider works →
        // quota isn't the problem). Applied for the primary AND every fallback
        // tried, so a quota-capped FALLBACK is also cooled down (else it would be
        // retried on every review).
        const effectFor = (provider: ProviderId, res: ReviewResult): CooldownEffect => {
          if (res.status === "quota-exhausted") {
            const parsed = parseQuotaResetAt(res.statusDetail, now);
            return parsed
              ? { provider, resetAt: parsed, source: "parsed" }
              : {
                  provider,
                  resetAt: new Date(now.getTime() + DEFAULT_COOLDOWN_MS).toISOString(),
                  source: "default",
                };
          }
          return { provider, clear: true };
        };

        const cappedUntil = cooldownStore.skipUntil(r.provider, now);
        let run: ReviewerRun;
        const effects: CooldownEffect[] = [];
        if (cappedUntil && r.fallback?.length) {
          run = {
            res: {
              reviewerId: `${r.provider}-${persona}`,
              verdict: "ERROR",
              findings: [],
              usage: { ...ZERO_USAGE },
              durationMs: 0,
              exitCode: -1,
              rawEventsPath: "",
              status: "quota-exhausted",
              statusDetail: `cooldown-skip: ${r.provider} capped until ${cappedUntil}`,
            },
            provider: r.provider,
            persona,
            model,
          };
          // No effect for a skipped primary: its existing cooldown record stands.
        } else {
          // The prompt depends only on the persona, so it is reused for any fallback.
          run = await runProvider(
            r.provider,
            persona,
            model,
            providerCfg,
            promptFile,
            findingsPath,
            diffPath,
          );
          effects.push(effectFor(r.provider, run.res));
        }

        // Failover: ONLY when the primary is quota-exhausted (codex usage cap,
        // gemini RESOURCE_EXHAUSTED, … OR a cooldown skip above) and the slot
        // declares a fallback chain. A candidate runs if it is registered +
        // configured + available + NOT itself cooled-down; its own `enabled` flag
        // is ignored (listing it in `fallback` IS the opt-in). Walk until one runs.
        if (run.res.status === "quota-exhausted" && r.fallback?.length) {
          for (const fb of r.fallback) {
            const fbCfg = this.input.config.providers[fb] as ProviderConfig | undefined;
            if (!this.input.adapters[fb] || !fbCfg) continue;
            const available = this.input.providerAvailable ?? isProviderAvailable;
            if (!available(fb, fbCfg.apiKeyEnv)) continue;
            // Skip a fallback that is itself in its (non-re-probe) cooldown window,
            // so we don't re-attempt a known-capped provider every review.
            if (cooldownStore.skipUntil(fb, now)) continue;
            const fbModel = resolveReviewerModel(fb, fbCfg.model);
            if (fbModel === null) continue;
            const exhaustedFrom = run.provider;
            run = await runProvider(
              fb,
              persona,
              fbModel,
              fbCfg,
              promptFile,
              findingsPath,
              diffPath,
            );
            run.res.statusDetail =
              `[fallback from ${exhaustedFrom}: quota-exhausted] ${run.res.statusDetail ?? ""}`
                .trim()
                .slice(0, 1000);
            effects.push(effectFor(fb, run.res)); // record/clear the fallback too
            if (run.res.status !== "quota-exhausted") break;
          }
        }
        return { run, effects };
      },
    );

    // allSettled (not all): a single adapter that THROWS (not just returns
    // ERROR) must not abort the whole panel — treat a rejection as no run.
    const outcomes = await Promise.allSettled(tasks);
    const taskResults = outcomes
      .map((o) => (o.status === "fulfilled" ? o.value : null))
      .filter((x): x is { run: ReviewerRun; effects: CooldownEffect[] } => x !== null);
    const settled = taskResults.map((t) => t.run);
    // Apply quota-cooldown effects once, after the parallel panel settles (one
    // writer). Covers the primary AND every fallback tried this run.
    for (const t of taskResults) {
      for (const e of t.effects) {
        if ("clear" in e) cooldownStore.clear(e.provider);
        else cooldownStore.record(e.provider, e.resetAt, now, e.source);
      }
    }
    const okRuns = settled.filter((s) => s.res.status === "ok");

    // Per-reviewer outcomes for the RunSummary (includes thrown adapters, now
    // surfaced as error runs in `settled`). Built once for both the okRuns===0
    // ERROR path and the normal final return.
    const reviewerOutcomes = settled.map((s) => ({
      provider: s.provider,
      persona: s.persona,
      res: { status: s.res.status, usage: { costUsd: s.res.usage.costUsd } },
      durationMs: s.res.durationMs,
    }));

    // --- Brain write path (collect): parse memory_proposals from each OK
    // reviewer's rawText, stamp evidence with this run + reviewer id, and drop
    // anything below the 0.5 confidence floor. Curation happens post-verdict.
    //
    // ANTI-COLLUSION: every evidence item's `reviewer_id` and `run_id` are
    // ALWAYS OVERWRITTEN with the emitting adapter's identity. Whatever the LLM
    // supplied is discarded — an output is only ever trustworthy evidence FROM
    // its own emitter, so a single provider can never fake other providers'
    // voices to manufacture a cross-provider quorum. Real cross-provider quorum
    // is reconstructed downstream by the Curator, which GROUPS similar proposals
    // emitted by DISTINCT reviewers. Each proposal here therefore carries
    // evidence from exactly ONE provider (the reviewer that produced it). ---
    const proposals: MemoryProposal[] = [];
    if (brainCfg?.enabled) {
      for (const run of okRuns) {
        const parsed = run.res.rawText ? parseReviewOutput(run.res.rawText) : null;
        for (const raw of parsed?.memory_proposals ?? []) {
          if (typeof raw.confidence !== "number" || raw.confidence < 0.5) continue;
          proposals.push({
            type: raw.type as MemoryProposal["type"],
            scope: raw.scope,
            title: raw.title,
            body: raw.body,
            confidence: raw.confidence,
            tags: Array.isArray(raw.tags) ? raw.tags : [],
            evidence: buildProposalEvidence(raw.evidence, opts.runId, run.res.reviewerId),
          });
        }
      }
    }

    // Fail CLOSED: zero reviewers produced a usable result — whether they
    // returned an error, THREW (0 settled runs), or none were enabled/available.
    // Past triage we expected to review, so an empty findings list here is
    // "could not review", NOT "clean". Emitting PASS would let a capped /
    // unavailable / misconfigured panel silently pass every turn (Finding A).
    // ERROR makes the LoopDriver block with a reviewer-error message.
    if (okRuns.length === 0) {
      await this.writeReport(opts, start, settled, [], "ERROR");
      return {
        verdict: "ERROR",
        costUsd: settled.reduce((sum, s) => sum + s.res.usage.costUsd, 0),
        durationMs: Date.now() - start,
        signaturesThisIter: [],
        summary: buildRunSummary({
          verdict: "ERROR",
          source: "panel",
          counts: { critical: 0, warn: 0, info: 0 },
          durationMs: Date.now() - start,
          criticCostUsd: 0,
          findings: [],
          runs: reviewerOutcomes,
        }),
      };
    }

    // --- Symbol-relative signatures: recompute each finding's signature using
    // its enclosing symbol (when the language is supported) before dedup. ---
    const rawFindings = okRuns.flatMap((s) => s.res.findings);
    const allFindings = await this.applySymbolSignatures(rawFindings);

    // --- Optional critic phase (demote-only) ---
    let criticMap: Map<string, CriticVerdict> | undefined;
    // Observability: record whether the critic actually ran + produced verdicts,
    // so a configured-but-silent critic (e.g. unparseable output) is visible in
    // pending.json instead of being indistinguishable from "no critic".
    let criticInfo:
      | { provider: string; status: "ran" | "error" | "empty" | "misconfigured"; verdicts: number }
      | undefined;
    // Critic cost is always 0: it runs via complete(), which returns only text
    // (no usage envelope). Kept as a named field for the IterationResult shape.
    const criticCostUsd = 0;
    const criticCfg = this.input.config.phases.critic;
    if (criticCfg && allFindings.length > 0) {
      const criticAdapter = this.input.adapters[criticCfg.provider];
      const cProviderCfg = this.input.config.providers[criticCfg.provider] as
        | ProviderConfig
        | undefined;
      if (criticAdapter && cProviderCfg) {
        // Critic runs via the adapter's free-form complete() (see runCritic), NOT
        // review() — review() forces REVIEW_OUTPUT_SCHEMA on codex/openrouter and
        // makes the critic a silent no-op. No cost is attributed: complete()
        // returns only text (no usage envelope), so the critic phase is $0 here.
        const r = await runCritic(
          criticAdapter,
          criticCfg.provider,
          {
            model: criticCfg.model ?? cProviderCfg.model,
            ...(cProviderCfg.apiKeyEnv ? { apiKeyEnv: cProviderCfg.apiKeyEnv } : {}),
            ...(cProviderCfg.auth ? { auth: cProviderCfg.auth } : {}),
            timeoutMs: cProviderCfg.timeoutMs,
            ...(opts.signal ? { signal: opts.signal } : {}),
          },
          allFindings,
        );
        criticMap = r.map.size > 0 ? r.map : undefined;
        criticInfo = r.info;
      } else {
        criticInfo = { provider: criticCfg.provider, status: "misconfigured", verdicts: 0 };
      }
    }

    const fpActive = fpActiveSnapshot
      ? new Map([...fpActiveSnapshot].map(([sig, e]) => [sig, { id: e.id }]))
      : undefined;

    const agg = aggregate({
      findings: allFindings,
      reviewersTotal: okRuns.length,
      changedRanges: parseChangedRanges(this.input.diff),
      // One-shot reviews (plan/spec) review a WHOLE document, not a code change —
      // there are no "unchanged lines" to exclude, so diff-scoping must not apply
      // (its synthetic full-file diff would otherwise mis-demote legit findings).
      scopeToDiff:
        this.input.reportMode !== "one-shot" &&
        this.input.config.phases.review.scopeToDiff !== false,
      outOfDiffBlocking: this.input.config.phases.review.outOfDiffBlocking ?? [],
      ...(criticMap ? { critic: criticMap } : {}),
      ...(fpActive ? { fpActive } : {}),
    });

    const demoted = agg.dedupedFindings.filter((f) => f.critic_verdict === "likely_fp").length;
    await this.writeReport(
      opts,
      start,
      settled,
      agg.dedupedFindings,
      agg.verdict,
      agg.counts,
      criticInfo ? { ...criticInfo, demoted } : undefined,
    );

    // --- Brain Curator (Phase 4): non-blocking, best-effort, hard-timeout-bounded.
    // Runs AFTER the verdict + report are committed and NEVER throws into / changes
    // the already-computed verdict. Validates collected proposals against the
    // deterministic 7 rules (+ an optional LLM judge), then writes promotions. ---
    if (brainCfg?.enabled && proposals.length > 0) {
      await this.runCuratorPhase(repo, opts.runId, brainCfg, proposals).catch(() => undefined);
    }

    // M5 Phase B3 — FP↔Brain coupling: pair active FP-ledger entries to brain
    // convention entries. Post-verdict + non-blocking, like the curator. Needs
    // BOTH brain and the FP-ledger enabled; runs even when there were no proposals
    // (a previously-active FP entry may still be unpaired).
    if (brainCfg?.enabled && fpStore) {
      const embedder = this.buildEmbedder(brainCfg);
      if (embedder) {
        const judge = this.buildContradictionJudge(repo, brainCfg);
        await pairActiveFpEntries({
          fpStore,
          brainStore: new BrainStore(repo),
          embedder,
          embedCfg: {
            model: brainCfg.embeddings.model,
            apiKeyEnv: brainCfg.embeddings.apiKeyEnv,
            timeoutMs: brainCfg.curatorTimeoutMs,
          },
          runId: opts.runId,
          nowIso: new Date().toISOString(),
          ...(judge ? { judge } : {}),
        }).catch(() => undefined);
      }
    }

    // --- Cache store (only passing verdicts; FAIL must re-run to surface findings) ---
    // No abort checkpoint here on purpose: the cache is only reached AFTER
    // writeReport committed a real verdict (its guard threw otherwise), so a
    // cached PASS reflects a genuinely completed review. If the deadline fired
    // during this bounded post-verdict work, LoopDriver awaits the run, sees it
    // resolve, and honors the verdict — the cache then makes the (rare) re-run cheap.
    if (cacheEnabled && (agg.verdict === "PASS" || agg.verdict === "SOFT-PASS")) {
      await putCachedReview(repo, cacheKey, { verdict: agg.verdict, counts: agg.counts }).catch(
        () => undefined,
      );
    }

    return {
      verdict: agg.verdict,
      costUsd: settled.reduce((sum, s) => sum + s.res.usage.costUsd, 0),
      durationMs: Date.now() - start,
      signaturesThisIter: agg.dedupedFindings.map((f) => f.signature).sort(),
      summary: buildRunSummary({
        verdict: agg.verdict,
        source: "panel",
        counts: agg.counts,
        durationMs: Date.now() - start,
        criticCostUsd,
        findings: agg.dedupedFindings,
        runs: reviewerOutcomes,
      }),
    };
  }

  // Recompute finding signatures using the enclosing tree-sitter symbol when the
  // file's language is supported; falls back to the finding's existing signature.
  private async applySymbolSignatures(findings: Finding[]): Promise<Finding[]> {
    const out: Finding[] = [];
    for (const f of findings) {
      const sym = await enclosingSymbol(join(this.input.repoRoot, f.file), f.line_start).catch(
        () => null,
      );
      if (!sym) {
        out.push(f);
        continue;
      }
      const signature = computeSignature({
        file: f.file,
        ruleId: f.rule_id,
        category: f.category as FindingCategory,
        lineStart: f.line_start,
        lineEnd: f.line_end,
        symbolName: sym.name,
        symbolStartLine: sym.startLine,
      });
      out.push({ ...f, signature });
    }
    return out;
  }

  // M5 Phase B3b — build the FP↔Brain contradiction judge from the curator
  // provider (only when phases.brain.curator is set). Asks whether treating an FP
  // as a known false positive contradicts an existing active brain memory. Any
  // adapter/parse problem → {contradicts:false} (fail OPEN: never lose a pairing
  // over a judge hiccup; pairActiveFpEntries also catches throws).
  private buildContradictionJudge(
    repo: string,
    brainCfg: NonNullable<ReviewgateConfig["phases"]["brain"]>,
  ): ContradictionJudge | undefined {
    const curatorCfg = brainCfg.curator;
    if (!curatorCfg) return undefined;
    return async ({ fp, brainEntries }) => {
      const adapter = this.input.adapters[curatorCfg.provider];
      const pcfg = this.input.config.providers[curatorCfg.provider] as ProviderConfig | undefined;
      // A judge needs a FREE-FORM completion: review() forces the review output
      // schema, so the model would never return {contradicts:…}. Require complete().
      if (!adapter || !pcfg || typeof adapter.complete !== "function") {
        return { contradicts: false };
      }
      const prompt = [
        "You are a repo-memory Curator. A finding has been confirmed as a KNOWN FALSE",
        `POSITIVE (rule "${fp.rule_id}" in ${fp.file}) — i.e. it should NOT be reported.`,
        "Decide whether treating it as a false positive CONTRADICTS any established repo",
        "memory below (e.g. a memory asserting this rule/file IS a real concern).",
        'Output ONLY a single JSON object: {"contradicts":true|false,"brain_entry_id":"<id|empty>","reason":"<one line>"}.',
        "",
        "## Established active repo memories",
        brainEntries.map((e) => `- [${e.id}] (${e.type}) ${e.title}: ${e.body}`).join("\n") ||
          "(none)",
      ].join("\n");
      try {
        const text = await adapter.complete(prompt, {
          model: curatorCfg.model ?? pcfg.model,
          ...(pcfg.apiKeyEnv ? { apiKeyEnv: pcfg.apiKeyEnv } : {}),
          auth: pcfg.auth,
          timeoutMs: brainCfg.curatorTimeoutMs,
        });
        const first = text.indexOf("{");
        const last = text.lastIndexOf("}");
        if (first < 0 || last <= first) return { contradicts: false };
        const obj = JSON.parse(text.slice(first, last + 1)) as {
          contradicts?: unknown;
          brain_entry_id?: unknown;
          reason?: unknown;
        };
        return {
          contradicts: obj.contradicts === true,
          ...(typeof obj.brain_entry_id === "string" && obj.brain_entry_id.length > 0
            ? { brain_entry_id: obj.brain_entry_id }
            : {}),
          ...(typeof obj.reason === "string" ? { reason: obj.reason } : {}),
        };
      } catch {
        return { contradicts: false };
      }
    };
  }

  // Wrap the panel's OpenRouter adapter (single-text embed → number[]) as the
  // curator's batch Embedder (number[][]). Null when no OpenRouter adapter is
  // configured. Shared by the Curator and the B3 FP↔Brain pairing.
  private buildEmbedder(
    brainCfg: NonNullable<ReviewgateConfig["phases"]["brain"]>,
  ): Embedder | null {
    const orAdapter = this.input.adapters.openrouter;
    if (!orAdapter || typeof (orAdapter as { embed?: unknown }).embed !== "function") return null;
    const orEmbed = orAdapter as unknown as {
      embed(
        text: string,
        opts: { model: string; apiKeyEnv: string; timeoutMs?: number },
      ): Promise<number[]>;
    };
    return {
      embed: async (texts, cfg) =>
        Promise.all(
          texts.map((t) =>
            orEmbed.embed(t, {
              model: cfg?.model ?? brainCfg.embeddings.model,
              apiKeyEnv: cfg?.apiKeyEnv ?? brainCfg.embeddings.apiKeyEnv,
              ...(cfg?.timeoutMs != null ? { timeoutMs: cfg.timeoutMs } : {}),
            }),
          ),
        ),
    };
  }

  // Non-blocking Curator phase. Best-effort: any failure (timeout, missing
  // embedder, enrichment error) is swallowed by the caller's `.catch()` and the
  // already-committed verdict is untouched. Pinned-snapshot mutations land in
  // brain.json and are only visible to the next run.
  private async runCuratorPhase(
    repo: string,
    runId: string,
    brainCfg: NonNullable<ReviewgateConfig["phases"]["brain"]>,
    proposals: MemoryProposal[],
  ): Promise<void> {
    const store = new BrainStore(repo);
    await decayPass(store, repo, new Date().toISOString());

    // The embedder is the OpenRouter adapter the panel already built (wrapped to
    // batch). Absent adapter → skip curation entirely (dedup would be
    // undeduplicatable; fail-closed by not promoting).
    const embedder = this.buildEmbedder(brainCfg);
    if (!embedder) return;

    // Enrich citation evidence (best-effort; failures drop the citation).
    const fetchOpts = {
      allow: brainCfg.egressAllowlist,
      ...(this.input.fetchOverrides?.fetchImpl
        ? { fetchImpl: this.input.fetchOverrides.fetchImpl }
        : {}),
      ...(this.input.fetchOverrides?.resolve ? { resolve: this.input.fetchOverrides.resolve } : {}),
    };
    const enriched: MemoryProposal[] = [];
    for (const p of proposals) {
      try {
        const { enriched: e } = await enrichProposal(repo, p, fetchOpts);
        enriched.push(e);
      } catch {
        enriched.push(p);
      }
    }

    // Hybrid: build the optional LLM judge only when phases.brain.curator is set.
    // It calls the configured non-reviewer provider via the critic-phase
    // invocation pattern and parses {"accept":bool,"reason":"..."}; defaults to
    // accept on parse failure or missing adapter (the deterministic gates already
    // passed by the time the judge runs).
    const curatorCfg = brainCfg.curator;
    const judge = curatorCfg
      ? async (prop: MemoryProposal): Promise<{ accept: boolean; reason?: string }> => {
          const adapter = this.input.adapters[curatorCfg.provider];
          const pcfg = this.input.config.providers[curatorCfg.provider] as
            | ProviderConfig
            | undefined;
          // A judge needs a FREE-FORM completion (review() forces the review
          // schema → the model could never return {accept:…}). Require complete().
          if (!adapter || !pcfg || typeof adapter.complete !== "function") return { accept: true };
          const activeTitles = (await store.snapshot()).entries
            .filter((e) => e.status === "active")
            .map((e) => `- ${e.title}`)
            .join("\n");
          const prompt = [
            "You are a brain Curator. Decide whether to ACCEPT a proposed repo-memory entry.",
            "Reject if it contradicts an existing convention (consistency) or its scope/quality",
            'is implausible. Output ONLY a single JSON object: {"accept":true|false,"reason":"<one line>"}.',
            "",
            "## Existing active brain titles",
            activeTitles || "(none)",
            "",
            "## Proposed entry",
            JSON.stringify(
              { type: prop.type, scope: prop.scope, title: prop.title, body: prop.body },
              null,
              2,
            ),
          ].join("\n");
          try {
            const text = await adapter.complete(prompt, {
              model: curatorCfg.model ?? pcfg.model,
              ...(pcfg.apiKeyEnv ? { apiKeyEnv: pcfg.apiKeyEnv } : {}),
              auth: pcfg.auth,
              timeoutMs: brainCfg.curatorTimeoutMs,
            });
            const first = text.indexOf("{");
            const last = text.lastIndexOf("}");
            if (first < 0 || last <= first) return { accept: true };
            const obj = JSON.parse(text.slice(first, last + 1)) as {
              accept?: unknown;
              reason?: unknown;
            };
            return {
              accept: obj.accept !== false,
              ...(typeof obj.reason === "string" ? { reason: obj.reason } : {}),
            };
          } catch {
            return { accept: true };
          }
        }
      : undefined;

    await withTimeout(
      runCurator({
        repoRoot: repo,
        runId,
        proposals: enriched,
        store,
        embedder,
        embedCfg: {
          model: brainCfg.embeddings.model,
          apiKeyEnv: brainCfg.embeddings.apiKeyEnv,
          timeoutMs: brainCfg.curatorTimeoutMs,
        },
        nowIso: new Date().toISOString(),
        ...(judge ? { judge } : {}),
      }),
      brainCfg.curatorTimeoutMs,
      "curator",
    ).catch(() => undefined);
  }

  private async writeReport(
    opts: { runId: string; iter: number; signal?: AbortSignal },
    start: number,
    runs: ReviewerRun[],
    findings: Finding[],
    verdict: "PASS" | "SOFT-PASS" | "FAIL" | "ERROR",
    counts: { critical: number; warn: number; info: number } = { critical: 0, warn: 0, info: 0 },
    critic?: {
      provider: string;
      status: "ran" | "error" | "empty" | "misconfigured";
      verdicts: number;
      demoted: number;
    },
  ): Promise<void> {
    // Single chokepoint for the self-deadline: if the gate aborted this run
    // (loop.runTimeoutMs), NO writeReport branch — early triage ERROR/PASS, cache
    // hit, zero-ok ERROR, or the main panel write — may persist pending.*, or it
    // would clobber/contradict LoopDriver's "did not complete" decision (which
    // already cleared pending.*). Guarding here covers every call site at once.
    opts.signal?.throwIfAborted();
    const writer = new ReportWriter(this.input.repoRoot);
    const reviewers =
      runs.length > 0
        ? runs.map((r) => ({
            id: r.res.reviewerId,
            provider: r.provider,
            model: r.model,
            persona: r.persona,
            status: r.res.status,
            cost_usd: r.res.usage.costUsd,
            duration_ms: r.res.durationMs,
            ...(r.res.statusDetail ? { status_detail: r.res.statusDetail } : {}),
          }))
        : [
            {
              id: "reviewgate",
              provider: "codex" as ProviderId,
              model: this.input.config.providers.codex.model,
              persona: "security",
              status: "ok" as const,
              cost_usd: 0,
              duration_ms: Date.now() - start,
            },
          ];
    await writer.write(
      {
        schema: "reviewgate.pending.v1",
        run_id: opts.runId,
        iter: opts.iter,
        max_iter: this.input.config.loop.maxIterations,
        verdict: verdict === "ERROR" ? "FAIL" : verdict,
        counts,
        reviewers,
        findings,
        ...(critic ? { critic } : {}),
        cost_usd_total: runs.reduce((sum, r) => sum + r.res.usage.costUsd, 0),
        duration_ms_total: Date.now() - start,
        generated_at: new Date().toISOString(),
        git: {
          sha: this.input.gitInfo?.sha ?? process.env.GIT_SHA ?? "0".repeat(40),
          branch: this.input.gitInfo?.branch ?? process.env.GIT_BRANCH ?? "main",
          dirty_files: this.input.gitInfo?.dirtyFiles ?? [],
        },
      },
      { mode: this.input.reportMode ?? "gate" },
    );
  }
}
