// src/core/orchestrator.ts
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeCacheKey, getCachedReview, putCachedReview } from "../cache/cache.ts";
import type { ReviewgateConfig } from "../config/define-config.ts";
import { sanitizeDiff } from "../diff/sanitizer.ts";
import { computeSignature } from "../diff/signature.ts";
import type { ProviderAdapter, ProviderConfig, ReviewResult } from "../providers/adapter-base.ts";
import type { ProviderId } from "../providers/registry.ts";
import { loadConventions } from "../research/conventions.ts";
import { computeDiffFacts } from "../research/diff-facts.ts";
import { researchPath, writeResearch } from "../research/research-writer.ts";
import { buildSymbolGraph, enclosingSymbol } from "../research/symbol-graph.ts";
import type { Finding, FindingCategory } from "../schemas/finding.ts";
import { triageFromFacts } from "../triage/matrix.ts";
import { refineTriage } from "../triage/triage-engine.ts";
import type { HostTier } from "../utils/host-model.ts";
import { modelIdForTier, reviewerTierFor } from "../utils/host-model.ts";
import { aggregate } from "./aggregator.ts";
import { type CriticVerdict, buildCriticPrompt, parseCriticOutput } from "./critic.ts";
import { ReportWriter } from "./report-writer.ts";

export interface OrchestratorInput {
  repoRoot: string;
  config: ReviewgateConfig;
  adapters: Partial<Record<ProviderId, ProviderAdapter>>;
  sandboxMode: "strict" | "permissive" | "off";
  hostTier: HostTier;
  diff: string;
  reasonOnFailEnabled: boolean;
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
].join("\n");

const PERSONA_REAFFIRM: Record<string, string> = {
  security:
    "You are a hostile senior security auditor. Assume the author was overconfident. Find real bugs.",
  architecture: "You are a senior software architect. Judge design, coupling, and maintainability.",
  adversarial: "You are an adversarial critic. Attack assumptions; find what others miss.",
};
const DEFAULT_REAFFIRM = PERSONA_REAFFIRM.security as string;

const RG_VERSION = "0.1.0-m1";

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
    const triage = await refineTriage(triageFromFacts(facts), { llm: null });

    if (!triage.runReview) {
      // Doc-only / trivial diff: pass without spawning any reviewer ($0).
      await this.writeReport(opts, start, [], [], "PASS");
      return {
        verdict: "PASS",
        costUsd: 0,
        durationMs: Date.now() - start,
        signaturesThisIter: [],
      };
    }

    // --- Cache short-circuit (only for previously-passing verdicts) ---
    const cacheEnabled = this.input.config.cache.enabled;
    const cacheKey = computeCacheKey({
      diff: this.input.diff,
      configHash: createHash("sha256").update(JSON.stringify(this.input.config)).digest("hex"),
      providerVersions: "", // M3: not queried; cache invalidates on config/version/schema change
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

      const reaffirm = PERSONA_REAFFIRM[r.persona] ?? DEFAULT_REAFFIRM;
      const sanitised = sanitizeDiff({ diff: this.input.diff, personaReaffirm: reaffirm });
      const runDir = mkdtempSync(join(tmpdir(), `rg-rev-${r.provider}-`));
      const promptFile = join(runDir, "prompt.txt");
      const findingsPath = join(runDir, "findings.md");
      const diffPath = join(runDir, "diff.patch");
      // research.md goes BEFORE the untrusted-diff fence (trusted context).
      const promptParts = [REVIEW_PROMPT_PREAMBLE, ""];
      if (researchText) promptParts.push("## Research context", researchText, "");
      promptParts.push(sanitised.text);
      writeFileSync(promptFile, promptParts.join("\n"));
      writeFileSync(diffPath, this.input.diff);
      const res = await adapter.review({
        cfg: { ...providerCfg, model },
        reviewerId: `${r.provider}-${r.persona}`,
        promptFile,
        workingDir: repo,
        findingsPath,
        persona: r.persona,
        diffPath,
      });
      return { res, provider: r.provider, persona: r.persona, model };
    });

    // allSettled (not all): a single adapter that THROWS (not just returns
    // ERROR) must not abort the whole panel — treat a rejection as no run.
    const outcomes = await Promise.allSettled(tasks);
    const settled = outcomes
      .map((o) => (o.status === "fulfilled" ? o.value : null))
      .filter((x): x is ReviewerRun => x !== null);
    const okRuns = settled.filter((s) => s.res.status === "ok");

    // Fail closed: at least one reviewer attempted but none succeeded.
    if (settled.length > 0 && okRuns.length === 0) {
      await this.writeReport(opts, start, settled, [], "ERROR");
      return {
        verdict: "ERROR",
        costUsd: 0,
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
        if (criticText) criticMap = parseCriticOutput(criticText);
      }
    }

    const agg = aggregate({
      findings: allFindings,
      reviewersTotal: okRuns.length,
      ...(criticMap ? { critic: criticMap } : {}),
    });

    await this.writeReport(opts, start, settled, agg.dedupedFindings, agg.verdict, agg.counts);

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

  private async writeReport(
    opts: { runId: string; iter: number },
    start: number,
    runs: ReviewerRun[],
    findings: Finding[],
    verdict: "PASS" | "SOFT-PASS" | "FAIL" | "ERROR",
    counts: { critical: number; warn: number; info: number } = { critical: 0, warn: 0, info: 0 },
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
    await writer.write({
      schema: "reviewgate.pending.v1",
      run_id: opts.runId,
      iter: opts.iter,
      max_iter: this.input.config.loop.maxIterations,
      verdict: verdict === "ERROR" ? "FAIL" : verdict,
      counts,
      reviewers,
      findings,
      cost_usd_total: runs.reduce((sum, r) => sum + r.res.usage.costUsd, 0),
      duration_ms_total: Date.now() - start,
      generated_at: new Date().toISOString(),
      git: {
        sha: process.env.GIT_SHA ?? "0".repeat(40),
        branch: process.env.GIT_BRANCH ?? "main",
        dirty_files: [],
      },
    });
  }
}
