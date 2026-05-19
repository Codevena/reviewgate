# Reviewgate — Design Spec v1

| Field | Value |
|---|---|
| **Document** | docs/superpowers/specs/2026-05-20-reviewgate-design.md |
| **Date** | 2026-05-20 |
| **Status** | Draft — pending user approval |
| **Owner** | markus.wiesecke@gmail.com |
| **Scope** | v1 (Agent-Loop only; pre-commit, TUI, CI in v2) |
| **Schema-version of this doc** | reviewgate.spec.v1 |

---

## 1. Executive Summary

Reviewgate is a multi-agent code-review tool that runs **inside Claude Code's
agent loop**. After Claude Code edits files, Reviewgate is auto-invoked via
Claude Code hooks (`PostToolUse` + `Stop`), spawns several heterogeneous LLM
reviewers as isolated subprocesses (Codex, Gemini, Claude — fresh subprocess
only, never the host session), aggregates findings under a severity-weighted
veto rule, and blocks Claude's turn-end until the findings are addressed.
Reviewgate keeps a curated, per-repo "brain" of accepted conventions and
known false positives so every subsequent review is calibrated to this repo,
this team, this codebase.

The mechanism is provider-agnostic and respects subscription auth: users on
Claude Pro/Max, ChatGPT Plus/Pro and Gemini Advanced pay **zero per-token cost
within their subscription quota** because Reviewgate spawns the official
CLIs and lets them use their OAuth session.

---

## 2. Vision and Positioning

### 2.1 Market gap

The 2025–2026 AI code-review market is saturated with PR-time SaaS reviewers
(CodeRabbit, Greptile, Diamond, Vercel Agent) and an OSS wave of
manual-trigger multi-agent panels (claude-consensus, Mozilla Star Chamber,
agent-council, claude-octopus). None combines all five of:

1. **Auto-invoked from inside the coding agent's loop**
2. **Adaptive multi-phase pipeline with hard gates between phases**
3. **Heterogeneous multi-LLM quorum with severity-weighted veto**
4. **Per-repo curated learning brain shared across reviewers**
5. **OAuth-first cost model — $0 for subscription holders**

Reviewgate occupies that empty quadrant.

### 2.2 Differentiators (what Reviewgate uniquely does)

- **Pre-commit-gate as first-class citizen for AI agents.** CodeRabbit CLI is
  single-model; OSS pre-commit hooks are single-model. Reviewgate ties a
  cross-provider quorum to Claude Code's agent loop.
- **Research-Phase as a blocking step.** Reviewers see a structured
  `research.md` (diff facts + 1-hop symbol graph + repo conventions) before
  judging — no tool currently makes this explicit.
- **Adaptive phase selection by triage LLM.** Doc-only diffs skip review;
  security-sensitive diffs trigger expanded budget and a fourth reviewer.
- **Persona-diverse reviewers across providers.** Codex as security
  auditor, Gemini as architecture reviewer, Claude (fresh subprocess) as
  adversarial critic. Cross-provider plus cross-persona kills both
  provider blind spots and perspective blind spots.
- **Severity-weighted veto, not majority vote.** NeurIPS 2025 work shows
  majority vote fails when one reviewer is right and others miss.
- **Shared curated Brain.** A `.reviewgate/brain/brain.md` living document
  is built by a Curator-Agent from cross-model consensus and web-research,
  versioned in git, and re-injected into every future reviewer prompt.
- **OAuth-aware cost model.** Subscription holders pay nothing; API-key and
  OpenRouter users get a hard USD cap. No competitor matches that price.
- **Findings as files, not chat.** Every finding lands in a structured
  Markdown + JSON pair that Claude Code reads with the Read tool. No
  stdout-parsing fragility, no chat-style streaming.

### 2.3 Non-goals (v1)

- No human-facing TUI dashboard (v2).
- No pre-commit hook for non-Claude-Code users (v2).
- No CI integration / SARIF output (v2).
- No browser-based report viewer (v2).
- No telemetry to a hosted backend (always opt-in, off by default).
- No fine-tuning of any model — learning is in-context only (few-shot via
  Brain).
- No auto-fixing by Reviewgate itself — Reviewgate only reports; Claude Code
  fixes.

---

## 3. Personas and Use Cases

### 3.1 Primary Persona — Markus (the user)

- Senior engineer using Claude Code as primary coding interface.
- Has Claude Pro/Max, ChatGPT Plus, Gemini Advanced subscriptions.
- Wants drastically higher code quality without writing manual review prompts.
- Already runs a manual Codex×2 + Claude×2 pipeline (documented in his
  global CLAUDE.md) — Reviewgate productises this pattern.

### 3.2 Primary Use Case — Agent Self-Review Loop

```
1.  Markus: "Implement payment webhook signing in src/webhook.ts"
2.  Claude Code: Edits src/webhook.ts (and friends)
3.  PostToolUse hook fires (async) → marks .reviewgate/dirty.flag
4.  Claude Code completes its turn → Stop hook fires
5.  Reviewgate runs the adaptive pipeline:
       - Phase 0 Static (typecheck/lint/secrets) — pass
       - Phase 1 Triage — risk=high (payment-adjacent), phases=[sec,qual,arch]
       - Phase 2 Review parallel (Codex+Gemini+Claude-fresh)
       - Phase 3 Critic (Gemini Flash filters likely-FPs)
6.  Aggregator → Verdict FAIL (2 CRITICAL, 1 WARN)
7.  Stop hook emits {"decision":"block", reason:"...", additionalContext:"..."}
8.  Claude Code is forced to keep working: reads .reviewgate/pending.md,
    fixes each finding OR appends rejected-with-reason to decisions/2.jsonl
9.  Claude Code stops again → Stop hook re-fires → Reviewgate iter 2
10. Iter 2 PASS → allow_stop → Claude Code reports success to Markus
11. Markus reviews diff and commits manually
```

### 3.3 Secondary Use Case — Manual Invocation

`reviewgate gate` runs the same pipeline against staged or
range-specified changes; CLI prints a one-line verdict + path to
`.reviewgate/pending.md`. Used for spot-checks outside the agent loop.

---

