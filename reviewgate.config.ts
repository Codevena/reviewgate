// Reviewgate dogfoods itself. This config matches the shape that `reviewgate
// init` writes for new users (1 primary reviewer + fallback chain + brain +
// FP-ledger), so we're testing what we ship — not a bespoke superset.
//
// Single-primary on purpose: cross-run quorum (PR #35) is most interesting
// when each run is single-provider. The fallback chain (codex → gemini →
// claude-code → openrouter) gives the provider variation ACROSS runs that
// lets candidates from one run match a later run's proposal from a DIFFERENT
// provider and finally promote.
//
// Plain default-export object — NOT `defineConfig` from a bare "reviewgate"
// import — so the loader's deep-merge over defaults works.
export default {
  providers: {
    codex: { enabled: true, auth: "oauth", model: "gpt-5.4", timeoutMs: 300_000 },
    gemini: {
      enabled: true,
      auth: "oauth",
      model: "gemini-3-flash-preview",
      timeoutMs: 300_000,
    },
    "claude-code": {
      enabled: true,
      auth: "oauth",
      model: "claude-sonnet-4-6",
      timeoutMs: 300_000,
    },
    // openrouter powers the brain's embeddings (and is the paid last-resort
    // fallback in the reviewer chain). Needs OPENROUTER_API_KEY in env.
    openrouter: {
      enabled: true,
      auth: "openrouter",
      model: "deepseek/deepseek-v4-pro",
      apiKeyEnv: "OPENROUTER_API_KEY",
      timeoutMs: 300_000,
    },
    // opencode is reserved here as the independent brain curator (NOT a
    // reviewer) — keeps the LLM judge out of the panel it adjudicates.
    opencode: { enabled: true, auth: "oauth", model: "minimax-m2", timeoutMs: 300_000 },
  },
  phases: {
    review: {
      reviewers: [
        {
          provider: "codex",
          persona: "security",
          fallback: ["gemini", "claude-code", "openrouter"],
        },
      ],
    },
    // FP-ledger: learns which finding signatures you reject as false
    // positives and stops re-reporting them. Standalone.
    fpLedger: { enabled: true },
    // Brain: committed per-repo memory + cross-run quorum (PR #35). Cross-run
    // is on by default (TTL=60d, cap=5000) — no need to spell it out here.
    brain: {
      enabled: true,
      maxPromptTokens: 1500,
      embeddings: {
        provider: "openrouter",
        model: "baai/bge-base-en-v1.5",
        apiKeyEnv: "OPENROUTER_API_KEY",
      },
      egressAllowlist: [],
      curatorTimeoutMs: 60_000,
      // opencode = independent NON-reviewer LLM judge; keeps the curator
      // out of the same provider set whose proposals it judges.
      curator: { provider: "opencode", persona: "fp-filter" },
    },
  },
};
