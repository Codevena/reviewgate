# Agent Lessons v1 — Design

Status: **approved for planning** (brainstorm 2026-07-03). Next: writing-plans → Codex Plan-Gate → TDD implementation → DoD.

## Problem

The gate is currently only **reviewer-side** intelligent: FP-ledger, reputation, implicit-outcomes,
few-shot and brain **all calibrate the panel**. The single highest-value signal — a finding the
agent **accepted AND fixed** (a verified, categorized, located, real mistake) — is used only to
credit reviewer trust and is then discarded. The mistake *pattern* is lost, and **nothing feeds
back into Claude across sessions**. Agent Lessons captures accepted+fixed findings, detects
recurring patterns deterministically, and injects them back to Claude as **advisory** context at
SessionStart.

House principle (non-negotiable): **render-only / advisory, NEVER verdict-affecting, fail-safe**.
A bug in this feature must never block a review, never change a verdict, and never break session
startup. Same contract as research.md / provider-precision-context / fp-fragmentation-hint.

## Scope

**v1 = thin deterministic MVP** (agreed with Markus):

- **In:** Collect (accepted+fixed → `agent-lessons.json`) + deterministic recurrence distill +
  inject via SessionStart `additionalContext` only + opt-in config + `learn-status` inspection.
- **Out (YAGNI, explicitly deferred):** LLM distillation via `adapter.complete()`; the `pending.md`
  recurrence header; the global `~/.reviewgate/lessons` tier. Each can be a clean fast-follow.

**Default = OFF / opt-in** (`phases.agentLessons` null = off, like `phases.brain`/`fpLedger`).

## Honest deltas from the original sketch

The `docs/dev/2026-07-03-fail-open-remediation-followups.md` sketch assumed three things that a
reuse-surface audit of the code disproved. This spec corrects them:

1. **The FP-ledger persists as a single JSON document, not JSONL** (despite the `.jsonl` filename —
   `src/utils/paths.ts:78-80`, `src/core/fp-ledger/store.ts:102-108`). Agent Lessons mirrors that:
   a single JSON index, because recurrence needs *find-or-create-by-key aggregation*, not
   append-only lines.
2. **The accepted+fixed collection does not exist yet.** `learnFromDecisions`
   (`src/core/fp-ledger/learn.ts:43`) folds **only** `verdict==="rejected" && reviewer_was_wrong`.
   Collecting `accepted`/`fixed` is net-new; `absorbPriorDecisions` is the natural hook and
   `foldLastDecisions` + the by-id Finding map is the exact reusable pattern.
3. **The SessionStart → `additionalContext` path does not exist at all.** grep for
   `additionalContext`/`hookSpecificOutput` across `src/` = 0 hits; the reset hook deliberately
   returns empty stdout (`src/cli/commands/gate.ts:310,340`). Building this emission path is the
   main work — and the main risk — of v1, mitigated by a hard fail-safe (below).

## Confirmed external contract (Claude Code SessionStart hook)

Verified against the current official hooks docs (2026-07-03):

- Output shape: `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"<text>"}}`
  on stdout. `hookEventName` must equal `"SessionStart"`; `additionalContext` is the injected text.
- **Fail-safe is guaranteed by the platform:** exit 0 + empty stdout = silent no-op; SessionStart
  hooks **cannot block** session startup (errors are advisory only). Plain-text stdout is also
  added as context, and even malformed JSON at exit 0 is tolerated (treated as plain text). We rely
  only on the "empty stdout = no-op" guarantee.
- `additionalContext` is capped at **10,000 chars** (our default cap ~1500 is well under) and is
  injected **before the first user prompt**, upstream of CLAUDE.md — ideal for priming.
- The hook receives `source` on stdin: `startup` | `resume` | `clear` | `compact`. **We inject only
  on `startup` and `resume`** — never on `clear`/`compact`, to avoid re-priming the same block mid-session.

## Architecture

New, isolated module `src/core/agent-lessons/` mirroring `src/core/fp-ledger/`:

- `store.ts` — `AgentLessonsStore`, mirroring `FpLedgerStore` persistence semantics: flock-guarded
  `mutate()`, atomic tmp+rename, mode `0o600`, corrupt-file backup, and **never persist an empty
  snapshot over real data on transient I/O error**.
- `learn.ts` — `learnLessonsFromDecisions(...)`, the accepted+fixed twin of `learnFromDecisions`.
- `distill.ts` — deterministic recurrence → one-line imperative lessons.
- `inject.ts` — build the SessionStart `additionalContext` block (pure function, string in/out).

New schema `src/schemas/agent-lessons.ts`. New path helpers in `src/utils/paths.ts`. Config in
`src/config/define-config.ts` + `src/config/defaults.ts`. Collection wired into
`src/core/loop-driver.ts`. Injection wired into the reset branch of `src/cli/commands/gate.ts`
(+ `src/cli/index.ts` already writes `res.stdout`). CLI view in `src/cli/commands/learn-status.ts`.

