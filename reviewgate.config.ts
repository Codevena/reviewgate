// Reviewgate dogfoods itself. This config matches the shape that `reviewgate
// init` writes for new users (1 primary reviewer + fallback chain + brain +
// FP-ledger), so we're testing what we ship — not a bespoke superset.
//
// Single-primary on purpose: cross-run quorum (PR #35) is most interesting
// when each run is single-provider. The fallback chain (codex → gemini →
// claude-code) gives the provider variation ACROSS runs that lets candidates
// from one run match a later run's proposal from a DIFFERENT provider and
// finally promote. (openrouter is NOT in the chain — low-precision paid model;
// embeddings only.)
//
// Plain default-export object — NOT `defineConfig` from a bare "reviewgate"
// import — so the loader's deep-merge over defaults works.
export default {
  providers: {
    codex: { enabled: true, auth: "oauth", model: "gpt-5.5", timeoutMs: 300_000 },
    gemini: {
      enabled: true,
      auth: "oauth",
      model: "gemini-3.5-flash",
      timeoutMs: 300_000,
    },
    "claude-code": {
      enabled: true,
      auth: "oauth",
      model: "claude-sonnet-4-6",
      timeoutMs: 300_000,
    },
    // openrouter powers the brain's embeddings + grounding ONLY (NOT a reviewer
    // fallback — deepseek-flash is low-precision). Needs OPENROUTER_API_KEY in env.
    openrouter: {
      enabled: true,
      auth: "openrouter",
      model: "deepseek/deepseek-v4-flash",
      apiKeyEnv: "OPENROUTER_API_KEY",
      timeoutMs: 300_000,
      // Pin the upstream: WITHOUT this OpenRouter load-balances deepseek/* to an
      // arbitrary upstream — often the priciest (DigitalOcean/Baidu), ~13× alibaba.
      // `alibaba` = cheapest full-precision (non-fp8) upstream for deepseek-v4-flash
      // at full 1M ctx. Maps to OpenRouter's `provider: { only: ["alibaba"] }`.
      // MODEL-COUPLED: alibaba is cheap for -flash but EXPENSIVE for -pro.
      openrouterProvider: { only: ["alibaba"] },
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
          // openrouter (deepseek-flash) removed from the failover: it's a low-precision PAID
          // reviewer (~23% in this repo, 3 TP / 10 FP) and running it solo when codex is
          // quota-capped just pays for noise. The free OAuth chain covers failover; openrouter
          // stays enabled below for the brain's embeddings/grounding only.
          fallback: ["gemini", "claude-code"],
        },
      ],
    },
    // FP-ledger: learns which finding signatures you reject as false
    // positives and stops re-reporting them. Standalone.
    fpLedger: { enabled: true },
    // S6 grounding layer 2: an LLM judge demotes a CRITICAL whose claim is not supported
    // by the actual code (e.g. an invented XSS sink). openrouter = deepseek-v4-flash via
    // alibaba (cheap). Demote-only, fail-safe, CRITICAL-only.
    grounding: { provider: "openrouter" },
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
