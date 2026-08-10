// src/core/aggregator.ts
import { type Range, rangeOverlapsChanged } from "../diff/hunks.ts";
import { normalizeRepoPath } from "../diff/repo-path.ts";
import { classify } from "../research/diff-facts.ts";
import type { Consensus, Finding, FindingCategory } from "../schemas/finding.ts";
import type { Verdict } from "../schemas/pending-report.ts";
import type { PolicyEffect } from "../schemas/policy-trace.ts";
import { compareCodeUnits } from "../utils/compare.ts";
import { isHarnessConfigPath } from "../utils/git.ts";
import type { CriticVerdict } from "./critic.ts";
import { normalizeProviders } from "./decision-outcome.ts";
import { ruleIdToken0 } from "./fp-ledger/clusters.ts";
import type { PolicyProtectionCode, PolicyReasonCode } from "./policy/catalog.ts";
import { type PolicyRuntime, mergePolicyEffects, transitionFinding } from "./policy/trace.ts";

export interface AggregateInput {
  findings: Finding[];
  reviewersTotal: number;
  policyRuntime?: PolicyRuntime;
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
  // R5 (field report 2026-07-03): when true (and demoteCorrectness is on), a lone
  // unreliable reviewer's uncorroborated CRITICAL-correctness finding is CLAMPED to a
  // decision-required WARN (+ demoted_from_critical + reputation_corroboration_required)
  // instead of the old unconditional exemption that let a chronically-wrong reviewer
  // manufacture hard FAILs. Requires reviewersTotal >= 2 (the PR#22 singleton failsafe
  // is untouched); security stays an unconditional hard FAIL. Absent/false → off.
  corroborateCritical?: boolean;
  // Slice 2 (field report #9): when true, a SECURITY finding whose file classify()s as
  // "tests" is demoted to INFO (advisory). Only security; correctness/other stay. Absent/
  // false → no-op (production passes the config value, default true). Representative-keyed.
  demoteTestSecurity?: boolean;
  // Slice D (P5, field report 2026-06-22): when true, a CRITICAL finding whose FILE
  // classifies as "docs" is CAPPED to WARN (a stale doc is over-severity). security/
  // correctness (representative OR any merged member) is EXEMPT and stays CRITICAL — a
  // markdown file can hold a leaked secret / dangerous command. Capped to WARN (not INFO)
  // so it stays SOFT-PASS-blocking + decision-required (G0). Absent/false → no-op
  // (production passes the config value, default true). File-class-keyed, not category.
  capDocsSeverity?: boolean;
  // Slice A (P1, field report 2026-06-22): repo-relative paths FOREIGN to this session
  // (byte-identical to its SessionStart baseline, not tool-owned — provably not authored by
  // it). A blocking finding on such a file is demoted to advisory INFO + tagged
  // foreign_to_session, so a parallel agent's uncommitted work / pre-existing dirty state
  // can't block this session's turn. STRUCTURAL scope demote (like out-of-diff): → INFO,
  // never sets demoted_from_critical (G0-EXEMPT). Honors the outOfDiffBlocking escape hatch.
  // Absent/empty → no scoping (full review = fail-closed default).
  foreignFiles?: Set<string> | null;
  // §4.3 Fix-Verification: signatures the agent marked accepted/action:"fixed" in
  // an EARLIER iteration of the current cycle → earliest claimed iter. A deduped
  // finding whose representative OR any member signature matches (and whose
  // representative signature is NOT in `cycleRejected` — tie-break) is PINNED:
  // the critic, confidence-floor, and reputation demote passes skip it so an
  // ineffective "fix" stays blocking. NOT exempt from scopeFindings/fp passes.
  claimedFixed?: Map<string, number>;
  // T3/R4 (field report 2026-07-03): cycle-scoped REGIONS the agent explicitly
  // rejected (verdict:rejected / verified-not-applicable). A new blocking finding
  // overlapping one (±REGION_WINDOW sliding tolerance) is demoted to INFO ONLY
  // when the region has >= 2 DISTINCT dispositioned findings AND every member
  // category of the new finding is already in the region's rejected-categories
  // set — otherwise badge-only (stays blocking). CRITICAL, security and
  // demoted_from_critical findings are NEVER demoted here (G0/G0b mirror).
  // Signal source is the agent's own >= 20-char-reason dispositions, so this
  // layer stays live at panel size 1. Empty/absent → off.
  rejectedRegions?: Array<{
    file: string;
    start_line: number;
    end_line: number;
    severity: Finding["severity"];
    categories: FindingCategory[];
    reason: string;
    distinct_count: number;
  }>;
  // T4/R2 (field report 2026-07-03): the delta GATING scope for iteration >= 2 —
  // normalized paths of files changed since the prior reviewed snapshot + new
  // files + files of all prior blocking findings (computeDeltaScope). A NEW
  // blocking finding outside it demotes to INFO + delta_scope_demoted (policy
  // demote; security/correctness + §4.3 pins exempt). null/absent → inert
  // (full scope: iteration 1, one-shot mode, missing snapshot, incomplete diff).
  deltaScope?: Set<string> | null;
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
  /** T3/R4: findings the region-rejection pass demoted to INFO this run. The
   *  loop-driver folds it into state.region_suppressed_hits, which the contested
   *  breaker counts as evidence — so suppression can only make escalation fire
   *  EARLIER, never starve it. */
  regionSuppressedCount: number;
}

const DEMOTE: Record<Finding["severity"], Finding["severity"] | "drop"> = {
  CRITICAL: "WARN",
  WARN: "INFO",
  INFO: "drop",
};

// G0 (field report 2026-06-21): a VALUE-JUDGMENT one-step demote that never pushes a
// finding derived from a CRITICAL below WARN, and carries demoted_from_critical provenance
// forward. A finding is "from CRITICAL" if it IS a CRITICAL now (this pass lowers it) OR a
// prior value-judgment pass already lowered it (flag set). Clamping at WARN keeps it
// SOFT-PASS-blocking + decision-required — a non-blocking INFO/PASS would auto-hide a
// possibly-real CRITICAL under the default softPassPolicy. A genuine never-CRITICAL finding
// demotes normally (WARN→INFO→drop). Used by the critic-likely_fp and reputation-pure-quality
// passes; the two direct-INFO passes (confidence-floor, reputation-correctness) clamp inline.
function demoteOneStep(f: Finding): {
  severity: Finding["severity"] | "drop";
  demoted_from_critical: boolean;
} {
  const fromCritical = f.demoted_from_critical === true || f.severity === "CRITICAL";
  const next = DEMOTE[f.severity];
  // The clamp only ever LOWERS (CRITICAL/WARN → WARN); it must never RAISE an already-INFO
  // finding. An INFO carrying the flag (a value-judgment WARN later suppressed to INFO by a
  // structural/agent off-ramp) demotes normally (→ drop), never re-promotes to a blocking WARN.
  if (fromCritical && f.severity !== "INFO" && next !== "WARN") {
    return { severity: "WARN", demoted_from_critical: true };
  }
  return { severity: next, demoted_from_critical: fromCritical };
}

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
export const REGION_WINDOW = 5;
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
  effects: PolicyEffect[];
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

