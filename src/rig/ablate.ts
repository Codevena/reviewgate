// src/rig/ablate.ts
// The counterfactual: what would the suppression stack have emitted from these same findings
// with one layer switched off?
//
// WHY THIS DOES NOT RE-RUN THE GATE LOOP UNDER CASSETTE REPLAY. `reviewKey(reviewerId)` keys
// the replay queue on the reviewer id ALONE and serves entries FIFO, so correct replay needs
// an IDENTICAL sequence of review calls. Disabling a suppression layer changes verdicts →
// changes iteration counts → changes the number of review calls, at which point the queue
// hands turn 5's findings to turn 3 and the run reports a difference that is pure
// misalignment. Re-deriving from the harvested per-turn findings has no such coupling: each
// turn's findings are addressed BY TURN INDEX, so a layer toggle can only change what the
// aggregation layer emits, never which findings it sees. Do not "simplify" this back into a
// loop re-run under replay — that is a wrong measurement that looks like a result.
//
// WHAT IT CANNOT ANSWER, AND WHY THE ANSWER IS AN INTERVAL FOR SOME LAYERS. The harvested
// findings are POST-aggregation, so undoing a layer means reading the demotion markers it
// left behind. The four layers are not equally legible:
//
//   * `critic` demotes ONE STEP and stamps `critic_verdict: "likely_fp"`, so a finding sitting
//     at INFO with that marker was a WARN — exact. Its severity LABEL is ambiguous in one case
//     (a WARN carrying `demoted_from_critical` was either a CRITICAL or an unchanged WARN),
//     but both are BLOCKING, so blocking status — the thing every metric here depends on — is
//     unambiguous. Findings the critic DROPPED entirely are absent from the artifact, and that
//     costs nothing: the drop path only fires on INFO findings, which were already non-blocking.
//   * `reputation` demotes the same way and stamps `reputation_demoted` — exact for the same reason.
//   * `fp-ledger` does NOT demote by a step. It assigns `severity: "INFO"` OUTRIGHT, and the
//     pre-suppression severity is persisted nowhere. A suppressed finding was CRITICAL, WARN or
//     already INFO and the artifact cannot say which, so its contribution is a BOUND, not a point.
//   * `lore` never demotes anything. It ADDS synthetic verdict-neutral INFO findings, so
//     switching it off REMOVES them: zero blocking delta by construction, and a real reduction
//     in decision load, which is reported instead of a fake severity delta.
//
// The honest output is therefore a lower and an upper counterfactual. They are identical when
// the layer is exactly recoverable, and the reporter prints a point estimate then; where they
// differ it prints the interval. Collapsing an interval to its midpoint would invent precision
// the artifact does not contain.
import { matchesAnyTag } from "../bench/matcher.ts";
import { makeMetric } from "../bench/metrics.ts";
import type { Finding } from "../schemas/finding.ts";
import type { RigResult, RigTurnRecord } from "../schemas/rig-result.ts";
import { RigResultSchema } from "../schemas/rig-result.ts";
import { loadTurnScript } from "./turn-script.ts";

export const SUPPRESSION_LAYERS = ["critic", "reputation", "fp-ledger", "lore"] as const;
export type SuppressionLayer = (typeof SUPPRESSION_LAYERS)[number];

export function isSuppressionLayer(v: string): v is SuppressionLayer {
  return (SUPPRESSION_LAYERS as readonly string[]).includes(v);
}

export interface RigAblation {
  layer: SuppressionLayer;
  /** true when the layer's effect is exactly recoverable, i.e. `lower` and `upper` agree */
  exact: boolean;
  /** the counterfactual under the most CONSERVATIVE reading (unknowables changed nothing) */
  lower: RigResult;
  /** identical to `lower` when exact; otherwise the most GENEROUS reading */
  upper: RigResult;
  /** how many findings the layer touched, and how many of those are unrecoverable */
  counts: { touched: number; recovered: number; unrecoverable: number };
  notes: string[];
}

