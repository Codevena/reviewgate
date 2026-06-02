// src/cli/commands/learn-status.ts
//
// `reviewgate learn status` — a one-shot snapshot of every self-learning
// subsystem so an operator can verify, at a glance, whether the brain /
// FP-ledger / reputation actually accumulate state under real day-to-day use.
//
// Reads (no writes, no locks needed):
//   - .reviewgate/brain/brain.json                  (BrainStore)
//   - .reviewgate/brain/candidates.jsonl            (CandidateStore, cross-run quorum pool)
//   - .reviewgate/brain/proposals/pool/*.jsonl      (F2 per-run proposal pools)
//   - .reviewgate/brain/proposals/curator-decisions/*.jsonl
//   - .reviewgate/learnings/known_fp.jsonl          (FpLedgerStore + F3 cluster view)
//   - .reviewgate/reputation.json                   (ReputationStore)
//
// Output is plain text by default; pass --json for machine-readable. A
// `--since <ISO date>` window scopes time-sensitive sections (curator
// decisions) — defaults to 30 days.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CandidateStore } from "../../core/brain/candidate-store.ts";
import { ProposalStore } from "../../core/brain/proposal-store.ts";
import { BrainStore } from "../../core/brain/store.ts";
import { computeFpClusters, isNearActive } from "../../core/fp-ledger/clusters.ts";
import { FpLedgerStore } from "../../core/fp-ledger/store.ts";
import { ImplicitOutcomeStore } from "../../core/learnings/implicit-outcomes.ts";
import { decayedCount, trustScore } from "../../core/reputation/score.ts";
import { ReputationStore } from "../../core/reputation/store.ts";
import { brainDir, proposalsPoolDir } from "../../utils/paths.ts";

export interface LearnStatusInput {
  repoRoot: string;
  /** Lower bound for time-sensitive aggregations (curator decisions, recent
   *  promotions). Defaults to 30 days before `now`. ISO 8601. */
  since?: string;
  /** Override "now" for deterministic tests. */
  now?: string;
  /** Reputation decay half-life in days. Defaults to 45, matching the
   *  phases.reputation.halfLifeDays config default. Pass a custom value when
   *  the repo overrides it so the trust/samples here match what the gate
   *  actually computes. (We do NOT auto-read the config because this command
   *  intentionally has no config-loader dependency.) */
  halfLifeDays?: number;
  /** Emit JSON instead of text. */
  json?: boolean;
  write?: (s: string) => void;
}

const DAY_MS = 86_400_000;

export interface LearnStatusReport {
  generated_at: string;
  since: string;
  brain: {
    active: number;
    candidate: number;
    stale: number;
    archived: number;
    total: number;
    recent_promotions: Array<{ id: string; title: string; created_at: string }>;
  };
  brain_candidates: {
    total: number;
    distinct_providers: string[];
    oldest_at: string | null;
    newest_at: string | null;
  };
  proposal_pools: {
    open_pools: number;
    total_proposals: number;
    per_pool: Array<{ run_id: string; iters: number[]; providers: string[]; count: number }>;
  };
  curator_decisions: {
    in_window_count: number;
    decisions: Record<string, number>; // verdict:rule_failed → count
    // Why nothing promotes: distribution of quorum-fails by achieved distinct-
    // provider count, and how many were exactly ONE provider short of the bar.
    // A high `one_short` (esp. concentrated at 1 provider) means the brain is
    // starved of cross-provider corroboration, not blocked by some other gate.
    quorum_stuck: {
      total_quorum_fails: number;
      by_providers: Record<string, number>; // "<providers>/<need>" → count
      one_short: number;
    };
  };
  fp_ledger: {
    candidate: number;
    active: number;
    sticky: number;
    pinned: number;
    top_by_rejects: Array<{
      id: string;
      rule_id: string;
      file: string;
      rejects: number;
      providers: string[];
    }>;
    clusters: {
      total: number;
      near_active: number;
      near_or_promoted: Array<{ key: string; stage: string; rejects: number; providers: string[] }>;
    };
  };
  reputation: Array<{
    key: string;
    trust: number;
    samples: number;
    correct: number;
    wrong: number;
  }>;
  implicit_outcomes: {
    total: number;
    by_reason: Record<string, number>;
    by_reviewer: Record<string, number>;
  };
}

