export const POLICY_CATALOG_VERSION = "reviewgate.policy-catalog.v1" as const;

export const POLICY_PASS_IDS = [
  "evidence.fact-location",
  "evidence.self-refutation",
  "judgment.hypothetical",
  "evidence.grounding-token",
  "judgment.grounding-llm",
  "evidence.redaction-placeholder",
  "judgment.critic",
  "scope.diff",
  "scope.delta",
  "scope.session",
  "history.fp-signature",
  "history.cycle-rejected",
  "history.fp-cluster",
  "judgment.confidence",
  "judgment.reputation",
  "history.region-rejected",
  "judgment.test-security",
  "judgment.docs-cap",
] as const;

export const POLICY_STAGE_IDS = ["aggregation.cluster", "verdict.compute"] as const;

export const POLICY_EFFECT_ACTIONS = [
  "demoted",
  "capped",
  "dropped",
  "protected",
  "suppressed",
  "reanchored",
] as const;

export const POLICY_REASON_CODES = [
  "ineligible-starting-state",
  "predicate-miss",
  "configured-off",
  "stage-precondition-miss",
  "instrumentation-error",
  "location-out-of-range",
  "evidence-line-reanchored",
  "terminal-self-refutation",
  "hypothetical-critical",
  "cited-token-absent",
  "judge-ungrounded",
  "placeholder-code-hallucination",
  "critic-likely-fp",
  "outside-changed-file",
  "outside-changed-lines",
  "preexisting-harness-config",
  "outside-delta-scope",
  "foreign-to-session",
  "active-fp-signature",
  "cycle-signature-rejected",
  "active-fp-cluster",
  "below-confidence-floor",
  "unreliable-reviewer",
  "rejected-region-overlap",
  "test-only-security",
  "docs-critical-cap",
  "singleton",
  "clustered",
  "hard-critical",
  "corroborated-warn",
  "claimed-fixed-recurrence",
  "blocking-present",
  "no-blocking-findings",
] as const;

export const POLICY_PROTECTION_CODES = [
  "claimed-fixed-pin",
  "security-correctness-floor",
  "deterministic-ground-truth",
  "secret-evidence-backstop",
  "self-refutation-visibility",
  "corroborated-majority",
  "corroborated-unanimous",
  "high-precision-reviewer",
  "out-of-diff-blocking-hatch",
  "critical-floor",
  "security-floor",
  "correctness-demote-disabled",
  "insufficient-distinct-rejections",
  "category-change",
  "severity-increase",
  "mixed-category-cluster",
] as const;

export type PolicyPassId = (typeof POLICY_PASS_IDS)[number];
export type PolicyStageId = (typeof POLICY_STAGE_IDS)[number];
export type PolicyCatalogId = PolicyPassId | PolicyStageId;
export type PolicyEffectAction = (typeof POLICY_EFFECT_ACTIONS)[number];
export type PolicyReasonCode = (typeof POLICY_REASON_CODES)[number];
export type PolicyProtectionCode = (typeof POLICY_PROTECTION_CODES)[number];
export type PolicyPassClass = "evidence" | "value-judgment" | "scope" | "history";
export type PolicySeverity = "CRITICAL" | "WARN" | "INFO";

export interface PolicyMaterialTransition {
  readonly reason_code: PolicyReasonCode;
  readonly action: Exclude<PolicyEffectAction, "protected">;
  readonly before: PolicySeverity;
  readonly after: PolicySeverity | null;
}

export interface PolicyProtectionRule {
  readonly reason_code: PolicyReasonCode;
  readonly protected_by: PolicyProtectionCode;
  readonly before: PolicySeverity;
}

export interface PolicyPassCatalogEntry {
  readonly id: PolicyPassId;
  readonly order: number;
  readonly class: PolicyPassClass;
  readonly actions: readonly PolicyEffectAction[];
  readonly reason_codes: readonly PolicyReasonCode[];
  readonly protection_codes: readonly PolicyProtectionCode[];
  readonly material_transitions: readonly PolicyMaterialTransition[];
  readonly protection_rules: readonly PolicyProtectionRule[];
  readonly opportunity: string;
  readonly depends_on: readonly PolicyCatalogId[];
  readonly overlaps_with: readonly PolicyPassId[];
  readonly ablatable: true;
  readonly slice_2_metric: string;
}

