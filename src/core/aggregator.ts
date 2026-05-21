// src/core/aggregator.ts
import type { Consensus, Finding } from "../schemas/finding.ts";
import type { Verdict } from "../schemas/pending-report.ts";
import type { CriticVerdict } from "./critic.ts";

export interface AggregateInput {
  findings: Finding[];
  reviewersTotal: number;
  critic?: Map<string, CriticVerdict>;
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

// Semantic dedup key — deliberately EXCLUDES rule_id (different reviewers name
// the same bug differently, e.g. "sql-injection" vs "sqli-risk", which would
// otherwise yield distinct signatures and force the user to disposition the same
// bug N times). Groups by file + category + a 5-line window, so the same issue
// reported by multiple reviewers collapses to one finding, while genuinely
// separate issues (>5 lines apart or different category) stay distinct.
function dedupKey(f: Finding): string {
  return `${f.file}|${f.category}|${Math.floor((f.line_start - 1) / 5)}`;
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
}

export function aggregate(input: AggregateInput): AggregateResult {
  const clusters: Cluster[] = [];
  for (const f of input.findings) {
    const reviewerKey = `${f.reviewer.provider}:${f.reviewer.persona}`;
    const fTokens = normTokens(f.message);
    // Merge into an existing cluster (same file) when EITHER the original
    // file|category|5-line region matches OR the wording is highly similar.
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
      // Representative = highest severity (most conservative); ties keep the first.
      if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[target.sample.severity]) {
        target.sample = f;
        target.tokens = fTokens;
      }
    } else {
      clusters.push({
        sample: f,
        reviewers: [reviewerKey],
        messages: [f.message],
        tokens: fTokens,
      });
    }
  }

  const deduped: Finding[] = [];
  for (const { sample, reviewers, messages } of clusters) {
    const consensus = computeConsensus(reviewers.length, input.reviewersTotal);
    // Preserve every reviewer's wording so nothing is lost when findings merge.
    const others = messages.filter((m) => m !== sample.message);
    const details =
      others.length > 0
        ? `${sample.details}\n\nAlso reported by other reviewers:\n${others.map((m) => `- ${m}`).join("\n")}`.slice(
            0,
            2000,
          )
        : sample.details;
    deduped.push({ ...sample, details, confirmed_by: reviewers, consensus });
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

  let critical = 0;
  let warn = 0;
  let info = 0;
  let fail = false;
  let warnFail = false;
  for (const f of survivors) {
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
  const renumbered = survivors.map((f, i) => ({ ...f, id: `F-${String(i + 1).padStart(3, "0")}` }));

  return { verdict, dedupedFindings: renumbered, counts: { critical, warn, info } };
}
