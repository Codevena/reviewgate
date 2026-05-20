// src/core/orchestrator.ts
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewgateConfig } from "../config/define-config.ts";
import { sanitizeDiff } from "../diff/sanitizer.ts";
import type { ProviderAdapter, ProviderConfig, ReviewResult } from "../providers/adapter-base.ts";
import type { ProviderId } from "../providers/registry.ts";
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

const PERSONA_REAFFIRM: Record<string, string> = {
  security:
    "You are a hostile senior security auditor. Assume the author was overconfident. Find real bugs.",
  architecture: "You are a senior software architect. Judge design, coupling, and maintainability.",
  adversarial: "You are an adversarial critic. Attack assumptions; find what others miss.",
};

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

    // Fail closed on sandboxing: M1/M2 cannot isolate the reviewer subprocess
    // (sandbox-runtime unpublished). Refuse any mode other than 'off'.
    if (this.input.sandboxMode !== "off") {
      await this.writeReport(opts, start, [], [], "ERROR");
      return {
        verdict: "ERROR",
        costUsd: 0,
        durationMs: Date.now() - start,
        signaturesThisIter: [],
      };
    }

    const reviewers = this.input.config.phases.review.reviewers;
    const tasks = reviewers.map(async (r): Promise<ReviewerRun | null> => {
      const adapter = this.input.adapters[r.provider];
      const providerCfg = this.input.config.providers[r.provider] as ProviderConfig | undefined;
      if (!adapter || !providerCfg || !providerCfg.enabled) return null;

      let model = r.model ?? providerCfg.model;
      if (r.provider === "claude-code") {
        const tier = reviewerTierFor(this.input.hostTier);
        if (tier === "disabled") return null; // host is haiku → no smaller claude tier
        model = modelIdForTier(tier) ?? model;
      }

      const reaffirm =
        PERSONA_REAFFIRM[r.persona] ??
        "You are a hostile senior security auditor. Assume the author was overconfident. Find real bugs.";
      const sanitised = sanitizeDiff({ diff: this.input.diff, personaReaffirm: reaffirm });
      const runDir = mkdtempSync(join(tmpdir(), `rg-rev-${r.provider}-`));
      const promptFile = join(runDir, "prompt.txt");
      const findingsPath = join(runDir, "findings.md");
      const diffPath = join(runDir, "diff.patch");
      writeFileSync(
        promptFile,
        [
          "Review the diff for issues. Output a JSON object matching the review schema you were given.",
          "",
          sanitised.text,
        ].join("\n"),
      );
      writeFileSync(diffPath, this.input.diff);
      const res = await adapter.review({
        cfg: { ...providerCfg, model },
        reviewerId: `${r.provider}-${r.persona}`,
        promptFile,
        workingDir: this.input.repoRoot,
        findingsPath,
        persona: r.persona,
        diffPath,
      });
      return { res, provider: r.provider, persona: r.persona, model };
    });

    const settled = (await Promise.all(tasks)).filter((x): x is ReviewerRun => x !== null);
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

    const allFindings = okRuns.flatMap((s) => s.res.findings);

    // Optional critic phase (demote-only).
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
          workingDir: this.input.repoRoot,
          findingsPath: join(cRun, "f.md"),
          persona: criticCfg.persona,
          diffPath: join(cRun, "d.patch"),
        });
        let criticText = "";
        try {
          criticText = cRes.rawEventsPath ? readFileSync(cRes.rawEventsPath, "utf8") : "";
        } catch {
          criticText = "";
        }
        if (criticText) criticMap = parseCriticOutput(criticText);
      }
    }

    const agg = aggregate({
      findings: allFindings,
      reviewersTotal: okRuns.length,
      ...(criticMap ? { critic: criticMap } : {}),
    });

    await this.writeReport(opts, start, settled, agg.dedupedFindings, agg.verdict, agg.counts);

    return {
      verdict: agg.verdict,
      costUsd: settled.reduce((sum, s) => sum + s.res.usage.costUsd, 0),
      durationMs: Date.now() - start,
      signaturesThisIter: agg.dedupedFindings.map((f) => f.signature).sort(),
    };
  }

  // Writes pending.md + pending.json. For ERROR verdicts the report records FAIL
  // (the PendingReport verdict enum has no ERROR) with the reviewers' real
  // statuses; the IterationResult carries ERROR so the LoopDriver blocks with an
  // error-specific reason.
  private async writeReport(
    opts: { runId: string; iter: number },
    start: number,
    runs: ReviewerRun[],
    findings: import("../schemas/finding.ts").Finding[],
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
              status: "error" as const,
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
