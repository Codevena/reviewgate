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
      // per provider). Verified end-to-end (CRITICAL timing finding, ~38s).
      model: "deepseek/deepseek-v4-pro",
      timeoutMs: 300_000,
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
      // 0 to disable.
      confidenceFloor: 0.3,
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
    runTimeoutMs: 840_000,
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