/**
 * Suppression markers OTHER than the ablated layer's that also force a finding to INFO.
 *
 * The aggregator applies its passes in sequence (critic → scope → delta-scope → fp-ledger →
 * cycle-rejected → … → reputation). If a LATER pass also pinned a finding to INFO, switching
 * off an EARLIER one changes nothing — the later pass would have pinned it anyway. Rather than
 * re-model that ordering (and get it subtly wrong), any finding carrying a second suppressor is
 * treated as UNRECOVERABLE and widens the interval. That errs toward admitting ignorance,
 * which is the safe direction for a number that will be published.
 */
function hasOtherSuppressor(f: Finding, layer: SuppressionLayer): boolean {
  const fromCritic = f.critic_verdict === "likely_fp";
  const fromReputation = f.reputation_demoted === true;
  const fromLedger =
    f.fp_ledger_match?.suppressed === true || f.fp_cluster_match?.suppressed === true;
  const others: boolean[] = [
    layer === "critic" ? false : fromCritic,
    layer === "reputation" ? false : fromReputation,
    layer === "fp-ledger" ? false : fromLedger,
    // Structural / agent-side demoters, none of which this rig ablates: any of them would have
    // held the finding at INFO regardless of the layer under test.
    f.scope_demoted === true,
    f.delta_scope_demoted === true,
    f.self_refuted === true,
    f.fact_invalid === true,
    f.redaction_demoted === true,
    f.test_severity_demoted === true,
    f.low_confidence === true,
    f.foreign_to_session === true,
    f.region_rejected_match?.suppressed === true,
  ];
  return others.some(Boolean);
}

type Effect = "unchanged" | "becomes-blocking" | "removed" | "unknown";

/** What happens to one finding when `layer` is switched off. */
function effectOf(f: Finding, layer: SuppressionLayer): Effect {
  if (layer === "lore") {
    // Verdict-neutral synthetic findings: switching lore off removes them outright. They are
    // INFO by construction, so nothing blocking changes — only the agent's decision load.
    return f.lore !== undefined ? "removed" : "unchanged";
  }
  if (layer === "critic") {
    if (f.critic_verdict !== "likely_fp") return "unchanged";
    if (hasOtherSuppressor(f, layer)) return "unknown";
    // One-step demote: INFO means it was a blocking WARN. Anything already blocking stays
    // blocking whichever way the G0 clamp went.
    return f.severity === "INFO" ? "becomes-blocking" : "unchanged";
  }
  if (layer === "reputation") {
    if (f.reputation_demoted !== true) return "unchanged";
    if (hasOtherSuppressor(f, layer)) return "unknown";
    return f.severity === "INFO" ? "becomes-blocking" : "unchanged";
  }
  // fp-ledger: severity was overwritten with INFO and the original is gone.
  const suppressed =
    f.fp_ledger_match?.suppressed === true || f.fp_cluster_match?.suppressed === true;
  if (!suppressed) return "unchanged";
  return "unknown";
}

/** Counterfactual finding set for one turn under one reading of the unknowns. */
function applyLayer(
  findings: Finding[],
  layer: SuppressionLayer,
  generous: boolean,
): { findings: Finding[]; blocking: number } {
  const out: Finding[] = [];
  for (const f of findings) {
    const effect = effectOf(f, layer);
    if (effect === "removed") continue;
    if (effect === "becomes-blocking" || (effect === "unknown" && generous)) {
      // Restored to the weakest severity that is still blocking. WARN, not CRITICAL: the
      // artifact cannot prove it was a CRITICAL, and overstating a restored severity would
      // overstate the layer's cost.
      out.push({ ...f, severity: "WARN" });
      continue;
    }
    out.push(f);
  }
  return {
    findings: out,
    blocking: out.filter((f) => f.severity === "CRITICAL" || f.severity === "WARN").length,
  };
}

function findingText(f: Finding): string {
  return `${f.message} ${f.details}`;
}

