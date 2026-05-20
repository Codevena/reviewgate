// src/core/aggregator.ts
import type { Consensus, Finding } from "../schemas/finding.ts";
import type { Verdict } from "../schemas/pending-report.ts";

export interface AggregateInput {
  findings: Finding[];
  reviewersTotal: number;
}

export interface AggregateResult {
  verdict: Verdict;
  dedupedFindings: Finding[];
  counts: { critical: number; warn: number; info: number };
}

function computeConsensus(flagged: number, total: number): Consensus {
  if (total >= 3 && flagged === total) return "unanimous";
  if (flagged >= 2) return "majority";
  if (total >= 3) return "minority";
  return "singleton";
}

export function aggregate(input: AggregateInput): AggregateResult {
  // Group by signature.
  const bySig = new Map<string, { sample: Finding; reviewers: string[] }>();
  for (const f of input.findings) {
    const key = f.signature;
    const entry = bySig.get(key);
    const reviewerKey = `${f.reviewer.provider}:${f.reviewer.persona}`;
    if (entry) {
      if (!entry.reviewers.includes(reviewerKey)) entry.reviewers.push(reviewerKey);
    } else {
      bySig.set(key, { sample: f, reviewers: [reviewerKey] });
    }
  }

  const deduped: Finding[] = [];
  for (const { sample, reviewers } of bySig.values()) {
    const consensus = computeConsensus(reviewers.length, input.reviewersTotal);
    deduped.push({ ...sample, confirmed_by: reviewers, consensus });
  }

  let critical = 0;
  let warn = 0;
  let info = 0;
  let fail = false;
  let warnFail = false;
  for (const f of deduped) {
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

  return { verdict, dedupedFindings: deduped, counts: { critical, warn, info } };
}
