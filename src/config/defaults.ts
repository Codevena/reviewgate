export const defaultConfig = {
  version: 1 as const,
  providers: {
    codex: { enabled: true, auth: "oauth" as const, model: "gpt-5.4", timeoutMs: 300_000 },
    gemini: { enabled: false, auth: "oauth" as const, model: "gemini-3-pro", timeoutMs: 300_000 },
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
      model: "google/gemini-3.5-flash",
      timeoutMs: 300_000,
    },
  },
  phases: {
    review: {
      reviewers: [{ provider: "codex" as const, persona: "security" }],
    },
    critic: null as null | {
      provider: "codex" | "gemini" | "claude-code" | "openrouter";
      model?: string;
      persona: string;
    },
  },
  loop: {
    maxIterations: 3,
    costCapUsd: 1.5,
    stuckThreshold: 2,
    rejectRateEscalation: 0.8,
    softPassPolicy: "allow" as const,
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
};

export type ReviewgateConfig = typeof defaultConfig;