// Slice C (P4, field report 2026-06-22): the EXACT condition under which the verdict gate
// below hard-FAILs a CRITICAL purely because it is the lone opinion on a single-reviewer panel
// (reviewersTotal<=1) — i.e. not security/correctness (those FAIL on their own merit) and not
// corroborated (consensus would otherwise carry it). Used ONLY to stamp a render-only badge so
// the report can frame it honestly; the verdict math is UNCHANGED (zero PR#22 regression).
// Shared with the verdict loop's reviewersTotal<=1 branch so the badge can never desync from it.
function isLoneUncorroboratedCritical(f: Finding, reviewersTotal: number): boolean {
  return (
    f.severity === "CRITICAL" &&
    reviewersTotal <= 1 &&
    f.consensus !== "unanimous" &&
    f.consensus !== "majority" &&
    !touchesSecurityOrCorrectness(f)
  );
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
    // G0: carry each member's value-judgment CRITICAL→ provenance so the representative
    // can OR it in (a flagged member merged under an unflagged equal-severity rep must not
    // silently lose the flag). Only set when true so members[] stays minimal otherwise.
    ...(f.demoted_from_critical === true ? { demoted_from_critical: true } : {}),
    ...(f.anchor_repaired === true ? { anchor_repaired: true } : {}),
  };
}

function sourceSignatures(f: Finding): string[] {
  return [...new Set([f.signature, ...(f.members?.map((member) => member.signature) ?? [])])].sort(
    compareCodeUnits,
  );
}