## 4. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│ Claude Code (host process)                                          │
│   Edit / Write / MultiEdit tool call                                │
│                  │                                                  │
│   ┌──────────────▼──────────────────────────────────────┐           │
│   │ .claude/settings.json hooks  (Reviewgate installs)  │           │
│   │   PostToolUse (async, debounced) → bin/trigger      │           │
│   │   Stop        (blocking, gate)   → bin/gate         │           │
│   │   SessionStart                    → bin/reset       │           │
│   └─────────────────────────────────────────────────────┘           │
└──────────────────────┬──────────────────────────────────────────────┘
                       │ subprocess spawn
                       ▼
┌─────────────────────────────────────────────────────────────────────┐
│ reviewgate  (Bun-compiled single binary; Node 20+ fallback)         │
│                                                                     │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐            │
│  │ ConfigLoader│  │  StateStore  │  │  Brain + Ledgers │            │
│  │ .config.ts  │  │  state.json  │  │  brain.md / fp   │            │
│  └──────┬──────┘  └──────┬───────┘  └────────┬─────────┘            │
│         └──────────┬─────┴───────────────────┘                      │
│                    ▼                                                │
│            Orchestrator (loop FSM, caps, escalation)                │
│                    ▼                                                │
│            Adaptive Pipeline (P0 → P1 → P2(║) → P3 → P4 curator)    │
│                    ▼                                                │
│            Provider Adapter Registry                                │
│            codex │ gemini │ claude-code │ opencode                  │
│            spawn CLI → sandbox-runtime → parse JSON                 │
│                    ▼                                                │
│            FindingsAggregator (signature dedup, severity-veto)      │
│                    ▼                                                │
│            Report Writer (pending.md / pending.json / audit JSONL)  │
└─────────────────────────────────────────────────────────────────────┘
```

**Architectural axes:**
- **Process-spawn** for reviewers (not in-process SDK) — only way to use
  OAuth subscriptions, only way to wrap each reviewer in a sandbox.
- **Stateless engine + file-based state** — every invocation reads
  `state.json`, no daemon.
- **Bun + TypeScript** primary; compiles to a single binary via
  `bun build --compile`. Node 20+ fallback for users without Bun.

---

## 5. Detailed Design

### 5.1 Components

| Component | Responsibility |
|---|---|
| **ConfigLoader** | Loads `reviewgate.config.ts` via dynamic import; validates against zod schema; merges with defaults |
| **StateStore** | Reads/writes `.reviewgate/state.json`; provides locked-update primitive (flock); detects corruption + recovery |
| **Orchestrator** | Loop FSM driver; checks `stop_hook_active`, caps, escalation triggers; emits final Stop-hook JSON |
| **AdaptivePipeline** | Schedules phases 0–5 based on triage decision; enforces phase dependencies |
| **TriageEngine** | Phase 1 — deterministic diff analysis + single-LLM-call to classify risk and phase set |
| **PhaseRunner** | Generic phase executor; spawns parallel reviewers when phase allows; collects findings |
| **ProviderRegistry** | Maps provider IDs to ProviderAdapter implementations |
| **ProviderAdapter** | Per-provider CLI wrapper (codex, claude-code, gemini, opencode); spawn + sandbox + JSON parse + usage extraction |
| **SandboxManager** | Wraps provider invocations with `@anthropic-ai/sandbox-runtime` (Seatbelt/bubblewrap/JobObject) |
| **DiffSanitizer** | Strips prompt-injection markers from diff before reviewer ingestion; wraps in `<<UNTRUSTED_DIFF>>` |
| **FindingsAggregator** | Signature-dedup; severity-weighted veto; FP-Ledger filter; consensus calculation |
| **CriticPhase** | Final adversarial pass that may demote (not promote) findings |
| **BrainEngine** | Reads/writes `.reviewgate/brain/`; relevance-based prompt injection; curator validation |
| **Curator** | Separate LLM call that validates memory proposals before they enter brain.md |
| **FPLedger** | Per-repo known-false-positive store; lifecycle candidate→active→sticky |
| **AuditLogger** | Append-only JSONL with hash-chained tamper evidence; OpenTelemetry GenAI conventions |
| **ReportWriter** | Renders `pending.md` (for Claude) + `pending.json` (machine) + audit entry |
| **HookDriver scripts** | `.reviewgate/bin/{trigger,gate,reset}` — thin shell wrappers that invoke `reviewgate` binary |

### 5.2 Hook System and Loop-Control FSM

**Hook configuration installed by `reviewgate init`:**

```jsonc
// .claude/settings.json (merged, never overwritten)
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [{
          "type": "command",
          "command": "${CLAUDE_PROJECT_DIR}/.reviewgate/bin/trigger",
          "timeout": 5,
          "async": true,
          "statusMessage": "Reviewgate: analyzing…"
        }]
      }
    ],
    "Stop": [
      {
        "matcher": "*",
        "hooks": [{
          "type": "command",
          "command": "${CLAUDE_PROJECT_DIR}/.reviewgate/bin/gate",
          "timeout": 900
        }]
      }
    ],
    "SessionStart": [
      { "hooks": [{
          "type": "command",
          "command": "${CLAUDE_PROJECT_DIR}/.reviewgate/bin/reset"
      }] }
    ]
  }
}
```

**FSM (executed by `gate.sh` on every Stop):**

```
read state.json
if stop_hook_active == true: allow_stop
elif no dirty.flag since last PASS: allow_stop
else:
   run_review_iteration()
   case verdict:
     PASS:                       allow_stop
     FAIL and decisions/<n>.jsonl exists with all finding_ids addressed:
                                  iter++; run new review
     FAIL with missing decisions: BLOCK (emit decision-block JSON)
     ESCALATE (iter≥MAX | cost≥CAP | same-sig 2× | reject-rate≥80% × 2):
                                  allow_stop after writing ESCALATION.md