/**
 * Rebuild a `RigResult` from counterfactual per-turn finding sets.
 *
 * Only the AGGREGATION-derived numbers move: blocking counts, recall, escape rate and the
 * ablated layer's M6 count. Iterations, cost, FP burden and its slope are left untouched, and
 * that is not an oversight — they are facts about what the agent and the panel actually DID.
 * Changing a suppression layer would in reality change verdicts, hence iteration counts, hence
 * cost; but no recording of one run can say what an agent would have done in a run that never
 * happened. Rewriting them here would fabricate exactly that.
 */
function rebuild(
  base: RigResult,
  layer: SuppressionLayer,
  generous: boolean,
  seededTags: Map<number, string[]>,
): RigResult {
  const turns: RigTurnRecord[] = base.turns.map((t) => {
    const applied = applyLayer(t.findings, layer, generous);
    return {
      ...t,
      findingsTotal: applied.findings.length,
      blockingTotal: applied.blocking,
      // findingsTotal can only shrink (lore removal), so the null contract must be re-honoured.
      fpBurden: applied.findings.length === 0 ? null : t.rejectedAsFp / applied.findings.length,
      suppressed: { ...t.suppressed, [layerKey(layer)]: 0 },
      findings: applied.findings,
      caught: t.caught,
      escaped: t.escaped,
    };
  });

  // Recall and escape rate are recomputed from the counterfactual BLOCKING findings — a
  // finding restored to blocking can newly catch its turn's seeded defect, which is the whole
  // point of asking what the layer cost.
  const blockingTexts = new Map<number, string[]>();
  for (const t of turns) {
    blockingTexts.set(
      t.index,
      t.findings.filter((f) => f.severity === "CRITICAL" || f.severity === "WARN").map(findingText),
    );
  }
  for (const [i, t] of turns.entries()) {
    if (t.seededId === null) continue;
    const tags = seededTags.get(t.index) ?? [];
    t.caught = (blockingTexts.get(t.index) ?? []).some((text) => matchesAnyTag(text, tags));
    t.escaped = !turns
      .slice(i)
      .some((later) =>
        (blockingTexts.get(later.index) ?? []).some((text) => matchesAnyTag(text, tags)),
      );
  }

  const seeded = turns.filter((t) => t.seededId !== null);
  return RigResultSchema.parse({
    ...base,
    turns,
    metrics: {
      ...base.metrics,
      recall: makeMetric(seeded.filter((t) => t.caught === true).length, seeded.length),
      escapeRate: makeMetric(seeded.filter((t) => t.escaped === true).length, seeded.length),
      suppression: { ...base.metrics.suppression, [layerKey(layer)]: 0 },
    },
    warnings: [
      ...base.warnings,
      `ABLATED: ${layer} (${generous ? "generous" : "conservative"} reading). Iterations, cost and FP burden are NOT recomputed — they are facts about the run that happened, and this is an aggregation-layer counterfactual, not a behavioural A/B.`,
    ],
  });
}

/** Map a CLI layer name to its key in the suppression counts object. */
function layerKey(layer: SuppressionLayer): "critic" | "reputation" | "fp_ledger" | "lore" {
  return layer === "fp-ledger" ? "fp_ledger" : layer;
}

/**
 * Ablate one suppression layer over a harvested result.
 *
 * PURE: a function of `(result, layer, seededTags)` alone — no cassette, no network, no
 * `.reviewgate/` reads — so the Δ it reports is attributable to the layer and nothing else.
 * The seeded tags come from the turn script, which is ground truth rather than run state.
 */
