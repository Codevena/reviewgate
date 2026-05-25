// src/core/aggregator.ts
import { type Range, rangeOverlapsChanged } from "../diff/hunks.ts";
import { normalizeRepoPath } from "../diff/repo-path.ts";
import type { Consensus, Finding, FindingCategory } from "../schemas/finding.ts";
import type { Verdict } from "../schemas/pending-report.ts";
import { compareCodeUnits } from "../utils/compare.ts";
import type { CriticVerdict } from "./critic.ts";

export interface AggregateInput {
  findings: Finding[];
  reviewersTotal: number;
  critic?: Map<string, CriticVerdict>;
  // M5 Part A: per-file changed new-file line ranges. When provided and
  // scopeToDiff !== false, findings outside the changed hunks are demoted to INFO.
  changedRanges?: Map<string, Range[]>;
  scopeToDiff?: boolean;
  // Categories whose findings stay BLOCKING even when their file is not in the
  // diff at all (escape hatch for legitimate cross-file impact — e.g. a changed
  // export breaking an untouched caller). Empty/absent → every out-of-diff
  // finding demotes to INFO (the default, maximal hallucination suppression).
  outOfDiffBlocking?: FindingCategory[];
  // M5 Part B1: active/sticky FP-ledger entries keyed by signature. A finding
  // whose representative or any member signature matches is demoted to INFO.
  fpActive?: Map<string, { id: string }>;
  // Phase 4 #7: reviewer-confidence floor (0..1). When > 0, an UNCORROBORATED
  // finding whose confidence is below the floor is demoted to INFO (advisory) —
  // so a reviewer's own low-confidence call no longer blocks as hard as a
  // high-confidence one. A CRITICAL security/correctness finding is exempt (always
  // blocks), and a corroborated finding (majority/unanimous) is exempt (consensus
  // overrides one reviewer's low self-rating). 0/absent → confidence unused.
  confidenceFloor?: number;
  // Providers currently below the reputation trust floor. A lone (un-corroborated),
  // NON-security/correctness finding whose every contributing provider is in this set
  // is demoted ONE step (CRITICAL→WARN, WARN→INFO; never below INFO). Empty/absent → off.
  repUnreliable?: Set<string>;
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
  members: NonNullable<Finding["members"]>;
}

// True if the finding's representative OR any merged member is categorized
// security/correctness. Clustering is category-independent, so such a concern can
// ride as a member under, e.g., a quality representative — both the always-block
// verdict gate and the confidence-demote exemption must look past the
// representative's own category, or a dangerous finding silently goes advisory.
function touchesSecurityOrCorrectness(f: Finding): boolean {
  const cats = [f.category, ...(f.members?.map((m) => m.category) ?? [])];
  return cats.some((c) => c === "security" || c === "correctness");
}

function memberOf(f: Finding): NonNullable<Finding["members"]>[number] {
  return {
    signature: f.signature,
    provider: f.reviewer.provider,
    rule_id: f.rule_id,
    category: f.category,
    confidence: f.confidence,
  };
}

