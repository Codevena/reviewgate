// src/core/aggregator.ts
import { type Range, rangeOverlapsChanged } from "../diff/hunks.ts";
import type { Consensus, Finding } from "../schemas/finding.ts";
import type { Verdict } from "../schemas/pending-report.ts";
import type { CriticVerdict } from "./critic.ts";

export interface AggregateInput {
  findings: Finding[];
  reviewersTotal: number;
  critic?: Map<string, CriticVerdict>;
  // M5 Part A: per-file changed new-file line ranges. When provided and
  // scopeToDiff !== false, findings outside the changed hunks are demoted to INFO.
  changedRanges?: Map<string, Range[]>;
  scopeToDiff?: boolean;
}

export interface AggregateResult {
  verdict: Verdict;
  dedupedFindings: Finding[];
  counts: { critical: number; warn: number; info: number };
}

const DEMOTE: Record<Finding["severity"], Finding["severity"] | "drop"> = {
  CRITICAL: "WARN",
  WARN: "INFO",
  INFO: "drop",
};

function computeConsensus(flagged: number, total: number): Consensus {
  if (total >= 3 && flagged === total) return "unanimous";
  if (flagged >= 2) return "majority";
  if (total >= 3) return "minority";
  return "singleton";
}

const SEVERITY_RANK: Record<Finding["severity"], number> = { CRITICAL: 2, WARN: 1, INFO: 0 };

// Region dedup key — groups by file + a 5-line window. Deliberately EXCLUDES
// BOTH rule_id AND category: different reviewers name the same bug differently
// ("sql-injection" vs "sqli-risk") and categorize the same line differently (the
// same magic number is "quality" to one reviewer and "performance" to another),
// which would otherwise split one issue into several the user must disposition
// separately. The tight 5-line window keeps genuinely separate issues (>5 lines
// apart) distinct; representative keeps the highest severity, so a co-located
// CRITICAL is never hidden behind a lower-severity neighbour.
function dedupKey(f: Finding): string {
  return `${f.file}|${Math.floor((f.line_start - 1) / 5)}`;
}

// Significant-word set of a message (lowercased, punctuation→space, drop short
// tokens). Used for a CONSERVATIVE lexical-similarity merge so the SAME bug
// described in similar words by different reviewers — even at a different
// category/line/rule_id — collapses to one finding.
function normTokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const t of s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")) {
    if (t.length > 3) out.add(t);
  }
  return out;
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}
// Deliberately HIGH: only near-identical wording merges. Genuinely distinct
// issues stay separate — over-merging would mask a real finding behind another's
// single decision (a security risk), so we err toward keeping findings apart.
const SIM_THRESHOLD = 0.6;

interface Cluster {
  sample: Finding;
  reviewers: string[];
  messages: string[];
  tokens: Set<string>;
  categories: Set<string>;
}

