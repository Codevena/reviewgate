import { z } from "zod";
import { FindingCategory } from "../schemas/finding.ts";
import { defaultConfig } from "./defaults.ts";

// Single source of truth for brain.crossRunCandidates defaults — reused by
// both the inner sub-field `.default(...)` calls AND the outer wrapper so the
// numbers can't drift between the two.
const BRAIN_CROSS_RUN_DEFAULTS = { enabled: true, ttlDays: 60, maxEntries: 5000 } as const;

export const ProviderConfigSchema = z.object({
  enabled: z.boolean(),
  auth: z.enum(["oauth", "apikey", "openrouter"]),
  apiKeyEnv: z.string().optional(),
  model: z.string(),
  reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
  maxTokens: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive(),
  costPerMTokensUsd: z.number().nonnegative().optional(),
  // OpenRouter ONLY: upstream-provider routing (OpenRouter's request `provider`
  // field). Pins which upstream serves the model — e.g. deepseek/deepseek-v4 must
  // be served by the `deepseek` upstream, not a worse/quantized OpenRouter
  // alternative. `only`/`order` are passed verbatim; allowFallbacks →
  // allow_fallbacks. Ignored by non-OpenRouter providers.
  openrouterProvider: z
    .object({
      only: z.array(z.string()).optional(),
      order: z.array(z.string()).optional(),
      allowFallbacks: z.boolean().optional(),
    })
    .optional(),
});

const ProviderId = z.enum(["codex", "gemini", "claude-code", "openrouter", "opencode"]);

