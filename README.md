# Reviewgate

**A code-review gate that runs inside Claude Code's agent loop.**

When Claude Code edits files in a Reviewgate-initialised repo, Reviewgate spawns
a heterogeneous LLM reviewer panel as isolated subprocesses, aggregates their
findings under a severity-weighted veto, and **blocks Claude from ending its
turn** until every finding is either fixed or rejected-with-reason. Findings live
in files (`.reviewgate/pending.md`) that Claude reads with its normal Read tool —
no chat-stream parsing, no flaky stdout scraping.

Reviewers run the official provider CLIs (Codex, Gemini, Claude), so users on
Claude Pro/Max, ChatGPT Plus/Pro and Gemini Advanced pay **$0 per review** within
their subscription quotas (OAuth-first). OpenRouter reviewers use an API key and
can target any hosted model by name.

> **Status: M2 (Multi-Reviewer Panel).** Ships Codex + Gemini + Claude + OpenRouter
> reviewers, a parallel panel, an adversarial critic phase, and cost tracking.
> See [Scope & limitations](#scope--limitations).

---

## How it works

```
┌──────────────────────────── Claude Code (host) ────────────────────────────┐
│  Edit / Write / MultiEdit                                                   │
│        │                                                                    │
│        ▼  PostToolUse hook                                                  │
│  .reviewgate/bin/trigger  ──►  marks .reviewgate/dirty.flag                 │
│                                                                             │
│  …Claude finishes its turn…                                                 │
│        │                                                                    │
│        ▼  Stop hook                                                         │
│  .reviewgate/bin/gate  ──►  reviewgate gate --hook stop                     │
│        │                                                                    │
│        ├─ no changes since last pass ───────────────────────► allow stop   │
│        │                                                                    │
│        ▼  spawn Codex (sandboxed*) on `git diff HEAD`                       │
│  aggregate findings → verdict                                               │
│        │                                                                    │
│        ├─ PASS / SOFT-PASS ─────────────────────────────────► allow stop   │
│        ├─ FAIL ──► write pending.md/json, BLOCK Claude's turn               │
│        │           Claude reads pending.md, fixes or rejects each finding,  │
│        │           appends decisions/<iter>.jsonl, stops again → re-review  │
│        └─ max iterations / stuck / cost cap ──► ESCALATION.md, allow stop   │
└─────────────────────────────────────────────────────────────────────────────┘
```

\* Sandbox isolation requires `@anthropic-ai/sandbox-runtime`, which is not yet
published at v1. **M1 runs the reviewer unisolated** under the honest default
`sandbox.mode: "off"`; setting `"strict"`/`"permissive"` fails closed (refuses to
review) rather than silently running unisolated. See [Security](#security).

---

## Requirements

- [Bun](https://bun.sh) ≥ 1.0 (Node 20+ works for the compiled binary)
- [Codex CLI](https://github.com/openai/codex) ≥ 0.130, logged in (`codex login`)
- macOS or Linux (Windows: use WSL2)
- git

Check your environment at any time:

```bash
reviewgate doctor
```

---

## Install

```bash
git clone https://github.com/Codevena/reviewgate.git
cd reviewgate
bun install
bun run build          # produces ./dist/reviewgate (single binary)
```

Then, in the repo you want reviewed:

```bash
reviewgate init        # installs hooks into .claude/settings.json,
                       # copies .reviewgate/bin/{trigger,gate,reset},
                       # appends .gitignore, writes a starter reviewgate.config.ts
```

`init` is idempotent and merges into existing `.claude/settings.json` without
clobbering your other hooks.

---

## Quick start

1. `reviewgate init` in your project.
2. Use Claude Code as normal. After it edits files and tries to finish a turn,
   the Stop hook runs the review.
3. If Codex finds blocking issues, Claude is told to read `.reviewgate/pending.md`
   and address each finding — it cannot end the turn until it does.
4. You review the final diff and commit manually. Reviewgate never commits or
   edits code itself; it only reports.

You can also run the gate manually outside the loop:

```bash
reviewgate gate                      # review current `git diff HEAD`
reviewgate audit verify --file <jsonl>   # verify an audit-log hash chain
```

---

## Configuration — `reviewgate.config.ts`

Minimal single-reviewer setup (Codex only, OAuth, $0):

```ts
import { defineConfig } from "reviewgate";

export default defineConfig({
  providers: {
    codex: { enabled: true, auth: "oauth", model: "gpt-5.4", timeoutMs: 300_000 },
  },
  loop: {
    maxIterations: 3,        // escalate to the human after N failed review rounds
    costCapUsd: 1.5,         // only enforced in apikey/openrouter mode (OAuth = $0)
    softPassPolicy: "allow", // allow | block | ask-once for WARN-only verdicts
  },
  sandbox: {
    mode: "off",
  },
});
```

Multi-reviewer panel with an OpenRouter critic (M2):

```ts
import { defineConfig } from "reviewgate";

export default defineConfig({
  providers: {
    codex: { enabled: true, auth: "oauth", model: "gpt-5.4", timeoutMs: 300_000 },
    gemini: { enabled: true, auth: "oauth", model: "gemini-2.5-flash", timeoutMs: 300_000 },
    "claude-code": { enabled: true, auth: "oauth", model: "claude-sonnet-4-6", timeoutMs: 300_000 },
    openrouter: {
      enabled: true,
      auth: "openrouter",
      model: "deepseek/deepseek-v4-pro",   // ← any OpenRouter model slug (see below)
      apiKeyEnv: "OPENROUTER_API_KEY",
      costPerMTokensUsd: 0.075,            // optional; fed into loop costCapUsd tracking
      timeoutMs: 120_000,
    },
  },
  phases: {
    review: {
      reviewers: [
        { provider: "codex",       persona: "security" },
        { provider: "gemini",      persona: "security" },
        { provider: "claude-code", persona: "adversarial" },
        { provider: "openrouter",  persona: "security" },
      ],
    },
    critic: { provider: "openrouter", persona: "critic" },
  },
  loop: {
    maxIterations: 3,
    costCapUsd: 2.0,
    softPassPolicy: "allow",
  },
});
```

Anything you omit falls back to the defaults. The config is zod-validated.

### Choosing the OpenRouter model

The OpenRouter reviewer can target **any model OpenRouter hosts** — just set the
`model` field to its slug. Examples that work today:

```
deepseek/deepseek-v4-pro        deepseek/deepseek-v4-flash:free
google/gemini-2.0-flash-001     openai/gpt-4o-mini
anthropic/claude-sonnet-4.5     meta-llama/llama-3.3-70b-instruct
```

Browse and copy exact slugs from <https://openrouter.ai/models>. An invalid slug
returns a 404 (`ModelNotFoundError`) and the reviewer reports `status: error`
(fail-closed — never a silent pass). Set your key once in the shell:

```bash
export OPENROUTER_API_KEY=sk-or-...   # e.g. in ~/.zshrc
```

Reviewgate sends a strict JSON schema via OpenRouter's `response_format`; models
that ignore it are still recovered by the tolerant parser.

---

## Verdicts

| Verdict       | Meaning                                              | Effect            |
|---------------|------------------------------------------------------|-------------------|
| **PASS**      | No findings, or INFO only                            | allow stop        |
| **SOFT-PASS** | Only WARN findings, singleton/minority, no CRITICAL  | allow stop (default policy) |
| **FAIL**      | A CRITICAL (security/correctness), or majority WARN  | **block** until addressed |
| **ESCALATE**  | Max iterations, stuck findings, or cost cap hit      | writes `ESCALATION.md`, allow stop |
| **ERROR**     | Reviewer could not run (crash/timeout/sandbox)       | **block** (fail closed), eventually escalates |

Reviewgate **fails closed**: a reviewer that crashes or times out is never
treated as a pass.

---

## Security

- **Author ≠ reviewer.** The host Claude session never reviews its own work; the
  anti-sycophancy rule downgrades any Claude reviewer to a smaller tier (M2).
- **Diff sanitisation.** Diffs are run through a 6-layer pipeline (Unicode NFKC
  normalise → injection-marker neutralise → fenced wrap → high-entropy secret
  redaction → persona reaffirmation) before reaching the reviewer, to blunt
  prompt-injection planted in code.
- **Tamper-evident audit log.** Every run appends a sha256 hash-chained JSONL
  event log; `reviewgate audit verify` detects any modification.
- **Sandbox (partial in M1).** Full filesystem/network isolation needs
  `@anthropic-ai/sandbox-runtime` (unpublished at v1). Until then M1 runs the
  reviewer unisolated under the explicit `sandbox.mode: "off"`; other modes fail
  closed. Treat M1 as suitable for trusted local development, not untrusted diffs.

---

## What gets written to `.reviewgate/`

| Path                         | Committed? | Purpose                                  |
|------------------------------|-----------|-------------------------------------------|
| `bin/{trigger,gate,reset}`   | yes        | tiny hook shims that call the binary      |
| `personas/security.md`       | yes        | the reviewer's persona prompt             |
| `pending.md` / `pending.json`| no         | current iteration's findings (human + machine) |
| `decisions/<iter>.jsonl`     | no         | Claude's accept/reject ledger             |
| `state.json`                 | no         | loop FSM state                            |
| `audit/…`                    | no         | hash-chained event log                    |
| `ESCALATION.md`              | no         | written when a run escalates to the human |

---

## For AI agents

If you are an AI coding agent operating in a Reviewgate-enabled repo, read
[`docs/AGENTS.md`](docs/AGENTS.md) — it specifies exactly how to respond when
Reviewgate blocks your turn (read `pending.md`, fix or reject each finding, write
`decisions/<iter>.jsonl`).

---

## Scope & limitations

**In M1:** single Codex reviewer · Static + Review phases · single-iteration loop
with escalation (max-iterations / stuck-signatures / cost-cap) · severity-weighted
verdict · pending.md/json + decisions protocol · hash-chained audit log ·
`init` / `gate` / `doctor` / `audit verify` commands · OAuth ($0) cost model.

**In M2:** multi-reviewer panel (Codex + Gemini + Claude + OpenRouter any-model) ·
parallel panel execution · adversarial critic phase · `confirmed_by` consensus
tracking across reviewers · OpenRouter API-key cost tracking against `costCapUsd` ·
`google/gemini-3.5-flash` and any other OpenRouter model by slug.

**Not yet (M3–M6):** adaptive triage & research phase · symbol-graph via
tree-sitter · per-repo learning "brain" & curator · false-positive ledger ·
cassette replay & weekly reports · native sandbox isolation (pending
`@anthropic-ai/sandbox-runtime` v1).

---

## Development

```bash
bun test            # unit + integration (fake Codex stub)
bun run typecheck   # tsc --noEmit
bun run lint        # biome
bun run build       # compile single binary

REVIEWGATE_E2E=1 bun test tests/e2e   # real Codex end-to-end (uses your quota)
```

The design spec lives in `docs/superpowers/specs/`, the M1 implementation plan in
`docs/superpowers/plans/`, and spike findings in `docs/superpowers/spikes/`.
