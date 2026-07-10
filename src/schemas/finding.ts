import { z } from "zod";

export const Severity = z.enum(["CRITICAL", "WARN", "INFO"]);
export type Severity = z.infer<typeof Severity>;

// Reviewers don't always emit the canonical CRITICAL/WARN/INFO tokens — a model
// will write "warning", "Critical", "high", "note", etc. Without tolerance the
// whole finding is silently dropped at FindingSchema.safeParse (a real bug:
// genuine issues vanish). Map common synonyms + case to the canonical token; an
// unknown value is passed through UNCHANGED so the enum still rejects true
// garbage (e.g. "BOGUS"). Output type stays the canonical `Severity` enum. (F-7)
const SEVERITY_SYNONYMS: Record<string, Severity> = {
  critical: "CRITICAL",
  crit: "CRITICAL",
  blocker: "CRITICAL",
  high: "CRITICAL",
  severe: "CRITICAL",
  error: "CRITICAL",
  warn: "WARN",
  warning: "WARN",
  medium: "WARN",
  moderate: "WARN",
  major: "WARN",
  minor: "WARN",
  low: "WARN",
  info: "INFO",
  informational: "INFO",
  note: "INFO",
  notice: "INFO",
  nit: "INFO",
  suggestion: "INFO",
  trivial: "INFO",
};

/** Severity that tolerates case + common reviewer synonyms; canonical output. */
export const SeverityCoerced = z.preprocess((v) => {
  if (typeof v !== "string") return v;
  const key = v.trim().toLowerCase();
  return SEVERITY_SYNONYMS[key] ?? v.trim().toUpperCase();
}, Severity);

export const FindingCategory = z.enum([
  "security",
  "correctness",
  "quality",
  "architecture",
  "performance",
  "testing",
  "docs",
]);
export type FindingCategory = z.infer<typeof FindingCategory>;

export const Consensus = z.enum(["unanimous", "majority", "minority", "singleton"]);
export type Consensus = z.infer<typeof Consensus>;

