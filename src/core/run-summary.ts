// src/core/run-summary.ts
import type { ProviderId } from "../providers/registry.ts";
import type { ProviderStat, RunSummary } from "../schemas/audit-event.ts";
import type { Finding } from "../schemas/finding.ts";

const SIGNATURE_CAP = 20;

export interface ReviewerOutcome {
  provider: ProviderId;
  persona: string;
  res: { status: string; usage: { costUsd: number } };
  durationMs: number;
}

export interface BuildRunSummaryInput {
  verdict: RunSummary["verdict"];
  source: RunSummary["source"];
  counts: RunSummary["counts"];
  durationMs: number;
  criticCostUsd: number;
  findings: Finding[];
  runs: ReviewerOutcome[];
  // #6 instrumentation: count of uncited project/house-rule findings this run. Omitted on the
  // non-panel paths (skip/cache/error) where no reviewer findings were produced.
  ruleUncited?: number;
}

function isDemoted(f: Finding): boolean {
  return (
    f.scope_demoted === true ||
    f.fp_ledger_match?.suppressed === true ||
    f.fp_cluster_match?.suppressed === true ||
    f.critic_verdict === "likely_fp"
  );
}

export function buildRunSummary(input: BuildRunSummaryInput): RunSummary {
  const byProvider = new Map<ProviderId, ProviderStat>();
  const ensure = (provider: ProviderId): ProviderStat => {
    let p = byProvider.get(provider);
    if (!p) {
      p = {
        provider,
        personas: [],
        runs: 0,
        errors: 0,
        findings: 0,
        demoted: 0,
        cost_usd: 0,
        duration_ms: 0,
      };
      byProvider.set(provider, p);
    }
    return p;
  };
  for (const r of input.runs) {
    const p = ensure(r.provider);
    p.runs += 1;
    if (r.res.status !== "ok") p.errors += 1;
    if (!p.personas.includes(r.persona)) p.personas.push(r.persona);
    p.cost_usd += r.res.usage.costUsd;
    p.duration_ms += r.durationMs;
  }
  for (const f of input.findings) {
    const p = ensure(f.reviewer.provider as ProviderId);
    p.findings += 1;
    if (isDemoted(f)) p.demoted += 1;
  }

  const signatures = input.findings
    .filter((f) => f.severity === "CRITICAL" || f.severity === "WARN")
    .map((f) => f.signature)
    .slice(0, SIGNATURE_CAP);

  return {
    verdict: input.verdict,
    source: input.source,
    counts: input.counts,
    cost_usd: input.runs.reduce((sum, r) => sum + r.res.usage.costUsd, 0) + input.criticCostUsd,
    duration_ms: input.durationMs,
    demoted: input.findings.filter(isDemoted).length,
    signatures,
    providers: [...byProvider.values()],
    ...(input.ruleUncited !== undefined ? { rule_uncited: input.ruleUncited } : {}),
  };
}