export function aggregate(input: AggregateInput): AggregateResult {
  // Sort into a fully deterministic order BEFORE greedy clustering — reviewers
  // return findings in an unstable order, and the cluster a finding lands in must
  // not depend on that order. Highest severity first within a file+line so the
  // cluster seed is the representative and its token set is a stable anchor.
  const sorted = [...input.findings].sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.line_start - b.line_start ||
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      a.rule_id.localeCompare(b.rule_id) ||
      a.message.localeCompare(b.message),
  );
  const clusters: Cluster[] = [];
  for (const f of sorted) {
    const reviewerKey = `${f.reviewer.provider}:${f.reviewer.persona}`;
    const fTokens = normTokens(f.message);
    // Merge into an existing cluster (same file) when EITHER the file + 5-line
    // region matches (category-independent — see dedupKey) OR the wording is
    // highly similar.
    let target: Cluster | undefined;
    for (const c of clusters) {
      if (c.sample.file !== f.file) continue;
      if (dedupKey(c.sample) === dedupKey(f) || jaccard(c.tokens, fTokens) >= SIM_THRESHOLD) {
        target = c;
        break;
      }
    }
    if (target) {
      if (!target.reviewers.includes(reviewerKey)) target.reviewers.push(reviewerKey);
      if (!target.messages.includes(f.message)) target.messages.push(f.message);
      target.categories.add(f.category);
      // Representative = highest severity (most conservative); ties keep the first.
      // Note: target.tokens is NOT mutated — the seed's tokens stay the cluster's
      // stable comparison anchor (mutating them would make clustering order-dependent).
      if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[target.sample.severity]) {
        target.sample = f;
      }
    } else {
      clusters.push({
        sample: f,
        reviewers: [reviewerKey],
        messages: [f.message],
        tokens: fTokens,
        categories: new Set([f.category]),
      });
    }
  }

  const deduped: Finding[] = [];
  for (const { sample, reviewers, messages, categories } of clusters) {
    const consensus = computeConsensus(reviewers.length, input.reviewersTotal);
    // Preserve every reviewer's wording so nothing is lost when findings merge.
    const others = messages.filter((m) => m !== sample.message);
    let details =
      others.length > 0
        ? `${sample.details}\n\nAlso reported by other reviewers:\n${others.map((m) => `- ${m}`).join("\n")}`
        : sample.details;
    // Masking guard: when a region merge spans MULTIPLE categories, this single
    // finding (one decision) covers more than one concern — surface that so the
    // agent's accept/reject addresses all of them, not just the representative.
    if (categories.size > 1) {
      details += `\n\n⚠ This finding merges concerns categorized as: ${[...categories].sort().join(", ")}. Your decision dispositions ALL of them — make sure each is addressed before accepting/rejecting.`;
    }
    deduped.push({
      ...sample,
      details: details.slice(0, 2000),
      confirmed_by: reviewers,
      consensus,
    });
  }

  const critic = input.critic;
  const survivors: Finding[] = [];
  for (const f of deduped) {
    const cv = critic?.get(f.signature);
    if (cv?.verdict === "likely_fp") {
      const isCriticalSecurity =
        f.severity === "CRITICAL" && (f.category === "security" || f.category === "correctness");
      const isUnanimous = f.consensus === "unanimous";
      if (!isCriticalSecurity && !isUnanimous) {
        const next = DEMOTE[f.severity];
        if (next === "drop") continue; // INFO likely_fp dropped entirely
        survivors.push({
          ...f,
          severity: next,
          critic_verdict: "likely_fp",
          ...(cv.reason ? { critic_reason: cv.reason } : {}),
        });
        continue;
      }
      survivors.push({ ...f, critic_verdict: "keep" });
      continue;
    }
    survivors.push(f);
  }

  // M5 Part A — diff-scoping: demote findings outside the changed hunks to INFO
  // (advisory, never dropped). Cross-impact stays visible; only the BLOCKING
  // weight is removed. Range intersection (not line_start alone) keeps a finding
  // anchored to a declaration above the edit whose range overlaps the change.
  const scoped: Finding[] =
    input.scopeToDiff !== false && input.changedRanges
      ? survivors.map((f) => {
          if (!f.line_start) return f; // no usable line → keep (conservative)
          const ranges = input.changedRanges?.get(f.file);
          if (!ranges) return f; // file not in diff → keep (conservative)
          if (rangeOverlapsChanged(f.line_start, f.line_end ?? f.line_start, ranges)) return f;
          if (f.severity === "INFO") return { ...f, scope_demoted: true };
          return {
            ...f,
            severity: "INFO" as const,
            scope_demoted: true,
            details: `${f.details}\n\n↓ outside the changed lines — advisory only.`,
          };
        })
      : survivors;

  let critical = 0;
  let warn = 0;
  let info = 0;
  let fail = false;
  let warnFail = false;
  for (const f of scoped) {
    if (f.severity === "CRITICAL") {
      critical++;
      if (f.category === "security" || f.category === "correctness") {
        fail = true;
      } else if (f.consensus === "unanimous" || f.consensus === "majority") {
        fail = true;
      }
    } else if (f.severity === "WARN") {
      warn++;
      if (f.consensus === "unanimous" || f.consensus === "majority") {
        warnFail = true;
      }
    } else {
      info++;
    }
  }

  let verdict: Verdict;
  if (fail || warnFail) verdict = "FAIL";
  else if (warn > 0) verdict = "SOFT-PASS";
  else verdict = "PASS";

  // Reassign unique sequential ids across the merged panel. Each reviewer
  // numbers its own findings from F-001, so without this two distinct findings
  // could share an id — and the decisions-gate keys on finding_id, so a single
  // decision would wrongly satisfy both. Unique ids keep the gate sound.
  const renumbered = scoped.map((f, i) => ({ ...f, id: `F-${String(i + 1).padStart(3, "0")}` }));

  return { verdict, dedupedFindings: renumbered, counts: { critical, warn, info } };
}
