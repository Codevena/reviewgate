// The zod ConfigSchema (define-config.ts) is the single source of truth for the
// config shape; `defaultConfig` must conform to it (`satisfies` below catches
// drift at compile time). Type-only import → erased at runtime, so the
// defaults ↔ define-config dependency stays one-directional (no value cycle).
import type { ReviewgateConfig } from "./define-config.ts";

export const defaultConfig = {
  version: 1 as const,
  providers: {
    codex: { enabled: true, auth: "oauth" as const, model: "gpt-5.5", timeoutMs: 300_000 },
    gemini: {
      enabled: false,
      auth: "oauth" as const,
      // Driven by the Antigravity CLI (`agy`); the provider id stays "gemini".
      // agy has no model-selection flag, so `model` is INFORMATIONAL ONLY
      // (recorded in audit/research, never passed to the CLI). Kept in the
      // schema to avoid a breaking config change. Update the string when a
      // newer Gemini tier becomes the de-facto default in agy.
      model: "gemini-3.5-flash",
      timeoutMs: 300_000,
    },
    "claude-code": {
      enabled: false,
      auth: "oauth" as const,
      model: "claude-sonnet-4-6",
      timeoutMs: 300_000,
    },
    openrouter: {
      enabled: false,
      auth: "openrouter" as const,
      apiKeyEnv: "OPENROUTER_API_KEY",
      // Production default OpenRouter model. Users override per project with any
      // slug from https://openrouter.ai/models (and choose OAuth vs OpenRouter
      // per provider). `flash` is ~6× cheaper than `-pro` and cheap on every
      // upstream, so the un-pinned default can't bleed money the way -pro did.
      model: "deepseek/deepseek-v4-flash",
      timeoutMs: 300_000,
      // NOTE: the upstream pin (openrouterProvider) is DELIBERATELY NOT set here.
      // defineConfig deep-merges defaults under the user config, so a default pin
      // would leak onto a user's overridden model (e.g. wizard "auto-route") and
      // mis-route it. The pin is MODEL-COUPLED, so it lives in the explicit configs
      // that also fix the model: the init scaffold + reviewgate.config.ts pin
      // `alibaba` (cheapest full-precision upstream for deepseek-v4-flash).
    },
    // opencode CLI; uses its own configured provider creds; model is provider/model format
    opencode: {
      enabled: false,
      auth: "oauth" as const,
      // "default" = use opencode's OWN configured default model (the recommended
      // way — e.g. a MiniMax Token Plan default). Set a real `provider/model` id
      // (from `opencode models`) only to force a specific model via -m.
      model: "default",
      timeoutMs: 300_000,
    },
  },
  phases: {
    review: {
      // Predefined quota-failover chain: if codex hits its usage cap, the gate
      // automatically re-runs the SAME review on gemini, then claude-code — both
      // OAuth ($0), so no surprise billing. Each only runs if its CLI is actually
      // available; append "openrouter" if you want a paid last resort.
      reviewers: [
        {
          provider: "codex" as const,
          persona: "security",
          fallback: ["gemini", "claude-code"] as ("gemini" | "claude-code")[],
        },
      ],
      fileContextBudgetBytes: 32_000,
      scopeToDiff: true,
      // Default: demote ALL out-of-diff findings to INFO. Add categories (e.g.
      // ["security","correctness"]) to keep genuine cross-file impact blocking.
      outOfDiffBlocking: [] as import("../schemas/finding.ts").FindingCategory[],
      // Uncorroborated findings a reviewer rated below this confidence are demoted
      // to INFO (advisory) — they no longer block as hard as confident ones.
      // CRITICAL security/correctness and corroborated findings stay blocking. Set
      // 0 to disable. 0.6 (S0): with a single reviewer NOTHING is ever corroborated,
      // so this floor is the only live noise brake — a low value let every lone
      // sub-0.6 nitpick block (field report 2026-06-03).
      confidenceFloor: 0.6,
      // Maintainer-authored repo facts injected as trusted reviewer context (e.g. "this repo
      // uses hex color tokens, not HSL"). Default none — set per repo in reviewgate.config.ts.
      houseRules: [] as string[],
      // N5: imported-collaborator context — OFF by default (cost/prompt size). Enable
      // per repo (`collaboratorContext: { enabled: true }`) so reviewers can verify a
      // premise about an unchanged imported file instead of guessing.
      collaboratorContext: null as null | {
        enabled: boolean;
        maxBytes?: number;
        maxFiles?: number;
      },
    },
    critic: null as null | {
      provider: "codex" | "gemini" | "claude-code" | "openrouter" | "opencode";
      model?: string;
      persona: string;
    },
    triage: null as null | {
      provider: "codex" | "gemini" | "claude-code" | "openrouter" | "opencode";
      model?: string;
    },
    // S6 grounding layer 2 (LLM judge) — default OFF (opt-in). Enable with a cheap
    // provider (e.g. openrouter/deepseek-v4-flash) to demote fabricated CRITICALs.
    grounding: null as null | {
      provider: "codex" | "gemini" | "claude-code" | "openrouter" | "opencode";
      model?: string;
    },
    brain: null as null | {
      enabled: boolean;
      maxPromptTokens: number;
      curator?: {
        provider: "codex" | "gemini" | "claude-code" | "openrouter" | "opencode";
        model?: string;
        persona: string;
      };
      embeddings: {
        provider: "openrouter";
        model: string;
        apiKeyEnv: string;
      };
      egressAllowlist: string[];
      curatorTimeoutMs: number;
      crossRunCandidates: {
        enabled: boolean;
        ttlDays: number;
        maxEntries: number;
      };
    },
    reputation: {
      enabled: true,
      minSamples: 8,
      trustFloor: 0.35,
      halfLifeDays: 45,
      demoteCorrectness: true,
      quarantine: { enabled: false, floor: 0.15 },
    },
    implicitOutcomes: { enabled: true, cap: 5000 },
  },
  cache: { enabled: true, reviewTtlDays: 7 },
  research: { languages: ["typescript", "tsx", "python"] },
  // Completion signal: the gate always writes a one-line summary to stderr; set
  // notify.desktop=true to also fire a macOS/Linux desktop notification when a
  // review finishes (so "green" isn't silent).
  notify: { desktop: false },
  loop: {
    maxIterations: 3,
    costCapUsd: 1.5,
    stuckThreshold: 2,
    rejectRateEscalation: 0.8,
    fpStreakThreshold: 3,
    softPassPolicy: "allow" as const,
    // When true, the gate blocks ONCE on a passing verdict so the agent is told
    // the review passed (the Stop hook can't reach the agent on a silent
    // allow_stop). Costs one extra turn per pass. Default off.
    acknowledgePass: false,
    // Self-imposed run deadline (ms), strictly below the Stop-hook timeout. The
    // gate aborts + fails closed rather than being killed silently. See schema.
    // M-A0.4: lowered 840s→720s so the default leaves a ≥120s margin under the
    // 900s Stop-hook timeout for pre-deadline setup (config + git + state load,
    // which can run long under index.lock contention) + post-abort settle —
    // otherwise the OS kills the gate mid-run with empty stdout = fail-open.
    runTimeoutMs: 720_000,
  },
  sandbox: {
    // M1 default is 'off' because @anthropic-ai/sandbox-runtime is unpublished
    // at v1 and M1 cannot actually isolate the reviewer subprocess. 'off' is
    // honest: it runs the reviewer unisolated (acceptable for trusted local
    // dev). Setting 'strict'/'permissive' fails closed (Orchestrator refuses to
    // review) until sandbox-runtime support lands — never silently unisolated.
    mode: "off" as const,
    writablePaths: [".reviewgate/"],
    deniedReads: ["~/.ssh", "~/.aws", "~/.config", ".env*", "*.pem", "*.key"],
  },
  audit: {
    retentionDays: 180,
    compressAfterDays: 30,
    remoteExporter: null as string | null,
  },
  output: {
    pendingPath: ".reviewgate/pending.md",
    pendingJsonPath: ".reviewgate/pending.json",
  },
  // Plan/spec review — default ON, but SCOPED to plan/spec globs only (NOT every
  // doc): a doc-ONLY diff whose files match `globs` is reviewed with the `persona`
  // reviewer instead of skipped. So specs/plans get gated before code is written,
  // while trivial README/comment edits still skip at $0. Set enabled:false to opt
  // out. Glob matching uses Bun.Glob, repo-relative.
  docReview: {
    enabled: true,
    globs: ["docs/superpowers/specs/**", "docs/**/plan*.md", "docs/**/*spec*.md"],
    persona: "plan",
    referencedFilesBudgetBytes: 32_000,
  },
  weeklyReport: null as null | { autoSnapshot: boolean },
} satisfies ReviewgateConfig;