export const ConfigSchema = z.object({
  version: z.literal(1),
  providers: z.object({
    codex: ProviderConfigSchema,
    gemini: ProviderConfigSchema.optional(),
    "claude-code": ProviderConfigSchema.optional(),
    openrouter: ProviderConfigSchema.optional(),
    opencode: ProviderConfigSchema.optional(),
  }),
  phases: z.object({
    review: z.object({
      reviewers: z
        .array(
          z.object({
            provider: ProviderId,
            persona: z.string(),
            model: z.string().optional(),
            // Ordered failover chain for THIS reviewer slot. When the primary
            // provider returns `quota-exhausted` (e.g. codex hit its usage cap),
            // the orchestrator re-runs the same persona on the first fallback
            // provider that is configured (providers.<id> present) and available
            // (its CLI/key resolves) — regardless of that provider's own
            // `enabled` flag (listing it here IS the opt-in). Only quota
            // exhaustion triggers failover; a normal error/timeout does not.
            fallback: z.array(ProviderId).optional(),
          }),
        )
        .min(1),
      // §3.1: per-persona reaffirmation override. Beats the .reviewgate/personas/<id>.md
      // file and the built-in default for that persona id. Absent → file/built-in.
      personas: z.record(z.string(), z.string()).optional(),
      // Max bytes of full changed-file content fed to each reviewer alongside the
      // diff (for symbol verification). Smaller = smaller prompts = faster reviews
      // and fewer timeouts on slow remote models; larger = more context.
      fileContextBudgetBytes: z.number().int().positive().optional(),
      // Whole-vs-scoped threshold AND per-file output cap for changed-file context. A file
      // larger than this is scoped (symbol outline + enclosing function bodies) instead of
      // included whole. Default 8_000.
      fileContextPerFileBytes: z.number().int().positive().optional(),
      // Line-window radius for the scoped fallback (non-TS/Python, unparseable, or changed
      // lines outside any symbol). Default 40.
      fileContextWindowLines: z.number().int().nonnegative().optional(),
      // M5 Part A: demote findings outside the changed hunks to INFO (advisory).
      // Default ON via defaults.ts (deep-merged) — the gate primarily reviews the change.
      scopeToDiff: z.boolean().optional(),
      // Field report 2026-06-17 #1: demote a finding to INFO (advisory) when the reviewer's
      // OWN conclusion retracts it ("…appears safe", "No issue", "No defect"). Deterministic,
      // demote-only, fail-safe (positive-signal + negation backstop). Default ON via defaults.ts.
      selfRefutationFilter: z.boolean().optional(),
      // Field report 2026-06-17 #4: do NOT let the SOFT demoters (critic likely_fp /
      // confidence-floor) downgrade a finding from a high-track-record reviewer (precision
      // >= 0.70 with enough samples). Anti-suppression (only prevents a demote); never
      // affects hard suppressors or self-refuted findings. Default ON via defaults.ts.
      protectHighPrecisionReviewers: z.boolean().optional(),
      // Field report 2026-06-17 #3/#5: collapse solo, low-track-record, non-security/
      // correctness INFO notes into a single foldable block in pending.md so a noisy
      // low-precision reviewer's advisory flood doesn't dilute the agent's read. Render-only
      // (nothing dropped — every note stays in pending.json and the foldable block). Default
      // ON via defaults.ts.
      collapseLowTrustSoloInfo: z.boolean().optional(),
      // Field report 2026-06-17 (non-convergence #2): demote a CRITICAL one step to WARN when the
      // reviewer's own text frames it as currently-safe / hypothetical / future fragility (no
      // present demonstrable defect). Deterministic, one-step, demote-only, security/correctness-
      // exempt, fail-safe. Default ON via defaults.ts.
      hypotheticalSeverityGuard: z.boolean().optional(),
      // Field report 2026-06-17 #6 (instrumentation): tag + COUNT findings that assert a
      // project/house rule without a verifiable file:line citation (the F-004 class). Adds a
      // pending.md badge + a per-run count in RunSummary/audit — NON-suppressing (never demotes).
      // The count gives the rule-citation prompt directive a measurable before/after signal.
      // Default ON via defaults.ts.
      ruleCitationCheck: z.boolean().optional(),
      // Slice 2 (field report #9): demote security findings on test/fixture files to
      // INFO (advisory) — a mocked secret in a fixture isn't a prod vuln. Default ON via
      // defaults.ts. Set false for repos that ship production code under a tests/ path.
      demoteTestSecurity: z.boolean().optional(),
      // Categories that stay BLOCKING even when the finding's file is not in the
      // diff at ALL (escape hatch for legitimate cross-file impact, e.g. a changed
      // export breaking an untouched caller). Default [] — every out-of-diff
      // finding demotes to INFO (maximal suppression of unchanged-code hallucinations).
      outOfDiffBlocking: z.array(FindingCategory).optional(),
      // Phase 4 #7: reviewer-confidence floor (0..1). An uncorroborated finding
      // below this is demoted to INFO (advisory) instead of blocking — so a
      // reviewer's own low-confidence call no longer counts as much as a confident
      // one. CRITICAL security/correctness and corroborated findings are exempt.
      // 0 disables the signal. Default 0.3 (defaults.ts) — only quite-unsure
      // findings are demoted.
      confidenceFloor: z.number().min(0).max(1).optional(),
      // Maintainer-authored repo facts/conventions, injected as TRUSTED reviewer context.
      // Use for a recurring hallucination class the FP-ledger can't promote (e.g. "this repo
      // uses hex color tokens, not shadcn HSL tuples — never flag hex as a missing HSL
      // wrapper"). The reviewer must never raise a finding that contradicts a rule.
      // Optional (like the sibling review knobs); defaults.ts supplies [] so the output type
      // stays compatible with hand-built configs.
      houseRules: z.array(z.string()).optional(),
      // N5: inject the source of FIRST-PARTY (relative-import) collaborators that a
      // changed file depends on but which were NOT changed — so a reviewer can VERIFY
      // a premise about an unchanged file ("Card is/ isn't a flex container") instead
      // of guessing. Opt-in (cost/prompt size); 1-hop, byte-budgeted. null = off.
      collaboratorContext: z
        .object({
          enabled: z.boolean(),
          // Optional so a repo can opt in with just `{ enabled: true }`; the collector
          // applies its own defaults (6000 bytes / 10 files) when these are omitted.
          maxBytes: z.number().int().positive().optional(),
          maxFiles: z.number().int().positive().optional(),
        })
        .nullable()
        .default(null)
        .optional(),
      // N7: resolve Tailwind classes + CSS custom properties in changed UI files to their
      // computed values (gap-3 → 12px) and inject them as trusted facts, so reviewers stop
      // misreading layout from the raw diff. Opt-in (UI repos); no browser. null = off.
      uiAnalysis: z.object({ enabled: z.boolean() }).nullable().default(null).optional(),
      // #3: inject the installed dependency API surface (exported names from node_modules
      // .d.ts) as advisory reviewer context, so reviewers don't claim a real installed API is
      // non-existent. Context-only, no verdict change. Default ON.
      depSurface: z.boolean().optional(),
      depSurfaceBudgetBytes: z.number().int().positive().optional(),
      // #8: annotate each finding in pending.md/json with the historical precision
      // (tp/fp) of the provider(s) that raised it — ADVISORY context for the agent's
      // accept/reject decision; never changes severity/verdict. Default on.
      providerPrecisionContext: z.boolean().optional(),
      // #7: before collectDiff snapshots the working tree, briefly wait (≤ ~1.5s) for
      // working-tree files to stop changing (a background build/codegen or a parallel
      // session may still be writing), so the panel reviews a quiescent snapshot.
      // Bounded and fail-safe: only delays a review, never skips it. Default on.
      settleBeforeReview: z.boolean().optional(),
      // #4: surface an advisory hint in pending.md when a false-positive class is
      // fragmenting across many FP-ledger entries on a file but not promoting to
      // auto-suppression — recommending a house rule (the durable fix). Render-only;
      // never suppresses a finding. Default on. (No-op unless the FP-ledger is enabled.)
      fpFragmentationHint: z.boolean().optional(),
    }),
    critic: z
      .object({ provider: ProviderId, model: z.string().optional(), persona: z.string() })
      .nullable()
      .default(null),
    triage: z
      .object({ provider: ProviderId, model: z.string().optional() })
      .nullable()
      .default(null),
    // S6 grounding layer 2 (LLM judge): demote a CRITICAL whose claim is not supported
    // by the actual code (a fabricated XSS sink, invented value). Demote-only,
    // fail-safe, opt-in. null = off.
    grounding: z
      .object({ provider: ProviderId, model: z.string().optional() })
      .nullable()
      .default(null),
    brain: z
      .object({
        enabled: z.boolean(),
        maxPromptTokens: z.number().int().positive().default(1500),
        curator: z
          .object({ provider: ProviderId, model: z.string().optional(), persona: z.string() })
          .optional(), // hybrid: optional LLM judge
        embeddings: z.object({
          provider: z.literal("openrouter"),
          model: z.string().default("baai/bge-base-en-v1.5"),
          apiKeyEnv: z.string().default("OPENROUTER_API_KEY"),
          // Optional OpenRouter upstream routing for the EMBEDDINGS model — separate
          // from providers.openrouter.openrouterProvider (which pins the REVIEWER's
          // model, e.g. deepseek for deepseek-v4; that upstream doesn't serve the
          // bge embedding model, so it must NOT be reused here). Default: auto-route.
          openrouterProvider: z
            .object({
              only: z.array(z.string()).optional(),
              order: z.array(z.string()).optional(),
              allowFallbacks: z.boolean().optional(),
            })
            .optional(),
        }),
        egressAllowlist: z.array(z.string()).default([]),
        curatorTimeoutMs: z.number().int().positive().default(20_000),
        crossRunCandidates: z
          .object({
            enabled: z.boolean().default(BRAIN_CROSS_RUN_DEFAULTS.enabled),
            ttlDays: z.number().int().positive().default(BRAIN_CROSS_RUN_DEFAULTS.ttlDays),
            maxEntries: z.number().int().positive().default(BRAIN_CROSS_RUN_DEFAULTS.maxEntries),
          })
          .optional()
          .default(BRAIN_CROSS_RUN_DEFAULTS),
      })
      .nullable()
      .default(null)
      .optional(),
    // M5 Part B1: FP-ledger (signature-keyed false-positive learning). Opt-in.
    fpLedger: z.object({ enabled: z.boolean() }).nullable().default(null).optional(),
    // P0 self-improving: write-only capture of demoted/dropped finding outcomes.
    // Default ON; cap bounds the NDJSON (oldest-drop). No verdict/behavior effect.
    implicitOutcomes: z
      .object({ enabled: z.boolean(), cap: z.number().int().positive().default(5000) })
      .nullable()
      .default({ enabled: true, cap: 5000 })
      .optional(),
    // Reviewer Reputation Slice 1: per-reviewer accuracy tracking. Default ON.
    reputation: z
      .object({
        enabled: z.boolean(),
        minSamples: z.number().int().nonnegative().default(8),
        trustFloor: z.number().min(0).max(1).default(0.35),
        halfLifeDays: z.number().positive().default(45),
        // Demote a lone unreliable reviewer's uncorroborated CORRECTNESS finding to
        // INFO (advisory). security is never softened. Default ON.
        demoteCorrectness: z.boolean().default(true),
        // Slice C: opt-in quarantine — below `floor` (hard, < trustFloor) skip the
        // reviewer entirely for the cycle. Default OFF (can suppress findings; see spec §4).
        quarantine: z
          .object({
            enabled: z.boolean().default(false),
            floor: z.number().min(0).max(1).default(0.15),
          })
          .default({ enabled: false, floor: 0.15 }),
      })
      .default({
        enabled: true,
        minSamples: 8,
        trustFloor: 0.35,
        halfLifeDays: 45,
        demoteCorrectness: true,
        quarantine: { enabled: false, floor: 0.15 },
      }),
    // Deterministic checker tier: commands run fail-fast BEFORE the LLM panel.
    // First non-zero exit (or timeout/error) blocks the turn and skips the panel.
    // Default off (null). See docs/superpowers/specs/2026-06-15-deterministic-checker-tier-design.md
    checks: z
      .object({
        commands: z
          .array(
            z.object({
              name: z.string().min(1),
              run: z.string().min(1),
              timeoutMs: z.number().int().positive().optional(),
              category: FindingCategory.optional(),
            }),
          )
          .min(1),
        defaultTimeoutMs: z.number().int().positive().optional(),
        outputCapBytes: z.number().int().positive().optional(),
      })
      .nullable()
      .default(null)
      .optional(),
    // M6: Context7 library-docs injection into the research phase. Opt-in.
    contextDocs: z
      .object({
        enabled: z.boolean(),
        apiKeyEnv: z.string().default("CONTEXT7_API_KEY"),
        host: z.string().default("context7.com"),
        budgetBytes: z.number().int().positive().default(8000),
        perLibBytes: z.number().int().positive().default(2500),
        maxLibs: z.number().int().positive().default(5),
        ttlDays: z.number().int().positive().default(30),
      })
      .nullable()
      .default(null)
      .optional(),
  }),
  cache: z
    .object({ enabled: z.boolean(), reviewTtlDays: z.number().int().positive() })
    .default({ enabled: true, reviewTtlDays: 7 }),
  research: z
    .object({ languages: z.array(z.string()) })
    .default({ languages: ["typescript", "tsx", "python"] }),
  notify: z.object({ desktop: z.boolean() }).default({ desktop: false }),
  loop: z.object({
    maxIterations: z.number().int().positive(),
    costCapUsd: z.number().nonnegative(),
    stuckThreshold: z.number().int().positive(),
    rejectRateEscalation: z.number().min(0).max(1),
    // Cross-iteration confirmed-FP streak: escalate once this many reviewer_was_wrong
    // rejects of REAL findings accumulate over a review cycle (catches a reviewer that
    // hallucinates a fresh FP each iteration, which the per-iteration reject-rate and
    // signature-keyed FP-ledger/stuck-detection all miss). 0 disables. Default 3.
    fpStreakThreshold: z.number().int().nonnegative().default(3),
    softPassPolicy: z.enum(["allow", "block", "ask-once"]),
    acknowledgePass: z.boolean().default(false),
    // Self-imposed deadline (ms) for a single gate run, strictly BELOW the
    // Stop-hook `timeout` in .claude/settings.json. If a review can't finish in
    // time the gate aborts the in-flight reviewers and FAILS CLOSED (blocks
    // "review did not complete — re-run") instead of being killed silently by
    // Claude Code — a killed Stop hook is non-blocking, so the turn would end
    // UN-reviewed (fail-open). Default 720_000 (12min): ≥120s under the default
    // 900s hook for pre-deadline setup (git/state load, OUTSIDE this deadline) +
    // teardown + state/audit writes (M-A0.4). Raise BOTH together when you raise
    // the hook timeout. 0 disables the deadline (legacy behavior).
    runTimeoutMs: z.number().int().nonnegative().default(720_000),
    // Slice 3 (field report #6): warn (stderr + pending.md banner) when the reviewed diff
    // is large enough to risk a self-deadline timeout. WARN-ONLY — never auto-raises
    // runTimeoutMs (that could exceed the OS Stop-hook timeout → fail-open). 0 disables a check.
    diffWarnBytes: z.number().int().nonnegative().default(600_000),
    diffWarnFiles: z.number().int().nonnegative().default(80),
    // Short cooldown (ms) for a reviewer that hit its OWN per-reviewer timeoutMs, so it
    // is pre-spawn-skipped next iteration instead of re-burning the full wall-clock
    // every turn (field report: claude-code 300s every iteration). 0 disables it
    // (timeouts stay immediately retryable). A gate self-deadline abort never triggers
    // it. Default 300_000 (5min).
    timeoutCooldownMs: z.number().int().nonnegative().default(300_000),
    // Max consecutive turns the gate may DEFER when no reviewer can complete a review
    // on a MIXED total outage (some quota, some timeout/error). The common transient
    // outage is covered elsewhere (all-quota defers uncapped; per-reviewer timeout cools
    // down + fails over), so this only governs the rarer mixed case. DEFAULT 3: the gate
    // defers up to N turns (allow-stop, keeps the dirty flag, never PASSes, audit-logged)
    // then escalates to the human. Was 0 (hard-block), but a hard block on a total outage
    // just re-fires every turn until Claude Code's stop-hook cap force-ends it UNREVIEWED
    // — no real security, only a block-loop (field evidence 2026-06-05). Set 0 to restore
    // the old hard-block.
    infraDeferMaxConsecutive: z.number().int().nonnegative().default(3),
    // #10: max consecutive turns to DEFER a give-up escalation (max-iterations /
    // stuck-signatures) while a configured reviewer is in cooldown (quota cap or
    // timeout/error backoff — see quotaDegradationNote), before escalating anyway.
    // Mirrors infraDeferMaxConsecutive. 0 disables the defer (escalate immediately
    // even when degraded — prior behavior).
    quotaDeferMaxConsecutive: z.number().int().nonnegative().default(3),
    // #5: escalate when a single BLOCKING finding's signature recurs across this many
    // consecutive reviewed iterations (a treadmill where one finding sticks while the
    // set churns — the whole-set stuckThreshold check misses it). Fail-safe (surfaces
    // to the human, never suppresses). 0 disables. The loop-driver clamps the effective
    // value to > stuckThreshold so a low mis-config can't make per-signature the eager trigger.
    maxSignatureRecurrence: z.number().int().nonnegative().default(3),
    // Rec #3 (deep half): the installed git pre-push hook WARNS (never blocks; exit 0) when the
    // commit being pushed has no recorded clean Reviewgate PASS — closing the "a clean turn-end
    // pass got pushed before a deep review" gap for push-to-deploy setups. The Stop-hook can't
    // gate a later push, so this is a fail-safe nudge; the hard guarantee belongs in CI (docs).
    // false → the installed hook no-ops. Default true.
    prePushWarn: z.boolean().default(true),
  }),
  sandbox: z.object({
    mode: z.enum(["strict", "permissive", "off"]),
    writablePaths: z.array(z.string()),
    deniedReads: z.array(z.string()),
  }),
  audit: z.object({
    retentionDays: z.number().int().positive(),
    compressAfterDays: z.number().int().positive(),
    remoteExporter: z.string().nullable(),
  }),
  output: z.object({
    pendingPath: z.string(),
    pendingJsonPath: z.string(),
  }),
  docReview: z
    .object({
      enabled: z.boolean(),
      globs: z.array(z.string()),
      persona: z.string(),
      referencedFilesBudgetBytes: z.number().int().positive().optional(),
    })
    .default({
      enabled: true,
      globs: ["docs/superpowers/specs/**", "docs/**/plan*.md", "docs/**/*spec*.md"],
      persona: "plan",
      referencedFilesBudgetBytes: 32_000,
    }),
  // Weekly report auto-snapshot-on-rollover. Opt-in.
  weeklyReport: z.object({ autoSnapshot: z.boolean() }).nullable().default(null).optional(),
});

export type ReviewgateConfig = z.infer<typeof ConfigSchema>;

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export function deepMerge<T>(base: T, override: DeepPartial<T>): T {
  const out = Array.isArray(base) ? [...(base as unknown[])] : { ...(base as object) };
  for (const k of Object.keys(override) as Array<keyof T>) {
    const v = override[k];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const baseVal = (base as Record<string, unknown>)[k as string];
      (out as Record<string, unknown>)[k as string] =
        baseVal != null && typeof baseVal === "object"
          ? deepMerge(baseVal, v as DeepPartial<unknown>)
          : v;
    } else if (v !== undefined) {
      (out as Record<string, unknown>)[k as string] = v as unknown;
    }
  }
  return out as T;
}

export function defineConfig(user: DeepPartial<ReviewgateConfig>): ReviewgateConfig {
  const merged = deepMerge(defaultConfig as ReviewgateConfig, user);
  return ConfigSchema.parse(merged);
}
