// src/core/aggregator.ts
import { type Range, rangeOverlapsChanged } from "../diff/hunks.ts";
import { normalizeRepoPath } from "../diff/repo-path.ts";
import { classify } from "../research/diff-facts.ts";
import type { Consensus, Finding, FindingCategory } from "../schemas/finding.ts";
import type { Verdict } from "../schemas/pending-report.ts";
import { compareCodeUnits } from "../utils/compare.ts";
import { isHarnessConfigPath } from "../utils/git.ts";
import type { CriticVerdict } from "./critic.ts";
import { normalizeProviders } from "./decision-outcome.ts";
import { ruleIdToken0 } from "./fp-ledger/clusters.ts";

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
  // Per-cycle suppression: signatures the agent already rejected as
  // reviewer_was_wrong in an EARLIER iteration of the CURRENT review cycle. A
  // finding whose representative or any member signature matches is demoted to
  // INFO (advisory) so the agent never re-rejects the same recurring finding and
  // it stops feeding the reviewer-fp-streak. Reset on re-arm.
  cycleRejected?: Set<string>;
  // F3 Phase 2: active/sticky FP CLUSTERS keyed by `<rule_id_token0>@<file>`. A
  // finding whose (rule_id_token0, file) matches an active cluster is demoted
  // to INFO and tagged with `fp_cluster_match`. Catches multi-rule_id
  // hallucination bursts that per-signature granularity misses. Demote-only
  // (like fpActive) — never dropped, so a real cluster-domain bug stays
  // visible in the advisory section.
  fpActiveClusters?: Map<string, { key: string; member_ids: string[] }>;
  // Phase 4 #7: reviewer-confidence floor (0..1). When > 0, an UNCORROBORATED
  // finding whose confidence is below the floor is demoted to INFO (advisory) —
  // so a reviewer's own low-confidence call no longer blocks as hard as a
  // high-confidence one. A CRITICAL security/correctness finding is exempt (always
  // blocks), and a corroborated finding (majority/unanimous) is exempt (consensus
  // overrides one reviewer's low self-rating). 0/absent → confidence unused.
  confidenceFloor?: number;
  // Reviewer keys (`provider:persona`) currently below the reputation trust floor. A lone
  // (un-corroborated) finding whose every contributing reviewer key is in this set is demoted:
  // security is never softened; correctness goes to INFO (advisory) when demoteCorrectness is on;
  // pure quality/style is demoted one step (CRITICAL→WARN, WARN→INFO). Empty/absent → off.
  repUnreliable?: Set<string>;
  // #4 (field report 2026-06-17): base-provider keys with a high historical precision
  // (>= HIGH_PRECISION_FLOOR, >= PROTECT_MIN_DECISIONS samples). A BLOCKING finding whose
  // every contributing base provider is in this set is EXEMPT from the two SOFT demoters
  // (critic likely_fp + confidence-floor) — it stays at full severity + is tagged
  // protected_high_precision. Anti-suppression: only ever PREVENTS a demote, never drops or
  // softens. NEVER protects a self_refuted finding (T1) or any HARD suppressor. Empty/absent → off.
  protectedReviewers?: Set<string>;
  // When true, a lone unreliable reviewer's uncorroborated CORRECTNESS finding is
  // demoted to INFO (advisory). security is NEVER demoted. Absent/false → off
  // (preserves the pre-feature behavior; production passes true from config).
  demoteCorrectness?: boolean;
  // Slice 2 (field report #9): when true, a SECURITY finding whose file classify()s as
  // "tests" is demoted to INFO (advisory). Only security; correctness/other stay. Absent/
  // false → no-op (production passes the config value, default true). Representative-keyed.
  demoteTestSecurity?: boolean;
  // §4.3 Fix-Verification: signatures the agent marked accepted/action:"fixed" in
  // an EARLIER iteration of the current cycle → earliest claimed iter. A deduped
  // finding whose representative OR any member signature matches (and whose
  // representative signature is NOT in `cycleRejected` — tie-break) is PINNED:
  // the critic, confidence-floor, and reputation demote passes skip it so an
  // ineffective "fix" stays blocking. NOT exempt from scopeFindings/fp passes.
  claimedFixed?: Map<string, number>;
}

