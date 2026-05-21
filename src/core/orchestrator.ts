// src/core/orchestrator.ts
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeBehaviorHash } from "../cache/behavior-hash.ts";
import { computeCacheKey, getCachedReview, putCachedReview } from "../cache/cache.ts";
import type { ReviewgateConfig } from "../config/define-config.ts";
import { parseChangedRanges } from "../diff/hunks.ts";
import { sanitizeDiff } from "../diff/sanitizer.ts";
import { computeSignature } from "../diff/signature.ts";
import type { ProviderAdapter, ProviderConfig, ReviewResult } from "../providers/adapter-base.ts";
import type { ProviderId } from "../providers/registry.ts";
import { parseReviewOutput } from "../providers/review-output.ts";
import { loadConventions } from "../research/conventions.ts";
import { computeDiffFacts } from "../research/diff-facts.ts";
import { researchPath, writeResearch } from "../research/research-writer.ts";
import { buildSymbolGraph, enclosingSymbol } from "../research/symbol-graph.ts";
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
import { pairActiveFpEntries } from "./brain/fp-coupling.ts";
import { decayPass } from "./brain/lifecycle.ts";
import { BrainStore } from "./brain/store.ts";
import { type CriticVerdict, buildCriticPrompt, parseCriticOutput } from "./critic.ts";
import { buildFpFewShot } from "./fp-ledger/few-shot.ts";
import { learnFromDecisions } from "./fp-ledger/learn.ts";
import { FpLedgerStore } from "./fp-ledger/store.ts";
import { ReportWriter } from "./report-writer.ts";

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
}

export interface IterationResult {
  verdict: "PASS" | "SOFT-PASS" | "FAIL" | "ERROR";
  costUsd: number;
  durationMs: number;
  signaturesThisIter: string[];
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

  async runIteration(opts: { runId: string; iter: number }): Promise<IterationResult> {
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

    // M5 Part B2a: brain + FP identities flow through ONE structured behavior-hash
    // (not an ad-hoc append). FP is keyed on {signature, stage} (the behavior-
    // affecting fields; pattern_id is cosmetic). With no FP entries the result is
    // byte-identical to the legacy brain-only `id:status` hash, so existing cache
    // keys are preserved when fpLedger is off or has no active entries.
    const behaviorHash = computeBehaviorHash({
      brain: brainEngine
        ? brainEngine.snapshotEntries().map((e) => ({ id: e.id, status: e.status }))
        : [],
      fp: fpActiveSnapshot
        ? [...fpActiveSnapshot.values()].map((e) => ({ signature: e.signature, stage: e.stage }))
        : [],
    });

    // --- Cache short-circuit (only for previously-passing verdicts) ---
    const cacheEnabled = this.input.config.cache.enabled;
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
    );

    const tasks = activeReviewers.map(async (r): Promise<ReviewerRun | null> => {
      const adapter = this.input.adapters[r.provider];
      const providerCfg = this.input.config.providers[r.provider] as ProviderConfig | undefined;
      if (!adapter || !providerCfg || !providerCfg.enabled) return null;

      let model = r.model ?? providerCfg.model;
      if (r.provider === "claude-code") {
        const tier = reviewerTierFor(this.input.hostTier);
        if (tier === "disabled") return null;
        model = modelIdForTier(tier) ?? model;
      }

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
      if (fpFewShot) promptParts.push("## Known false positives (do not re-report)", fpFewShot, "");
      promptParts.push(sanitised.text);
      if (sanitisedCtx)
        promptParts.push(
          "",
          "## Full content of changed files (reference only — review the DIFF above; consult this to confirm a symbol exists before reporting it undefined/missing)",
          sanitisedCtx,
        );
      writeFileSync(promptFile, promptParts.join("\n"));
      writeFileSync(diffPath, this.input.diff);
      const res = await adapter.review({
        cfg: { ...providerCfg, model },
        reviewerId: `${r.provider}-${persona}`,
        promptFile,
        workingDir: repo,
        findingsPath,
        persona,
        diffPath,
      });
      return { res, provider: r.provider, persona, model };
    });

    // allSettled (not all): a single adapter that THROWS (not just returns
    // ERROR) must not abort the whole panel — treat a rejection as no run.
    const outcomes = await Promise.allSettled(tasks);
    const settled = outcomes
      .map((o) => (o.status === "fulfilled" ? o.value : null))
      .filter((x): x is ReviewerRun => x !== null);
    const okRuns = settled.filter((s) => s.res.status === "ok");

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
    const criticCfg = this.input.config.phases.critic;
    if (criticCfg && allFindings.length > 0) {
      const criticAdapter = this.input.adapters[criticCfg.provider];
      const cProviderCfg = this.input.config.providers[criticCfg.provider] as
        | ProviderConfig
        | undefined;
      if (criticAdapter && cProviderCfg) {
        const cRun = mkdtempSync(join(tmpdir(), "rg-critic-"));
        const cPrompt = join(cRun, "prompt.txt");
        writeFileSync(cPrompt, buildCriticPrompt(allFindings));
        const cRes = await criticAdapter.review({
          cfg: { ...cProviderCfg, ...(criticCfg.model ? { model: criticCfg.model } : {}) },
          reviewerId: `critic-${criticCfg.provider}`,
          promptFile: cPrompt,
          workingDir: repo,
          findingsPath: join(cRun, "f.md"),
          persona: criticCfg.persona,
          diffPath: join(cRun, "d.patch"),
        });
        const criticText = cRes.rawText ?? "";
        if (cRes.status !== "ok") {
          criticInfo = { provider: criticCfg.provider, status: "error", verdicts: 0 };
        } else if (!criticText) {
          criticInfo = { provider: criticCfg.provider, status: "empty", verdicts: 0 };
        } else {
          criticMap = parseCriticOutput(criticText);
          criticInfo = {
            provider: criticCfg.provider,
            status: criticMap.size > 0 ? "ran" : "empty",
            verdicts: criticMap.size,
          };
        }
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
      scopeToDiff: this.input.config.phases.review.scopeToDiff !== false,
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
        }).catch(() => undefined);
      }
    }

    // --- Cache store (only passing verdicts; FAIL must re-run to surface findings) ---
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
          if (!adapter || !pcfg) return { accept: true };
          const jRun = mkdtempSync(join(tmpdir(), "rg-curator-"));
          const jPrompt = join(jRun, "prompt.txt");
          const activeTitles = (await store.snapshot()).entries
            .filter((e) => e.status === "active")
            .map((e) => `- ${e.title}`)
            .join("\n");
          writeFileSync(
            jPrompt,
            [
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
            ].join("\n"),
          );
          const jRes = await adapter.review({
            cfg: { ...pcfg, ...(curatorCfg.model ? { model: curatorCfg.model } : {}) },
            reviewerId: `curator-${curatorCfg.provider}`,
            promptFile: jPrompt,
            workingDir: repo,
            findingsPath: join(jRun, "f.md"),
            persona: curatorCfg.persona,
            diffPath: join(jRun, "d.patch"),
          });
          try {
            const text = jRes.rawText ?? "";
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
    opts: { runId: string; iter: number },
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
