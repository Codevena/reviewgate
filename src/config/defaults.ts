export const defaultConfig = {
  version: 1 as const,
  providers: {
    codex: { enabled: true, auth: "oauth" as const, model: "gpt-5.4", timeoutMs: 300_000 },
    gemini: {
      enabled: false,
      auth: "oauth" as const,
      // A FAST flash model by default: pro/reasoning tiers (e.g.
      // gemini-3-pro-preview) can take minutes per review. Set to any model your
      // `gemini` CLI account can access; an unknown id yields a ModelNotFoundError
      // and the reviewer errors out (reduced coverage). Verified working on
      // gemini CLI 0.40.1 — note `gemini-flash-latest` is NOT a valid id there.
      model: "gemini-3-flash-preview",
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
      reviewers: [{ provider: "codex" as const, persona: "security" }],
      fileContextBudgetBytes: 32_000,
      scopeToDiff: true,
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
    },
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
    softPassPolicy: "allow" as const,
    // When true, the gate blocks ONCE on a passing verdict so the agent is told
    // the review passed (the Stop hook can't reach the agent on a silent
    // allow_stop). Costs one extra turn per pass. Default off.
    acknowledgePass: false,
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
  // Optional plan/spec review. Default OFF = today's doc-skip behavior (no
  // change for existing repos). When enabled, a doc-ONLY working-tree diff whose
  // files match `globs` is reviewed with the `persona` reviewer instead of
  // skipped. Glob matching uses Bun.Glob, repo-relative.
  docReview: {
    enabled: false,
    globs: ["docs/superpowers/specs/**", "docs/**/plan*.md", "docs/**/*spec*.md"],
    persona: "plan",
  },
};

export type ReviewgateConfig = typeof defaultConfig;
