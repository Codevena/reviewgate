# Architecture

This document explains how Reviewgate is put together. For usage see the
[README](../README.md); for the agent-facing protocol see [`AGENTS.md`](AGENTS.md).

## The big picture

Reviewgate is not a server and not a daemon. It is a CLI binary that Claude Code
or Codex **hooks** invoke at specific points in the agent loop. All state is plain
JSON/Markdown files under `.reviewgate/` — no database, no SQLite, no Redis.

```
┌──────────────────── Claude Code or Codex (host) ──────────────────────────┐
│  Edit / Write / MultiEdit                                                   │
│        │                                                                    │
│        ▼  PostToolUse hook                                                  │
│  reviewgate gate --hook trigger  ──►  marks .reviewgate/dirty.flag          │
│                                                                             │
│  …agent finishes its turn…                                                  │
│        │                                                                    │
│        ▼  Stop hook                                                         │
│  reviewgate gate --hook stop  ──►  LoopDriver.run() → Orchestrator          │
│        │                                                                    │
│        ├─ no dirty flag ─────────────────────────────────────► allow stop  │
│        ├─ PASS / SOFT-PASS ──────────────────────────────────► allow stop  │
│        ├─ FAIL ──► write pending.md/json, BLOCK the turn                    │
│        │           agent reads pending.md, fixes or rejects each finding,   │
│        │           appends decisions/<iter>.jsonl, stops again → re-review  │
│        └─ max iters / stuck / cost cap ──► ESCALATION.md, allow stop        │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Control flow

The entire pipeline is driven by hooks calling
`reviewgate gate --hook <trigger|stop|reset>` (`src/cli/commands/gate.ts`):

- **`trigger`** (PostToolUse) — just marks `.reviewgate/dirty.flag`. Cheap; runs
  after every edit.
- **`reset`** (SessionStart) — wipes per-session state. The same logic is exposed to humans/agents as the top-level `reviewgate reset` command (`src/cli/commands/reset.ts` → `handleReset`), used to re-arm an escalated gate.
- **`stop`** (Stop) — the real work: `LoopDriver.run()` → `Orchestrator.runIteration()`.

### LoopDriver (`src/core/loop-driver.ts`)

Decides **allow-stop vs. block**:

- No dirty flag → allow stop (nothing changed since the last pass).
- Otherwise it gates on the previous iteration's decisions
  (`.reviewgate/decisions/<iter>.jsonl` must address every finding id from
  `pending.json`), advances `iteration` toward the cap, and emits
  `ESCALATION.md` on max-iterations / stuck-signatures / cost-cap /
  high-reject-rate.
- It deliberately does **not** short-circuit on `stop_hook_active` — the
  FAIL → fix → re-review loop must run in-chain.
- It re-arms the budget on a clean PASS or a commit.

### Orchestrator (`src/core/orchestrator.ts`)

`runIteration()` is the pipeline:

```
triage → cache check → research → reviewer panel → critic → aggregate → write report
```

## Module map

| Area | Responsibility |
|---|---|
| **`src/diff/`** + `src/utils/git.ts` | `collectDiff` returns the diff since the **review base** (`git diff <base>` + untracked via `--no-index`), covering committed and uncommitted work since the batch started. `reviewgate.config.ts` is excluded from this normal reviewer diff but monitored by the separate config control plane; `.reviewgate/` runtime files are excluded. `sanitizer.ts` fences the untrusted diff and appends a persona reaffirmation. |
| **`src/triage/`** | `diff-facts.ts` classifies changed files (code/docs/tests/config/lockfile) and sensitivity tags; `matrix.ts` (`triageFromFacts`) maps facts → `RiskClass` + `runReview`. Doc-only / empty diffs are skipped unless `docReview` opts them back in. |
| **`src/providers/`** | One adapter per reviewer CLI (`codex.ts`, `gemini.ts`, `claude.ts`, `openrouter.ts`, `opencode.ts`, `ollama.ts`), all implementing `adapter-base.ts`. Most spawn the real CLIs via `src/utils/spawn.ts` (`spawnSafely`, which closes stdin — codex hangs otherwise); `openrouter.ts` and `ollama.ts` are subprocess-free HTTP adapters instead (`SUBPROCESSLESS_PROVIDERS` in `registry.ts`). `review-output.ts` holds the shared `REVIEW_OUTPUT_SCHEMA` and parses reviewer JSON into `Finding`s. |
| **`src/hosts/`** | Generates and merges native Claude Code and Codex lifecycle hooks. Codex commands resolve the Git root, preserve hook stdin, identify `REVIEWGATE_AGENT_HOST=codex`, and fail closed when the Stop shim is unavailable. Hook installation and Codex hash trust are intentionally separate states. |
| **`src/core/`** | `aggregator.ts` (severity-weighted verdict + dedup + consensus), `critic.ts` (demote-only adversarial pass), `report-writer.ts` (renders `pending.md`/`pending.json`), `state-store.ts` (locked, atomic `state.json`). |
| **`src/research/`** | `symbol-graph.ts` (tree-sitter, TS/Python `.wasm` grammars), `conventions.ts`, `research-writer.ts` produce `research.md`, injected as trusted context before the diff fence. |
| **`src/core/brain/`** | Per-repo memory ("Brain") + Curator. Default OFF. `fetcher.ts` is an SSRF-hardened `safeFetch`; the curator phase is non-blocking, timeout-bounded, and never changes the verdict. |
| **`src/config/`** | `reviewgate.config.ts` is parsed as data, never executed. `control-plane.ts` fingerprints source/effective policy separately, retains the last-known-good config, forces candidates through a special path, and requires a prior-policy pass plus TTY approval for weakening/non-monotonic changes. Invalid present configs block. The approved full config also participates in the review cache key. |
| **`src/schemas/`** | zod schemas are the source of truth for every persisted artifact (finding, triage, decision, pending-report, state, audit-event, research, brain). |

## The adaptive pipeline (stages before the panel)

1. **Triage** — classify the diff. Doc-only diffs get an automatic PASS at $0;
   sensitive paths (auth/crypto/payment/admin) get an expanded review budget.
2. **Cache check** — identical diff content hash → return the cached verdict
   without spawning any reviewer.
3. **Research** — build `research.md` (changed-file summary + tree-sitter symbol
   graph callers/callees + relevant brain entries) and inject it as trusted
   context ahead of the fenced, sanitised diff.
4. **Reviewer panel** — spawn the configured reviewer CLIs in parallel; each
   returns findings as strict-schema JSON.
5. **Critic** — a demote-only adversarial pass that can downgrade likely
   false-positives but never escalates severity or changes a PASS to a FAIL.
6. **Aggregate** — severity-weighted veto, cross-reviewer dedup, `confirmed_by`
   consensus tracking → final verdict.
7. **Write report** — render `pending.md` (human) + `pending.json` (machine).

## Verdicts

| Verdict | Meaning | Effect |
|---|---|---|
| **PASS** | No findings, or INFO only | allow stop |
| **SOFT-PASS** | Only WARN findings, singleton/minority, no CRITICAL | allow stop (default policy) |
| **FAIL** | A CRITICAL, or majority WARN | **block** until addressed |
| **ESCALATE** | Max iterations, stuck findings, or cost cap | writes `ESCALATION.md`, allow stop |
| **ERROR** | Reviewer could not run (crash/timeout/sandbox) | **block** (fail closed) |

Reviewgate **fails closed**: a reviewer that crashes or times out is never
treated as a pass, and zero successful reviewer runs yields `ERROR`, not `PASS`.

## Persistence layout

Everything lives under `.reviewgate/` as plain files:

| Path | Committed? | Purpose |
|---|---|---|
| `bin/{trigger,gate,reset}` | yes | tiny hook shims that call the binary |
| `personas/*.md` | yes | reviewer persona prompts (decorative this milestone — see note) |
| `pending.md` / `pending.json` | no | current iteration's findings |
| `decisions/<iter>.jsonl` | no | the agent's accept/reject ledger |
| `state.json` | no | loop FSM state |
| `cache/reviews/<key>.json` | no | per-diff cached verdicts |
| `audit/…` | no | sha256 hash-chained event log |
| `brain.{json,md}` | yes | committed per-repo memory (when Brain enabled) |
| `ESCALATION.md` | no | written when a run escalates to the human |

> **Note:** reviewer persona behaviour comes from the inline `PERSONA_REAFFIRM`
> map + prompt preamble in `orchestrator.ts`, **not** from reading
> `.reviewgate/personas/*.md` — those files are decorative in this milestone.

## Security posture

See [`SECURITY.md`](../SECURITY.md) for the full threat model. In short: diffs
are sanitised against prompt-injection before reaching reviewers, the host
session never reviews its own work, every run is recorded in a tamper-evident
audit log, and the gate does not label reviewer failure as PASS. The optional
Seatbelt/bubblewrap sandbox is a **denylist read model plus write isolation**, not
a read allowlist: known secrets are masked and writes are narrowed, but other host
files may remain readable. Network egress is not isolated and Linux cannot enforce
glob secret-denies, so prefer trusted repos. Provider execution risk differs: agy
and OpenCode are permission-bypassed coding-agent CLIs; see `SECURITY.md`.

### Codex activation boundary

`reviewgate init` owns installation, not Codex's trust decision. A generated
`.codex/hooks.json` is inert until Codex trusts the project layer and the user
reviews the exact current command-hook hash through `/hooks`. Codex skips a new
or changed hash until it is trusted again. Reviewgate Doctor can validate the
file, shims, timeouts and binary but cannot query the private per-hash trust state.

This is deliberate separation of duties: the repository installer and authoring
agent cannot be the authority that silently approves their own shell commands.
The generated hooks and the final fingerprint checks remain guardrails inside the
same user account, not a substitute for protected CI or another external boundary.
See [Codex host setup and hook trust](codex-host.md).