```

**Block-JSON emitted to Claude Code:**

```json
{
  "decision": "block",
  "reason": "Reviewgate FAIL — iteration N/MAX. Read .reviewgate/pending.md. Address each finding by either fixing the code OR appending to .reviewgate/decisions/<N>.jsonl with verdict=rejected and a written reason.",
  "hookSpecificOutput": {
    "hookEventName": "Stop",
    "additionalContext": "<top-3 findings, ≤8KB>"
  },
  "continue": true,
  "suppressOutput": false
}
```

**Anti-stuck heuristics:**

- iter ≥ MAX_ITER (default 3) → escalate
- cost ≥ COST_CAP (default $1.50; only when auth=apikey/openrouter) → escalate
- signature_history[-1] == signature_history[-2] → "no progress" → escalate
- Claude rejected ≥80% findings 2 iterations in a row → escalate
- Stop fires <5s after PASS → rate-limit, allow_stop

### 5.3 Adaptive Pipeline

**Phases:**

| # | Phase | Cost (OAuth) | Cost (API-key) | Typical Latency |
|---|---|---|---|---|
| 0 | Static Pre-Check (typecheck, lint, gitleaks) | $0 | $0 | 2–8 s |
| 1 | Research + Triage (deterministic + 1× cheap LLM) | $0 | ~$0.005 | 5–10 s |
| 2 | Review (parallel reviewers) | $0 | ~$0.20 | 40–60 s |
| 3 | Adversarial Critic | $0 | ~$0.03 | 10–15 s |
| 4 | Memory Curator (post-verdict, async; does **not** gate the loop) | $0 | ~$0.02 | 8–12 s |

A future Phase 3.5 (auto-fix suggestion) is reserved for v2 and is **not**
in scope for v1. The Curator runs as Phase 4 (after the gate decision is
already made) and never blocks Claude's loop — its work is observed only
on the next Reviewgate invocation when the updated brain.md is re-read.

**Triage decision matrix** (deterministic component, drives LLM prompt):

| Diff Profile | Phases Run | Reviewers | Budget Tier | Loop Cap |
|---|---|---|---|---|
| Doc-only (`*.md`, `*.txt`, `LICENSE`) | 0 | — | trivial | 1 |
| Tests only | 0, 1-light | Codex | minimal | 2 |
| Pure refactor (≤10 LOC, no imports changed) | 0, 1, 2-lite | Codex + Sonnet | standard | 3 |
| Default code change | 0, 1, 2, 3 | Codex + Gemini + Sonnet | standard | 3 |
| Sensitive paths (auth/, crypto/, *.sql, migrations/, payment/, *.env*) | 0, 1, 2-expanded, 3 | + OpenCode (4th) | expanded | 5 |
| `package.json` / `pnpm-lock.yaml` only | 0, 1, supply-chain-check | Codex + dep-audit | minimal | 2 |

LLMs **can read** the decision matrix but cannot upgrade their own budget;
only deterministic sensitivity tags trigger `expanded`.

**Research output** (`.reviewgate/research.md`, read by all reviewers):
- Diff facts: file list, LOC delta, sensitivity tags, file classification
- Git history: `git log -5` per changed file
- Symbol graph: 1-hop callers/callees via tree-sitter
- Project conventions: cached load of CLAUDE.md, README, ADRs, package.json scripts
- Triage decision JSON (risk_class, phases, personas, budget_tier, justification)

**Cache layer:**
```
.reviewgate/cache/
  research/<repo-sha>.json        TTL 24h
  symbol-graph/<file-sha>.json    TTL session
  reviews/<diff-sha>.json         TTL 7d
```

A cache hit on `reviews/<diff-sha>.json` returns the prior verdict without
spawning any reviewer.

### 5.4 Provider Adapters and Auth

**Adapter interface:**

```ts
interface ProviderAdapter {
  readonly id: 'codex' | 'claude-code' | 'gemini' | 'opencode';
  preflight(cfg: ProviderConfig): Promise<Preflight>;
  review(input: ReviewInput): Promise<ReviewResult>;
}
```

**Auth matrix:**

| Provider | OAuth ($0 within quota) | API key | OpenRouter |
|---|---|---|---|
| claude-code | ✅ `claude login` (Claude Pro/Max) | ✅ `ANTHROPIC_API_KEY` | ✅ via `--api-key-helper` proxy |
| codex | ✅ `codex login` (ChatGPT Plus/Pro) | ✅ `OPENAI_API_KEY` | ✅ via `--provider openrouter` |
| gemini | ✅ `gemini auth` (Gemini Advanced) | ✅ `GOOGLE_API_KEY` | ✅ via OpenRouter (gemini-3-pro) |
| opencode | ⚠ delegates | ✅ Models.dev keys | ✅ native primary |

**Config example:**

```ts
import { defineConfig } from 'reviewgate';

export default defineConfig({
  providers: {
    codex:         { enabled: true, auth: 'oauth', model: 'gpt-5.4' },
    'claude-code': { enabled: true, auth: 'oauth', model: 'claude-sonnet-4-6' },
    gemini:        { enabled: true, auth: 'oauth', model: 'gemini-3-pro' },
    opencode:      { enabled: false, auth: 'openrouter',
                     apiKeyEnv: 'OPENROUTER_API_KEY',
                     model: 'minimax/m2.7' },
  },
  phases: {
    review: {
      reviewers: [
        { provider: 'codex',         persona: 'security' },
        { provider: 'gemini',        persona: 'architecture' },
        { provider: 'claude-code',   persona: 'adversarial' },
      ],
    },
    critic: { provider: 'gemini', model: 'gemini-3-flash', persona: 'fp-filter' },
    triage: { provider: 'claude-code', model: 'claude-sonnet-4-6' },
  },
  loop:    { maxIterations: 3, costCapUsd: 1.5, stuckThreshold: 2 },
  sandbox: { mode: 'strict', writablePaths: ['.reviewgate/'] },
  brain:   { enabled: true, maxPromptTokens: 1500 },
});
```

**Concrete spawn commands** (always foreground; prompt always from file):

```bash
# Codex
codex exec --sandbox read-only --model gpt-5.4 --json \
  --output-last-message {findingsPath} \
  --output-schema {schemaPath} \
  --cd {workingDir} \
  "$(<{promptFile})"

# Claude Code (fresh subprocess always; never the host session)
claude --bare -p "$(<{promptFile})" \
  --model claude-sonnet-4-6 \
  --append-system-prompt "$(<{personaPromptFile})" \
  --allowedTools "Read,Grep,Glob" \
  --permission-mode dontAsk \
  --output-format json \
  --json-schema "$(<{schemaPath})"

# Gemini
gemini -p "$(<{promptFile})" \
  -m gemini-3-pro \
  --approval-mode plan \
  --include-directories "{workingDir}" \
  --output-format json

