import { existsSync, mkdirSync, readFileSync } from "node:fs";
import type { Finding } from "../../schemas/finding.ts";
import {
  type DemoteReason,
  type ImplicitOutcome,
  ImplicitOutcomeSchema,
} from "../../schemas/implicit-outcome.ts";
import { writeFileAtomic } from "../../utils/atomic-write.ts";
import { flock } from "../../utils/flock.ts";
import { implicitOutcomesLockPath, implicitOutcomesPath, learningsDir } from "../../utils/paths.ts";

// Highest-priority demote tag for a finding present in dedupedFindings, or null
// if it carries no demote tag (so it is not an "outcome" worth recording).
function reasonOf(f: Finding): DemoteReason | null {
  if (f.critic_verdict === "likely_fp") return "critic_likely_fp";
  // fact_invalid (cited line provably absent) and grounding_demoted (fabricated
  // code token) are the STRONGEST hallucination signals — rank them ahead of the
  // softer scope/fp/reputation/confidence demotes so the recorded outcome
  // reflects the most diagnostic reason. Previously omitted entirely, so these
  // demoted survivors produced no learning signal at all.
  if (f.fact_invalid) return "fact_invalid";
  if (f.grounding_demoted) return "grounding_demoted";
  if (f.scope_demoted) return "scope_demoted";
  if (f.fp_ledger_match) return "fp_ledger_match";
  // fp_cluster_match is the multi-rule_id sibling of fp_ledger_match (a DERIVED
  // active/sticky FP cluster); same FP-ledger provenance, so it sits next to it.
  if (f.fp_cluster_match) return "fp_cluster_match";
  if (f.reputation_demoted) return "reputation_demoted";
  if (f.low_confidence) return "low_confidence";
  return null;
}

/** Map an aggregate's demoted survivors + critic-dropped findings to outcomes.
 *  Pure (no I/O, no clock): `nowIso`/`runId`/`iter` are passed in. */
export function deriveImplicitOutcomes(
  dedupedFindings: Finding[],
  criticDropped: Finding[],
  ctx: { runId: string; iter: number; nowIso: string },
): ImplicitOutcome[] {
  const make = (f: Finding, reason: DemoteReason): ImplicitOutcome => ({
    schema: "reviewgate.implicit_outcome.v1",
    signature: f.signature,
    reviewer_key: `${f.reviewer.provider}:${f.reviewer.persona}`,
    category: f.category,
    demote_reason: reason,
    run_id: ctx.runId,
    iter: ctx.iter,
    created_at: ctx.nowIso,
  });
  const out: ImplicitOutcome[] = [];
  for (const f of dedupedFindings) {
    const reason = reasonOf(f);
    if (reason) out.push(make(f, reason));
  }
  for (const f of criticDropped) out.push(make(f, "critic_dropped"));
  return out;
}

/** Write-only learning-signal corpus of demoted/dropped findings. flock'd,
 *  atomic, prune-at-write (oldest-drop). */
export class ImplicitOutcomeStore {
  constructor(private readonly repoRoot: string) {}

  async load(): Promise<ImplicitOutcome[]> {
    const p = implicitOutcomesPath(this.repoRoot);
    if (!existsSync(p)) return [];
    const out: ImplicitOutcome[] = [];
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(ImplicitOutcomeSchema.parse(JSON.parse(t)));
      } catch {
        /* skip partial/old-schema line */
      }
    }
    return out;
  }

  /** Append `outcomes`, then prune to the newest `cap` lines (oldest dropped). */
  async append(outcomes: ImplicitOutcome[], cap: number): Promise<void> {
    if (outcomes.length === 0) return;
    const dir = learningsDir(this.repoRoot);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const lock = await flock(implicitOutcomesLockPath(this.repoRoot));
    try {
      const merged = [...(await this.load()), ...outcomes];
      const kept = merged.length > cap ? merged.slice(merged.length - cap) : merged;
      writeFileAtomic(
        implicitOutcomesPath(this.repoRoot),
        `${kept.map((o) => JSON.stringify(o)).join("\n")}\n`,
        { mode: 0o600 },
      );
    } finally {
      await lock.release();
    }
  }
}