// Diff-scoping: demote findings that don't anchor to the changed lines to INFO
// (advisory, never dropped) so a hallucination on unchanged code can't block.
// Two cases: (1) the finding's FILE isn't in the diff at all — the strongest FP
// signal — demoted unless its category is in `outOfDiffBlocking` (cross-file
// escape hatch); (2) the file is in the diff but the finding's line range is
// outside the changed hunks. Paths on both sides are normalized so a reviewer's
// "./src/x.ts" matches the canonical "src/x.ts" diff key.
function scopeFindings(survivors: Finding[], input: AggregateInput): Finding[] {
  if (input.scopeToDiff === false || !input.changedRanges) return survivors;
  const normalizedRanges = new Map<string, Range[]>();
  for (const [k, v] of input.changedRanges) normalizedRanges.set(normalizeRepoPath(k), v);
  const blocking = new Set<FindingCategory>(input.outOfDiffBlocking ?? []);
  // Keep details within FindingSchema's 2000-char cap (truncate the original,
  // never the note) — appending blindly can overflow a finding already at the
  // limit → schema-invalid pending.json.
  const demote = (f: Finding, note: string): Finding => {
    if (f.severity === "INFO") return { ...f, scope_demoted: true };
    const details = `${f.details.slice(0, 2000 - note.length)}${note}`;
    return { ...f, severity: "INFO" as const, scope_demoted: true, details };
  };
  return survivors.map((f) => {
    if (!f.line_start) return f; // no usable line → keep (conservative)
    const ranges = normalizedRanges.get(normalizeRepoPath(f.file));
    if (!ranges) {
      // Category-independent clustering can merge several categories into one
      // finding, so honor the escape hatch if ANY merged member category (not just
      // the representative's) is configured to stay blocking.
      const categories = [f.category, ...(f.members?.map((m) => m.category) ?? [])];
      if (categories.some((c) => blocking.has(c))) return f;
      return demote(f, "\n\n↓ not in the changed files — advisory only.");
    }
    if (rangeOverlapsChanged(f.line_start, f.line_end ?? f.line_start, ranges)) return f;
    return demote(f, "\n\n↓ outside the changed lines — advisory only.");
  });
}