export interface AggregateResult {
  verdict: Verdict;
  dedupedFindings: Finding[];
  counts: { critical: number; warn: number; info: number };
  /** Findings the critic DROPPED entirely (INFO likely_fp → drop). Exposed so a
   *  side-consumer (implicit-outcomes) can attribute them; the count is derived. */
  criticDropped: Finding[];
  /** Convenience count (== criticDropped.length); kept for existing callers. */
  criticDroppedCount: number;
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
// True 5-line proximity window (NOT a fixed bucket): two same-file findings whose
// line_start differs by ≤5 are in the same region. Fixed floor()-buckets broke
// the promise at every boundary (lines 5 vs 6 sit in different buckets despite
// being adjacent, while 1 vs 5 share one) — a sliding window honors the documented
// guarantee at every line (F-009).
const REGION_WINDOW = 5;
function sameRegion(a: { file: string; line_start: number }, b: Finding): boolean {
  return a.file === b.file && Math.abs(a.line_start - b.line_start) <= REGION_WINDOW;
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

// The wording-similarity merge is additionally distance-bounded: two findings
// whose messages are similar but which sit far apart in the file are almost
// always DIFFERENT defects that happen to be described alike (e.g. two distinct
// null-derefs). Without this bound the file-wide jaccard merge would bury the
// farther bug as a member disposed by a single decision — exactly the masking the
// SIM_THRESHOLD comment says we avoid (F-010). The window is generous enough to
// absorb reviewer line-jitter on the SAME issue, but far short of file-wide.
const WORDING_MERGE_MAX_LINE_DISTANCE = 25;

interface Cluster {
  sample: Finding;
  // Immutable membership anchor: the file + line_start of the cluster SEED (the
  // first finding that opened the cluster). `sample` is re-pointed to the highest
  // severity member as the cluster grows, so testing region/wording-distance
  // membership against `sample.line_start` would let the merge window DRIFT with
  // each merge (a later finding could merge only because an earlier higher-severity
  // member pulled the representative closer). Anchoring to the stable seed span
  // keeps membership order-independent (F-009/F-010 mirror the tokens-not-mutated
  // invariant).
  anchorFile: string;
  anchorLine: number;
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

// N6: the "high-stakes" category boundary. A correctness/security concern and a
// cosmetic one (quality/docs/testing/…) must not be REGION-merged under one finding,
// or one decision would dispose both and the nit inflates to the bug's severity.
function isHighStakesCategory(c: string): boolean {
  return c === "security" || c === "correctness";
}

// True if the finding's representative OR any merged member is `security`.
// security findings are NEVER reputation-demoted (hard veto preserved).
function touchesSecurity(f: Finding): boolean {
  const cats = [f.category, ...(f.members?.map((m) => m.category) ?? [])];
  return cats.some((c) => c === "security");
}
// True if the finding's representative OR any merged member is `correctness`.
function touchesCorrectness(f: Finding): boolean {
  const cats = [f.category, ...(f.members?.map((m) => m.category) ?? [])];
  return cats.some((c) => c === "correctness");
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
      // I-17: a finding on harness config (.claude/) the diff did NOT touch is
      // exploration noise — the every-branch "repo-local hooks = RCE" wolf-cry on
      // PRE-EXISTING hook config. Demote regardless of category (incl. the security
      // out-of-diff escape hatch): it isn't introduced by this change. An IN-DIFF
      // .claude change hits the ranges branch below and CAN still block, so
      // malicious/accidental hook edits stay reviewed (F-003).
      if (isHarnessConfigPath(normalizeRepoPath(f.file))) {
        return demote(
          f,
          "\n\n↓ pre-existing harness config not changed by this diff — advisory only.",
        );
      }
      // Category-independent clustering can merge several categories into one
      // finding, so honor the escape hatch if ANY merged member category (not just
      // the representative's) is configured to stay blocking.
      const categories = [f.category, ...(f.members?.map((m) => m.category) ?? [])];
      if (categories.some((c) => blocking.has(c))) return f;
      return demote(f, "\n\n↓ not in the changed files — advisory only.");
    }
    if (rangeOverlapsChanged(f.line_start, f.line_end ?? f.line_start, ranges)) return f;
    // In-file but outside the changed hunks. Honor the SAME blocking escape hatch
    // as the file-absent case above: a reviewer often cites the enclosing
    // declaration a few lines above the changed call, so a configured category
    // (e.g. security) must be able to stay blocking instead of silently demoting a
    // real CRITICAL to INFO (F-033).
    const categories = [f.category, ...(f.members?.map((m) => m.category) ?? [])];
    if (categories.some((c) => blocking.has(c))) return f;
    return demote(f, "\n\n↓ outside the changed lines — advisory only.");
  });
}

