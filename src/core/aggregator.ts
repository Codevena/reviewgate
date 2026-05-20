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
