# Reviewgate

**Reviewgate prevents AI coding agents from ending a turn until independent LLM
reviewers have checked the diff and every blocking finding is resolved.**

It runs *inside* Claude Code's agent loop. When Claude edits files in a
Reviewgate-initialised repo, a `Stop` hook spawns a heterogeneous LLM reviewer
panel (Codex · Gemini · Claude · OpenRouter) as subprocesses, aggregates their
findings under a severity-weighted veto, and **blocks Claude from ending its
turn** until every finding is either fixed or rejected-with-reason. Findings live
in files (`.reviewgate/pending.md`) that Claude reads with its normal Read tool —
no chat-stream parsing, no flaky stdout scraping.

Reviewers run the official provider CLIs, so users on Claude Pro/Max, ChatGPT
Plus/Pro and Gemini Advanced pay **$0 per review** within their subscription
quotas (OAuth-first). OpenRouter reviewers use an API key and can target any
hosted model by name.

> [!WARNING]
> **Alpha — trusted local development only.** Reviewgate runs provider CLIs on
> your working-tree diff *without sandbox isolation* (native isolation is pending
> an unpublished dependency). Use it on your own code, **not** on untrusted
> repositories or diffs. See [Security](#security).

<p align="center">
  <img src="docs/assets/demo.gif" alt="Reviewgate in action: Claude edits code, tries to finish, Reviewgate blocks on a CRITICAL finding, Claude fixes it, re-review passes." width="820">
</p>

> **Status: `0.1.0-alpha` (M1–M6 implemented).** Multi-reviewer panel
> (Codex + Gemini + Claude + OpenRouter) · parallel execution · adversarial critic ·
> adaptive triage · tree-sitter symbol graph · research context · review cache ·
> per-repo learning brain + curator · false-positive ledger · stats & weekly
> reports · interactive `setup` wizard. The one piece **not** done yet: native
> sandbox isolation. See [Scope & limitations](#scope--limitations).

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
published at v1. Reviewgate currently runs the reviewer **unisolated** under the
honest default `sandbox.mode: "off"`; setting `"strict"`/`"permissive"` fails
closed (refuses to review) rather than silently running unisolated. See
[Security](#security).

> 📐 For the full control flow, module map and pipeline stages, see
> [`docs/architecture.md`](docs/architecture.md).

---

## Requirements

- [Bun](https://bun.sh) ≥ 1.0 (Node 20+ works for the compiled binary)
- **At least one reviewer CLI**, installed and logged in:
  - [Codex CLI](https://github.com/openai/codex) ≥ 0.130 (`codex login`) — recommended default
  - [Gemini CLI](https://github.com/google-gemini/gemini-cli) (OAuth)
  - [Claude Code](https://claude.com/claude-code) (OAuth)
  - …or an [OpenRouter](https://openrouter.ai) API key for any hosted model
- macOS or Linux (Windows: use WSL2)
- git

You don't need all of them — one is enough to start. Check exactly which
reviewers are ready on your machine at any time:

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

Prefer to be walked through provider/model/quota choices? Run the interactive
wizard instead of hand-writing the config:

```bash
reviewgate setup       # interactive configuration wizard
```

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

`reviewgate.config.ts` is a **plain default-export object** (no import needed).
Reviewgate deep-merges it over the defaults and validates it. Do **not** write
`import { defineConfig } from "reviewgate"` — that package isn't installed in your
project, so the import would fail and Reviewgate would silently use defaults.

Minimal single-reviewer setup (Codex only, OAuth, $0):

```ts
export default {
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
};
```

Multi-reviewer panel with an OpenRouter critic:

```ts
export default {
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
};
```

Anything you omit falls back to the defaults. The config is zod-validated.

### Completion signal

A passing review used to be silent (the Stop hook just exits 0). Now the gate
always writes a one-line summary to **stderr** on completion — e.g.
`Reviewgate: DONE — Reviewgate PASS on iteration 1.` or `Reviewgate: BLOCK — …` —
so "green" is distinguishable from "the gate didn't run". Set `notify.desktop: true`
to also fire a macOS/Linux desktop notification when a review finishes:

```ts
export default {
  // ...providers, phases...
  notify: { desktop: true },   // osascript (macOS) / notify-send (Linux)
};
```

Note: by hook architecture, an AI agent can only be *interrupted* on a blocking
(FAIL) verdict — on PASS its turn simply ends. The stderr line and desktop
notification are the human-facing signal; an agent confirms a pass by reading
`.reviewgate/state.json` / `pending.md`.

If you want the **agent** to be told about a pass too, set
`loop: { acknowledgePass: true }`. Then a passing review blocks ONCE with a
`✅ Reviewgate PASS …` message so the agent can confirm the result to you, and
ends cleanly on the next stop (one extra turn per pass; default off).

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

## Adaptive pipeline (M3)

M3 adds four stages that run before the reviewer panel, making the gate faster
and more precise without changing any external protocols:

### Triage

Before spawning any reviewer, Reviewgate classifies the diff:

- **Doc-only diffs** (changes confined to Markdown, comments, or other
  non-executable files) are **skipped at $0** — they get an automatic PASS
  verdict without touching the reviewer panel.
- **Sensitive-path diffs** (auth, crypto, payment, admin) receive an expanded
  review budget (more iterations, higher cost cap).

### Research context

For every non-trivial diff Reviewgate builds a `research.md` context file and
injects it into each reviewer's prompt. The context includes:

- A summary of which files changed and why.
- **Symbol graph** callers/callees (see below).
- Any relevant entries from the per-repo learning brain (M4+).

Every reviewer reads this context, so findings reference stable symbol names
rather than raw line numbers.

### Tree-sitter symbol graph

Reviewgate uses `web-tree-sitter` + grammar WASM files to extract the call
graph around the changed symbols. Supported languages: TypeScript, TSX,
JavaScript, JSX, Python.

The symbol graph needs [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`)
to find callers efficiently. If `rg` is absent, the symbol graph degrades
gracefully (callers list is empty; reviews still run). If no grammar WASM can
be found the symbol graph is disabled entirely but reviews are unaffected.

Grammar WASM files are bundled into `dist/grammars/` by `bun run build` so the
compiled binary works without `node_modules`. Run `reviewgate doctor` to confirm
both `rg` and the grammars are available.

### Review cache

When the diff is byte-for-byte identical to a previous run (same content hash),
Reviewgate returns the cached verdict without spawning any reviewer. This makes
repeated stop-hooks instantaneous after a trivially clean re-run.

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
- **Sandbox (not yet isolated).** Full filesystem/network isolation needs
  `@anthropic-ai/sandbox-runtime` (unpublished at v1). Until then Reviewgate runs
  the reviewer unisolated under the explicit `sandbox.mode: "off"`; the
  `"strict"`/`"permissive"` modes fail closed. **Treat the current release as
  suitable for trusted local development only — not for reviewing untrusted
  repositories or diffs.**

See [`SECURITY.md`](SECURITY.md) for the full threat model and how to report a
vulnerability.

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

**In M3:** adaptive triage (doc-only diffs skip review at $0; sensitive paths get
expanded budget) · `research.md` context injected into every reviewer · tree-sitter
symbol graph (TS/JS/TSX/Python; needs ripgrep for callers; degrades gracefully) ·
review cache (identical diff → cached verdict, no reviewer spawn) · grammar WASM
bundled into `dist/grammars/` by `bun run build`.

**In M4:** per-repo learning brain & Curator (see [Brain & Curator (M4)](#brain--curator-m4) below) ·
`reviewgate brain list|show|revoke` CLI.

**In M5:** false-positive ledger (`reviewgate fp list|show|pin|unpin|audit` — known
FPs are demoted on future runs) · cassette record/replay for deterministic
provider testing · per-reviewer quota-failover chain.

**In M6:** review stats (`reviewgate stats`) · weekly Markdown reports
(`reviewgate report`) · one-shot plan/spec review (`reviewgate review-plan <file>`) ·
optional Context7 documentation context · interactive `reviewgate setup` wizard.

**Not yet:** native sandbox isolation (pending `@anthropic-ai/sandbox-runtime` v1) —
this is why the gate is positioned for trusted local development only. See
[Security](#security).

---

## Brain & Curator (M4)

The brain is a **committed per-repo memory** (`reviewgate.brain.json`,
`brain.md`, `sources.jsonl`, `archive.md` under `.reviewgate/brain/`). Every
reviewer reads the brain entries most relevant to the current diff and may
propose new facts. The **Curator** is a non-blocking background validator that
applies 7 acceptance rules (uniqueness, source authority, cross-provider
quorum, embedding dedup against existing entries, etc.) before anything enters
the brain; proposals that fail are discarded or archived, never silently
committed.

**Committed vs. gitignored:**

| Path | Committed? |
|---|---|
| `.reviewgate/brain/brain.json` | yes |
| `.reviewgate/brain/brain.md` | yes |
| `.reviewgate/brain/sources.jsonl` | yes |
| `.reviewgate/brain/archive.md` | yes |
| `.reviewgate/brain/proposals/` | no (gitignored) |
| `.reviewgate/brain/snapshots/` | no (gitignored) |

**Enable in `reviewgate.config.ts`:**

```ts
export default {
  // ...providers, phases...
  phases: {
    brain: {
      enabled: true,
      embeddings: {
        model: "baai/bge-base-en-v1.5",   // default; any sentence-transformers slug works
      },
      // optional: which provider runs Curator validation
      curator: { provider: "codex" },
      // optional: domains the brain may fetch sources from
      egressAllowlist: ["github.com", "docs.example.com"],
    },
  },
};
```

**CLI:**

```bash
reviewgate brain list          # list all committed brain entries
reviewgate brain show <id>     # show a single entry with metadata
reviewgate brain revoke <id>   # remove an entry (writes archive.md, re-commits)
```

---

## Development

```bash
bun test            # unit + integration (fake Codex stub)
bun run typecheck   # tsc --noEmit
bun run lint        # biome
bun run build       # compile single binary

REVIEWGATE_E2E=1 bun test tests/e2e   # real Codex end-to-end (uses your quota)
```

The design spec lives in `docs/superpowers/specs/`, the implementation plans in
`docs/superpowers/plans/`, and spike findings in `docs/superpowers/spikes/`.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a PR.

---

## Contributing

Bug reports, feedback, and small focused PRs are welcome — see
[`CONTRIBUTING.md`](CONTRIBUTING.md). For security issues, follow
[`SECURITY.md`](SECURITY.md) (do not file them publicly).

## License

[MIT](LICENSE) © Markus Wiesecke