// Slice 1 (field report #1): a finding whose SUBJECT (message/suggested_fix) is
// Reviewgate's own <REDACTED:…> placeholder, where the reviewer is treating that placeholder
// as a broken CODE SYMBOL (e.g. "undefined variable <REDACTED:…>", "invalid CUID") — a false
// positive by construction (the placeholder isn't real code). We DEMOTE such findings to
// advisory INFO. The SAME placeholder also masks a genuinely committed secret (sanitizer
// HEX_SECRET_WITH_CONTEXT), so the demote must NEVER touch a real-leak report. The gates are
// designed to FAIL SAFE — a finding is demoted ONLY when it POSITIVELY looks like the
// code-symbol hallucination AND nothing flags it as a secret:
//   (1) the placeholder is in the subject (message/suggested_fix), AND
//   (2) category !== security (a security finding always stays blocking), AND
//   (3) NO secret lead word in either subject field (trusted backstop, superset of the
//       sanitizer's own HEX_SECRET_WITH_CONTEXT lead words), AND
//   (4) a POSITIVE code-hallucination signal IS present (the reviewer calls the placeholder
//       an undefined/undeclared/unused symbol, a reference/type/syntax error, etc.).
// Gate (4) is the key fail-safe (the dogfood gate's codex, iter 2, flagged that an
// absence-only rule fails OPEN: a real leak worded blandly — "exposed value <REDACTED:…>" —
// matches no secret word and would be wrongly demoted). Requiring a POSITIVE code-symbol
// signal inverts the failure direction: an unrecognized finding is NOT demoted (stays
// blocking), so a real leak we can't positively classify as a code hallucination is never
// silently softened. `category` (gate 2) is reviewer-supplied/untrusted; gates (3)+(4) are
// trusted content checks over the SAME fields gate (1) triggers on.
const SECRET_LEAD_WORD =
  /api[_-]?key|secret|token|passwo?r?d|pwd|auth|bearer|access[_-]?key|private[_-]?key|client[_-]?secret|credential|hardcoded/i;