export const FindingSchema = z.object({
  id: z.string(),
  signature: z.string(),
  severity: SeverityCoerced,
  category: FindingCategory,
  rule_id: z.string(),
  file: z.string(),
  line_start: z.number().int().positive(),
  line_end: z.number().int().positive(),
  diff_hunk: z.string().optional(),
  message: z.string().max(200),
  details: z.string().max(2000),
  suggested_fix: z.string().optional(),
  reviewer: z.object({
    provider: z.string(),
    model: z.string(),
    persona: z.string(),
  }),
  confidence: z.number().min(0).max(1),
  confirmed_by: z.array(z.string()).optional(),
  consensus: Consensus,
  critic_verdict: z.enum(["keep", "likely_fp"]).optional(),
  critic_reason: z.string().optional(),
  // M5 Part A: set true when the aggregator demoted this finding to INFO because
  // its range falls outside the changed hunks (advisory, non-blocking).
  scope_demoted: z.boolean().optional(),
  // Field report 2026-06-17 #1: set true when the deterministic self-refutation pass
  // demoted this finding to INFO because the reviewer's OWN conclusion clause retracts it
  // ("…appears safe", "No issue", "No defect", "Safe."). Demote-only, category-independent
  // (a first-party retraction, like fact_invalid), fail-safe (positive-signal + negation
  // backstop). Advisory, non-blocking.
  self_refuted: z.boolean().optional(),
  // Slice 1 (field report #1): set true when the aggregator demoted this finding to INFO
  // because its subject (message/suggested_fix) targets Reviewgate's own <REDACTED:…>
  // placeholder — almost always the reviewer mistaking a stripped secret for broken code.
  // Demoted (not dropped) so a mis-worded REAL leak stays visible; security/secret-lead-word
  // findings are exempt (stay blocking). Advisory, non-blocking.
  redaction_demoted: z.boolean().optional(),
  // Slice 2 (field report #9): set true when the aggregator demoted a SECURITY finding
  // to INFO because its file is a test/fixture (classify()==="tests") — a mocked secret /
  // weak password in a fixture is not a production vulnerability. Only category "security"
  // is demoted; correctness/other on a test file stay blocking. Advisory, non-blocking.
  test_severity_demoted: z.boolean().optional(),
  // Slice D (P5, field report 2026-06-22): set true when the aggregator CAPPED a CRITICAL
  // finding to WARN because its FILE classifies as "docs" (a stale doc is over-severity, not
  // a security/data-loss bug). Capped to WARN (NOT INFO) so it stays SOFT-PASS-blocking +
  // decision-required (G0); carries demoted_from_critical. security/correctness on a doc
  // (a leaked secret / dangerous command in markdown) is EXEMPT and stays CRITICAL.
  docs_severity_capped: z.boolean().optional(),
  // Slice C (P4, field report 2026-06-22): set true when a CRITICAL is the ONLY (singleton,
  // uncorroborated) blocking opinion on a single-reviewer panel AND is NOT security/correctness.
  // Render-only honest framing — the verdict is UNCHANGED (it still hard-FAILs, PR#22); the
  // badge tells the agent to verify the cited code itself before fix/reject.
  lone_critical_uncorroborated: z.boolean().optional(),
  // Slice A (P1, field report 2026-06-22): set true when the aggregator demoted this finding to
  // INFO because its file is FOREIGN to this session (provably not authored by it — see the
  // baseline-delta ownership model). Structural scope demote (like scope_demoted), NOT a value
  // judgment: goes to INFO, never sets demoted_from_critical, G0-EXEMPT. Persisted in
  // pending.json as the ownership snapshot the out-of-scope decision gate reads (no live re-derive).
  foreign_to_session: z.boolean().optional(),
  // S2 (field report 2026-06-23): true when this finding's file IS attributable to this session
  // (owned ∪ baseline-net-changed ∪ dirty-now-not-baseline — the SOUND uncommitted-work set);
  // false when it is NOT (a parallel agent's committed work, or pre-existing dirty the session
  // never touched). Stamped server-side by the aggregator from the attributable set computed once
  // over facts.files, persisted as the snapshot the out-of-session decision gate reads (no live
  // re-derive). Absent (single-agent / scoping off) → treated as attributable (fail-closed: disown
  // unavailable). NEVER changes severity — purely an ownership tag, unlike foreign_to_session.
  session_attributable: z.boolean().optional(),
  // S4 (field report 2026-06-23): the exact source line the reviewer self-attests it relied on,
  // verbatim (capped). RENDER-ONLY: fact-check badges a CLEAR mismatch vs the working-tree line.
  // Never changes severity.
  evidence_line: z.string().optional(),
  // S4: set true (render-only) when the reviewer's quoted evidence_line matches NO line in the cited
  // file — a strong signal it reasoned on stale/absent/fabricated context. Advisory badge ONLY; the
  // verdict/severity are untouched (a moved line still present elsewhere does NOT trip it).
  evidence_mismatch: z.boolean().optional(),
  // Phase 4 #7: set true when the aggregator demoted this finding to INFO because
  // its reviewer-reported confidence fell below the configured floor AND it wasn't
  // corroborated by other reviewers (advisory, non-blocking).
  low_confidence: z.boolean().optional(),
  // Reviewer-reputation demote: set true when the aggregator demoted this finding
  // one severity step because its sole (un-corroborated) reviewer (provider:persona) is currently
  // below the reputation trust floor. Advisory-leaning; never security/correctness.
  reputation_demoted: z.boolean().optional(),
  // R5 (field report 2026-07-03): set true when the reputation pass clamped a lone
  // chronically-unreliable reviewer's uncorroborated CRITICAL-correctness finding to a
  // decision-required WARN (always together with reputation_demoted + demoted_from_critical).
  // The finding needs corroboration (a 2nd reviewer or the agent's own verification) to be
  // trusted at CRITICAL; G0 keeps it blocking until the agent decides. Render: this badge
  // REPLACES the generic low-precision advisory (which reads contradictory on a clamped finding).
  reputation_corroboration_required: z.boolean().optional(),
  // T3/R4 (field report 2026-07-03): this finding overlaps a (file, line-range) region the
  // agent already dispositioned-away this cycle (rejected / verified-not-applicable) — the
  // renamed-signature treadmill the signature-keyed guards miss. suppressed:true ⇒ the
  // aggregator demoted it to INFO (>= 2 distinct prior dispositions + category-compatible +
  // severity-dominated; never CRITICAL/security/demoted_from_critical). suppressed:false ⇒
  // badge-only: the prior reason is cited so the agent can fast-path a re-reject, but the
  // finding stays blocking.
  region_rejected_match: z
    .object({
      distinct_count: z.number().int().positive(),
      prior_reason: z.string(),
      suppressed: z.boolean(),
    })
    .optional(),
  // T4/R2 (field report 2026-07-03): set true when the delta-scope pass demoted this
  // finding to INFO because it sits on a file byte-identical to the prior reviewed
  // snapshot with no prior blocking finding (iteration >= 2 policy demote — a fresh nit
  // on already-reviewed, untouched content). STRUCTURAL scope demote like
  // scope_demoted/foreign_to_session: goes to INFO, never sets demoted_from_critical
  // (G0-EXEMPT — out of the delta scope, not a value judgment). security/correctness
  // and §4.3 pins are never delta-demoted.
  delta_scope_demoted: z.boolean().optional(),
  // Non-convergence #1 (field report 2026-06-17): set true when this finding's file:line region
  // was already raised as a finding in an EARLIER iteration of the current review cycle. ADVISORY
  // flag only — never demotes — so the agent verifies it is a genuinely NEW issue before
  // re-fixing (a reviewer re-litigating a settled line under a fresh signature is the treadmill;
  // the location-recurrence escalation fires once it recurs maxLocationRecurrence times).
  location_recurred: z.boolean().optional(),
  // Stable-Code-Guard (field report 2026-06-17, #2 bonus): set true when this finding is on a file
  // the agent did NOT edit this cycle while it WAS editing others — the code under it is unchanged
  // across the loop, so a fresh finding on it is likely reviewer non-determinism. ADVISORY flag
  // only — never demotes (a real new bug on stable code stays blocking, now with context).
  stable_code: z.boolean().optional(),
  // #6 instrumentation (field report 2026-06-17): set true when this finding asserts a
  // project/house rule (e.g. "CLAUDE.md says…") WITHOUT a verifiable file:line citation. Tag +
  // count ONLY — never demotes (non-suppressing). Rendered as an advisory badge; the per-run
  // count is persisted in RunSummary so the #6 directive's effect is measurable over time.
  rule_citation_unverified: z.boolean().optional(),
  // #4 (field report 2026-06-17): set true when a SOFT demoter (critic likely_fp or the
  // confidence-floor) WOULD have demoted this finding but it was kept at full blocking
  // severity because its sole contributing reviewer has a high historical precision
  // (>= HIGH_PRECISION_FLOOR with >= PROTECT_MIN_DECISIONS samples). Anti-suppression: the
  // flag only ever PREVENTS a demote (a real bug from a trusted reviewer must not be
  // silently downgraded — field report F-005). Never set on a self_refuted finding.
  protected_high_precision: z.boolean().optional(),
  // #8: historical precision of the base provider(s) that raised this finding,
  // attached at report-write time as ADVISORY context (never affects severity/
  // verdict). Only providers with >= PROVIDER_PRECISION_MIN_DECISIONS of decision
  // history are listed. precision is tp/(tp+fp), or null at zero samples.
  reviewer_precision: z
    .array(
      z.object({
        provider: z.string(),
        tp: z.number().int().nonnegative(),
        fp: z.number().int().nonnegative(),
        precision: z.number().min(0).max(1).nullable(),
      }),
    )
    .optional(),
  // #2 severity floor (field report 2026-06-17 non-convergence): set true when a CRITICAL was
  // demoted one step to WARN because the reviewer's OWN text frames it as currently-safe /
  // hypothetical / future fragility (no present demonstrable defect). Demote-only, one-step,
  // security/correctness-exempt; the finding still surfaces as a blocking WARN.
  hypothetical_demoted: z.boolean().optional(),
  // G0 (field report 2026-06-21 soft-pass fail-open): set true ONLY by a VALUE-JUDGMENT
  // demoter (hypothetical / grounding L1+L2 / critic likely_fp / reputation pure-quality /
  // reputation-correctness / confidence-floor) that lowered this finding from a CRITICAL by
  // one step. It is the SINGLE source of truth for "this WARN/CRITICAL was a CRITICAL a
  // value judgment softened" — NOT original_severity (which max()-propagates through merge and
  // would be contaminated by a structurally-demoted member). Structural/agent/ledger demoters
  // (scope/fact_invalid/redaction/self_refuted/cycleRejected/fp_ledger/fp_cluster/test_severity)
  // NEVER set it. OR-propagated through the dedup merge. Drives the from_critical_demoted count
  // → keeps a sole demoted-from-CRITICAL finding decision-required on SOFT-PASS (no silent re-arm).
  demoted_from_critical: z.boolean().optional(),
  // S6 grounding (layer 1): set true when the grounding pass demoted this finding
  // one severity step (CRITICAL→WARN) because it cited a code-shaped token (CSS
  // custom property or backtick code-span) that is wholly absent from the reviewed
  // corpus (diff + full content of changed files) — i.e. the reviewer fabricated
  // it. Breaks the otherwise-unconditional security/correctness CRITICAL hard-FAIL
  // ONLY for provably-ungrounded claims; advisory-leaning, still surfaced.
  grounding_demoted: z.boolean().optional(),
  // Deterministic fact-check: set true when the pre-grounding validator demoted this
  // finding to INFO because its cited file:line provably does NOT exist in the working
  // tree (file absent / empty / line out of range) — almost certainly a hallucination.
  // Unlike grounding, this does NOT exempt security/correctness: a non-existent line is
  // a fabrication regardless of category, and demoting (vs blocking on a phantom) is
  // strictly safer. Fail-safe: any fs uncertainty leaves the finding untouched.
  fact_invalid: z.boolean().optional(),
  // M5 Part B0: per-member provenance of a merged cluster. The aggregator clusters
  // findings (possibly different rule_id/category/signature) under one
  // representative; this records each member's own signature + trusted base
  // provider so the FP-ledger can attribute cross-provider quorum PER signature
  // (not to the representative's signature that some providers never emitted).
  members: z
    .array(
      z.object({
        signature: z.string(),
        provider: z.string(),
        rule_id: z.string(),
        category: FindingCategory,
        // Per-member reviewer confidence — so the confidence-demote uses the
        // cluster MAX (a co-located high-confidence member isn't masked by a
        // low-confidence representative). Optional for backward-compat.
        confidence: z.number().min(0).max(1).optional(),
        // G0: per-member provenance of a value-judgment CRITICAL→ demote, so the dedup
        // merge can OR-propagate it to the representative (a demoted member merged under
        // an unflagged equal-severity representative must not silently lose the flag).
        demoted_from_critical: z.boolean().optional(),
      }),
    )
    .optional(),
  fp_ledger_match: z
    .object({
      pattern_id: z.string(),
      matched_count: z.number().int().nonnegative(),
      suppressed: z.boolean(),
    })
    .optional(),
  // F3 Phase 2 — match against a DERIVED FP cluster (computeFpClusters) that
  // reached active/sticky stage. Different from fp_ledger_match: that tag fires
  // when a finding's exact signature matches a single ledger entry; this fires
  // when the finding's (rule_id_token0 × file) groups it with ≥3 rejects from
  // ≥2 distinct providers across MULTIPLE ledger entries — catching multi-
  // rule_id hallucination bursts (e.g. prisma-{attribute-corruption, corrupted-
  // attribute, invalid-attribute}) that per-signature granularity misses.
  fp_cluster_match: z
    .object({
      cluster_key: z.string(), // "<rule_id_token0>@<file>"
      member_ids: z.array(z.string()), // FP-ledger entry ids in the cluster
      suppressed: z.boolean(),
    })
    .optional(),
  // §4.3 Fix-Verification: set by the aggregator when this finding's signature was
  // marked accepted/action:"fixed" in an earlier iteration of the current cycle and
  // has RECURRED. The finding is PINNED (critic/confidence/reputation demote passes
  // skip it) so an ineffective "fix" stays blocking. `iter` = earliest iteration the
  // fix was claimed. Rendered as a blocking-section badge by report-writer.
  claimed_fixed_recurred: z.object({ iter: z.number().int().positive() }).optional(),
  // Deterministic checker tier: set true when this finding represents a configured
  // command (tsc/build/test) that exited non-zero — ground truth, not a reviewer
  // opinion. It is reject-forbidden in the decisions gate (you can't "reject" a
  // compiler) and exempt from the aggregator's demote passes (it short-circuits
  // the panel entirely). Signature is stable per check (`check:<name>`).
  deterministic: z.boolean().optional(),
  // Lore v1 (2026-07-09): set on the two synthetic lore findings — a staleness
  // "reminder" (a stale canon entry's anchors overlap the diff) or a
  // "canon-promotion" guard (a draft→canon transition / born-as-canon entry
  // needing human approval). Both are severity INFO and NEVER go through
  // aggregate() (built separately, concatenated after) — they are
  // VERDICT-NEUTRAL by construction (a PASS stays a PASS) but DECISION-REQUIRED
  // via the loop-driver (Task 7), same mechanics as G0/demoted_from_critical.
  // See docs/superpowers/specs/2026-07-09-lore-design.md.
  lore: z.enum(["reminder", "canon-promotion"]).optional(),
  contradicts_memory: z
    .object({
      brain_entry_id: z.string(),
      reason: z.string().max(500),
    })
    .optional(),
});

export type Finding = z.infer<typeof FindingSchema>;