# OpenCode
opencode run "$(<{promptFile})" \
  -m openrouter/minimax-m2.7 \
  --dir {workingDir} \
  --format json
```

**Anti-sycophancy hard rules** (enforced by Orchestrator preflight):

1. Author ≠ Reviewer at the **session** level: if Claude Code is the
   host process (detected via env `CLAUDE_PROJECT_DIR` + process tree),
   any `claude-code` reviewer **must** use a different model tier than
   the host (Opus host → Sonnet reviewer; Sonnet host → Haiku reviewer;
   Haiku host → claude-code reviewer is **disabled** for this run, since
   no smaller tier exists — Codex/Gemini compensate).
2. Claude-code reviewer always runs with `--bare` (no CLAUDE.md load,
   no plugins, no MCP servers) — guaranteed fresh context.
3. Claude-code reviewer always gets `--append-system-prompt` with an
   adversarial persona file.
4. **DiffSanitizer** scrubs author cues from diff text before passing
   to any reviewer: `Co-Authored-By: Claude`, `Generated with Claude Code`,
   `// AI:`, `// claude:` comments, etc.

**Sandbox wrapping:**

```
macOS    → sandbox-exec with custom Seatbelt profile
Linux    → bubblewrap with --ro-bind / --bind / --unshare-net allowlist
Windows  → Job Object + AppContainer (v1 best-effort; warns on missing isolation)

Default profile per reviewer:
  fs.read:    workingDir
  fs.write:   findingsPath ONLY (single file, not a directory)
  fs.deny:    ~/.ssh ~/.aws ~/.config .env* *.pem *.key
  net.allow:  api.anthropic.com, api.openai.com,
              generativelanguage.googleapis.com,
              openrouter.ai, chatgpt.com (OAuth)
  net.deny:   everything else
  budget:     walltime=timeoutMs, max-tokens enforced via provider flag
```

### 5.5 Findings Schema and Aggregator

**Finding object** (zod-schema-validated):

```ts
interface Finding {
  id: string;
  signature: string;                      // sha1(file + normalized-line + rule_id)
  severity: 'CRITICAL' | 'WARN' | 'INFO';
  category: 'security' | 'correctness' | 'quality' | 'architecture'
          | 'performance' | 'testing' | 'docs';
  rule_id: string;                        // free-form but stable
  file: string;
  line_start: number;
  line_end: number;
  diff_hunk?: string;
  message: string;                        // ≤200 chars
  details: string;                        // ≤2000 chars
  suggested_fix?: string;
  reviewer: { provider; model; persona };
  confidence: number;                     // 0..1
  confirmed_by?: string[];                // populated by aggregator
  consensus: 'unanimous' | 'majority' | 'minority' | 'singleton';
  critic_verdict?: 'keep' | 'likely_fp';
  critic_reason?: string;
  fp_ledger_match?: {
    pattern_id; matched_count; suppressed;
  };
}
```

**Signature normalisation:** signature uses the surrounding-symbol name +
relative offset, not absolute line numbers — survives 3-line insertions.

**Severity-weighted veto:**

```
for each unique signature:
  flagged = count of reviewers reporting this signature
  if flagged == reviewers_total: consensus = unanimous
  elif flagged >= 2:             consensus = majority
  elif reviewers_total >= 3:     consensus = minority
  else:                          consensus = singleton

  if critic_verdict == 'likely_fp':
    if severity == 'CRITICAL' and category in {security, correctness}:
      KEEP (critic cannot veto critical-security)
    elif consensus == 'unanimous':
      KEEP (critic cannot veto unanimous panel)
    else:
      DEMOTE one level (CRITICAL→WARN, WARN→INFO, INFO→drop)

Verdict:
  any CRITICAL in {security, correctness}  → FAIL
  any CRITICAL elsewhere with majority      → FAIL
  any WARN with majority                     → FAIL
  only WARN singleton/minority + no CRIT     → SOFT-PASS
  only INFO                                  → PASS
  no findings                                → PASS
```

**Validation:** every finding is validated against actual file/line bounds
before aggregation; hallucinated files or out-of-bounds lines are dropped
and counted as `reviewer.hallucination_count`.

### 5.6 Brain (Shared Memory) and Curator

**Storage:**
```
.reviewgate/brain/                       committed
├── brain.md                             living doc
├── brain.json                           structured index
├── sources.jsonl                        provenance trail
└── proposals/                           gitignored
    ├── <run_id>.jsonl
    └── curator-decisions/<run_id>.jsonl
```

**Entry types:**

| Type | Scope | Example |
|---|---|---|
| `convention` | this-repo | "src/cart.ts null-guards are intentional Promise.all pattern" |
| `anti-pattern` | language-* | "TS `as` casts must become runtime guards for network data" |
| `external-knowledge` | framework-*, library-* | "Next.js 16 uses `use cache` directive; `unstable_cache` deprecated" |
| `disagreement` | n/a | "Codex flags pure-fn purity 3× more than Gemini — observability only" |
| `research-cache` | n/a | Cached web-fetch results for expensive lookups |

**Prompt injection (read path):**

- Per reviewer prompt, the BrainEngine selects up to `maxPromptTokens`
  (default 1500) of relevant **brain content** based on triage tags +
  file globs + category match. This is a budget on the injected brain
  excerpt only; the full reviewer prompt (diff, research.md, persona,
  instructions) is significantly larger.
- Priority order: conventions > anti-patterns > external-knowledge >
  research-cache > disagreement.
- Each entry is annotated with `[Source: ...]`; reviewers may contradict
  via a `contradicts_memory` field on their findings.

**Proposal (write path):**

- Each reviewer **may** emit `memory_proposals[]` alongside its findings.
- Proposals never enter brain.md directly.
- Phase 5 (Curator) runs AFTER the verdict is computed and does not block
  Claude Code's loop.
- Curator agent (a different model than any reviewer) validates each
  proposal against five hard rules:
  1. Schema-conform + all fields present.
  2. ≥ 2 independent sources OR 1 deterministic source (web-fetch with URL).
  3. Consistent with existing brain.md (no contradiction without explicit
     revision flag).
  4. Not duplicating existing entries (embedding-cosine threshold 0.85).
  5. Scope plausible (no `universal` from a single-language sample).