export interface PolicyStageCatalogEntry {
  readonly id: PolicyStageId;
  readonly order: number;
  readonly reason_codes: readonly PolicyReasonCode[];
  readonly depends_on: readonly PolicyCatalogId[];
  readonly ablatable: false;
}

const COMMON_REASONS = [
  "ineligible-starting-state",
  "predicate-miss",
  "configured-off",
  "stage-precondition-miss",
] as const satisfies readonly PolicyReasonCode[];

export const POLICY_PASSES = [
  {
    id: "evidence.fact-location",
    order: 10,
    class: "evidence",
    actions: ["demoted", "reanchored"],
    reason_codes: [...COMMON_REASONS, "location-out-of-range", "evidence-line-reanchored"],
    protection_codes: [],
    material_transitions: [
      {
        reason_code: "location-out-of-range",
        action: "demoted",
        before: "CRITICAL",
        after: "INFO",
      },
      { reason_code: "location-out-of-range", action: "demoted", before: "WARN", after: "INFO" },
      { reason_code: "location-out-of-range", action: "demoted", before: "INFO", after: "INFO" },
      {
        reason_code: "evidence-line-reanchored",
        action: "reanchored",
        before: "CRITICAL",
        after: "CRITICAL",
      },
      {
        reason_code: "evidence-line-reanchored",
        action: "reanchored",
        before: "WARN",
        after: "WARN",
      },
      {
        reason_code: "evidence-line-reanchored",
        action: "reanchored",
        before: "INFO",
        after: "INFO",
      },
    ],
    protection_rules: [],
    opportunity: "cited repo file is safely readable and the finding has a positive line",
    depends_on: [],
    overlaps_with: [
      "evidence.self-refutation",
      "judgment.hypothetical",
      "evidence.grounding-token",
      "judgment.grounding-llm",
      "evidence.redaction-placeholder",
    ],
    ablatable: true,
    slice_2_metric: "re-anchor yield and blocking delta per opportunity",
  },
  {
    id: "evidence.self-refutation",
    order: 20,
    class: "evidence",
    actions: ["demoted", "protected"],
    reason_codes: [...COMMON_REASONS, "terminal-self-refutation"],
    protection_codes: ["security-correctness-floor", "deterministic-ground-truth"],
    material_transitions: [
      {
        reason_code: "terminal-self-refutation",
        action: "demoted",
        before: "CRITICAL",
        after: "INFO",
      },
      {
        reason_code: "terminal-self-refutation",
        action: "demoted",
        before: "WARN",
        after: "INFO",
      },
    ],
    protection_rules: [
      {
        reason_code: "terminal-self-refutation",
        protected_by: "security-correctness-floor",
        before: "CRITICAL",
      },
      {
        reason_code: "terminal-self-refutation",
        protected_by: "security-correctness-floor",
        before: "WARN",
      },
      {
        reason_code: "terminal-self-refutation",
        protected_by: "deterministic-ground-truth",
        before: "CRITICAL",
      },
      {
        reason_code: "terminal-self-refutation",
        protected_by: "deterministic-ground-truth",
        before: "WARN",
      },
    ],
    opportunity: "blocking finding",
    depends_on: ["evidence.fact-location"],
    overlaps_with: [
      "evidence.fact-location",
      "judgment.hypothetical",
      "evidence.grounding-token",
      "judgment.grounding-llm",
      "evidence.redaction-placeholder",
    ],
    ablatable: true,
    slice_2_metric: "blocking delta and disposition accuracy per opportunity",
  },
  {
    id: "judgment.hypothetical",
    order: 30,
    class: "value-judgment",
    actions: ["demoted", "protected"],
    reason_codes: [...COMMON_REASONS, "hypothetical-critical"],
    protection_codes: ["security-correctness-floor", "deterministic-ground-truth"],
    material_transitions: [
      {
        reason_code: "hypothetical-critical",
        action: "demoted",
        before: "CRITICAL",
        after: "WARN",
      },
    ],
    protection_rules: [
      {
        reason_code: "hypothetical-critical",
        protected_by: "security-correctness-floor",
        before: "CRITICAL",
      },
      {
        reason_code: "hypothetical-critical",
        protected_by: "deterministic-ground-truth",
        before: "CRITICAL",
      },
    ],
    opportunity: "CRITICAL finding",
    depends_on: ["evidence.self-refutation"],
    overlaps_with: [
      "evidence.fact-location",
      "evidence.self-refutation",
      "evidence.grounding-token",
      "judgment.grounding-llm",
      "evidence.redaction-placeholder",
    ],
    ablatable: true,
    slice_2_metric: "severity delta and disposition accuracy per opportunity",
  },
  {
    id: "evidence.grounding-token",
    order: 40,
    class: "evidence",
    actions: ["demoted", "protected"],
    reason_codes: [...COMMON_REASONS, "cited-token-absent"],
    protection_codes: ["security-correctness-floor"],
    material_transitions: [
      {
        reason_code: "cited-token-absent",
        action: "demoted",
        before: "CRITICAL",
        after: "WARN",
      },
    ],
    protection_rules: [
      {
        reason_code: "cited-token-absent",
        protected_by: "security-correctness-floor",
        before: "CRITICAL",
      },
    ],
    opportunity: "CRITICAL finding with at least one extractable token",
    depends_on: ["judgment.hypothetical"],
    overlaps_with: [
      "evidence.fact-location",
      "evidence.self-refutation",
      "judgment.hypothetical",
      "judgment.grounding-llm",
      "evidence.redaction-placeholder",
    ],
    ablatable: true,
    slice_2_metric: "severity delta and disposition accuracy per opportunity",
  },
  {
    id: "judgment.grounding-llm",
    order: 50,
    class: "value-judgment",
    actions: ["demoted", "protected"],
    reason_codes: [...COMMON_REASONS, "judge-ungrounded"],
    protection_codes: ["security-correctness-floor"],
    material_transitions: [
      {
        reason_code: "judge-ungrounded",
        action: "demoted",
        before: "CRITICAL",
        after: "WARN",
      },
    ],
    protection_rules: [
      {
        reason_code: "judge-ungrounded",
        protected_by: "security-correctness-floor",
        before: "CRITICAL",
      },
    ],
    opportunity: "CRITICAL finding with a judge verdict for its signature",
    depends_on: ["evidence.grounding-token"],
    overlaps_with: [
      "evidence.fact-location",
      "evidence.self-refutation",
      "judgment.hypothetical",
      "evidence.grounding-token",
      "evidence.redaction-placeholder",
    ],
    ablatable: true,
    slice_2_metric: "severity delta and disposition accuracy per opportunity",
  },
  {
    id: "evidence.redaction-placeholder",
    order: 60,
    class: "evidence",
    actions: ["demoted", "protected"],
    reason_codes: [...COMMON_REASONS, "placeholder-code-hallucination"],
    protection_codes: ["security-correctness-floor", "secret-evidence-backstop"],
    material_transitions: [
      {
        reason_code: "placeholder-code-hallucination",
        action: "demoted",
        before: "CRITICAL",
        after: "INFO",
      },
      {
        reason_code: "placeholder-code-hallucination",
        action: "demoted",
        before: "WARN",
        after: "INFO",
      },
    ],
    protection_rules: [
      {
        reason_code: "placeholder-code-hallucination",
        protected_by: "security-correctness-floor",
        before: "CRITICAL",
      },
      {
        reason_code: "placeholder-code-hallucination",
        protected_by: "security-correctness-floor",
        before: "WARN",
      },
      {
        reason_code: "placeholder-code-hallucination",
        protected_by: "secret-evidence-backstop",
        before: "CRITICAL",
      },
      {
        reason_code: "placeholder-code-hallucination",
        protected_by: "secret-evidence-backstop",
        before: "WARN",
      },
    ],
    opportunity: "blocking finding whose subject contains a redaction placeholder",
    depends_on: ["judgment.grounding-llm"],
    overlaps_with: [
      "evidence.fact-location",
      "evidence.self-refutation",
      "judgment.hypothetical",
      "evidence.grounding-token",
      "judgment.grounding-llm",
    ],
    ablatable: true,
    slice_2_metric: "blocking delta and disposition accuracy per opportunity",
  },
  {
    id: "judgment.critic",
    order: 70,
    class: "value-judgment",
    actions: ["demoted", "dropped", "protected"],
    reason_codes: [...COMMON_REASONS, "critic-likely-fp"],
    protection_codes: [
      "claimed-fixed-pin",
      "self-refutation-visibility",
      "security-correctness-floor",
      "corroborated-majority",
      "corroborated-unanimous",
      "high-precision-reviewer",
    ],
    material_transitions: [
      {
        reason_code: "critic-likely-fp",
        action: "demoted",
        before: "CRITICAL",
        after: "WARN",
      },
      {
        reason_code: "critic-likely-fp",
        action: "demoted",
        before: "WARN",
        after: "INFO",
      },
      {
        reason_code: "critic-likely-fp",
        action: "dropped",
        before: "INFO",
        after: null,
      },
    ],
    protection_rules: [
      {
        reason_code: "critic-likely-fp",
        protected_by: "claimed-fixed-pin",
        before: "CRITICAL",
      },
      {
        reason_code: "critic-likely-fp",
        protected_by: "claimed-fixed-pin",
        before: "WARN",
      },
      {
        reason_code: "critic-likely-fp",
        protected_by: "claimed-fixed-pin",
        before: "INFO",
      },
      {
        reason_code: "critic-likely-fp",
        protected_by: "self-refutation-visibility",
        before: "INFO",
      },
      {
        reason_code: "critic-likely-fp",
        protected_by: "security-correctness-floor",
        before: "CRITICAL",
      },
      {
        reason_code: "critic-likely-fp",
        protected_by: "corroborated-majority",
        before: "CRITICAL",
      },
      {
        reason_code: "critic-likely-fp",
        protected_by: "corroborated-majority",
        before: "WARN",
      },
      {
        reason_code: "critic-likely-fp",
        protected_by: "corroborated-majority",
        before: "INFO",
      },
      {
        reason_code: "critic-likely-fp",
        protected_by: "corroborated-unanimous",
        before: "CRITICAL",
      },
      {
        reason_code: "critic-likely-fp",
        protected_by: "corroborated-unanimous",
        before: "WARN",
      },
      {
        reason_code: "critic-likely-fp",
        protected_by: "corroborated-unanimous",
        before: "INFO",
      },
      {
        reason_code: "critic-likely-fp",
        protected_by: "high-precision-reviewer",
        before: "CRITICAL",
      },
      {
        reason_code: "critic-likely-fp",
        protected_by: "high-precision-reviewer",
        before: "WARN",
      },
    ],
    opportunity: "critic emitted a verdict for representative or member signature",
    depends_on: ["aggregation.cluster"],
    overlaps_with: ["judgment.confidence", "judgment.reputation"],
    ablatable: true,
    slice_2_metric: "precision and recall delta per opportunity",
  },
  {
    id: "scope.diff",
    order: 80,
    class: "scope",
    actions: ["demoted", "protected"],
    reason_codes: [
      ...COMMON_REASONS,
      "outside-changed-file",
      "outside-changed-lines",
      "preexisting-harness-config",
    ],
    protection_codes: ["out-of-diff-blocking-hatch"],
    material_transitions: [
      {
        reason_code: "outside-changed-file",
        action: "demoted",
        before: "CRITICAL",
        after: "INFO",
      },
      {
        reason_code: "outside-changed-file",
        action: "demoted",
        before: "WARN",
        after: "INFO",
      },
      {
        reason_code: "outside-changed-lines",
        action: "demoted",
        before: "CRITICAL",
        after: "INFO",
      },
      {
        reason_code: "outside-changed-lines",
        action: "demoted",
        before: "WARN",
        after: "INFO",
      },
      {
        reason_code: "preexisting-harness-config",
        action: "demoted",
        before: "CRITICAL",
        after: "INFO",
      },
      {
        reason_code: "preexisting-harness-config",
        action: "demoted",
        before: "WARN",
        after: "INFO",
      },
    ],
    protection_rules: [
      {
        reason_code: "outside-changed-file",
        protected_by: "out-of-diff-blocking-hatch",
        before: "CRITICAL",
      },
      {
        reason_code: "outside-changed-file",
        protected_by: "out-of-diff-blocking-hatch",
        before: "WARN",
      },
      {
        reason_code: "outside-changed-lines",
        protected_by: "out-of-diff-blocking-hatch",
        before: "CRITICAL",
      },
      {
        reason_code: "outside-changed-lines",
        protected_by: "out-of-diff-blocking-hatch",
        before: "WARN",
      },
    ],
    opportunity: "blocking finding has a usable line while changed ranges exist",
    depends_on: ["aggregation.cluster"],
    overlaps_with: ["scope.delta", "scope.session"],
    ablatable: true,
    slice_2_metric: "blocking delta and disposition accuracy per opportunity",
  },
  {
    id: "scope.delta",
    order: 90,
    class: "scope",
    actions: ["demoted", "protected"],
    reason_codes: [...COMMON_REASONS, "outside-delta-scope"],
    protection_codes: [
      "claimed-fixed-pin",
      "security-correctness-floor",
      "critical-floor",
      "out-of-diff-blocking-hatch",
    ],
    material_transitions: [
      {
        reason_code: "outside-delta-scope",
        action: "demoted",
        before: "CRITICAL",
        after: "INFO",
      },
      {
        reason_code: "outside-delta-scope",
        action: "demoted",
        before: "WARN",
        after: "INFO",
      },
    ],
    protection_rules: [
      {
        reason_code: "outside-delta-scope",
        protected_by: "claimed-fixed-pin",
        before: "CRITICAL",
      },
      {
        reason_code: "outside-delta-scope",
        protected_by: "claimed-fixed-pin",
        before: "WARN",
      },
      {
        reason_code: "outside-delta-scope",
        protected_by: "security-correctness-floor",
        before: "CRITICAL",
      },
      {
        reason_code: "outside-delta-scope",
        protected_by: "security-correctness-floor",
        before: "WARN",
      },
      {
        reason_code: "outside-delta-scope",
        protected_by: "critical-floor",
        before: "CRITICAL",
      },
      {
        reason_code: "outside-delta-scope",
        protected_by: "critical-floor",
        before: "WARN",
      },
      {
        reason_code: "outside-delta-scope",
        protected_by: "out-of-diff-blocking-hatch",
        before: "CRITICAL",
      },
      {
        reason_code: "outside-delta-scope",
        protected_by: "out-of-diff-blocking-hatch",
        before: "WARN",
      },
    ],
    opportunity: "blocking finding while a delta scope exists",
    depends_on: ["scope.diff"],
    overlaps_with: ["scope.diff", "scope.session"],
    ablatable: true,
    slice_2_metric: "blocking delta and disposition accuracy per opportunity",
  },
  {
    id: "scope.session",
    order: 100,
    class: "scope",
    actions: ["demoted", "protected"],
    reason_codes: [...COMMON_REASONS, "foreign-to-session"],
    protection_codes: ["out-of-diff-blocking-hatch"],
    material_transitions: [
      {
        reason_code: "foreign-to-session",
        action: "demoted",
        before: "CRITICAL",
        after: "INFO",
      },
      {
        reason_code: "foreign-to-session",
        action: "demoted",
        before: "WARN",
        after: "INFO",
      },
    ],
    protection_rules: [
      {
        reason_code: "foreign-to-session",
        protected_by: "out-of-diff-blocking-hatch",
        before: "CRITICAL",
      },
      {
        reason_code: "foreign-to-session",
        protected_by: "out-of-diff-blocking-hatch",
        before: "WARN",
      },
    ],
    opportunity: "blocking finding while foreign-file facts exist",
    depends_on: ["scope.delta"],
    overlaps_with: ["scope.diff", "scope.delta"],
    ablatable: true,
    slice_2_metric: "blocking delta and disposition accuracy per opportunity",
  },
  {
    id: "history.fp-signature",
    order: 110,
    class: "history",
    actions: ["suppressed"],
    reason_codes: [...COMMON_REASONS, "active-fp-signature"],
    protection_codes: [],
    material_transitions: [
      {
        reason_code: "active-fp-signature",
        action: "suppressed",
        before: "CRITICAL",
        after: "INFO",
      },
      {
        reason_code: "active-fp-signature",
        action: "suppressed",
        before: "WARN",
        after: "INFO",
      },
    ],
    protection_rules: [],
    opportunity: "blocking finding while an active signature snapshot exists",
    depends_on: ["scope.session"],
    overlaps_with: ["history.cycle-rejected", "history.fp-cluster", "history.region-rejected"],
    ablatable: true,
    slice_2_metric: "state-conditioned precision and recall delta per opportunity",
  },
  {
    id: "history.cycle-rejected",
    order: 120,
    class: "history",
    actions: ["suppressed", "protected"],
    reason_codes: [...COMMON_REASONS, "cycle-signature-rejected"],
    protection_codes: ["critical-floor", "security-correctness-floor"],
    material_transitions: [
      {
        reason_code: "cycle-signature-rejected",
        action: "suppressed",
        before: "WARN",
        after: "INFO",
      },
    ],
    protection_rules: [
      {
        reason_code: "cycle-signature-rejected",
        protected_by: "critical-floor",
        before: "CRITICAL",
      },
      {
        reason_code: "cycle-signature-rejected",
        protected_by: "security-correctness-floor",
        before: "CRITICAL",
      },
      {
        reason_code: "cycle-signature-rejected",
        protected_by: "security-correctness-floor",
        before: "WARN",
      },
    ],
    opportunity: "blocking finding while rejected signatures exist",
    depends_on: ["history.fp-signature"],
    overlaps_with: ["history.fp-signature", "history.fp-cluster", "history.region-rejected"],
    ablatable: true,
    slice_2_metric: "state-conditioned precision and recall delta per opportunity",
  },
  {
    id: "history.fp-cluster",
    order: 130,
    class: "history",
    actions: ["suppressed"],
    reason_codes: [...COMMON_REASONS, "active-fp-cluster"],
    protection_codes: [],
    material_transitions: [
      {
        reason_code: "active-fp-cluster",
        action: "suppressed",
        before: "CRITICAL",
        after: "INFO",
      },
      {
        reason_code: "active-fp-cluster",
        action: "suppressed",
        before: "WARN",
        after: "INFO",
      },
    ],
    protection_rules: [],
    opportunity: "blocking finding while active cluster keys exist",
    depends_on: ["history.cycle-rejected"],
    overlaps_with: ["history.fp-signature", "history.cycle-rejected", "history.region-rejected"],
    ablatable: true,
    slice_2_metric: "state-conditioned precision and recall delta per opportunity",
  },
  {
    id: "judgment.confidence",
    order: 140,
    class: "value-judgment",
    actions: ["demoted", "capped", "protected"],
    reason_codes: [...COMMON_REASONS, "below-confidence-floor"],
    protection_codes: [
      "claimed-fixed-pin",
      "security-correctness-floor",
      "corroborated-majority",
      "corroborated-unanimous",
      "high-precision-reviewer",
    ],
    material_transitions: [
      {
        reason_code: "below-confidence-floor",
        action: "capped",
        before: "CRITICAL",
        after: "WARN",
      },
      {
        reason_code: "below-confidence-floor",
        action: "demoted",
        before: "WARN",
        after: "INFO",
      },
    ],
    protection_rules: [
      {
        reason_code: "below-confidence-floor",
        protected_by: "claimed-fixed-pin",
        before: "CRITICAL",
      },
      {
        reason_code: "below-confidence-floor",
        protected_by: "claimed-fixed-pin",
        before: "WARN",
      },
      {
        reason_code: "below-confidence-floor",
        protected_by: "security-correctness-floor",
        before: "CRITICAL",
      },
      {
        reason_code: "below-confidence-floor",
        protected_by: "corroborated-majority",
        before: "CRITICAL",
      },
      {
        reason_code: "below-confidence-floor",
        protected_by: "corroborated-majority",
        before: "WARN",
      },
      {
        reason_code: "below-confidence-floor",
        protected_by: "corroborated-unanimous",
        before: "CRITICAL",
      },
      {
        reason_code: "below-confidence-floor",
        protected_by: "corroborated-unanimous",
        before: "WARN",
      },
      {
        reason_code: "below-confidence-floor",
        protected_by: "high-precision-reviewer",
        before: "CRITICAL",
      },
      {
        reason_code: "below-confidence-floor",
        protected_by: "high-precision-reviewer",
        before: "WARN",
      },
    ],
    opportunity: "blocking finding while the confidence floor is positive",
    depends_on: ["history.fp-cluster"],
    overlaps_with: ["judgment.critic", "judgment.reputation"],
    ablatable: true,
    slice_2_metric: "precision and recall delta per opportunity",
  },
  {
    id: "judgment.reputation",
    order: 150,
    class: "value-judgment",
    actions: ["demoted", "capped", "protected"],
    reason_codes: [...COMMON_REASONS, "unreliable-reviewer"],
    protection_codes: [
      "claimed-fixed-pin",
      "security-floor",
      "correctness-demote-disabled",
      "corroborated-majority",
      "corroborated-unanimous",
      "critical-floor",
    ],
    material_transitions: [
      {
        reason_code: "unreliable-reviewer",
        action: "demoted",
        before: "CRITICAL",
        after: "WARN",
      },
      {
        reason_code: "unreliable-reviewer",
        action: "capped",
        before: "CRITICAL",
        after: "WARN",
      },
      {
        reason_code: "unreliable-reviewer",
        action: "demoted",
        before: "WARN",
        after: "INFO",
      },
    ],
    protection_rules: [
      {
        reason_code: "unreliable-reviewer",
        protected_by: "claimed-fixed-pin",
        before: "CRITICAL",
      },
      {
        reason_code: "unreliable-reviewer",
        protected_by: "claimed-fixed-pin",
        before: "WARN",
      },
      {
        reason_code: "unreliable-reviewer",
        protected_by: "security-floor",
        before: "CRITICAL",
      },
      {
        reason_code: "unreliable-reviewer",
        protected_by: "security-floor",
        before: "WARN",
      },
      {
        reason_code: "unreliable-reviewer",
        protected_by: "correctness-demote-disabled",
        before: "CRITICAL",
      },
      {
        reason_code: "unreliable-reviewer",
        protected_by: "correctness-demote-disabled",
        before: "WARN",
      },
      {
        reason_code: "unreliable-reviewer",
        protected_by: "corroborated-majority",
        before: "CRITICAL",
      },
      {
        reason_code: "unreliable-reviewer",
        protected_by: "corroborated-majority",
        before: "WARN",
      },
      {
        reason_code: "unreliable-reviewer",
        protected_by: "corroborated-unanimous",
        before: "CRITICAL",
      },
      {
        reason_code: "unreliable-reviewer",
        protected_by: "corroborated-unanimous",
        before: "WARN",
      },
      {
        reason_code: "unreliable-reviewer",
        protected_by: "critical-floor",
        before: "CRITICAL",
      },
      {
        reason_code: "unreliable-reviewer",
        protected_by: "critical-floor",
        before: "WARN",
      },
    ],
    opportunity: "blocking finding while unreliable reviewers exist",
    depends_on: ["judgment.confidence"],
    overlaps_with: ["judgment.critic", "judgment.confidence"],
    ablatable: true,
    slice_2_metric: "state-conditioned precision and recall delta per opportunity",
  },
  {
    id: "history.region-rejected",
    order: 160,
    class: "history",
    actions: ["suppressed", "protected"],
    reason_codes: [...COMMON_REASONS, "rejected-region-overlap"],
    protection_codes: [
      "claimed-fixed-pin",
      "insufficient-distinct-rejections",
      "category-change",
      "severity-increase",
      "critical-floor",
      "security-correctness-floor",
    ],
    material_transitions: [
      {
        reason_code: "rejected-region-overlap",
        action: "suppressed",
        before: "WARN",
        after: "INFO",
      },
    ],
    protection_rules: [
      {
        reason_code: "rejected-region-overlap",
        protected_by: "claimed-fixed-pin",
        before: "CRITICAL",
      },
      {
        reason_code: "rejected-region-overlap",
        protected_by: "claimed-fixed-pin",
        before: "WARN",
      },
      {
        reason_code: "rejected-region-overlap",
        protected_by: "insufficient-distinct-rejections",
        before: "CRITICAL",
      },
      {
        reason_code: "rejected-region-overlap",
        protected_by: "insufficient-distinct-rejections",
        before: "WARN",
      },
      {
        reason_code: "rejected-region-overlap",
        protected_by: "category-change",
        before: "CRITICAL",
      },
      {
        reason_code: "rejected-region-overlap",
        protected_by: "category-change",
        before: "WARN",
      },
      {
        reason_code: "rejected-region-overlap",
        protected_by: "severity-increase",
        before: "CRITICAL",
      },
      {
        reason_code: "rejected-region-overlap",
        protected_by: "severity-increase",
        before: "WARN",
      },
      {
        reason_code: "rejected-region-overlap",
        protected_by: "critical-floor",
        before: "CRITICAL",
      },
      {
        reason_code: "rejected-region-overlap",
        protected_by: "critical-floor",
        before: "WARN",
      },
      {
        reason_code: "rejected-region-overlap",
        protected_by: "security-correctness-floor",
        before: "CRITICAL",
      },
      {
        reason_code: "rejected-region-overlap",
        protected_by: "security-correctness-floor",
        before: "WARN",
      },
    ],
    opportunity: "blocking finding with a usable line while rejected regions exist",
    depends_on: ["judgment.reputation"],
    overlaps_with: ["history.fp-signature", "history.cycle-rejected", "history.fp-cluster"],
    ablatable: true,
    slice_2_metric: "state-conditioned precision and recall delta per opportunity",
  },
  {
    id: "judgment.test-security",
    order: 170,
    class: "value-judgment",
    actions: ["demoted", "protected"],
    reason_codes: [...COMMON_REASONS, "test-only-security"],
    protection_codes: ["mixed-category-cluster"],
    material_transitions: [
      {
        reason_code: "test-only-security",
        action: "demoted",
        before: "CRITICAL",
        after: "INFO",
      },
      {
        reason_code: "test-only-security",
        action: "demoted",
        before: "WARN",
        after: "INFO",
      },
    ],
    protection_rules: [
      {
        reason_code: "test-only-security",
        protected_by: "mixed-category-cluster",
        before: "CRITICAL",
      },
      {
        reason_code: "test-only-security",
        protected_by: "mixed-category-cluster",
        before: "WARN",
      },
    ],
    opportunity: "blocking finding in a classified test or fixture file",
    depends_on: ["history.region-rejected"],
    overlaps_with: ["judgment.docs-cap"],
    ablatable: true,
    slice_2_metric: "blocking delta and disposition accuracy per opportunity",
  },
  {
    id: "judgment.docs-cap",
    order: 180,
    class: "value-judgment",
    actions: ["capped", "protected"],
    reason_codes: [...COMMON_REASONS, "docs-critical-cap"],
    protection_codes: ["security-correctness-floor"],
    material_transitions: [
      {
        reason_code: "docs-critical-cap",
        action: "capped",
        before: "CRITICAL",
        after: "WARN",
      },
    ],
    protection_rules: [
      {
        reason_code: "docs-critical-cap",
        protected_by: "security-correctness-floor",
        before: "CRITICAL",
      },
    ],
    opportunity: "CRITICAL finding in a classified docs file",
    depends_on: ["judgment.test-security"],
    overlaps_with: ["judgment.test-security"],
    ablatable: true,
    slice_2_metric: "severity delta and disposition accuracy per opportunity",
  },
] as const satisfies readonly PolicyPassCatalogEntry[];

export const POLICY_STAGES = [
  {
    id: "aggregation.cluster",
    order: 65,
    reason_codes: ["singleton", "clustered"],
    depends_on: ["evidence.redaction-placeholder"],
    ablatable: false,
  },
  {
    id: "verdict.compute",
    order: 190,
    reason_codes: [
      "hard-critical",
      "corroborated-warn",
      "claimed-fixed-recurrence",
      "blocking-present",
      "no-blocking-findings",
    ],
    depends_on: ["judgment.docs-cap"],
    ablatable: false,
  },
] as const satisfies readonly PolicyStageCatalogEntry[];
