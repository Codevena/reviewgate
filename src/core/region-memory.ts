// src/core/region-memory.ts
//
// T3 / R4 (field report 2026-07-03): cycle-scoped REGION memory of the agent's
// explicit dispositions. The field failure: a rejected finding returned round
// after round under a RENAMED signature on the same ~5 lines (stale-effect-dep →
// stale-action-param-cleanup → action-param-race → …), defeating every
// signature-keyed guard. Rejections are therefore additionally bound to
// (file, line-range) regions; the aggregator demotes a same-region, same-category
// re-raise once the region has >= 2 DISTINCT dispositioned findings (a single
// mistaken rejection can never self-ratchet into suppression — codex plan-gate C1).
//
// Storage model (reworked after the adversarial review 2026-07-03): the state
// persists RAW per-disposition records; regions are DERIVED fresh at read time
// (mergeRegions). Merging at write time let a later-SUPERSEDED disposition leave
// its absorbed categories/severity/bounds/reason behind on a surviving region —
// suppression evidence the agent had retracted. Deriving from the surviving raw
// records makes the supersede reconciliation exact by construction.
//
// Pure functions: the loop-driver supplies the parsed decisions + pending
// findings and persists the folded result; nothing here touches the filesystem.
import { normalizeRepoPath } from "../diff/repo-path.ts";
import type { DecisionEntry } from "../schemas/decision.ts";
import type { Finding, FindingCategory, Severity } from "../schemas/finding.ts";
import type { CycleDisposition } from "../schemas/state.ts";
import { REGION_WINDOW } from "./aggregator.ts";

const SEVERITY_RANK: Record<Severity, number> = { CRITICAL: 2, WARN: 1, INFO: 0 };
const REASON_CAP = 200;

export interface HarvestedDisposition {
  finding_id: string;
  file: string;
  line_start: number;
  line_end: number;
  severity: Severity;
  categories: FindingCategory[];
  reason: string | null;
  disposition: "rejected" | "addressed";
}

// The merged, aggregator-facing view of one region (derived, never persisted).
export interface CycleRegion {
  file: string;
  start_line: number;
  end_line: number;
  severity: Severity;
  categories: FindingCategory[];
  reason: string;
  distinct_count: number;
}

/**
 * Join last-wins decisions against the iteration's pending findings.
 *
 * "rejected" region signals: verdict:"rejected" (reason >= 20 chars by schema)
 * AND accepted/action:"verified-not-applicable" (the field report's "valid but
 * not applicable here" class — same >= 20-char evidence bar, and exactly the
 * class that produced the CREDIT_COSTS treadmill). "addressed" region signals:
 * accepted/action:"fixed" (consumed by the follow-up contradiction badge).
 *
 * Only BLOCKING (CRITICAL/WARN) findings are harvested: INFO findings never
 * require a decision, so counting agent-authored decisions against them would
 * let the agent pad distinct_count toward the >= 2 suppression bar (adversarial
 * review 2026-07-03 — mirrors computeRejectRate's real-id anti-padding rule).
 * Findings without usable line data are skipped (fail-safe: no region, no
 * suppression). Other accepted actions carry no region semantics.
 */
export function harvestDispositions(
  decisions: Iterable<DecisionEntry>,
  findingsById: Map<string, Finding>,
): HarvestedDisposition[] {
  const out: HarvestedDisposition[] = [];
  for (const d of decisions) {
    const f = findingsById.get(d.finding_id);
    if (!f || typeof f.line_start !== "number") continue;
    if (f.severity === "INFO") continue;
    const isRejectedSignal =
      d.verdict === "rejected" ||
      (d.verdict === "accepted" && d.action === "verified-not-applicable");
    const isAddressed = d.verdict === "accepted" && d.action === "fixed";
    if (!isRejectedSignal && !isAddressed) continue;
    const categories = [
      ...new Set<FindingCategory>([f.category, ...(f.members?.map((m) => m.category) ?? [])]),
    ];
    out.push({
      finding_id: d.finding_id,
      file: f.file,
      line_start: f.line_start,
      line_end: typeof f.line_end === "number" ? f.line_end : f.line_start,
      severity: f.severity,
      categories,
      reason: typeof d.reason === "string" && d.reason.trim().length > 0 ? d.reason : null,
      disposition: isRejectedSignal ? "rejected" : "addressed",
    });
  }
  return out;
}