- Approved proposals enter brain.md with `status: candidate`,
  `referenced_count: 1`.
- After 3 references across ≥ 3 different reviewers, promoted to `active`.
- After 90 days without reference, decays to `stale` and drops from default
  prompt injection.
- After 180 more days stale, archived to `brain/archive.md`.

**Safety constraints:**

- No reviewer writes to brain.md directly.
- Confidence floor 0.5 — lower-confidence proposals are not even submitted.
- User veto: `reviewgate brain revoke <entry_id>` invalidates immediately.
- Contradiction check on promotion blocks conflicting entries until
  manual revision.
- Persona-bias detector: if any persona/reviewer produces >2× the median
  share of accepted proposals, flagged in `reviewgate stats`.

### 5.7 Audit, Replay, Learning

**Storage layout** (full):

```
.reviewgate/
├── audit/                              gitignored
│   ├── YYYY/MM/DD/<short-sha>.jsonl    one file per run
│   ├── YYYY/MM/DD/<short-sha>.meta.json
│   └── index.sqlite                    aggregate queries
├── cassettes/                          gitignored except golden/
│   ├── <run_id>/<reviewer>.prompt.txt
│   ├── <run_id>/<reviewer>.response.jsonl
│   └── golden/<name>/...               committed regression fixtures
├── learnings/                          committed
│   ├── known_fp.jsonl                  FP-Ledger
│   ├── valuable.jsonl                  positive few-shot candidates
│   └── conventions.md                  living doc (weekly regen)
├── brain/                              committed (see 5.6)
├── reports/                            gitignored
│   └── YYYY-Www.md                     weekly summaries
├── pending.md / pending.json           current iter
├── decisions/<iter>.jsonl              Claude's accept/reject ledger
├── state.json                          loop FSM state
├── research.md                         current iter triage output
├── dirty.flag                          touched by PostToolUse hook
└── .lock                               concurrent-session file lock
```

**Default `.gitignore` entries** appended by `reviewgate init`:

```
.reviewgate/audit/
.reviewgate/cassettes/
!.reviewgate/cassettes/golden/
.reviewgate/reports/
.reviewgate/pending.*
.reviewgate/decisions/
.reviewgate/state.json
.reviewgate/research.md
.reviewgate/dirty.flag
.reviewgate/.lock
.reviewgate/cache/
```

Committed: `learnings/`, `brain/` (except `proposals/`), `cassettes/golden/`,
`reviewgate.config.ts`.

**Audit event schema** (OpenTelemetry GenAI v1.38 semantic conventions,
JSONL with hash-chained tamper evidence):

```json
{
  "schema": "reviewgate.audit.v1",
  "ts": "2026-05-20T14:32:11.482Z",
  "run_id": "01HXQ2K8B3A7N5",
  "iter": 2,
  "event": "reviewer.complete",
  "git": { "sha", "branch", "dirty_files[]", "base", "ahead_by" },
  "trigger": "stop-hook" | "post-tool-use" | "manual",
  "reviewer": { "id", "role", "iter_attempt" },
  "gen_ai": {
    "provider.name", "request.model", "response.model",
    "operation.name", "request.temperature", "request.seed",
    "usage.input_tokens", "usage.output_tokens",
    "usage.cached_input_tokens", "response.finish_reasons[]"
  },
  "prompt_sha256", "response_sha256",
  "prompt_ref", "response_ref",                // paths into cassettes/
  "files_read[]",
  "latency_ms", "cost_usd", "auth_mode", "quota_used_pct",
  "exit_code",
  "finding_count", "finding_signatures[]",
  "verdict_contribution",
  "prev_event_hash", "this_event_hash"         // Merkle chain
}
```

**Event types:**
`session.start`, `run.start`, `phase.start`, `phase.complete`,
`reviewer.start`, `reviewer.complete`, `reviewer.error`,
`aggregator.complete`, `critic.complete`, `verdict.computed`,
`gate.decision`, `escalation`, `decision.applied`, `run.complete`,
`session.end`.

**Privacy:**
- Audit stores only hashes of prompts/responses.
- Raw text lives in `cassettes/` — gitignored, local only.
- `gitleaks` runs in Phase 0; detected secrets are replaced with placeholders
  before any reviewer sees the diff.
- Remote telemetry (opt-in) exports only hashes + counts + categories.
- `reviewgate scrub <run_id>` deletes cassettes, keeps audit trail.

**Replay:**

```bash
reviewgate replay <run_id>
# Rehydrates pending.md + pending.json from cassettes
# Re-runs aggregator + verdict on cassette data — no LLM calls
# Diffs against original verdict — drift logged as "provider drift detected"
```

**Learning loop v1 — single mechanism:**
- After each run, decisions/<iter>.jsonl is scanned.
- "accepted" findings with severity ≥ WARN → candidates for `valuable.jsonl`.
- "rejected with reviewer_was_wrong:true" → candidates for `known_fp.jsonl`.
- Weekly batch promotes top-K valuable per category into `conventions.md`,
  which is then auto-included in triage + reviewer prompts.

**FP-Ledger lifecycle:**

| Stage | Trigger | Effect |
|---|---|---|
| candidate | first reject with `reviewer_was_wrong:true` | logged, not applied |
| active | 3 rejects with same signature template | matching findings filtered pre-review; sent as negative few-shot |
| sticky | 5 rejects | bypasses auto-expire |
| auto-expire | 90 days no new match (candidate only) | removed |

**Safety against ledger poisoning:**
- ≥ 80% reject-rate for 2 consecutive iterations → stuck-loop, escalate.
- Curator cross-checks every new FP entry against existing brain entries
  for contradiction.

### 5.8 Error Handling and Edge Cases

**Per-component failure modes:**