function readJsonlEntries(path: string): unknown[] {
  if (!existsSync(path)) return [];
  const out: unknown[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

function listJsonlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
}

async function buildReport(input: LearnStatusInput): Promise<LearnStatusReport> {
  const now = input.now ? new Date(input.now) : new Date();
  const sinceDate = input.since ? new Date(input.since) : new Date(now.getTime() - 30 * DAY_MS);
  const sinceMs = sinceDate.getTime();

  // --- Brain ---
  const brainSnap = await new BrainStore(input.repoRoot).snapshot();
  const brainBy = (status: string) => brainSnap.entries.filter((e) => e.status === status).length;
  const recent = brainSnap.entries
    .filter((e) => e.status === "active" && Date.parse(e.created_at) >= sinceMs)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(0, 5)
    .map((e) => ({ id: e.id, title: e.title, created_at: e.created_at }));

  // --- Cross-run candidate pool ---
  const candidates = await new CandidateStore(input.repoRoot).listAll();
  const candProviders = [...new Set(candidates.map((c) => c.provider))].sort();
  const candTimes = candidates
    .map((c) => Date.parse(c.created_at))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);

  // --- F2 per-run proposal pools ---
  const poolDir = proposalsPoolDir(input.repoRoot);
  const poolFiles = listJsonlFiles(poolDir).filter((n) => n !== "errors.jsonl");
  let totalProposals = 0;
  const perPool: LearnStatusReport["proposal_pools"]["per_pool"] = [];
  for (const f of poolFiles) {
    const runId = f.replace(/\.jsonl$/, "");
    const entries = new ProposalStore(input.repoRoot, runId).readAll();
    if (entries.length === 0) continue;
    const iters = [...new Set(entries.map((e) => e.iter))].sort((a, b) => a - b);
    const providers = [
      ...new Set(
        entries.flatMap((e) =>
          e.proposal.evidence.map((ev) => ev.reviewer_id).filter((v): v is string => Boolean(v)),
        ),
      ),
    ].sort();
    perPool.push({ run_id: runId, iters, providers, count: entries.length });
    totalProposals += entries.length;
  }

  // --- Curator decisions (in-window count + reason histogram) ---
  const curatorDir = join(brainDir(input.repoRoot), "proposals", "curator-decisions");
  const decisionCounts: Record<string, number> = {};
  let inWindowCount = 0;
  let quorumFails = 0;
  let quorumOneShort = 0;
  const quorumByProviders: Record<string, number> = {};
  for (const f of listJsonlFiles(curatorDir)) {
    const entries = readJsonlEntries(join(curatorDir, f));
    for (const raw of entries) {
      // A JSONL line that parses to a non-object (`null`, a bare number, a
      // string, a top-level array) would crash on field access — skip them.
      if (raw === null || typeof raw !== "object") continue;
      const e = raw as {
        decision?: unknown;
        rule_failed?: unknown;
        ts?: unknown;
        providers?: unknown;
        provider_need?: unknown;
      };
      if (typeof e.ts !== "string") continue;
      const ms = Date.parse(e.ts);
      // A malformed ts yields NaN; `NaN < sinceMs` is false, which would
      // incorrectly include the entry as "in window". Reject NaN explicitly.
      if (!Number.isFinite(ms) || ms < sinceMs) continue;
      inWindowCount += 1;
      const verdict = typeof e.decision === "string" ? e.decision : "?";
      const ruleFailed = typeof e.rule_failed === "string" ? e.rule_failed : "-";
      const key = `${verdict}:${ruleFailed}`;
      decisionCounts[key] = (decisionCounts[key] ?? 0) + 1;
      // Quorum-fail provider distribution (instrumentation for "why no promote").
      if (
        (ruleFailed === "quorum" || ruleFailed === "diff-quorum") &&
        typeof e.providers === "number" &&
        typeof e.provider_need === "number"
      ) {
        quorumFails += 1;
        quorumByProviders[`${e.providers}/${e.provider_need}`] =
          (quorumByProviders[`${e.providers}/${e.provider_need}`] ?? 0) + 1;
        if (e.providers === e.provider_need - 1) quorumOneShort += 1;
      }
    }
  }

  // --- FP ledger (entries + F3 cluster view) ---
  const fpSnap = await new FpLedgerStore(input.repoRoot).snapshot();
  const fpBy = (stage: string) => fpSnap.entries.filter((e) => e.stage === stage).length;
  const pinned = fpSnap.entries.filter((e) => Boolean(e.pinned_by)).length;
  const topByRejects = [...fpSnap.entries]
    .sort((a, b) => b.rejects.length - a.rejects.length)
    .slice(0, 5)
    .map((e) => ({
      id: e.id,
      rule_id: e.rule_id,
      file: e.file,
      rejects: e.rejects.length,
      providers: e.distinct_providers,
    }));
  const clusters = computeFpClusters(fpSnap.entries, now.toISOString());
  const nearOrPromoted = clusters
    .filter((c) => c.stage !== "candidate" || isNearActive(c))
    .map((c) => ({
      key: c.key,
      stage: isNearActive(c) ? `${c.stage} (near-active)` : c.stage,
      rejects: c.reject_count_total,
      providers: c.distinct_providers,
    }));

  // --- Reputation (per provider:persona key) ---
  const repSnap = await new ReputationStore(input.repoRoot).snapshot();
  const HALF_LIFE_DAYS = input.halfLifeDays ?? 45;
  const reputation = Object.entries(repSnap.reviewers)
    .map(([key, entry]) => {
      const correct = decayedCount(entry.correct, now, HALF_LIFE_DAYS);
      const wrong = decayedCount(entry.wrong, now, HALF_LIFE_DAYS);
      return {
        key,
        trust: trustScore(entry.correct, entry.wrong, now, HALF_LIFE_DAYS),
        samples: correct + wrong,
        correct: entry.correct.length,
        wrong: entry.wrong.length,
      };
    })
    .sort((a, b) => a.trust - b.trust); // worst trust first — flags problem reviewers

  // --- Implicit outcomes (write-only learning-signal corpus) ---
  const implicit = await new ImplicitOutcomeStore(input.repoRoot).load();
  const byReason: Record<string, number> = {};
  const byReviewer: Record<string, number> = {};
  for (const o of implicit) {
    byReason[o.demote_reason] = (byReason[o.demote_reason] ?? 0) + 1;
    byReviewer[o.reviewer_key] = (byReviewer[o.reviewer_key] ?? 0) + 1;
  }

  return {
    generated_at: now.toISOString(),
    since: sinceDate.toISOString(),
    brain: {
      active: brainBy("active"),
      candidate: brainBy("candidate"),
      stale: brainBy("stale"),
      archived: brainBy("archived"),
      total: brainSnap.entries.length,
      recent_promotions: recent,
    },
    brain_candidates: {
      total: candidates.length,
      distinct_providers: candProviders,
      oldest_at: candTimes.length > 0 ? new Date(candTimes[0] as number).toISOString() : null,
      newest_at:
        candTimes.length > 0
          ? new Date(candTimes[candTimes.length - 1] as number).toISOString()
          : null,
    },
    proposal_pools: {
      open_pools: perPool.length,
      total_proposals: totalProposals,
      per_pool: perPool,
    },
    curator_decisions: {
      in_window_count: inWindowCount,
      decisions: decisionCounts,
      quorum_stuck: {
        total_quorum_fails: quorumFails,
        by_providers: quorumByProviders,
        one_short: quorumOneShort,
      },
    },
    fp_ledger: {
      candidate: fpBy("candidate"),
      active: fpBy("active"),
      sticky: fpBy("sticky"),
      pinned,
      top_by_rejects: topByRejects,
      clusters: {
        total: clusters.length,
        near_active: clusters.filter(isNearActive).length,
        near_or_promoted: nearOrPromoted,
      },
    },
    reputation,
    implicit_outcomes: { total: implicit.length, by_reason: byReason, by_reviewer: byReviewer },
  };
}