// Diff-scoping: demote findings that don't anchor to the changed lines to INFO
// (advisory, never dropped) so a hallucination on unchanged code can't block.
// Two cases: (1) the finding's FILE isn't in the diff at all — the strongest FP
// signal — demoted unless its category is in `outOfDiffBlocking` (cross-file
// escape hatch); (2) the file is in the diff but the finding's line range is
// outside the changed hunks. Paths on both sides are normalized so a reviewer's
// "./src/x.ts" matches the canonical "src/x.ts" diff key.
function scopeFindings(survivors: Finding[], input: AggregateInput): Finding[] {
  const enabled = input.scopeToDiff !== false && input.changedRanges !== undefined;
  if (!enabled && input.policyRuntime === undefined) return survivors;
  const normalizedRanges = new Map<string, Range[]>();
  for (const [k, v] of input.changedRanges ?? []) {
    normalizedRanges.set(normalizeRepoPath(k), v);
  }
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
    const opportunity = enabled && f.severity !== "INFO" && Boolean(f.line_start);
    if (!enabled || !f.line_start) {
      return (
        transitionFinding({
          ...(input.policyRuntime === undefined ? {} : { runtime: input.policyRuntime }),
          passId: "scope.diff",
          finding: f,
          opportunity,
          matched: false,
          reasonCode: "outside-changed-lines",
          action: "demoted",
          sourceSignatures: sourceSignatures(f),
          proposed: () => f,
        }) ?? f
      );
    }

    const ranges = normalizedRanges.get(normalizeRepoPath(f.file));
    const categories = [f.category, ...(f.members?.map((m) => m.category) ?? [])];
    let matched = false;
    let protectedBy: PolicyProtectionCode | undefined;
    let reasonCode: PolicyReasonCode = "outside-changed-lines";
    let note = "\n\n↓ outside the changed lines — advisory only.";

    if (!ranges) {
      // I-17: a finding on harness config (.claude/) the diff did NOT touch is
      // exploration noise — the every-branch "repo-local hooks = RCE" wolf-cry on
      // PRE-EXISTING hook config. Demote regardless of category (incl. the security
      // out-of-diff escape hatch): it isn't introduced by this change. An IN-DIFF
      // .claude change hits the ranges branch below and CAN still block, so
      // malicious/accidental hook edits stay reviewed (F-003).
      if (isHarnessConfigPath(normalizeRepoPath(f.file))) {
        matched = opportunity;
        reasonCode = "preexisting-harness-config";
        note = "\n\n↓ pre-existing harness config not changed by this diff — advisory only.";
      } else {
        matched = opportunity;
        reasonCode = "outside-changed-file";
        note = "\n\n↓ not in the changed files — advisory only.";
        if (matched && categories.some((c) => blocking.has(c))) {
          protectedBy = "out-of-diff-blocking-hatch";
        }
      }
    } else if (!rangeOverlapsChanged(f.line_start, f.line_end ?? f.line_start, ranges)) {
      matched = opportunity;
      if (matched && categories.some((c) => blocking.has(c))) {
        protectedBy = "out-of-diff-blocking-hatch";
      }
    }

    const transitioned =
      transitionFinding({
        ...(input.policyRuntime === undefined ? {} : { runtime: input.policyRuntime }),
        passId: "scope.diff",
        finding: f,
        opportunity,
        matched,
        reasonCode,
        action: "demoted",
        ...(protectedBy === undefined ? {} : { protectedBy }),
        sourceSignatures: sourceSignatures(f),
        proposed: () => demote(f, note),
      }) ?? f;

    // INFO is outside this pass's blocking opportunity denominator, but the legacy
    // implementation still stamped the advisory marker when it was outside scope.
    if (
      f.severity === "INFO" &&
      ((ranges === undefined && !categories.some((category) => blocking.has(category))) ||
        (ranges !== undefined &&
          !rangeOverlapsChanged(f.line_start, f.line_end ?? f.line_start, ranges) &&
          !categories.some((category) => blocking.has(category))) ||
        (ranges === undefined && isHarnessConfigPath(normalizeRepoPath(f.file))))
    ) {
      return demote(transitioned, note);
    }
    return transitioned;
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

function redactionSubjectFields(f: Finding): string[] {
  return [f.message, f.suggested_fix ?? ""];
}

function hasRedactionPlaceholder(f: Finding): boolean {
  return redactionSubjectFields(f).some((field) => field.includes("<REDACTED:"));
}

function hasRedactionHallucinationSignal(f: Finding): boolean {
  return redactionSubjectFields(f).some((field) => REDACTION_CODE_HALLUCINATION.test(field));
}

function redactionProtection(f: Finding): PolicyProtectionCode | undefined {
  if (f.category === "security") return "security-correctness-floor";
  if (redactionSubjectFields(f).some((field) => SECRET_LEAD_WORD.test(field))) {
    return "secret-evidence-backstop";
  }
  return undefined;
}

function isRedactionArtifact(f: Finding): boolean {
  const fields = redactionSubjectFields(f);
  if (!hasRedactionPlaceholder(f)) return false; // gate 1: subject only
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
    const legacyMatch = isRedactionArtifact(f);
    const opportunity = f.severity !== "INFO" && hasRedactionPlaceholder(f);
    const matched = opportunity && hasRedactionHallucinationSignal(f);
    const protectedBy = matched ? redactionProtection(f) : undefined;
    const note =
      "\n\n↓ targets Reviewgate's own <REDACTED:…> placeholder (a stripped secret, not real code) — advisory only.";
    const transitioned =
      transitionFinding({
        ...(input.policyRuntime === undefined ? {} : { runtime: input.policyRuntime }),
        passId: "evidence.redaction-placeholder",
        finding: f,
        opportunity,
        matched,
        reasonCode: "placeholder-code-hallucination",
        action: "demoted",
        ...(protectedBy === undefined ? {} : { protectedBy }),
        sourceSignatures: [f.signature],
        proposed: () => ({
          ...f,
          severity: "INFO" as const,
          redaction_demoted: true,
          details: `${f.details.slice(0, 2000 - note.length)}${note}`,
        }),
      }) ?? f;
    // INFO findings are outside the blocking opportunity denominator, but the old
    // path still exposed a matching placeholder as redaction-demoted.
    if (f.severity === "INFO" && legacyMatch) return { ...transitioned, redaction_demoted: true };
    return transitioned;
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
      target.effects = mergePolicyEffects(target.effects, f.policy_effects);
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
        effects: mergePolicyEffects(f.policy_effects),
      });
    }
  }

  const deduped: Finding[] = [];
  for (const { sample, reviewers, messages, categories, members, effects } of clusters) {
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
    // G0: the representative's value-judgment CRITICAL→ provenance = OR(rep, all members).
    // Load-bearing: a CRITICAL-demoted member merged under an unflagged equal-severity WARN
    // representative (ties-keep-first) would otherwise silently lose the flag = fail-open.
    // OR is exactly right because STRUCTURAL demoters never set the flag, so it carries only
    // genuine value-judgment provenance (no original_severity-style contamination).
    const demotedFromCritical =
      sample.demoted_from_critical === true ||
      members.some((m) => m.demoted_from_critical === true);
    // Slice A mirror of the G0 OR above: the repaired finding is often NOT the representative
    // (equal severity + ties-keep-first), and losing the marker would hide the mis-anchor in
    // exactly the merge the repair made possible.
    const anchorRepaired =
      sample.anchor_repaired === true || members.some((m) => m.anchor_repaired === true);
    const mergedEffects = mergePolicyEffects(effects);
    const representative: Finding = {
      ...sample,
      details: details.slice(0, 2000),
      confirmed_by: reviewers,
      consensus,
      members,
      ...(mergedEffects.length > 0 || sample.policy_effects !== undefined
        ? { policy_effects: mergedEffects }
        : {}),
      ...(demotedFromCritical ? { demoted_from_critical: true } : {}),
      ...(anchorRepaired ? { anchor_repaired: true } : {}),
    };
    deduped.push(representative);
    const inputSignatures = sourceSignatures(representative);
    input.policyRuntime?.recordStage({
      stageId: "aggregation.cluster",
      reasonCode: members.length === 1 ? "singleton" : "clustered",
      memberCount: members.length,
      inputSignatures,
      outputSignature: representative.signature,
    });
    input.policyRuntime?.linkFinal(inputSignatures, representative.signature);
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
    // Scan the representative AND every merged member signature (mirror the
    // fp_ledger_match pass): the critic may have keyed its verdict on a member's
    // signature, not the promoted representative's — checking only f.signature
    // would let that likely_fp leak through with full blocking weight.
    const critSigs = [f.signature, ...(f.members?.map((m) => m.signature) ?? [])];
    const criticRows = critic ? critSigs.map((signature) => critic.get(signature)) : [];
    const cv =
      criticRows.find((verdict) => verdict?.verdict === "likely_fp") ??
      criticRows.find((verdict) => verdict !== undefined);
    const opportunity = cv !== undefined;
    const matched = cv?.verdict === "likely_fp";
    let protectedBy: PolicyProtectionCode | undefined;

    if (matched && pinned.has(f.signature)) {
      protectedBy = "claimed-fixed-pin";
    } else if (matched && f.self_refuted === true) {
      // #1: a self-refuted finding (T1) is already advisory INFO. The critic's
      // INFO+likely_fp → DROP must not erase its visible attribution.
      protectedBy = "self-refutation-visibility";
    } else if (matched && f.severity === "WARN" && f.demoted_from_critical === true) {
      // G0: a prior value-judgment CRITICAL→WARN clamp is already at its floor.
      // Treat the critic's attempted second demotion as protection, not an
      // applied WARN→WARN mutation (which is neither material nor catalog-valid).
      protectedBy = "critical-floor";
    }

    let isSecurityProtected = false;
    let isCorroborated = false;
    let highPrecisionProtected = false;
    if (matched && protectedBy === undefined) {
      // CRITICAL-only by measurement. A WARN floor (Slice B, 2026-08-05) sat here until
      // 2026-08-07 and was REVERTED: replayed over the whole recorded corpus it fired 3 times,
      // protected a false positive all 3 times, and protected 0 true positives. The one time the
      // critic proposed demoting a catch of a seed that actually landed, CORROBORATION — not the
      // floor — is what saved it. All three activations were hedged, uncorroborated WARN claims
      // ("may lead to", "may cause", "may still allow") whose security/correctness category was
      // the reviewer's own generous self-classification: exactly what the critic exists to filter.
      // Accepted cost: an uncorroborated WARN security finding from an unproven reviewer, called
      // likely_fp, now goes to INFO with no downstream gate (protected_high_precision below is
      // cold-start-inert). Evidence: docs/dev/2026-08-07-slice-b-critic-floor-counterfactual.md.
      isSecurityProtected = f.severity === "CRITICAL" && touchesSecurityOrCorrectness(f);
      // A single adversarial critic must not override GROUP agreement. Both
      // unanimous AND majority are corroborated consensus — the verdict gate
      // treats them identically (warnFail), and the confidence- and reputation-
      // demote tiers already exempt majority. Mirror that here so the critic
      // can't silently flip a corroborated FAIL into a SOFT-PASS.
      isCorroborated = f.consensus === "unanimous" || f.consensus === "majority";
      // #4: a high-precision reviewer's blocking finding is kept at full severity even when
      // the critic calls it likely_fp — the dangerous direction is a demoted TRUE positive
      // (field report F-005). Tag it so the agent sees WHY it stayed blocking; do NOT set
      // critic_verdict (that renders the dismissive "likely FP" badge).
      highPrecisionProtected = !isSecurityProtected && !isCorroborated && isProtected(f);
      if (isSecurityProtected) protectedBy = "security-correctness-floor";
      else if (f.consensus === "unanimous") protectedBy = "corroborated-unanimous";
      else if (f.consensus === "majority") protectedBy = "corroborated-majority";
      else if (highPrecisionProtected) protectedBy = "high-precision-reviewer";
    }

    const predictedDemotion = matched ? demoteOneStep(f) : undefined;
    const transitioned = transitionFinding({
      ...(input.policyRuntime === undefined ? {} : { runtime: input.policyRuntime }),
      passId: "judgment.critic",
      finding: f,
      opportunity,
      matched,
      reasonCode: "critic-likely-fp",
      action: predictedDemotion?.severity === "drop" ? "dropped" : "demoted",
      ...(protectedBy === undefined ? {} : { protectedBy }),
      sourceSignatures: sourceSignatures(f),
      proposed: () => {
        const demoted = demoteOneStep(f);
        if (demoted.severity === "drop") return null;
        return {
          ...f,
          severity: demoted.severity,
          // G0: a critic likely_fp that lowers a from-CRITICAL keeps it ≥WARN + decision-required.
          ...(demoted.demoted_from_critical ? { demoted_from_critical: true } : {}),
          critic_verdict: "likely_fp",
          ...(cv?.reason ? { critic_reason: cv.reason } : {}),
        };
      },
    });

    if (transitioned === null) {
      criticDropped.push(f); // INFO likely_fp dropped entirely — keep it attributable
      continue;
    }
    if (matched && protectedBy === "high-precision-reviewer") {
      survivors.push({ ...transitioned, protected_high_precision: true });
      continue;
    }
    if (matched && (isSecurityProtected || isCorroborated)) {
      survivors.push({ ...transitioned, critic_verdict: "keep" });
      continue;
    }
    survivors.push(transitioned);
  }

  // M5 Part A — diff-scoping: demote findings outside the changed hunks to INFO
  // (advisory, never dropped). Cross-impact stays visible; only the BLOCKING
  // weight is removed. Range intersection (not line_start alone) keeps a finding
  // anchored to a declaration above the edit whose range overlaps the change.
  const scoped: Finding[] = scopeFindings(survivors, input);

  // T4/R2 (field report 2026-07-03) — delta-scope POLICY demote (iteration >= 2).
  // The field's #1 pain: every fix re-reviewed the FULL batch diff and the panel
  // drew fresh nits from the unchanged 95% each round. The reviewer prompt keeps
  // the full diff (cross-file reasoning preserved) — only the GATING scope
  // narrows: a NEW blocking finding on a file that is byte-identical to the prior
  // reviewed snapshot AND carried no prior blocking finding demotes to INFO +
  // delta_scope_demoted. This is an honest policy demote, not a soundness claim:
  // the residual class (a genuinely-new quality/testing/perf/docs finding on an
  // untouched file in iteration >= 2) renders as visible INFO instead of blocking.
  // Exemptions/fail-safety: security/correctness (any member) always stay
  // blocking; §4.3 pinned recurrences stay; inert when no deltaScope was computed
  // (missing/corrupt snapshot, iteration 1, one-shot mode, incomplete diff).
  const deltaScope = input.deltaScope;
  const deltaScoped: Finding[] =
    deltaScope !== null && deltaScope !== undefined
      ? scoped.map((f) => {
          const opportunity = f.severity !== "INFO";
          const matched = opportunity && !deltaScope.has(normalizeRepoPath(f.file));
          let protectedBy: PolicyProtectionCode | undefined;
          if (matched && f.claimed_fixed_recurred) {
            protectedBy = "claimed-fixed-pin";
          } else if (matched && touchesSecurityOrCorrectness(f)) {
            protectedBy = "security-correctness-floor";
          } else if (matched && f.demoted_from_critical === true) {
            // G0 alignment: a from-CRITICAL WARN remains decision-required.
            protectedBy = "critical-floor";
          } else if (matched) {
            // Honor the same cross-file escape hatch as diff/session scope.
            const memberCats = [f.category, ...(f.members?.map((m) => m.category) ?? [])];
            const hatch = new Set<FindingCategory>(input.outOfDiffBlocking ?? []);
            if (memberCats.some((category) => hatch.has(category))) {
              protectedBy = "out-of-diff-blocking-hatch";
            }
          }

          return (
            transitionFinding({
              ...(input.policyRuntime === undefined ? {} : { runtime: input.policyRuntime }),
              passId: "scope.delta",
              finding: f,
              opportunity,
              matched,
              reasonCode: "outside-delta-scope",
              action: "demoted",
              ...(protectedBy === undefined ? {} : { protectedBy }),
              sourceSignatures: sourceSignatures(f),
              proposed: () => {
                const note =
                  "\n\n↓ on content already reviewed in an earlier iteration and unchanged since — advisory only (delta scope).";
                return {
                  ...f,
                  severity: "INFO" as const,
                  delta_scope_demoted: true,
                  details: `${f.details.slice(0, 2000 - note.length)}${note}`,
                };
              },
            }) ?? f
          );
        })
      : input.policyRuntime
        ? scoped.map(
            (f) =>
              transitionFinding({
                ...(input.policyRuntime === undefined ? {} : { runtime: input.policyRuntime }),
                passId: "scope.delta",
                finding: f,
                opportunity: false,
                matched: false,
                reasonCode: "outside-delta-scope",
                action: "demoted",
                sourceSignatures: sourceSignatures(f),
                proposed: () => f,
              }) ?? f,
          )
        : scoped;

  // Slice A (P1) — session-ownership demote. A blocking finding on a file FOREIGN to this
  // session (provably byte-identical to its SessionStart baseline, not tool-owned) is demoted
  // to advisory INFO + tagged foreign_to_session (the ownership snapshot the out-of-scope
  // decision gate reads — no live re-derive). STRUCTURAL scope demote: goes to INFO and NEVER
  // sets demoted_from_critical (G0-EXEMPT — foreign = out of scope, not a value judgment, so it
  // correctly converges OUT of the gate). Honors the SAME outOfDiffBlocking escape hatch: a
  // category the maintainer chose to keep blocking across files stays blocking even when
  // foreign (still tagged, so the agent can dispose it via an out-of-scope decision). Done as
  // an INDEPENDENT pass (not inside scopeFindings, which early-returns when scopeToDiff is off).
  const foreignFiles = input.foreignFiles;
  const foreignScoped: Finding[] =
    foreignFiles && foreignFiles.size > 0
      ? deltaScoped.map((f) => {
          const opportunity = f.severity !== "INFO";
          const isForeign = foreignFiles.has(normalizeRepoPath(f.file));
          const matched = opportunity && isForeign;
          const categories = [f.category, ...(f.members?.map((m) => m.category) ?? [])];
          const blocking = new Set<FindingCategory>(input.outOfDiffBlocking ?? []);
          const protectedBy =
            matched && categories.some((category) => blocking.has(category))
              ? "out-of-diff-blocking-hatch"
              : undefined;
          const transitioned =
            transitionFinding({
              ...(input.policyRuntime === undefined ? {} : { runtime: input.policyRuntime }),
              passId: "scope.session",
              finding: f,
              opportunity,
              matched,
              reasonCode: "foreign-to-session",
              action: "demoted",
              ...(protectedBy === undefined ? {} : { protectedBy }),
              sourceSignatures: sourceSignatures(f),
              proposed: () => {
                const note =
                  "\n\n↓ on a file this session did not author (parallel agent / pre-existing) — advisory only.";
                return {
                  ...f,
                  severity: "INFO" as const,
                  foreign_to_session: true,
                  details: `${f.details.slice(0, 2000 - note.length)}${note}`,
                };
              },
            }) ?? f;
          // The legacy INFO marker is explanatory rather than a blocking policy
          // transition. A protected blocking finding is likewise tagged so the
          // out-of-scope disposition remains available.
          if (isForeign && (f.severity === "INFO" || protectedBy !== undefined)) {
            return { ...transitioned, foreign_to_session: true };
          }
          return transitioned;
        })
      : input.policyRuntime
        ? deltaScoped.map(
            (f) =>
              transitionFinding({
                ...(input.policyRuntime === undefined ? {} : { runtime: input.policyRuntime }),
                passId: "scope.session",
                finding: f,
                opportunity: false,
                matched: false,
                reasonCode: "foreign-to-session",
                action: "demoted",
                sourceSignatures: sourceSignatures(f),
                proposed: () => f,
              }) ?? f,
          )
        : deltaScoped;

  // M5 Part B1 — reactive FP-ledger demote: a finding whose representative
  // signature (or any merged member signature) matches an active/sticky FP entry
  // is demoted to INFO + tagged. Never dropped — stays visible in the advisory
  // section, and the decisions-gate already ignores INFO.
  const fpActive = input.fpActive;
  const fpSignatureEnabled = fpActive !== undefined && fpActive.size > 0;
  const fpScoped: Finding[] =
    fpSignatureEnabled || input.policyRuntime
      ? foreignScoped.map((f) => {
          // Representative first, then members; dedup so a member equal to the
          // representative is not double-counted.
          const sigs = [...new Set([f.signature, ...(f.members?.map((m) => m.signature) ?? [])])];
          const matchingSignatures = fpActive ? sigs.filter((s) => fpActive.has(s)) : [];
          const opportunity = fpSignatureEnabled && f.severity !== "INFO";
          const matched = opportunity && matchingSignatures.length > 0;
          // pattern_id = the first matching signature's entry (deterministic order).
          const hit = matchingSignatures[0] ? fpActive?.get(matchingSignatures[0]) : undefined;
          const transitioned =
            transitionFinding({
              ...(input.policyRuntime === undefined ? {} : { runtime: input.policyRuntime }),
              passId: "history.fp-signature",
              finding: f,
              opportunity,
              matched,
              reasonCode: "active-fp-signature",
              action: "suppressed",
              sourceSignatures: sourceSignatures(f),
              proposed: () => ({
                ...f,
                severity: "INFO" as const,
                fp_ledger_match: {
                  pattern_id: (hit as { id: string }).id,
                  matched_count: matchingSignatures.length,
                  suppressed: true,
                },
              }),
            }) ?? f;
          // INFO-only matches keep their legacy attribution without entering the
          // blocking opportunity denominator.
          if (f.severity === "INFO" && hit !== undefined) {
            return {
              ...transitioned,
              fp_ledger_match: {
                pattern_id: hit.id,
                matched_count: matchingSignatures.length,
                suppressed: true,
              },
            };
          }
          return transitioned;
        })
      : foreignScoped;

  // Per-cycle suppression: a finding whose representative OR any member signature
  // the agent already rejected (reviewer_was_wrong) earlier this cycle is demoted
  // to INFO (advisory). Breaks the re-flag→re-reject→fp-streak loop: the agent
  // dispositions a finding once and never sees it as blocking again this cycle.
  const cycleRejected = input.cycleRejected;
  const cycleRejectedEnabled = cycleRejected !== undefined && cycleRejected.size > 0;
  const cycleScoped: Finding[] =
    cycleRejectedEnabled || input.policyRuntime
      ? fpScoped.map((f) => {
          const sigs = [f.signature, ...(f.members?.map((m) => m.signature) ?? [])];
          const opportunity = cycleRejectedEnabled && f.severity !== "INFO";
          const matched = opportunity && sigs.some((s) => cycleRejected?.has(s));
          // G0b ceiling (codex DoD 2026-06-21): NEVER auto-hide a CRITICAL or any
          // security/correctness finding via cycleRejected. One false reviewer_was_wrong
          // rejection must not silence a later REAL CRITICAL of the same signature this cycle
          // (a fail-open); it re-surfaces for an explicit per-iteration decision instead.
          let protectedBy: PolicyProtectionCode | undefined;
          if (matched && f.severity === "CRITICAL") protectedBy = "critical-floor";
          else if (matched && touchesSecurityOrCorrectness(f)) {
            protectedBy = "security-correctness-floor";
          }
          return (
            transitionFinding({
              ...(input.policyRuntime === undefined ? {} : { runtime: input.policyRuntime }),
              passId: "history.cycle-rejected",
              finding: f,
              opportunity,
              matched,
              reasonCode: "cycle-signature-rejected",
              action: "suppressed",
              ...(protectedBy === undefined ? {} : { protectedBy }),
              sourceSignatures: sourceSignatures(f),
              proposed: () => ({
                ...f,
                severity: "INFO" as const,
                details: `${f.details.slice(0, 1900)}\n\n↓ already rejected earlier this cycle — advisory only.`,
              }),
            }) ?? f
          );
        })
      : fpScoped;

  // F3 Phase 2 — DERIVED FP-cluster demote. Applies AFTER the signature-keyed
  // pass so a finding already tagged via fp_ledger_match keeps both tags
  // (signature match + cluster match are both true). Same demote-not-drop
  // semantic as fp_ledger_match. Idempotent because the same cluster map
  // produces the same output: re-running on already-cluster-tagged input
  // re-applies the identical tag + INFO severity. No explicit short-circuit.
  const fpClusters = input.fpActiveClusters;
  const fpClusterEnabled = fpClusters !== undefined && fpClusters.size > 0;
  const fpClusterScoped: Finding[] =
    fpClusterEnabled || input.policyRuntime
      ? cycleScoped.map((f) => {
          // Check the representative AND every merged member rule_id (clustering is
          // category/rule-id-independent, so a known-FP rule can ride as a member
          // under a different representative). Same file for all cluster members.
          const ruleIds = [f.rule_id, ...(f.members?.map((m) => m.rule_id) ?? [])];
          const keys = [...new Set(ruleIds.map((rid) => `${ruleIdToken0(rid)}@${f.file}`))];
          const matchKey = keys.find((key) => fpClusters?.has(key));
          const hit = matchKey ? fpClusters?.get(matchKey) : undefined;
          const opportunity = fpClusterEnabled && f.severity !== "INFO";
          const matched = opportunity && hit !== undefined;
          const transitioned =
            transitionFinding({
              ...(input.policyRuntime === undefined ? {} : { runtime: input.policyRuntime }),
              passId: "history.fp-cluster",
              finding: f,
              opportunity,
              matched,
              reasonCode: "active-fp-cluster",
              action: "suppressed",
              sourceSignatures: sourceSignatures(f),
              proposed: () => ({
                ...f,
                severity: "INFO" as const,
                fp_cluster_match: {
                  cluster_key: (hit as { key: string }).key,
                  member_ids: (hit as { member_ids: string[] }).member_ids,
                  suppressed: true,
                },
              }),
            }) ?? f;
          // INFO-only matches retain the legacy explanatory marker.
          if (f.severity === "INFO" && hit !== undefined) {
            return {
              ...transitioned,
              fp_cluster_match: {
                cluster_key: hit.key,
                member_ids: hit.member_ids,
                suppressed: true,
              },
            };
          }
          return transitioned;
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
    floor > 0 || input.policyRuntime
      ? fpClusterScoped.map((f) => {
          // Cluster confidence = MAX over the representative and all merged members,
          // so a co-located high-confidence member is never masked by a
          // low-confidence representative. (memberOf records each member's
          // confidence; older/persisted members may omit it → ignored in the max.)
          const memberConfs = (f.members ?? [])
            .map((m) => m.confidence)
            .filter((c): c is number => typeof c === "number");
          const maxConfidence = Math.max(f.confidence, ...memberConfs);
          const corroborated = f.consensus === "unanimous" || f.consensus === "majority";
          // A from-CRITICAL WARN is already at the G0 floor. The current catalog
          // deliberately treats that marker-only repeat as ineligible rather than
          // inventing a second WARN→WARN material transition.
          const atCriticalFloor = f.severity === "WARN" && f.demoted_from_critical === true;
          const opportunity =
            floor > 0 && f.severity !== "INFO" && !corroborated && !atCriticalFloor;
          const matched = opportunity && maxConfidence < floor;
          let protectedBy: PolicyProtectionCode | undefined;
          if (matched && pinned.has(f.signature)) protectedBy = "claimed-fixed-pin";
          else if (matched && f.severity === "CRITICAL" && touchesSecurityOrCorrectness(f)) {
            protectedBy = "security-correctness-floor";
          } else if (matched && isProtected(f)) {
            protectedBy = "high-precision-reviewer";
          }

          const action = f.severity === "CRITICAL" ? "capped" : "demoted";
          const transitioned =
            transitionFinding({
              ...(input.policyRuntime === undefined ? {} : { runtime: input.policyRuntime }),
              passId: "judgment.confidence",
              finding: f,
              opportunity,
              matched,
              reasonCode: "below-confidence-floor",
              action,
              ...(protectedBy === undefined ? {} : { protectedBy }),
              sourceSignatures: sourceSignatures(f),
              proposed: () => {
                if (f.severity === "CRITICAL") {
                  const note = `\n\n↓ low reviewer confidence (${maxConfidence.toFixed(2)} < ${floor}) — demoted CRITICAL→WARN; kept blocking pending your decision.`;
                  return {
                    ...f,
                    severity: "WARN" as const,
                    low_confidence: true,
                    demoted_from_critical: true,
                    details: `${f.details.slice(0, 2000 - note.length)}${note}`,
                  };
                }
                const note = `\n\n↓ low reviewer confidence (${maxConfidence.toFixed(2)} < ${floor}) — advisory only.`;
                return {
                  ...f,
                  severity: "INFO" as const,
                  low_confidence: true,
                  details: `${f.details.slice(0, 2000 - note.length)}${note}`,
                };
              },
            }) ?? f;

          // #4: a high-precision reviewer's blocking finding is not demoted for low
          // self-reported confidence — its track record outweighs one low confidence call.
          if (matched && protectedBy === "high-precision-reviewer") {
            return { ...transitioned, protected_high_precision: true };
          }
          if (
            f.severity === "INFO" &&
            floor > 0 &&
            maxConfidence < floor &&
            !corroborated &&
            !pinned.has(f.signature)
          ) {
            return { ...transitioned, low_confidence: true };
          }
          // G0: this pass sends a non-security/correctness low-confidence CRITICAL DIRECTLY to
          // INFO (not via DEMOTE) — that would flip a sole demoted-from-CRITICAL finding to a
          // non-blocking INFO/PASS and auto-hide a possibly-real CRITICAL. CLAMP a from-CRITICAL
          // at WARN (kept blocking + decision-required) and stamp provenance; a genuine
          // never-CRITICAL WARN still demotes to INFO as before.
          if (
            atCriticalFloor &&
            floor > 0 &&
            maxConfidence < floor &&
            !corroborated &&
            !pinned.has(f.signature)
          ) {
            if (isProtected(f)) {
              return { ...transitioned, protected_high_precision: true };
            }
            const note = `\n\n↓ low reviewer confidence (${maxConfidence.toFixed(2)} < ${floor}) — demoted CRITICAL→WARN; kept blocking pending your decision.`;
            return {
              ...transitioned,
              severity: "WARN" as const,
              low_confidence: true,
              demoted_from_critical: true,
              details: `${transitioned.details.slice(0, 2000 - note.length)}${note}`,
            };
          }
          return transitioned;
        })
      : fpClusterScoped;

  // Reviewer-reputation demote (Slice B: provider:persona keys): an un-corroborated finding whose every
  // contributing reviewer key is currently unreliable is demoted one step. Mirrors the
  // confidence-demote exemptions: corroborated (majority/unanimous) findings are exempt;
  // security is never demoted; correctness demotes to INFO when demoteCorrectness is on;
  // INFO is untouched.
  const repUnreliable = input.repUnreliable;
  const reputationEnabled = repUnreliable !== undefined && repUnreliable.size > 0;
  const repScoped: Finding[] =
    reputationEnabled || input.policyRuntime
      ? confScoped.map((f) => {
          const corroborated = f.consensus === "unanimous" || f.consensus === "majority";
          const isCorrectness = touchesCorrectness(f);
          const keys =
            f.confirmed_by && f.confirmed_by.length > 0
              ? f.confirmed_by
              : [`${f.reviewer.provider}:${f.reviewer.persona}`];
          const opportunity = reputationEnabled && f.severity !== "INFO" && !corroborated;
          const matched = opportunity && keys.every((key) => repUnreliable?.has(key));
          const canClampCorrectnessCritical =
            input.demoteCorrectness === true &&
            input.corroborateCritical === true &&
            input.reviewersTotal > 1;
          let protectedBy: PolicyProtectionCode | undefined;
          if (matched && pinned.has(f.signature)) protectedBy = "claimed-fixed-pin";
          else if (matched && touchesSecurity(f)) protectedBy = "security-floor";
          else if (matched && isCorrectness && input.demoteCorrectness !== true) {
            protectedBy = "correctness-demote-disabled";
          } else if (
            matched &&
            ((f.severity === "WARN" && f.demoted_from_critical === true) ||
              (isCorrectness && f.severity === "CRITICAL" && !canClampCorrectnessCritical))
          ) {
            protectedBy = "critical-floor";
          }

          const action = isCorrectness && f.severity === "CRITICAL" ? "capped" : "demoted";
          const transitioned =
            transitionFinding({
              ...(input.policyRuntime === undefined ? {} : { runtime: input.policyRuntime }),
              passId: "judgment.reputation",
              finding: f,
              opportunity,
              matched,
              reasonCode: "unreliable-reviewer",
              action,
              ...(protectedBy === undefined ? {} : { protectedBy }),
              sourceSignatures: sourceSignatures(f),
              proposed: () => {
                if (isCorrectness) {
                  // R5: an eligible CRITICAL correctness claim is clamped to a
                  // decision-required WARN pending corroboration.
                  if (f.severity === "CRITICAL") {
                    const note =
                      "\n\n↓ low reviewer reputation — uncorroborated CRITICAL correctness from a chronically-unreliable reviewer; demoted CRITICAL→WARN pending corroboration. Kept blocking + decision-required: verify the claim in the cited code, then fix it or reject it with evidence.";
                    return {
                      ...f,
                      severity: "WARN" as const,
                      reputation_demoted: true,
                      demoted_from_critical: true,
                      reputation_corroboration_required: true,
                      details: `${f.details.slice(0, 2000 - note.length)}${note}`,
                    };
                  }
                  const note =
                    "\n\n↓ low reviewer reputation — correctness finding from an unreliable lone reviewer; advisory only.";
                  return {
                    ...f,
                    severity: "INFO" as const,
                    reputation_demoted: true,
                    details: `${f.details.slice(0, 2000 - note.length)}${note}`,
                  };
                }

                // Pure quality/style: existing one-step demote (CRITICAL→WARN,
                // WARN→INFO), with the G0 floor handled above as a protection.
                const demoted = demoteOneStep(f);
                if (demoted.severity === "drop") return f;
                const note = demoted.demoted_from_critical
                  ? "\n\n↓ low reviewer reputation — demoted CRITICAL→WARN; kept blocking pending your decision."
                  : "\n\n↓ low reviewer reputation — advisory only.";
                return {
                  ...f,
                  severity: demoted.severity,
                  reputation_demoted: true,
                  ...(demoted.demoted_from_critical ? { demoted_from_critical: true } : {}),
                  details: `${f.details.slice(0, 2000 - note.length)}${note}`,
                };
              },
            }) ?? f;
          // Preserve the pre-trace marker/details behavior for a pure-quality
          // from-CRITICAL WARN already held at the G0 floor. The trace records
          // the attempted second demotion as protected.
          if (
            matched &&
            protectedBy === "critical-floor" &&
            !isCorrectness &&
            f.severity === "WARN"
          ) {
            const note =
              "\n\n↓ low reviewer reputation — demoted CRITICAL→WARN; kept blocking pending your decision.";
            return {
              ...transitioned,
              reputation_demoted: true,
              demoted_from_critical: true,
              details: `${transitioned.details.slice(0, 2000 - note.length)}${note}`,
            };
          }
          return transitioned;
        })
      : confScoped;

  // T3/R4 (field report 2026-07-03) — region-rejection pass. Placed AFTER the
  // reputation clamp so it evaluates POST-clamp severity (a clamped from-CRITICAL
  // WARN is visible here but protected by the demoted_from_critical guard). A new
  // blocking finding overlapping a region the agent already dispositioned-away
  // this cycle (±REGION_WINDOW sliding tolerance) is:
  //   - demoted to INFO + region_rejected_match.suppressed ONLY when the region has
  //     >= 2 DISTINCT dispositioned findings (one mistaken rejection can never
  //     self-ratchet, codex plan-gate C1) AND every member category of the new
  //     (post-merge) finding is already in the region's rejected-categories set
  //     (a category jump is new information) AND the region's recorded severity
  //     dominates (a rejected WARN never suppresses a new CRITICAL) — with hard
  //     ceilings: CRITICAL, security, demoted_from_critical (G0), and §4.3
  //     claimed-fixed recurrences are NEVER demoted here;
  //   - otherwise badge-only (region_rejected_match.suppressed:false): the prior
  //     rejection reason is cited so the agent can fast-path a re-reject, but the
  //     finding stays blocking.
  // Fail-safe: findings without line data and unparseable regions are untouched.
  const rejectedRegions = input.rejectedRegions;
  const regionRejectedEnabled = rejectedRegions !== undefined && rejectedRegions.length > 0;
  let regionSuppressedCount = 0;
  const regionScoped: Finding[] =
    regionRejectedEnabled || input.policyRuntime
      ? repScoped.map((f) => {
          const opportunity =
            regionRejectedEnabled && f.severity !== "INFO" && Boolean(f.line_start);
          const file = normalizeRepoPath(f.file);
          const lineEnd = typeof f.line_end === "number" ? f.line_end : f.line_start;
          const match = rejectedRegions?.find(
            (r) =>
              typeof r.start_line === "number" &&
              typeof r.end_line === "number" &&
              normalizeRepoPath(r.file) === file &&
              f.line_start <= r.end_line + REGION_WINDOW &&
              lineEnd >= r.start_line - REGION_WINDOW,
          );
          const matched = opportunity && match !== undefined;
          const memberCats = [f.category, ...(f.members?.map((m) => m.category) ?? [])];
          const categoryCompatible =
            match !== undefined &&
            memberCats.every((category) => match.categories.includes(category));
          const severityDominated =
            match !== undefined && SEVERITY_RANK[f.severity] <= SEVERITY_RANK[match.severity];
          let protectedBy: PolicyProtectionCode | undefined;
          if (matched && f.claimed_fixed_recurred) protectedBy = "claimed-fixed-pin";
          else if (matched && (match?.distinct_count ?? 0) < 2) {
            protectedBy = "insufficient-distinct-rejections";
          } else if (matched && !categoryCompatible) protectedBy = "category-change";
          else if (matched && !severityDominated) protectedBy = "severity-increase";
          else if (matched && (f.severity === "CRITICAL" || f.demoted_from_critical === true)) {
            protectedBy = "critical-floor";
          } else if (matched && touchesSecurity(f)) {
            protectedBy = "security-correctness-floor";
          }

          const transitioned =
            transitionFinding({
              ...(input.policyRuntime === undefined ? {} : { runtime: input.policyRuntime }),
              passId: "history.region-rejected",
              finding: f,
              opportunity,
              matched,
              reasonCode: "rejected-region-overlap",
              action: "suppressed",
              ...(protectedBy === undefined ? {} : { protectedBy }),
              sourceSignatures: sourceSignatures(f),
              proposed: () => {
                const hit = match as NonNullable<typeof match>;
                const tag = {
                  distinct_count: hit.distinct_count,
                  prior_reason: hit.reason.slice(0, 200),
                  suppressed: true,
                };
                const note = `\n\n↓ overlaps a region you already rejected ${hit.distinct_count}× this cycle ("${hit.reason.slice(0, 120)}") — advisory only.`;
                return {
                  ...f,
                  severity: "INFO" as const,
                  region_rejected_match: tag,
                  details: `${f.details.slice(0, 2000 - note.length)}${note}`,
                };
              },
            }) ?? f;

          if (matched && protectedBy !== undefined && protectedBy !== "claimed-fixed-pin") {
            const hit = match as NonNullable<typeof match>;
            return {
              ...transitioned,
              region_rejected_match: {
                distinct_count: hit.distinct_count,
                prior_reason: hit.reason.slice(0, 200),
                suppressed: false,
              },
            };
          }
          if (
            matched &&
            protectedBy === undefined &&
            transitioned.severity === "INFO" &&
            transitioned.region_rejected_match?.suppressed === true
          ) {
            regionSuppressedCount++;
          }
          return transitioned;
        })
      : repScoped;

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
    input.demoteTestSecurity === true || input.policyRuntime
      ? regionScoped.map((f) => {
          const testFile = classify(f.file) === "tests";
          const opportunity =
            input.demoteTestSecurity === true && f.severity !== "INFO" && testFile;
          const matched = opportunity && f.category === "security";
          const protectedBy =
            matched && (f.members ?? []).some((member) => member.category !== "security")
              ? "mixed-category-cluster"
              : undefined;
          const transitioned =
            transitionFinding({
              ...(input.policyRuntime === undefined ? {} : { runtime: input.policyRuntime }),
              passId: "judgment.test-security",
              finding: f,
              opportunity,
              matched,
              reasonCode: "test-only-security",
              action: "demoted",
              ...(protectedBy === undefined ? {} : { protectedBy }),
              sourceSignatures: sourceSignatures(f),
              proposed: () => {
                const note =
                  "\n\n↓ security finding on a test/fixture file — not production code; advisory only.";
                return {
                  ...f,
                  severity: "INFO" as const,
                  test_severity_demoted: true,
                  details: `${f.details.slice(0, 2000 - note.length)}${note}`,
                };
              },
            }) ?? f;
          // Preserve the legacy marker for already-advisory security test findings.
          if (
            input.demoteTestSecurity === true &&
            f.severity === "INFO" &&
            testFile &&
            f.category === "security" &&
            !(f.members ?? []).some((member) => member.category !== "security")
          ) {
            return { ...transitioned, test_severity_demoted: true };
          }
          return transitioned;
        })
      : regionScoped;

  // Slice D (P5) — docs severity cap. A CRITICAL whose FILE classifies as "docs" is
  // over-severity (a stale doc is not a security/data-loss bug). Cap to WARN via demoteOneStep
  // (→ WARN + demoted_from_critical, G0-safe: stays SOFT-PASS-blocking + decision-required,
  // never auto-hidden). EXEMPT when touchesSecurityOrCorrectness (representative OR any merged
  // member) — a markdown file can hold a leaked secret / dangerous command. classify() checks
  // tests BEFORE docs, so a *.md fixture under tests/ is "tests", not "docs", and is untouched.
  // Fires BEFORE the verdict loop so a capped docs finding no longer trips the singleton
  // reviewersTotal<=1 hard-FAIL; the sec/corr exemption preserves that path for dangerous docs.
  const docsScoped: Finding[] =
    input.capDocsSeverity === true || input.policyRuntime
      ? testScoped.map((f) => {
          const opportunity = input.capDocsSeverity === true && f.severity === "CRITICAL";
          const matched = opportunity && classify(f.file) === "docs";
          const protectedBy =
            matched && touchesSecurityOrCorrectness(f) ? "security-correctness-floor" : undefined;
          return (
            transitionFinding({
              ...(input.policyRuntime === undefined ? {} : { runtime: input.policyRuntime }),
              passId: "judgment.docs-cap",
              finding: f,
              opportunity,
              matched,
              reasonCode: "docs-critical-cap",
              action: "capped",
              ...(protectedBy === undefined ? {} : { protectedBy }),
              sourceSignatures: sourceSignatures(f),
              proposed: () => {
                const demoted = demoteOneStep(f); // CRITICAL → WARN (+ demoted_from_critical)
                if (demoted.severity !== "WARN") return f;
                const note =
                  "\n\n↓ docs/markdown file — capped CRITICAL→WARN (a stale doc is not a security/data-loss bug); kept blocking pending your decision.";
                return {
                  ...f,
                  severity: "WARN" as const,
                  docs_severity_capped: true,
                  ...(demoted.demoted_from_critical ? { demoted_from_critical: true } : {}),
                  details: `${f.details.slice(0, 2000 - note.length)}${note}`,
                };
              },
            }) ?? f
          );
        })
      : testScoped;

  // Slice C (P4) — render-only honest framing for a lone uncorroborated CRITICAL. It STILL
  // hard-FAILs in the verdict loop below (PR#22 unchanged); the badge just tells the agent to
  // verify the cited code itself. Stamped on the POST-demote set so a finding the
  // confidence-floor already clamped to WARN (no longer CRITICAL) is never tagged.
  const loneTagged: Finding[] = docsScoped.map((f) =>
    isLoneUncorroboratedCritical(f, input.reviewersTotal)
      ? { ...f, lone_critical_uncorroborated: true }
      : f,
  );

  let critical = 0;
  let warn = 0;
  let info = 0;
  let fail = false;
  let warnFail = false;
  let hardCritical = false;
  let corroboratedWarn = false;
  let claimedFixedRecurrence = false;
  for (const f of loneTagged) {
    if (f.severity === "CRITICAL") {
      critical++;
      if (touchesSecurityOrCorrectness(f)) {
        // Always a hard FAIL — checks the representative AND merged member
        // categories, so a security/correctness concern clustered under a
        // different representative category is never silently non-blocking.
        fail = true;
        hardCritical = true;
      } else if (f.consensus === "unanimous" || f.consensus === "majority") {
        fail = true;
        hardCritical = true;
      } else if (input.reviewersTotal <= 1) {
        // Single-reviewer panel (e.g. the only non-capped reviewer after a quota
        // failover): `singleton` is the STRONGEST consensus achievable — there is
        // no second opinion to corroborate or demote. Honour the lone reviewer's
        // CRITICAL as a hard FAIL rather than letting it SOFT-PASS through. (With
        // ≥2 reviewers the consensus gate above still guards against one reviewer's
        // lone over-call.)
        fail = true;
        hardCritical = true;
      } else if (f.claimed_fixed_recurred) {
        // §4.3: a pinned claimed-fixed recurrence still CRITICAL here is a hard FAIL —
        // the agent claimed to fix it and it is still present; the gate must not open.
        fail = true;
        claimedFixedRecurrence = true;
      }
    } else if (f.severity === "WARN") {
      warn++;
      if (f.consensus === "unanimous" || f.consensus === "majority") {
        warnFail = true;
        corroboratedWarn = true;
      } else if (f.claimed_fixed_recurred) {
        // §4.3: a pinned WARN recurrence forces FAIL even as a singleton — otherwise a
        // lone-reviewer claimed-fixed recurrence would only SOFT-PASS and the gate would
        // open, breaking the "still-blocking" guarantee.
        warnFail = true;
        claimedFixedRecurrence = true;
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

  const verdictReason: PolicyReasonCode = hardCritical
    ? "hard-critical"
    : corroboratedWarn
      ? "corroborated-warn"
      : claimedFixedRecurrence
        ? "claimed-fixed-recurrence"
        : warn > 0 || critical > 0
          ? "blocking-present"
          : "no-blocking-findings";
  input.policyRuntime?.recordStage({
    stageId: "verdict.compute",
    reasonCode: verdictReason,
    inputSignatures: loneTagged
      .filter((finding) => finding.severity !== "INFO")
      .map((finding) => finding.signature),
    verdict,
  });

  // Reassign unique sequential ids across the merged panel. Each reviewer
  // numbers its own findings from F-001, so without this two distinct findings
  // could share an id — and the decisions-gate keys on finding_id, so a single
  // decision would wrongly satisfy both. Unique ids keep the gate sound.
  const renumbered = loneTagged.map((f, i) => ({
    ...f,
    id: `F-${String(i + 1).padStart(3, "0")}`,
  }));

  return {
    verdict,
    dedupedFindings: renumbered,
    counts: { critical, warn, info },
    criticDropped,
    criticDroppedCount: criticDropped.length,
    regionSuppressedCount,
  };
}