| Component | Failure | Reaction |
|---|---|---|
| Provider CLI missing | `which X` not found | Reviewer disabled, others run, doctor shows install hint |
| Provider CLI not authed | auth-error response | Same + login hint |
| Provider CLI hang/timeout | walltime exceeded | kill -9 + 0-byte watchdog (60 s no-output); ERROR result; others run; aggregator treats as abstain |
| Provider CLI malformed JSON | parse failure | 1× retry with schema-reinforcement; then ERROR |
| Sandbox unavailable | bubblewrap missing | Warning + spawn unsandboxed; audit notes `sandbox: none` |
| Sandbox escape attempt | write outside whitelist | bubblewrap/Seatbelt blocks; `security.violation: true` in audit |
| Network down | DNS/conn refused | Provider bails fast; local providers continue |
| OAuth quota exhausted | 429 + `quota_used_pct: 100` | Reviewer marked quota-exhausted; if ≥ 2 reviewers alive → continue, else escalate |
| Cost cap hit (apikey/openrouter) | running cost ≥ cap | Active reviewer finishes (sunk cost); no new phase; verdict on partial data |
| Disk full | ENOSPC | allow-stop with ESCALATION; no auto-cleanup |
| Tree-sitter parse error | exotic file | Skip symbol-graph for that file |
| Concurrent runs | two Claude sessions in same repo | `flock .reviewgate/.lock`; second run waits 30 s then skips with notice |
| Git in transitional state | rebase/bisect/merge-conflict markers | Skip entire review, notice "git in transitional state" |
| Massive diff (>10 MB) | stdin caps | Diff to file, reviewer reads via Read tool; >50 MB → split per file, sequential |
| Binary files in diff | git "Binary files differ" | Skip for reviewers; LFS-pointer change becomes convention-finding |
| state.json corrupt | JSON.parse fails | Backup to `state.corrupt.json`; reinit; audit notes "recovered from corruption" |
| brain.md merge conflict | `<<<<<<<` markers | Skip brain-injection this run; `reviewgate brain resolve` helper |
| Reviewer hallucinates file/line | finding refs nonexistent loc | Drop finding; bump `reviewer.hallucination_count` |
| Reviewer wrong line ±5 | symbol fuzzy-match | Soft-correct; otherwise drop |
| Prompt injection in diff | `<system>...override</system>` in user code | DiffSanitizer escapes + wraps `<<UNTRUSTED_DIFF>>` |
| Claude Code crash mid-loop | hook never re-fires | Next `SessionStart` detects incomplete iter; audit notes `recovered_from: crash`; state reset |

**Edge cases with explicit test coverage:**

- Empty diff / whitespace-only diff
- Pure deletion diffs
- Renames (git rename detection)
- Submodule changes (deterministic skip)
- Generated files (.dist/, lockfiles) — via `.gitattributes` + `.reviewgateignore`
- First commit (no `HEAD~1`)
- Squash-merge after rebase → cache hit by diff-hash
- All sensitivity tags at once → expanded + max iter 5
- Adversarial persona never rejects → meta-metric warning
- All reviewers PASS but `findings_count > 0` → schema violation, ERROR
- Claude rejects 100% of findings 2 iter in a row → stuck-loop
- Cost cap hit mid-iteration → finish current, no new
- Contradictory findings on same line → critic arbitrates; if undecided → both WARN with `disagreement`
- brain.md grows >100 KB → trigger archive sweep
- OAuth quota header at 80% → injected into pending.md

### 5.9 Testing Strategy

**Layer 1 — Unit tests (~80 % of suite, bun test):**
- Aggregator: signature dedup, severity-veto matrix, FP-ledger application.
- FSM: every transition isolated.
- Triage decision tree: every sensitivity tag → expected phase set.
- DiffSanitizer: corpus of OWASP LLM-Top-10 prompt-injection payloads.
- Cost calculator per (provider × auth-mode).

**Layer 2 — Integration tests via cassette replay (~15 %):**
- Golden cassettes for 12 canonical scenarios:
  happy-path-3iter-pass, critical-security-fail, claude-rejects-fp,
  stuck-loop-escalation, cost-cap-hit, provider-down-degradation,
  massive-diff-handling, prompt-injection-in-diff,
  curator-accepts-proposal, curator-rejects-bogus,
  concurrent-session-lock, git-rebase-state-skip.
- Replay runs the full aggregator + verdict + brain logic against frozen data.

**Layer 3 — E2E with real CLIs (~5 %, opt-in):**
- Local: fixture repos under `e2e/fixtures/`.
- CI: smoke test with Codex + Gemini free tiers.
- Monthly cron: full re-run of golden cassettes with live LLMs → drift detection.

**Layer 4 — Property-based (fast-check):**
- FSM terminates within MAX_ITER + 1 Stop-calls for every legal sequence.
- Signature stability under +/- N-line context shift.

**Layer 5 — Adversarial / red-team suite:**
- Prompt-injection corpus must all wrap as `<<UNTRUSTED_DIFF>>`.
- Unicode-confusable file paths.
- Zip-bomb binaries (triage must detect and skip).

**Dogfooding:** Reviewgate's own repo runs Reviewgate with a different
provider combo than its default — prevents echo-chamber development.
Golden cassettes are regression fixtures in every PR.

---

## 6. Configuration Reference

`reviewgate.config.ts` — full default-resolved shape (typed via `defineConfig`):

```ts
import { defineConfig } from 'reviewgate';

export default defineConfig({
  version: 1,
  providers: {
    codex:         { enabled: true, auth: 'oauth', model: 'gpt-5.4',
                     reasoningEffort: 'medium', timeoutMs: 300_000 },
    'claude-code': { enabled: true, auth: 'oauth', model: 'claude-sonnet-4-6',
                     timeoutMs: 300_000 },
    gemini:        { enabled: true, auth: 'oauth', model: 'gemini-3-pro',
                     timeoutMs: 300_000 },
    opencode:      { enabled: false, auth: 'openrouter',
                     apiKeyEnv: 'OPENROUTER_API_KEY',
                     model: 'openrouter/minimax-m2.7',
                     timeoutMs: 300_000 },
  },
  phases: {
    triage: { provider: 'claude-code', model: 'claude-sonnet-4-6' },
    review: {
      reviewers: [
        { provider: 'codex',         persona: 'security' },
        { provider: 'gemini',        persona: 'architecture' },
        { provider: 'claude-code',   persona: 'adversarial' },
      ],
      personasPath: '.reviewgate/personas/',
    },
    critic: { provider: 'gemini', model: 'gemini-3-flash', persona: 'fp-filter' },
    curator: { provider: 'gemini', model: 'gemini-3-flash' },
  },
  loop: {
    maxIterations: 3,
    costCapUsd: 1.5,
    stuckThreshold: 2,
    rejectRateEscalation: 0.8,
  },
  sandbox: {
    mode: 'strict',           // 'strict' | 'permissive' | 'off'
    writablePaths: ['.reviewgate/'],
    deniedReads: ['~/.ssh', '~/.aws', '~/.config', '.env*', '*.pem', '*.key'],
  },
  brain: {
    enabled: true,
    maxPromptTokens: 1500,
    candidateToActiveThreshold: 3,
    staleAfterDays: 90,
    archiveAfterDays: 180,
  },
  audit: {
    retentionDays: 180,
    compressAfterDays: 30,
    remoteExporter: null,     // OTLP endpoint, optional
  },
  output: {
    pendingPath: '.reviewgate/pending.md',
    pendingJsonPath: '.reviewgate/pending.json',
  },
});
```