// Positive "the reviewer thinks the placeholder is a broken code symbol" signal. Tight on
// purpose: a vague phrasing ("exposed value", "suspicious string") does NOT match, so it
// stays blocking. Matching here is the ONLY thing that permits a demote.
const REDACTION_CODE_HALLUCINATION =
  /\b(undefined|undeclared|not\s+defined|unused|unresolved|reference\s?error|type\s?error|syntax\s?error|no\s+such\s+(?:variable|symbol|identifier)|cannot\s+find\s+(?:name|module)|can't\s+find\s+(?:name|module)|invalid\s+(?:identifier|cuid|uuid|token|symbol)|not\s+a\s+valid\s+(?:identifier|name|variable)|never\s+(?:declared|defined))\b/i;

function isRedactionArtifact(f: Finding): boolean {
  const fields = [f.message, f.suggested_fix ?? ""];
  if (!fields.some((s) => s.includes("<REDACTED:"))) return false; // gate 1: subject only
  if (f.category === "security") return false; // gate 2: keep a possible real leak blocking
  if (fields.some((s) => SECRET_LEAD_WORD.test(s))) return false; // gate 3: secret-word backstop
  // gate 4 (fail-safe): demote ONLY with a positive code-hallucination signal. No signal →
  // not demoted → stays blocking, so an unrecognized real leak is never softened.
  if (!fields.some((s) => REDACTION_CODE_HALLUCINATION.test(s))) return false;
  return true;
}

export function aggregate(input: AggregateInput): AggregateResult {
  // Slice 1: DEMOTE redaction-artifact findings to INFO (advisory) BEFORE clustering.
  // Pre-cluster so a demoted artifact (now INFO, the lowest severity) can never become a
  // cluster REPRESENTATIVE that masks a real co-located finding — a real CRITICAL/WARN seeds
  // the cluster instead, and the artifact rides as an INFO member. Demote, NOT drop: see
  // isRedactionArtifact — a mis-worded real secret leak must stay VISIBLE, not vanish.
  const demoteRedaction = (f: Finding): Finding => {
    if (!isRedactionArtifact(f)) return f;
    if (f.severity === "INFO") return { ...f, redaction_demoted: true };
    const note =
      "\n\n↓ targets Reviewgate's own <REDACTED:…> placeholder (a stripped secret, not real code) — advisory only.";
    return {
      ...f,
      severity: "INFO" as const,
      redaction_demoted: true,
      details: `${f.details.slice(0, 2000 - note.length)}${note}`,
    };
  };
  // Canonicalize every finding's path up front so clustering/dedup, the emitted
  // representative path, AND the diff-scope lookup all agree — otherwise "./x.ts"
  // and "x.ts" from two reviewers would never merge and would scope inconsistently.
  // (Built-in reviewers already normalize in review-output, but aggregate() is
  // exported and must be robust to raw paths.) Redaction-demote folds in here so a
  // demoted finding's INFO severity is set before the severity-ordered clustering sort.
  const findings = input.findings.map((f) => {
    const d = demoteRedaction(f);
    return d.file ? { ...d, file: normalizeRepoPath(d.file) } : d;
  });
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
    // region matches (category-independent — see sameRegion) OR the wording is
    // highly similar.
    let target: Cluster | undefined;
    for (const c of clusters) {
      if (c.anchorFile !== f.file) continue;
      // Test membership against the IMMUTABLE seed anchor (anchorFile/anchorLine),
      // NOT the mutated representative `c.sample` — otherwise a higher-severity
      // member re-pointing `sample` would shift the region/wording window and make
      // clustering order-dependent. Mirrors the `tokens`-not-mutated invariant.
      const wordingMerge =
        jaccard(c.tokens, fTokens) >= SIM_THRESHOLD &&
        Math.abs(c.anchorLine - f.line_start) <= WORDING_MERGE_MAX_LINE_DISTANCE;
      if (sameRegion({ file: c.anchorFile, line_start: c.anchorLine }, f) || wordingMerge) {
        // N6: a REGION-only merge (co-located but differently-worded) that crosses the
        // high-stakes boundary bundles a real bug with a cosmetic nit under one
        // decision and inflates the nit's severity — block it, keep them separate. A
        // WORDING merge (high lexical similarity) is the SAME issue two reviewers
        // worded/categorized differently → still merge (genuine dedup, F-137).
        const fHigh = isHighStakesCategory(f.category);
        if (!wordingMerge && [...c.categories].some((cat) => isHighStakesCategory(cat) !== fHigh)) {
          continue;
        }
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
        anchorFile: f.file,
        anchorLine: f.line_start,
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
    let suffix =
      others.length > 0
        ? `\n\nAlso reported by other reviewers:\n${others.map((m) => `- ${m}`).join("\n")}`
        : "";
    // Masking guard: when a region merge spans MULTIPLE categories, this single
    // finding (one decision) covers more than one concern — surface that so the
    // agent's accept/reject addresses all of them, not just the representative.
    if (categories.size > 1) {
      suffix += `\n\n⚠ This finding merges concerns categorized as: ${[...categories].sort().join(", ")}. Your decision dispositions ALL of them — make sure each is addressed before accepting/rejecting.`;
    }
    // Keep details within FindingSchema's 2000-char cap by truncating the
    // ORIGINAL, never the appended notes (the demote() invariant) — appending
    // before slicing dropped the masking warning exactly on long-detail
    // findings (F-08). A pathological over-cap suffix keeps its TAIL so the
    // masking warning (appended last) always survives.
    const details = suffix
      ? `${sample.details.slice(0, Math.max(0, 2000 - suffix.length))}${suffix.slice(-2000)}`
      : sample.details;
    deduped.push({
      ...sample,
      details: details.slice(0, 2000),
      confirmed_by: reviewers,
      consensus,
      members,
    });
  }

  // §4.3 Fix-Verification — pin claimed-fixed recurrences UP FRONT (before any
  // demote pass; the passes do not run in a single linear order — critic precedes
  // scope — so the pin must exist before the chain regardless of ordering). A
  // deduped finding matches if its representative OR any member signature is in
  // claimedFixed. Tie-break: a finding contested via ANY of those signatures in
  // cycleRejected is NOT pinned — the agent has contested it, so cycleRejected wins
  // and the escape hatch stays open. `pinned` stores REPRESENTATIVE signatures
  // (the guards below key on `f.signature`), even when the match was on a member.
  const claimedFixed = input.claimedFixed;
  const pinned = new Set<string>();
  const taggedFindings: Finding[] =
    claimedFixed && claimedFixed.size > 0
      ? deduped.map((f) => {
          const sigs = [f.signature, ...(f.members?.map((m) => m.signature) ?? [])];
          // Tie-break: the agent contested this finding via ANY clustered signature
          // → cycleRejected wins; do not pin or tag (the unguarded cycleRejected pass
          // still demotes it to INFO, so suppressing the tag avoids an INFO finding
          // wearing a claimed_fixed_recurred badge).
          if (input.cycleRejected && sigs.some((s) => input.cycleRejected?.has(s))) return f;
          const iters = sigs
            .map((s) => claimedFixed.get(s))
            .filter((n): n is number => typeof n === "number");
          if (iters.length === 0) return f;
          pinned.add(f.signature);
          return { ...f, claimed_fixed_recurred: { iter: Math.min(...iters) } };
        })
      : deduped;

  const critic = input.critic;
  // #4: a BLOCKING finding whose every contributing base provider is high-precision is
  // protected from the SOFT demoters. Never protects a self_refuted (T1) or INFO finding —
  // only a real, blocking finding from a trusted reviewer. Anti-suppression by construction.
  const protectedReviewers = input.protectedReviewers;
  const isProtected = (f: Finding): boolean => {
    if (!protectedReviewers || protectedReviewers.size === 0) return false;
    if (f.severity === "INFO" || f.self_refuted === true) return false;
    const provs = normalizeProviders(f);
    return provs.length > 0 && provs.every((p) => protectedReviewers.has(p));
  };
  const survivors: Finding[] = [];
  const criticDropped: Finding[] = [];
  for (const f of taggedFindings) {
    // §4.3: a pinned recurrence keeps its blocking severity — skip the critic demote.
    if (pinned.has(f.signature)) {
      survivors.push(f);
      continue;
    }
    // #1: a self-refuted finding (T1) is already demoted to advisory INFO. The critic's
    // INFO+likely_fp → DROP would erase it, violating self-refutation's "demote-to-INFO,
    // never drop — stays visible/attributable" fail-safe contract end-to-end. Keep it as a
    // visible advisory survivor (it is already non-blocking, so nothing is gained by dropping).
    if (f.self_refuted === true) {
      survivors.push(f);
      continue;
    }
    // Scan the representative AND every merged member signature (mirror the
    // fp_ledger_match pass): the critic may have keyed its verdict on a member's
    // signature, not the promoted representative's — checking only f.signature
    // would let that likely_fp leak through with full blocking weight.
    const critSigs = [f.signature, ...(f.members?.map((m) => m.signature) ?? [])];
    const cv = critic && critSigs.map((s) => critic.get(s)).find((v) => v?.verdict === "likely_fp");
    if (cv?.verdict === "likely_fp") {
      const isCriticalSecurity = f.severity === "CRITICAL" && touchesSecurityOrCorrectness(f);
      // A single adversarial critic must not override GROUP agreement. Both
      // unanimous AND majority are corroborated consensus — the verdict gate
      // treats them identically (warnFail), and the confidence- and reputation-
      // demote tiers already exempt majority. Mirror that here so the critic
      // can't silently flip a corroborated FAIL into a SOFT-PASS.
      const isCorroborated = f.consensus === "unanimous" || f.consensus === "majority";
      // #4: a high-precision reviewer's blocking finding is kept at full severity even when
      // the critic calls it likely_fp — the dangerous direction is a demoted TRUE positive
      // (field report F-005). Tag it so the agent sees WHY it stayed blocking; do NOT set
      // critic_verdict (that renders the dismissive "likely FP" badge).
      if (!isCriticalSecurity && !isCorroborated && isProtected(f)) {
        survivors.push({ ...f, protected_high_precision: true });
        continue;
      }
      if (!isCriticalSecurity && !isCorroborated) {
        const next = DEMOTE[f.severity];
        if (next === "drop") {
          criticDropped.push(f); // INFO likely_fp dropped entirely — keep it attributable
          continue;
        }
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

  // Per-cycle suppression: a finding whose representative OR any member signature
  // the agent already rejected (reviewer_was_wrong) earlier this cycle is demoted
  // to INFO (advisory). Breaks the re-flag→re-reject→fp-streak loop: the agent
  // dispositions a finding once and never sees it as blocking again this cycle.
  const cycleRejected = input.cycleRejected;
  const cycleScoped: Finding[] =
    cycleRejected && cycleRejected.size > 0
      ? fpScoped.map((f) => {
          const sigs = [f.signature, ...(f.members?.map((m) => m.signature) ?? [])];
          if (!sigs.some((s) => cycleRejected.has(s))) return f;
          // G0b ceiling (codex DoD 2026-06-21): NEVER auto-hide a CRITICAL or any
          // security/correctness finding via cycleRejected. One false reviewer_was_wrong
          // rejection must not silence a later REAL CRITICAL of the same signature this cycle
          // (a fail-open); it re-surfaces for an explicit per-iteration decision instead.
          if (f.severity === "CRITICAL" || touchesSecurityOrCorrectness(f)) return f;
          return f.severity === "INFO"
            ? f
            : {
                ...f,
                severity: "INFO" as const,
                details: `${f.details.slice(0, 1900)}\n\n↓ already rejected earlier this cycle — advisory only.`,
              };
        })
      : fpScoped;

  // F3 Phase 2 — DERIVED FP-cluster demote. Applies AFTER the signature-keyed
  // pass so a finding already tagged via fp_ledger_match keeps both tags
  // (signature match + cluster match are both true). Same demote-not-drop
  // semantic as fp_ledger_match. Idempotent because the same cluster map
  // produces the same output: re-running on already-cluster-tagged input
  // re-applies the identical tag + INFO severity. No explicit short-circuit.
  const fpClusters = input.fpActiveClusters;
  const fpClusterScoped: Finding[] = fpClusters
    ? cycleScoped.map((f) => {
        // Check the representative AND every merged member rule_id (clustering is
        // category/rule-id-independent, so a known-FP rule can ride as a member
        // under a different representative). Same file for all cluster members.
        const ruleIds = [f.rule_id, ...(f.members?.map((m) => m.rule_id) ?? [])];
        const keys = [...new Set(ruleIds.map((rid) => `${ruleIdToken0(rid)}@${f.file}`))];
        const matchKey = keys.find((k) => fpClusters.has(k));
        const hit = matchKey ? fpClusters.get(matchKey) : undefined;
        if (!hit) return f;
        const base = f.severity === "INFO" ? f : { ...f, severity: "INFO" as const };
        return {
          ...base,
          fp_cluster_match: {
            cluster_key: hit.key,
            member_ids: hit.member_ids,
            suppressed: true,
          },
        };
      })
    : cycleScoped;

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
      ? fpClusterScoped.map((f) => {
          if (pinned.has(f.signature)) return f; // §4.3: pinned recurrence stays blocking
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
          // #4: a high-precision reviewer's blocking finding is not demoted for low
          // self-reported confidence — its track record outweighs one low confidence call.
          if (isProtected(f)) return { ...f, protected_high_precision: true };
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
      : fpClusterScoped;

  // Reviewer-reputation demote (Slice B: provider:persona keys): an un-corroborated finding whose every
  // contributing reviewer key is currently unreliable is demoted one step. Mirrors the
  // confidence-demote exemptions: corroborated (majority/unanimous) findings are exempt;
  // security is never demoted; correctness demotes to INFO when demoteCorrectness is on;
  // INFO is untouched.
  const repUnreliable = input.repUnreliable;
  const repScoped: Finding[] =
    repUnreliable && repUnreliable.size > 0
      ? confScoped.map((f) => {
          if (pinned.has(f.signature)) return f; // §4.3: pinned recurrence stays blocking
          if (f.severity === "INFO") return f;
          if (f.consensus === "unanimous" || f.consensus === "majority") return f;
          // security is NEVER softened — hard veto preserved.
          if (touchesSecurity(f)) return f;
          const isCorrectness = touchesCorrectness(f);
          // correctness is exempt UNLESS the demoteCorrectness flag is on.
          if (isCorrectness && input.demoteCorrectness !== true) return f;
          const keys =
            f.confirmed_by && f.confirmed_by.length > 0
              ? f.confirmed_by
              : [`${f.reviewer.provider}:${f.reviewer.persona}`];
          if (!keys.every((k) => repUnreliable.has(k))) return f;
          if (isCorrectness) {
            // A CRITICAL correctness finding is NEVER reputation-demoted: it is an
            // unconditional hard FAIL, and turning it into a no-decision INFO would
            // let a real data-corruption bug ship silently from a single unreliable
            // reviewer (subverting the singleton-CRITICAL-must-FAIL invariant).
            // Reputation must be at least as conservative as the critic, which
            // refuses to demote CRITICAL correctness at all (F-022). Only WARN
            // correctness softens to advisory INFO.
            if (f.severity === "CRITICAL") return f;
            // Advisory tier: a chronically-wrong lone reviewer's WARN correctness
            // finding goes to INFO (non-blocking). Mirrors the FP-ledger advisory demote.
            const note =
              "\n\n↓ low reviewer reputation — correctness finding from an unreliable lone reviewer; advisory only.";
            return {
              ...f,
              severity: "INFO" as const,
              reputation_demoted: true,
              details: `${f.details.slice(0, 2000 - note.length)}${note}`,
            };
          }
          // Pure quality/style: existing one-step demote (CRITICAL→WARN, WARN→INFO).
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

  // Slice 2 (field report #9): demote a SECURITY finding on a test/fixture file to INFO
  // (advisory). Only category "security"; correctness/other test-file findings stay blocking
  // (a real test bug is a bug). Clustering is per-file (anchorFile) so members share the file.
  // BOTH masking directions are handled: (a) a security member merged under a NON-security
  // representative is simply not demoted (the representative isn't security) — safe; (b) a
  // NON-security member (e.g. correctness) merged under a SECURITY representative must NOT ride
  // the demote down to advisory (that would suppress a real correctness concern, violating the
  // "correctness stays blocking" rule — flagged by the dogfood gate iter 3). So we demote only
  // when EVERY clustered member is also security: a single non-security member keeps the whole
  // cluster blocking. (members[] includes the representative's own entry; absent → lone finding.)
  const testScoped: Finding[] =
    input.demoteTestSecurity === true
      ? repScoped.map((f) => {
          if (f.category !== "security" || classify(f.file) !== "tests") return f;
          if ((f.members ?? []).some((m) => m.category !== "security")) return f;
          if (f.severity === "INFO") return { ...f, test_severity_demoted: true };
          const note =
            "\n\n↓ security finding on a test/fixture file — not production code; advisory only.";
          return {
            ...f,
            severity: "INFO" as const,
            test_severity_demoted: true,
            details: `${f.details.slice(0, 2000 - note.length)}${note}`,
          };
        })
      : repScoped;

  let critical = 0;
  let warn = 0;
  let info = 0;
  let fail = false;
  let warnFail = false;
  for (const f of testScoped) {
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
      } else if (f.claimed_fixed_recurred) {
        // §4.3: a pinned claimed-fixed recurrence still CRITICAL here is a hard FAIL —
        // the agent claimed to fix it and it is still present; the gate must not open.
        fail = true;
      }
    } else if (f.severity === "WARN") {
      warn++;
      if (f.consensus === "unanimous" || f.consensus === "majority") {
        warnFail = true;
      } else if (f.claimed_fixed_recurred) {
        // §4.3: a pinned WARN recurrence forces FAIL even as a singleton — otherwise a
        // lone-reviewer claimed-fixed recurrence would only SOFT-PASS and the gate would
        // open, breaking the "still-blocking" guarantee.
        warnFail = true;
      }
    } else {
      info++;
    }
  }

  let verdict: Verdict;
  if (fail || warnFail) verdict = "FAIL";
  // Keep the ladder monotone in severity: a CRITICAL that did not trip a `fail`
  // branch above (singleton non-security/correctness on a multi-reviewer panel)
  // must at least SOFT-PASS — never rank weaker than a lone WARN. Otherwise it
  // bypasses softPassPolicy entirely and the gate opens silently (F-06).
  else if (warn > 0 || critical > 0) verdict = "SOFT-PASS";
  else verdict = "PASS";

  // Reassign unique sequential ids across the merged panel. Each reviewer
  // numbers its own findings from F-001, so without this two distinct findings
  // could share an id — and the decisions-gate keys on finding_id, so a single
  // decision would wrongly satisfy both. Unique ids keep the gate sound.
  const renumbered = testScoped.map((f, i) => ({
    ...f,
    id: `F-${String(i + 1).padStart(3, "0")}`,
  }));

  return {
    verdict,
    dedupedFindings: renumbered,
    counts: { critical, warn, info },
    criticDropped,
    criticDroppedCount: criticDropped.length,
  };
}