export function ablate(
  result: RigResult,
  layer: SuppressionLayer,
  seededTags: Map<number, string[]>,
): RigAblation {
  let touched = 0;
  let recovered = 0;
  let unrecoverable = 0;
  for (const t of result.turns) {
    for (const f of t.findings) {
      const effect = effectOf(f, layer);
      if (effect === "unchanged") continue;
      touched++;
      if (effect === "unknown") unrecoverable++;
      else recovered++;
    }
  }

  const lower = rebuild(result, layer, false, seededTags);
  const exact = unrecoverable === 0;
  const upper = exact ? lower : rebuild(result, layer, true, seededTags);

  const notes: string[] = [];
  if (layer === "fp-ledger" && touched > 0) {
    notes.push(
      `fp-ledger overwrites severity with INFO outright and the pre-suppression severity is persisted nowhere, so all ${touched} suppressed finding(s) are unrecoverable: the Δ is an interval, not a point. Recording per-turn cassette offsets (driver manifest) is what would let a future re-aggregation over the RAW reviewer findings turn this into a point estimate.`,
    );
  }
  if (layer === "lore") {
    notes.push(
      "lore never demotes — it adds verdict-neutral INFO findings. Its Δ is therefore zero blocking findings by construction; what switching it off actually saves is the agent's decision load (one required decision per emitted lore finding).",
    );
  }
  if (unrecoverable > 0 && layer !== "fp-ledger") {
    notes.push(
      `${unrecoverable} of ${touched} finding(s) carry a SECOND suppressor, so switching off ${layer} alone may not have changed them. They widen the interval instead of being guessed.`,
    );
  }
  return { layer, exact, lower, upper, counts: { touched, recovered, unrecoverable }, notes };
}

/** Seeded tags by turn index, read from the turn script that produced the run. */
export function seededTagsFromScript(scriptPath: string): Map<number, string[]> {
  const script = loadTurnScript(scriptPath);
  const map = new Map<number, string[]>();
  for (const t of script.turns) {
    if (t.seeded !== null) map.set(t.index, t.seeded.tags);
  }
  return map;
}

/**
 * The Δ table, in the shape `bench matrix` uses: baseline row plus one row per layer, each
 * with the signed change against the baseline. An interval prints as an interval.
 */
export function renderAblationMatrix(base: RigResult, ablations: RigAblation[]): string {
  const L: string[] = [];
  L.push("Reviewgate rig — ablation matrix (baseline = full suppression)");
  L.push("");
  const fmtRange = (lo: number, hi: number): string =>
    lo === hi
      ? `${lo >= 0 ? "+" : ""}${lo}`
      : `${lo >= 0 ? "+" : ""}${lo}…${hi >= 0 ? "+" : ""}${hi}`;
  const baseBlocking = base.turns.reduce((a, t) => a + t.blockingTotal, 0);
  const baseRecall = base.metrics.recall;
  L.push(
    `  baseline                    blocking ${baseBlocking}  ·  recall ${baseRecall.value === null ? "n/a" : baseRecall.value.toFixed(2)} (${baseRecall.num}/${baseRecall.den})`,
  );
  for (const a of ablations) {
    const loBlocking = a.lower.turns.reduce((acc, t) => acc + t.blockingTotal, 0);
    const hiBlocking = a.upper.turns.reduce((acc, t) => acc + t.blockingTotal, 0);
    const loRecall = a.lower.metrics.recall.num;
    const hiRecall = a.upper.metrics.recall.num;
    L.push(
      `  −${a.layer.padEnd(26)} blocking ${fmtRange(loBlocking - baseBlocking, hiBlocking - baseBlocking)}  ·  recall ${fmtRange(loRecall - baseRecall.num, hiRecall - baseRecall.num)}/${baseRecall.den}  ${a.exact ? "(exact)" : "(interval — see notes)"}`,
    );
  }
  L.push("");
  L.push("Δ = ablated − baseline. A POSITIVE blocking Δ means the layer was suppressing that");
  L.push("many findings; a positive recall Δ means it was suppressing a real catch.");
  const allNotes = ablations.flatMap((a) => a.notes.map((n) => `  · ${a.layer}: ${n}`));
  if (allNotes.length > 0) {
    L.push("");
    L.push("Notes:");
    L.push(...allNotes);
  }
  return `${L.join("\n")}\n`;
}