Personas live as Markdown files under `.reviewgate/personas/`:
- `security.md`, `architecture.md`, `adversarial.md`, `fp-filter.md`,
  `maintainability.md`, ...

Each persona file is the body of `--append-system-prompt` for that role.
Personas are committable Team-Wissen.

---

## 7. CLI Reference

```
reviewgate init [--mode=agent-loop]
                Install Claude Code hooks into .claude/settings.json
                + bootstrap files. Idempotent. Adds .reviewgate/ entries
                to .gitignore. v1 only supports --mode=agent-loop;
                lefthook/husky adapters are v2.

reviewgate gate [--range=<git-range>] [--reviewer=<id>...]
                Run the full pipeline manually. Default range: dirty + staged.

reviewgate run  (alias for gate)

reviewgate replay <run_id>
                Rehydrate audit + cassettes; re-compute verdict offline.

reviewgate stats [--week] [--json]
                Aggregate metrics over audit log.

reviewgate brain show [<type>]
                Print brain.md sections.

reviewgate brain revoke <entry_id>
                Invalidate a brain entry; append to sources.jsonl.

reviewgate brain resolve
                Helper for resolving brain.md merge conflicts.

reviewgate doctor
                Check Bun/Node version, provider CLIs, sandbox deps,
                plugin api-version match, OAuth login status.

reviewgate scrub <run_id> | --older-than=<days>
                Delete cassettes; keep audit hashes.

reviewgate schema export > reviewgate.schema.json
                Emit JSON schema for IDE autocomplete.

reviewgate audit verify [<run_id>]
                Verify Merkle hash chain.

reviewgate migrate
                Codemod config from previous version.
```

---

## 8. Security Model

**Threat model assets:**
- Source code (highest sensitivity)
- API keys / OAuth tokens
- Audit trail integrity
- Brain.md content (potential trust amplifier)

**Threats addressed:**

| Threat | Mitigation |
|---|---|
| Prompt injection in diff | DiffSanitizer + `<<UNTRUSTED_DIFF>>` wrap + "treat as untrusted" preamble |
| Reviewer modifies code | Sandbox `fs.write` restricted to findings path only |
| Reviewer exfiltrates secrets | Sandbox `fs.deny` on `.env*`, `.ssh`, `.aws`; net.allow only LLM endpoints |
| Reviewer reads private files | Same fs.deny list |
| Cost runaway | Hard USD cap (apikey/openrouter); iter cap; stuck-loop detection |
| Audit tampering | Merkle hash chain; `audit verify` |
| Brain poisoning | Curator validation; multi-source rule; user-veto; persona-bias detection |
| Concurrent-session corruption | flock on `.reviewgate/.lock` |
| Provider supply-chain attack on CLI | We can't fix this directly; doctor verifies signed CLI binaries where possible (Codex via npm; Claude via Anthropic install script) |
| Plugin supply-chain attack (v2) | Plugins also sandboxed; signed manifests via Sigstore (v2 roadmap) |

**Hard rules:**
- Reviewer subprocesses never get the host Claude Code session's env.
- `--dangerously-skip-permissions` requires explicit per-provider opt-in
  with prominent doctor warning.
- Author and Reviewer must be different sessions; if author is claude-code,
  reviewer must be claude --bare with a different model tier.

---

## 9. Cost Model

**OAuth mode** (Claude Pro/Max + ChatGPT Plus/Pro + Gemini Advanced):
- USD cost: $0 within subscription quotas.
- Tracking: `quota_used_pct` from each provider's response headers.
- Warning at 80 % consumed (per provider).
- Hard cap: iteration count only (default 3).

**API-key mode:**
- USD cost: computed from `usage.{input,output,cached_input,reasoning_output}_tokens` × per-model price table.
- Hard cap: `loop.costCapUsd` (default $1.50).
- Per-iter typical: $0.20–0.35 standard, $0.45–0.60 expanded.

**OpenRouter mode:**
- USD cost: from OpenRouter response `usage.cost` (exact).
- Same hard cap as API-key mode.

**Key handling (apikey + openrouter modes):**
- For each provider, `apiKeyEnv` in config defines which env var the
  adapter reads. Default fallbacks per provider:
  - `claude-code` apikey → `ANTHROPIC_API_KEY`
  - `codex` apikey → `OPENAI_API_KEY`
  - `gemini` apikey → `GOOGLE_API_KEY`
  - any provider openrouter → `OPENROUTER_API_KEY`
- Keys are **never** persisted by Reviewgate. They are read from process
  env or from `.env.reviewgate` (gitignored, auto-loaded by adapter).

Reviewgate **never** charges directly. There is no payment integration.

---

## 10. Anti-Patterns Explicitly Avoided

1. **Echo-chamber reviewers** (3× the same model). Enforced via
   different-provider requirement in default config.
2. **Multi-agent debate for everything.** Debate only happens in
   adversarial-critic phase, not as default reasoning mode.
3. **Self-review by the host Claude session.** Anti-sycophancy hard rule.
4. **Findings to stdout.** Findings are always files.
5. **Sycophancy in sequential review.** Reviewers in Phase 2 are blind to
   each other; only the critic in Phase 3 sees all findings.
6. **No-timeout reviewers.** Watchdog kills 0-byte-output after 60 s; hard
   walltime per provider.
7. **Volle RAG / vector index per commit.** Brain is curated, not retrieved.
8. **Reviewers as auto-fixers.** Reviewgate only reports; Claude Code fixes.
9. **Gate without override path.** Stuck-loop escalation surfaces to user.
10. **Background `codex exec`.** Always foreground; prompts always from file.

