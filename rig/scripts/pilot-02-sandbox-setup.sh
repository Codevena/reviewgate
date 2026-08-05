#!/usr/bin/env bash
# rig/scripts/pilot-02-sandbox-setup.sh
#
# Build the pilot-02 sandbox. Identical to pilot-01's (docs/superpowers/plans/
# 2026-07-29-longitudinal-effectiveness-rig.md Task 1 Steps 1-2, as actually executed) except
# for ONE added config block: phases.critic. That single delta is the whole experiment — see
# rig/preregistrations/pilot-02.json.
#
# $SB must be the PHYSICAL /private/tmp path, not /tmp: /tmp is a symlink on macOS and the
# cassette recorder's inside-the-repo check resolves paths before comparing them.
set -euo pipefail

RG="${RG:-$PWD/dist/reviewgate}"
SB="$(mktemp -d /private/tmp/rig-pilot02-XXXXXX)"
echo "sandbox: $SB"

cd "$SB"
git init -q .
git config user.email rig@example.invalid
git config user.name rig

printf 'export function add(a: number, b: number): number {\n  return a + b\n}\n' > src.ts
# The cassette lives INSIDE the repo under review (the recorder refuses anything else, and it
# refuses during the gate's SETUP phase). Ignoring it keeps it out of collectDiff, which
# includes untracked files — otherwise every turn would review the recording of itself.
printf 'cassette.jsonl\n' > .gitignore

# Plain default-export object literal: reviewgate DATA-PARSES this file and never imports or
# executes it, so no imports and no computed values.
cat > reviewgate.config.ts <<'CFG'
export default {
  providers: {
    codex: { enabled: false, auth: "oauth", model: "gpt-5.4-codex", timeoutMs: 300000 },
    gemini: { enabled: false, auth: "oauth", model: "gemini-3.5-flash", timeoutMs: 300000 },
    "claude-code": { enabled: false, auth: "oauth", model: "claude-sonnet-4-6", timeoutMs: 300000 },
    openrouter: {
      enabled: true,
      auth: "openrouter",
      apiKeyEnv: "OPENROUTER_API_KEY",
      model: "deepseek/deepseek-v3.2",
      timeoutMs: 300000,
      costPerMTokensUsd: 0.28,
    },
    opencode: { enabled: false, auth: "oauth", model: "default", timeoutMs: 300000 },
    ollama: {
      enabled: true,
      auth: "apikey",
      apiKeyEnv: "OLLAMA_API_KEY",
      model: "glm-5.2:cloud",
      timeoutMs: 300000,
      costPerMTokensUsd: 0,
      baseUrl: "http://localhost:11434/v1",
    },
  },
  phases: {
    review: {
      reviewers: [
        { provider: "openrouter", persona: "security" },
        { provider: "ollama", persona: "correctness" },
      ],
    },
    // THE ONE DELTA vs pilot-01. `model` is pinned rather than inherited on purpose: this
    // sandbox's providers.openrouter.model is deepseek-v3.2, which is ALSO panel reviewer #1,
    // so an inherited critic would be judging its own findings. The pin makes the critic
    // independent of every panel member AND makes it the exact model the +4.1pp precision /
    // -16.7pp clean-FP bench figures were measured with (bench/results/alpha12-v2/attempt-09).
    // No openrouterProvider upstream pin: phases.critic inherits it from providers.openrouter,
    // so pinning one would re-route the PANEL too — a second change. Registered as a deviation.
    critic: { provider: "openrouter", model: "deepseek/deepseek-v4-flash", persona: "fp-filter" },
    brain: {
      enabled: true,
      maxPromptTokens: 1500,
      embeddings: {
        provider: "openrouter",
        model: "baai/bge-base-en-v1.5",
        apiKeyEnv: "OPENROUTER_API_KEY",
      },
      egressAllowlist: [],
      curatorTimeoutMs: 20000,
    },
    fpLedger: { enabled: true },
  },
  loop: { runTimeoutMs: 600000 },
};
CFG

git add -A && git commit -qm "arm: seed + pilot panel config"

# Fully non-interactive. The config is present and committed BEFORE init, so init approves it
# as the control-plane baseline — no TTY approval is needed for the critic in this checkout.
"$RG" init --host claude </dev/null
git add -A && git commit -qm "arm: reviewgate init artifacts"

echo "$SB"