/**
 * Fold iteration `iter`'s harvested dispositions into the cycle's raw record.
 *
 * Idempotent + supersede-safe across multiple stops of the same iteration
 * (mirrors the claimed_fixed_signatures reconciliation): every record keyed
 * `<iter>:<finding_id>` is dropped first, then re-added from the current
 * last-wins set — an early partial fold the agent later superseded (rejected →
 * accepted) leaves NOTHING behind, because regions are derived from these raw
 * records at read time. Earlier iterations' records are locked.
 */
export function foldDispositions(
  existing: CycleDisposition[],
  harvested: HarvestedDisposition[],
  iter: number,
): CycleDisposition[] {
  const prefix = `${iter}:`;
  const kept = existing.filter((d) => !d.key.startsWith(prefix));
  const added = [...harvested]
    .sort((a, b) => a.finding_id.localeCompare(b.finding_id))
    .map((h) => ({
      key: `${iter}:${h.finding_id}`,
      file: h.file,
      start_line: h.line_start,
      end_line: h.line_end,
      severity: h.severity,
      categories: [...h.categories],
      reason: (h.reason ?? "").slice(0, REASON_CAP),
    }));
  return [...kept, ...added];
}

/**
 * Derive the merged region view from the surviving raw dispositions.
 *
 * Same-file dispositions within the sliding ±REGION_WINDOW tolerance merge into
 * one region: bounds union, severity max, categories union, `distinct_count` =
 * number of contributing dispositions, `reason` = the newest contributor's
 * non-empty reason (keys sort by iteration first, so "newest" is the latest
 * disposition — the most informative citation for the agent's fast-path
 * re-reject). Deterministic regardless of input order.
 */
export function mergeRegions(dispositions: CycleDisposition[]): CycleRegion[] {
  interface Acc extends CycleRegion {
    keys: string[];
  }
  const regions: Acc[] = [];
  // Numeric-iteration ordering (lexicographic would put "10:" before "2:"), then
  // finding id — so "newest reason wins" holds past iteration 9.
  const iterOf = (key: string): number => Number.parseInt(key.split(":")[0] ?? "0", 10) || 0;
  const sorted = [...dispositions].sort(
    (a, b) => iterOf(a.key) - iterOf(b.key) || a.key.localeCompare(b.key),
  );
  for (const d of sorted) {
    const file = normalizeRepoPath(d.file);
    const hit = regions.find(
      (r) =>
        normalizeRepoPath(r.file) === file &&
        d.start_line <= r.end_line + REGION_WINDOW &&
        d.end_line >= r.start_line - REGION_WINDOW,
    );
    if (hit) {
      if (hit.keys.includes(d.key)) continue; // defensive: keys are unique by fold contract
      hit.keys.push(d.key);
      hit.start_line = Math.min(hit.start_line, d.start_line);
      hit.end_line = Math.max(hit.end_line, d.end_line);
      if (SEVERITY_RANK[d.severity] > SEVERITY_RANK[hit.severity]) hit.severity = d.severity;
      for (const c of d.categories) if (!hit.categories.includes(c)) hit.categories.push(c);
      if (d.reason) hit.reason = d.reason;
      hit.distinct_count = hit.keys.length;
    } else {
      regions.push({
        file: d.file,
        start_line: d.start_line,
        end_line: d.end_line,
        severity: d.severity,
        categories: [...d.categories],
        reason: d.reason,
        distinct_count: 1,
        keys: [d.key],
      });
    }
  }
  return regions.map(({ keys: _keys, ...region }) => region);
}