---

## 11. v1 Scope vs v2 Roadmap

### v1 (this spec)

- Agent-loop invocation via Claude Code hooks (PostToolUse + Stop).
- Adaptive 4-phase pipeline (Static → Triage → Review → Critic) + Curator.
- 4 provider adapters (Codex, Claude Code, Gemini, OpenCode).
- OAuth + API-key + OpenRouter auth per provider.
- Sandbox via `@anthropic-ai/sandbox-runtime`.
- Severity-weighted veto aggregator.
- Brain + Curator with safety constraints.
- FP-Ledger + valuable findings learning loop.
- Hash-chained audit log + cassette replay.
- `reviewgate.config.ts` + CLI.

### v2 (roadmap, not in this spec)

- Pre-commit hook for non-Claude users (Lefthook adapter).
- Ink-based TUI dashboard for humans running `reviewgate gate` manually.
- SARIF + GitHub Annotations + JUnit-XML output for CI.
- Auto-fix phase (Phase 4) for deterministic INFO/WARN findings.
- Cross-repo learning (opt-in telemetry feeds anonymised patterns to brain).
- Plugin system for custom phases (`@reviewgate/plugin-*`).
- WASM plugin runtime.
- Web report renderer (`reviewgate report --html`).
- Local Ollama provider for offline use.
- Multi-tenant brain (workspaces / org-level shared learnings).
- VSCode extension surfacing pending.md inline.

---

## 12. Open Questions / Risks

| # | Question / Risk | Resolution Plan |
|---|---|---|
| Q1 | How exactly does Claude Code's `stop_hook_active` flag behave across nested Stop hooks? | Validate empirically in spike; fall back to our own iteration counter if flag unreliable |
| Q2 | Does `claude --bare` reliably skip CLAUDE.md when invoked from inside a CLAUDE.md-aware project? | Spike + add `--cwd=/tmp/reviewgate-isolated/` if needed |
| Q3 | Codex `--output-schema` reliability with complex zod-derived JSON schemas | Spike; if unreliable, fall back to free-form Markdown findings + post-parse |
| Q4 | Gemini `--approval-mode plan` is documented as in-development; how strict is it in practice? | Belt-and-suspenders: bubblewrap + plan mode together; doctor warns if plan-mode flag is missing |
| R1 | Bun's single-binary `--compile` size (~50–80 MB) may concern users on metered connections | Offer Node-runtime path via npm install as alternative |
| R2 | OAuth-session leakage across reviewers (a reviewer accidentally inheriting host's tokens) | Explicit env-scrub in adapter; subprocess gets only the env keys we set |
| R3 | Curator agent itself hallucinating "valid" memory entries | Multi-source rule + persona-bias detection + user-veto + cap entries per run (e.g. max 3 brain promotions per run) |
| R4 | Adversarial persona becoming sycophantic over many iterations | Meta-metric: if adversarial-persona reject-suggestion-rate drops <10 % over 30 days, alert in `reviewgate stats` |
| R5 | Brain.md merge conflicts in active team use | Section-level CRDT? v1: plain merge + `reviewgate brain resolve` helper; reconsider in v2 |
| R6 | `stuck-loop` may trigger false-positive when Claude legitimately fixes the same file twice in different ways | Signature is symbol-relative, not file-line; if symbol changes, signature changes; should be fine but needs e2e validation |
| R7 | Cost overrun for users who don't realise they're in API-key mode | Doctor + first-run wizard explicitly asks for auth mode; cost cap default 1.50 USD is conservative |
| R8 | What if a provider deprecates a CLI flag we depend on? | Provider-adapter capability matrix in doctor; integration tests run against each CLI on cron schedule |

---

## 13. Success Criteria for v1

A `reviewgate init` in a fresh project followed by a Claude Code session
that edits files results in:

1. Reviewgate auto-invoked at the end of Claude's turn.
2. At least two reviewers ran (Codex + Gemini if OAuth; configurable).
3. A `.reviewgate/pending.md` was written with structured findings.
4. If FAIL: Claude Code is forced to address findings before stopping.
5. If `stuck-loop` or `escalation`: Claude Code reports to Markus.
6. No code outside `.reviewgate/` was modified by Reviewgate.
7. Audit chain verifies (`reviewgate audit verify` passes).
8. With Claude Pro/Max + ChatGPT Plus + Gemini Advanced subscriptions:
   $0 marginal cost within the run.

---

## 14. References

- arxiv 2509.16533 — Sycophancy in self-review under iterative pressure
- arxiv 2601.06884 — Confirmation bias in LLM code review
- arxiv 2509.16533 — Multi-Agent Debate for LLM Judges (NeurIPS 2025)
- arxiv 2604.02923 — Council Mode, heterogeneous models
- arxiv 2510.02534 — ZeroFalse, LLM as SAST FP filter
- arxiv 2411.03079 — SAST-Genius 91% FP reduction
- arxiv 2511.05302 — When More Retrieval Hurts
- dl.acm.org/doi/pdf/10.1145/3696630.3728618 — AutoReview, FSE 2025
- code.claude.com/docs/en/hooks — Claude Code hooks reference
- claude.com/blog/how-to-configure-hooks — Anthropic hook configuration
- code.claude.com/docs/en/sandboxing — `@anthropic-ai/sandbox-runtime`
- developers.openai.com/codex/cli/reference — Codex CLI
- developers.openai.com/codex/concepts/sandboxing — Codex sandbox modes
- opencode.ai/docs/cli/ — OpenCode CLI
- google-gemini.github.io/gemini-cli/docs/cli/headless.html — Gemini headless
- opentelemetry.io/docs/specs/semconv/gen-ai/ — OpenTelemetry GenAI conv.
- smartscope.blog — claude-review-loop deep-dive
- cursor.com/blog/bugbot-learning — BugBot self-learning model
- github.com/AltimateAI/claude-consensus — closest existing analogue
- blog.mozilla.ai — Mozilla Star Chamber pattern
- vercel.com/changelog/ai-code-reviews-by-vercel-agent-now-in-beta — Vercel Agent
- biomejs.dev — Biome's no-plugins philosophy contrast
- vitejs.dev / vitest.dev — `defineConfig` pattern reference

---

*End of design spec v1.*
