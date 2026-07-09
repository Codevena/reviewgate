// Reviewgate dogfoods itself. This config matches the shape that `reviewgate
// init` writes for new users (1 primary reviewer + fallback chain + brain +
// FP-ledger), so we're testing what we ship — not a bespoke superset.
//
// CONSENSUS panel (codex + claude-code, both security): two strong independent
// reviewers so the FP-suppression machinery (consensus, FP-ledger ≥2-provider
// promotion, reputation cross-check) is actually exercised — all of it is INERT
// on a single reviewer. Decouples the gate from codex's flaky quota too (a codex
// cap degrades to gemini+claude, not codex-solo→nothing). openrouter is NOT a
// reviewer here (low-precision paid model; embeddings/grounding only).
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
    // glm-5.2:cloud as a 3rd consensus reviewer — dogfoods our own ollama provider.
    // LOCAL daemon (loopback → keyless): works in the Stop-hook's env regardless of whether
    // OLLAMA_API_KEY reaches it (a non-interactive spawn often doesn't source ~/.zshrc).
    // Needs `ollama serve` + `ollama signin`. Cloud-direct alt: drop baseUrl (needs the key IN the gate env).
    ollama: {
      enabled: true,
      auth: "apikey",
      apiKeyEnv: "OLLAMA_API_KEY",
      model: "glm-5.2:cloud",
      baseUrl: "http://localhost:11434/v1",
      timeoutMs: 300_000,
    },
  },
  phases: {
    review: {
      reviewers: [
        // CONSENSUS panel — two strong, INDEPENDENT reviewers (different vendors). A finding
        // BOTH raise is high-confidence; a LONE one is demotable, and the FP-ledger promotion
        // (≥2-provider floor) + reputation cross-check finally work (all inert on 1 reviewer).
        // Both OAuth/$0. Each falls to gemini under a quota cap so the panel stays size-2; they
        // do NOT fall to each other (a primary) or to openrouter (low-precision paid, embeddings
        // only). claude-code in slot 2 is NOT in codex's fallback to avoid a double-claude.
        { provider: "codex", persona: "security", fallback: ["gemini"] },
        { provider: "claude-code", persona: "security", fallback: ["gemini"] },
        // glm-5.2:cloud (Ollama Cloud, local daemon) — 3rd consensus voice, dogfoods the
        // ollama provider. $0 in-sub; errors fail-closed (panel drops to 2) if the daemon is down.
        { provider: "ollama", persona: "security" },
      ],
    },
    // FP-ledger: learns which finding signatures you reject as false
    // positives and stops re-reporting them. Standalone.
    fpLedger: { enabled: true },
    // Agent Lessons: the agent-facing twin of the FP-ledger. Collects the agent's
    // accepted+fixed findings (verified real mistakes) and injects the recurring ones
    // back at SessionStart as advisory context. Render-only, never verdict-affecting,
    // fail-safe, opt-in. Dogfooded here so this repo's gate feeds its own lessons back.
    agentLessons: { enabled: true },
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