export function aggregate(input: AggregateInput): AggregateResult {
  // Canonicalize every finding's path up front so clustering/dedup, the emitted
  // representative path, AND the diff-scope lookup all agree — otherwise "./x.ts"
  // and "x.ts" from two reviewers would never merge and would scope inconsistently.
  // (Built-in reviewers already normalize in review-output, but aggregate() is
  // exported and must be robust to raw paths.)
  const findings = input.findings.map((f) =>
    f.file ? { ...f, file: normalizeRepoPath(f.file) } : f,
  );
  // Sort into a fully deterministic order BEFORE greedy clustering — reviewers
  // return findings in an unstable order, and the cluster a finding lands in must
  // not depend on that order. Highest severity first within a file+line so the
  // cluster seed is the representative and its token set is a stable anchor.
  const sorted = [...findings].sort(
    (a, b) =>
      compareCodeUnits(a.file, b.file) ||
      a.line_start - b.line_start ||
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      compareCodeUnits(a.rule_id, b.rule_id) ||
      compareCodeUnits(a.message, b.message),
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
      target.members.push(memberOf(f));
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
        members: [memberOf(f)],
      });
    }
  }

  const deduped: Finding[] = [];
  for (const { sample, reviewers, messages, categories, members } of clusters) {
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
      members,
    });
  }

  const critic = input.critic;
  const survivors: Finding[] = [];
  for (const f of deduped) {
    const cv = critic?.get(f.signature);
    if (cv?.verdict === "likely_fp") {
      const isCriticalSecurity = f.severity === "CRITICAL" && touchesSecurityOrCorrectness(f);
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
  const scoped: Finding[] = scopeFindings(survivors, input);

  // M5 Part B1 — reactive FP-ledger demote: a finding whose representative
  // signature (or any merged member signature) matches an active/sticky FP entry
  // is demoted to INFO + tagged. Never dropped — stays visible in the advisory
  // section, and the decisions-gate already ignores INFO.
  const fpActive = input.fpActive;
  const fpScoped: Finding[] = fpActive
    ? scoped.map((f) => {
        // Representative first, then members; dedup so a member equal to the
        // representative is not double-counted.
        const sigs = [...new Set([f.signature, ...(f.members?.map((m) => m.signature) ?? [])])];
        const matched = sigs.filter((s) => fpActive.has(s));
        if (matched.length === 0) return f;
        // pattern_id = the first matching signature's entry (deterministic order).
        const hit = fpActive.get(matched[0] as string);
        const base = f.severity === "INFO" ? f : { ...f, severity: "INFO" as const };
        return {
          ...base,
          fp_ledger_match: {
            pattern_id: (hit as { id: string }).id,
            matched_count: matched.length,
            suppressed: true,
          },
        };
      })
    : scoped;

  // Phase 4 #7 — confidence demote: an uncorroborated finding below the floor is
  // advisory only. Exempt: corroborated findings (majority/unanimous — multiple
  // reviewers agreeing outweighs one's low self-rating) and CRITICAL clusters that
  // touch security/correctness. The latter checks the representative AND every
  // merged member category (clustering is category-independent, so a CRITICAL
  // security/correctness concern can ride as a member under, e.g., a quality
  // representative — demoting the cluster would hide it and could flip FAIL→PASS).
  const floor = input.confidenceFloor ?? 0;
  const confScoped: Finding[] =
    floor > 0
      ? fpScoped.map((f) => {
          // Cluster confidence = MAX over the representative and all merged members,
          // so a co-located high-confidence member is never masked by a
          // low-confidence representative. (memberOf records each member's
          // confidence; older/persisted members may omit it → ignored in the max.)
          const memberConfs = (f.members ?? [])
            .map((m) => m.confidence)
            .filter((c): c is number => typeof c === "number");
          const maxConfidence = Math.max(f.confidence, ...memberConfs);
          if (maxConfidence >= floor) return f;
          if (f.consensus === "unanimous" || f.consensus === "majority") return f;
          if (f.severity === "CRITICAL" && touchesSecurityOrCorrectness(f)) return f;
          if (f.severity === "INFO") return { ...f, low_confidence: true };
          const note = `\n\n↓ low reviewer confidence (${maxConfidence.toFixed(2)} < ${floor}) — advisory only.`;
          // Truncate the ORIGINAL (not the note) so the explanation is never lost
          // — mirrors scopeFindings' demote() and stays within the 2000-char cap.
          return {
            ...f,
            severity: "INFO" as const,
            low_confidence: true,
            details: `${f.details.slice(0, 2000 - note.length)}${note}`,
          };
        })
      : fpScoped;

  // Reviewer-reputation demote (Slice 1): an un-corroborated finding whose every
  // contributing provider is currently unreliable is demoted one step. Mirrors the
  // confidence-demote exemptions: corroborated (majority/unanimous) and any
  // security/correctness finding are NEVER reputation-demoted; INFO is untouched.
  const repUnreliable = input.repUnreliable;
  const repScoped: Finding[] =
    repUnreliable && repUnreliable.size > 0
      ? confScoped.map((f) => {
          if (f.severity === "INFO") return f;
          if (f.consensus === "unanimous" || f.consensus === "majority") return f;
          if (touchesSecurityOrCorrectness(f)) return f;
          const provs = [f.reviewer.provider, ...(f.members?.map((m) => m.provider) ?? [])];
          if (!provs.every((p) => repUnreliable.has(p))) return f;
          const next = DEMOTE[f.severity];
          if (next === "drop") return f;
          const note = "\n\n↓ low reviewer reputation — advisory only.";
          return {
            ...f,
            severity: next,
            reputation_demoted: true,
            details: `${f.details.slice(0, 2000 - note.length)}${note}`,
          };
        })
      : confScoped;

  let critical = 0;
  let warn = 0;
  let info = 0;
  let fail = false;
  let warnFail = false;
  for (const f of repScoped) {
    if (f.severity === "CRITICAL") {
      critical++;
      if (touchesSecurityOrCorrectness(f)) {
        // Always a hard FAIL — checks the representative AND merged member
        // categories, so a security/correctness concern clustered under a
        // different representative category is never silently non-blocking.
        fail = true;
      } else if (f.consensus === "unanimous" || f.consensus === "majority") {
        fail = true;
      } else if (input.reviewersTotal <= 1) {
        // Single-reviewer panel (e.g. the only non-capped reviewer after a quota
        // failover): `singleton` is the STRONGEST consensus achievable — there is
        // no second opinion to corroborate or demote. Honour the lone reviewer's
        // CRITICAL as a hard FAIL rather than letting it SOFT-PASS through. (With
        // ≥2 reviewers the consensus gate above still guards against one reviewer's
        // lone over-call.)
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
  const renumbered = repScoped.map((f, i) => ({
    ...f,
    id: `F-${String(i + 1).padStart(3, "0")}`,
  }));

  return { verdict, dedupedFindings: renumbered, counts: { critical, warn, info } };
}