### A · Data model — `.reviewgate/learnings/agent-lessons.json`

Single JSON index (`JSON.stringify(idx, null, 2)`, mode `0o600`), schema
`reviewgate.agentlessons.v1`:

```
AgentLessonsIndex {
  schema: "reviewgate.agentlessons.v1"
  entries: LessonEntry[]
  seq?: number                       // AL-NNN high-water, like FP-ledger seq
}

LessonEntry {
  id: string                         // "AL-NNN"
  key: string                        // sha256(category + normalizeRuleId(rule_id))
  category: FindingCategory
  rule_id: string                    // normalized (drift-tolerant, per signature.ts)
  occurrences: Occurrence[]          // append-only within the TTL window; newest last
  exemplar_message: string           // most-recent finding.message, SANITIZED, ≤200 chars
  first_seen_at: string              // ISO
  last_seen_at: string               // ISO
}

Occurrence {
  run_id: string                     // `${sessionId}:${cycleSeq}:${prevIter}` (reuse learn.ts:84)
  session_id: string
  signature: string                  // finding signature (idempotency component)
  file: string
  ts: string                         // ISO
}
```

`count`, `distinct_sessions`, and `distinct_files` are **derived at read time** from `occurrences`
(`count = occurrences.length`, `distinct_* = unique(...)`) — they are NOT stored. This deliberately
mirrors the FP-ledger, which derives `distinct_providers` and never stores a separate counter.

