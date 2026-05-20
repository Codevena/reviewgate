// src/core/orchestrator.ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sanitizeDiff } from '../diff/sanitizer.ts';
import type { ProviderAdapter, ProviderConfig, ReviewResult } from '../providers/adapter-base.ts';
import { aggregate } from './aggregator.ts';
import { ReportWriter } from './report-writer.ts';
import type { ReviewgateConfig } from '../config/define-config.ts';
import type { HostTier } from '../utils/host-model.ts';

export interface OrchestratorInput {
  repoRoot: string;
  config: ReviewgateConfig;
  providers: { codex: ProviderAdapter };
  sandboxMode: 'strict' | 'permissive' | 'off';
  hostTier: HostTier;
  diff: string;
  reasonOnFailEnabled: boolean;
}

export interface IterationResult {
  verdict: 'PASS' | 'SOFT-PASS' | 'FAIL' | 'ERROR';
  costUsd: number;
  durationMs: number;
  signaturesThisIter: string[];
}

export class Orchestrator {
  constructor(private readonly input: OrchestratorInput) {}

  async runIteration(opts: { runId: string; iter: number }): Promise<IterationResult> {
    const start = Date.now();
    const runDir = mkdtempSync(join(tmpdir(), `rg-iter-${opts.iter}-`));
    const promptFile = join(runDir, 'prompt.txt');
    const findingsPath = join(runDir, 'findings.md');
    const diffPath = join(runDir, 'diff.patch');

    // Persona for M1: only security.
    const personaReaffirm = 'You are a hostile senior security auditor. Assume the author was overconfident. Find real bugs.';
    const sanitised = sanitizeDiff({ diff: this.input.diff, personaReaffirm });
    writeFileSync(promptFile, [
      'Review the diff for security and correctness issues. Output a JSON object matching the Finding schema you were given.',
      '',
      sanitised.text,
    ].join('\n'));
    writeFileSync(diffPath, this.input.diff);

    const raw = this.input.config.providers.codex;
    const reviewerCfg: ProviderConfig = {
      enabled: raw.enabled,
      auth: raw.auth,
      model: raw.model,
      timeoutMs: raw.timeoutMs,
      ...(raw.apiKeyEnv !== undefined && { apiKeyEnv: raw.apiKeyEnv }),
      ...(raw.reasoningEffort !== undefined && { reasoningEffort: raw.reasoningEffort }),
      ...(raw.maxTokens !== undefined && { maxTokens: raw.maxTokens }),
    };
    const review: ReviewResult = await this.input.providers.codex.review({
      cfg: reviewerCfg,
      reviewerId: 'codex-security',
      promptFile,
      workingDir: this.input.repoRoot,
      findingsPath,
      persona: 'security',
      diffPath,
    });

    const agg = aggregate({ findings: review.findings, reviewersTotal: 1 });

    const writer = new ReportWriter(this.input.repoRoot);
    const now = new Date().toISOString();
    const branch = process.env['GIT_BRANCH'] ?? 'main';
    const sha = process.env['GIT_SHA'] ?? '0'.repeat(40);
    await writer.write({
      schema: 'reviewgate.pending.v1',
      run_id: opts.runId,
      iter: opts.iter,
      max_iter: this.input.config.loop.maxIterations,
      verdict: agg.verdict,
      counts: agg.counts,
      reviewers: [
        {
          id: review.reviewerId,
          provider: 'codex',
          model: reviewerCfg.model,
          persona: 'security',
          status: review.status,
          cost_usd: review.usage.costUsd,
          duration_ms: review.durationMs,
        },
      ],
      findings: agg.dedupedFindings,
      cost_usd_total: review.usage.costUsd,
      duration_ms_total: Date.now() - start,
      generated_at: now,
      git: { sha, branch, dirty_files: [] },
    });

    return {
      verdict: agg.verdict,
      costUsd: review.usage.costUsd,
      durationMs: Date.now() - start,
      signaturesThisIter: agg.dedupedFindings.map((f) => f.signature).sort(),
    };
  }
}