function renderText(r: LearnStatusReport): string {
  const lines: string[] = [];
  const sinceShort = r.since.slice(0, 10);

  lines.push(`Reviewgate · Learn Status   (since ${sinceShort})`);
  lines.push("");

  // Brain
  lines.push(
    `Brain                ${r.brain.active} active · ${r.brain.candidate} candidate · ${r.brain.stale} stale · ${r.brain.archived} archived`,
  );
  if (r.brain.recent_promotions.length === 0) {
    lines.push("  recent promotions  (none in window)");
  } else {
    lines.push("  recent promotions:");
    for (const p of r.brain.recent_promotions) {
      lines.push(`    ${p.created_at.slice(0, 10)}  ${p.id}  ${p.title}`);
    }
  }
  lines.push("");

  // Brain candidates (cross-run pool)
  lines.push(
    `Cross-run candidates ${r.brain_candidates.total} entries · providers: ${r.brain_candidates.distinct_providers.join(", ") || "(none)"}`,
  );
  if (r.brain_candidates.total > 0) {
    lines.push(
      `  oldest ${r.brain_candidates.oldest_at?.slice(0, 10)} · newest ${r.brain_candidates.newest_at?.slice(0, 10)}`,
    );
  }
  lines.push("");

  // Proposal pools (F2 in-flight)
  lines.push(
    `Proposal pools       ${r.proposal_pools.open_pools} open · ${r.proposal_pools.total_proposals} proposals total`,
  );
  for (const p of r.proposal_pools.per_pool) {
    lines.push(
      `  ${p.run_id}  iters [${p.iters.join(",")}]  providers [${p.providers.join(",")}]  ${p.count} proposals`,
    );
  }
  if (r.proposal_pools.open_pools > 0) lines.push("");

  // Curator decisions
  lines.push(`Curator decisions    ${r.curator_decisions.in_window_count} in window`);
  const totalsByVerdict: Record<string, number> = {};
  for (const [key, n] of Object.entries(r.curator_decisions.decisions)) {
    const verdict = key.split(":")[0] ?? "?";
    totalsByVerdict[verdict] = (totalsByVerdict[verdict] ?? 0) + n;
  }
  if (Object.keys(totalsByVerdict).length > 0) {
    const verdictLine = Object.entries(totalsByVerdict)
      .sort((a, b) => b[1] - a[1])
      .map(([v, n]) => `${v} ${n}`)
      .join(" · ");
    lines.push(`  verdicts:  ${verdictLine}`);
  }
  const ranked = Object.entries(r.curator_decisions.decisions).sort((a, b) => b[1] - a[1]);
  if (ranked.length > 0) {
    lines.push("  by rule_failed:");
    for (const [key, n] of ranked.slice(0, 6)) {
      lines.push(`    ${n.toString().padStart(3)}  ${key}`);
    }
  }
  // Why nothing promotes: quorum-fail provider distribution.
  const qs = r.curator_decisions.quorum_stuck;
  if (qs.total_quorum_fails > 0) {
    lines.push(`  quorum-fails: ${qs.total_quorum_fails}  (${qs.one_short} were 1 provider short)`);
    const dist = Object.entries(qs.by_providers).sort((a, b) => b[1] - a[1]);
    for (const [bucket, n] of dist.slice(0, 4)) {
      lines.push(`    ${n.toString().padStart(3)}  reached ${bucket} distinct providers`);
    }
    if (qs.one_short > 0 && qs.one_short === qs.total_quorum_fails) {
      lines.push("    → brain is starved of cross-provider corroboration (not blocked elsewhere)");
    }
  }
  lines.push("");

  // FP ledger
  lines.push(
    `FP ledger            ${r.fp_ledger.candidate} cand · ${r.fp_ledger.active} active · ${r.fp_ledger.sticky} sticky · ${r.fp_ledger.pinned} pinned`,
  );
  if (r.fp_ledger.top_by_rejects.length > 0) {
    lines.push("  top by rejects:");
    for (const e of r.fp_ledger.top_by_rejects) {
      lines.push(
        `    ${e.id}  ${e.rejects.toString().padStart(2)}× ${e.rule_id}  ${e.file}  [${e.providers.join(",") || "?"}]`,
      );
    }
  }
  lines.push(
    `  clusters: ${r.fp_ledger.clusters.total} total · ${r.fp_ledger.clusters.near_active} near-active`,
  );
  for (const c of r.fp_ledger.clusters.near_or_promoted) {
    lines.push(`    [${c.stage}] ${c.key}  ${c.rejects} rejects · [${c.providers.join(",")}]`);
  }
  lines.push("");

  // Reputation
  lines.push(`Reputation           ${r.reputation.length} reviewers tracked`);
  for (const rev of r.reputation) {
    const trustStr = rev.trust.toFixed(2);
    const samplesStr = rev.samples.toFixed(1);
    lines.push(
      `  ${rev.key.padEnd(28)}  trust ${trustStr}  samples ${samplesStr.padStart(5)}  (${rev.correct}c/${rev.wrong}w)`,
    );
  }
  lines.push("");

  // Implicit outcomes (write-only signal corpus)
  lines.push("Implicit outcomes    (write-only signal corpus)");
  if (r.implicit_outcomes.total === 0) {
    lines.push("  none yet");
  } else {
    lines.push(`  total: ${r.implicit_outcomes.total}`);
    lines.push(`  by reason: ${JSON.stringify(r.implicit_outcomes.by_reason)}`);
    lines.push(`  by reviewer: ${JSON.stringify(r.implicit_outcomes.by_reviewer)}`);
  }

  return `${lines.join("\n")}\n`;
}

export async function runLearnStatus(input: LearnStatusInput): Promise<number> {
  const out = input.write ?? ((s: string) => process.stdout.write(s));
  const report = await buildReport(input);
  if (input.json) {
    out(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    out(renderText(report));
  }
  return 0;
}

// Exposed for tests so they don't have to write a fake `write` callback.
export const __test = { buildReport, renderText };