**Idempotency:** an occurrence is deduped on `(run_id, signature)` — re-absorbing the same
iteration never double-counts (mirrors the FP-ledger's `(run_id, provider)` dedup, not a watermark).
**Pruning:** `occurrences` are **TTL-pruned** on a `decayPass()`-style write (drop occurrences older
than `ttlDays`, default 90; an entry with zero surviving occurrences is dropped). There is **no
per-entry occurrence cap** — a fixed cap that drops old occurrences would break the `(run_id,
signature)` dedup (a dropped occurrence can no longer be recognized as a duplicate → double-count),
exactly the tension the FP-ledger avoids by capping nothing. If an entry's occurrence list grows
unbounded within the window in the field, add a cap-with-compatible-dedup as a fast-follow.

### B · Collect

New `learnLessonsFromDecisions({repoRoot, prevIter, sessionId, cycleSeq, store, nowIso})`,
signature-identical to `learnFromDecisions`:

1. Read `.reviewgate/decisions/<prevIter>.jsonl` and `.reviewgate/pending.json`; build the
   `finding_id → Finding` map exactly as `learn.ts` does.
2. `foldLastDecisions(content)` (reuse `src/core/fp-ledger/decision-fold.ts`) — last-valid-line-per-id wins.
3. For each folded decision with **`verdict==="accepted" && action==="fixed"`**, look up the
   Finding, compute `key = sha256(category + normalizeRuleId(rule_id))`, and
   `store.recordOccurrence(key, {category, rule_id, message}, {run_id, session_id, signature, file}, nowIso)`.

Wired into `LoopDriver.absorbPriorDecisions(state)` (`src/core/loop-driver.ts:~2095`), gated on
`config.phases.agentLessons?.enabled`, run as `learnLessonsFromDecisions(...).then(prune/decay).catch()`
alongside the existing `learnFromDecisions` / `learnReputationFromDecisions` calls. Non-blocking;
a throw is swallowed and never touches the verdict. `absorbPriorDecisions` fires early in `run()`
so it still collects even when an escalation early-returns.

Note: Finding has **no `symbol` field** (audit-confirmed); occurrences key on `file` + signature
only. **Decision:** findings whose normalized `rule_id` is empty are **skipped** in v1 (they would
collapse into a giant catch-all `category`-only bucket that is too coarse to be an actionable
lesson). Revisit only if the field shows that valuable rule-less patterns are being dropped.

### C · Distill (deterministic — no LLM)

A lesson **surfaces** when `count >= minRecurrence` (default **3**). No LLM. `distill.ts` renders a
one-line imperative from `(category, rule_id, count, distinct_files, distinct_sessions,
exemplar_message)`. English (codebase convention for agent-facing text). Template:

```
- [{category}] rule "{rule_id}" — caught {count}× in this repo ({F} files, {S} sessions).
  Last: "{exemplar_message}". Check for this before ending your turn.
```

Ranking: `count` desc, tiebreak `last_seen_at` desc. Deterministic given the store → fully testable.
v1 gates on `count` only (a 3×-in-one-session pattern still qualifies); `distinct_sessions` is
displayed, not gated. A distinct-session floor can be added later if single-session noise appears.

### D · Inject (SessionStart `additionalContext`)

In the reset branch of `runGate` (`src/cli/commands/gate.ts`), **after** `handleReset` completes
(handleReset is untouched — it already seeds reviewed-through markers per the just-landed
"reset never blesses a dirty/escalated tree" fix; injection is strictly *read-only* and additive):

1. If `config.phases.agentLessons?.enabled` is falsy → return `stdout: ""` (today's behavior).
2. If `source` (from stdin) is not `startup` or `resume` → return `stdout: ""`.
3. Otherwise: load the store, filter `count >= minRecurrence`, rank, take top-K (default **5**),
   render each via `distill.ts`, join into a block, prefix with a short trusted header
   (e.g. `Reviewgate — recurring mistakes it has caught in this repo (advisory):`), enforce
   `maxInjectChars` (default 1500; drop lowest-ranked lessons until it fits), and return
   `stdout = JSON.stringify({hookSpecificOutput:{hookEventName:"SessionStart", additionalContext: block}})`.
4. **Fail-safe (wraps steps 1-3):** any thrown error, missing/corrupt store, or empty result →
   `stdout: ""`. A single `try/catch` around the whole block guarantees SessionStart never breaks
   and never emits partial/garbage output.

`src/cli/index.ts` already does `if (res.stdout) process.stdout.write(res.stdout)`, so no CLI-layer
change is needed beyond `runGate` returning the payload. The user-facing `reviewgate reset` command
(`src/cli/commands/reset.ts`) is a manual CLI path (stdout → terminal, not a hook) and is **not**
changed — only the hook path emits `additionalContext`.

### E · Safety / sanitization

`exemplar_message` is reviewer-authored text over a semi-trusted diff. It is sanitized with
`neutralizeInjectionMarkers` + `neutralizeFences` (`src/diff/sanitizer.ts`) — the established
pattern for reviewer text rendered into trusted context (report-writer.ts, critic.ts,
research-writer.ts) — **both when written into the store AND again at injection time** (defense in
depth). Length-clamped to ≤200 chars. `rule_id`/`category` are constrained enum/token values, not
free text. The injected block therefore contains no unsanitized reviewer prose.

### F · Config

`src/config/define-config.ts`, in the `phases` object (nullable-object subsystem pattern, like
`phases.fpLedger`):

```ts
agentLessons: z
  .object({
    enabled: z.boolean(),
    minRecurrence: z.number().int().min(1).default(3),
    topK: z.number().int().min(1).default(5),
    maxInjectChars: z.number().int().min(200).default(1500),
    ttlDays: z.number().int().min(1).default(90),
  })
  .nullable()
  .default(null)
  .optional(),
```

`src/config/defaults.ts`: `agentLessons: null` (OFF). Config is hashed into the review cache key
automatically (no extra work). To dogfood in this repo, set `phases.agentLessons: { enabled: true }`
in `reviewgate.config.ts`.

### G · CLI

Extend `src/cli/commands/learn-status.ts` with a read-only "Agent lessons" section: total entries,
and the top-K surfaced lessons with counts. No new subcommand, no mutation commands in v1.

## Testing (all deterministic → unit-testable)

- **Collect:** an `accepted`+`fixed` decision folds into a new entry; a `rejected` or
  `accepted`-without-`fixed` decision does **not**; re-absorbing the same `(run_id, signature)` is a
  no-op (idempotency); distinct sessions/files accumulate.
- **Distill:** `count < minRecurrence` → not surfaced; `>= minRecurrence` → surfaced; ranking order;
  exact template output for a fixed input; empty-rule findings skipped.
- **Inject:** correct `hookSpecificOutput` JSON on `startup`/`resume`; `""` on `clear`/`compact`;
  `""` when disabled; **`""` when the store is corrupt/missing (fail-safe)**; `maxInjectChars`
  trimming drops lowest-ranked first; block never exceeds the cap.
- **Safety:** a malicious `exemplar_message` (injection markers, fences, control bytes, high-entropy
  secret) is neutralized in both the store and the injected block.
- **Store:** flock/atomic/corrupt-backup parity with FP-ledger; transient I/O error does not persist
  an empty snapshot; `ttlDays` pruning drops stale occurrences and empties-out entries.
- **Config off = zero behavior change:** with `agentLessons: null`, no store writes, no stdout,
  cache key path unaffected beyond the (already-hashed) config value.

## Error handling / invariants

- Collection runs under the gate lock inside `absorbPriorDecisions`, `.catch()`-guarded → never
  blocks or changes a verdict.
- Injection is wrapped in one `try/catch` → SessionStart can only ever emit valid JSON or `""`.
- Store writes reuse FP-ledger's rethrow-on-transient-I/O guard → no data loss via empty overwrite.
- No mechanism in this feature can raise severity, add a blocking finding, or alter the loop's
  allow/block decision. It is purely additive context.

## Deferred (fast-follow candidates)

1. LLM distillation (`adapter.complete()`, curator-style: non-blocking, timeout-bounded, opt-in) for
   nicer lesson phrasing.
2. `pending.md` recurrence header ("Reviewgate has caught this mistake type N× here") during an
   active review.
3. Global `~/.reviewgate/lessons` tier (mistake patterns are often repo-independent).
4. Distinct-session floor for surfacing; entry-count size cap if the store grows unbounded.
