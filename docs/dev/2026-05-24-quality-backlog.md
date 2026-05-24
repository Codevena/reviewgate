# Quality backlog — verified findings + phased plan (2026-05-24)

Output of a full codebase analysis (2 explore agents + manual verification +
Codex second opinion). All findings below were verified against the code with
file:line. Phase 1 is DONE; Phases 2–4 are the remaining plan.

## Phase 1 — Critic via complete() ✅ DONE (branch `gate-critic-complete`)

The adversarial critic was a silent no-op for schema-enforcing providers
(`orchestrator` called `adapter.review()`, which forces REVIEW_OUTPUT_SCHEMA on
codex/openrouter → model can't emit `{verdicts:[...]}`). Fixed: `runCritic()` in
`critic.ts` uses `adapter.complete()`; `CompleteOptions.signal` added + threaded
into all 5 adapters' `complete()`. Critic is `null` by default, so this was
latent (bit only a configured codex/openrouter critic). DoD: Codex PASS + Claude PASS.

## Phase 2 — Diff-scoping + path normalization ✅ DONE (branch `gate-diff-scope-pathnorm`)

**Decision: demote out-of-diff to INFO + config escape-hatch** (default `[]` =
demote all; set `phases.review.outOfDiffBlocking` to keep categories blocking).
Shared `normalizeRepoPath` (src/diff/repo-path.ts) applied in review-output +
aggregate (findings + changedRanges keys + merged member categories). One-shot
reviews skip scoping. DoD: Codex PASS + Claude PASS. E2E on the compiled binary:
in-diff → BLOCK, out-of-diff → GATE OPEN.

- `aggregator.ts:205` `if (!ranges) return f` keeps a finding whose file is not in
  the diff at FULL severity → a hallucinated CRITICAL on an untouched file blocks.
- `review-output.ts:222` only normalizes ABSOLUTE paths; `./src/x.ts` mis-matches
  `hunks.ts` keys (`src/x.ts`).
- **Coupling:** today "keep if not in diff" masks the path bug. Must fix together:
  add a shared `normalizeRepoPath(raw, workingDir?)` used in `review-output.ts`
  (BEFORE signature computation), in `aggregator.ts` (normalize changedRanges keys
  too), AND before `applySymbolSignatures` (joins repoRoot + f.file). THEN demote
  file-not-in-diff → INFO (`scope_demoted`), with the escape-hatch config.
- Codex caveats: no blind lowercasing (case-sensitive FS); handle Windows `\`;
  legitimate cross-file impact (changed export breaks untouched caller) is why we
  want the escape-hatch, not a blanket demote.

## Phase 3 — Brain candidate→active promotion ✅ DONE (branch `gate-brain-promotion`)

Fixed: curator dup-merge now UNIONs new providers into `referencing_reviewers`;
`promoteIfReferenced` floor is `referenced_count>=3 && distinct providers>=2`.
End-to-end test proves a convention re-proposed across 3 runs by 2 providers
reaches `active`. DoD: Codex PASS + Claude PASS. (Live LLM-driven promotion E2E
remains cassette-territory per the nondeterminism note — the logic is now
deterministically proven.)

### Original analysis (verified DEAD before the fix)

- `curator.ts:346-353` (dedup-merge on re-proposal) bumps `referenced_count` but
  does NOT add the new run's providers to `referencing_reviewers` → that set is
  frozen at creation (≤2 via quorum, usually 1 under the failover chain).
- `lifecycle.ts:11` promotes only if `referenced_count>=3 && referencing_reviewers.length>=3`
  → the `>=3` reviewer floor is structurally unreachable. Candidates never reach active.
- Fix: (a) UNION `providersIn(newEvidence)` into `referencing_reviewers` inside the
  store mutation (via the dup id, using `providerOf`, deterministically sorted);
  (b) lower the floor to `referenced_count>=3 && distinctProviders>=2`. Compute
  distinctness defensively in lifecycle. Update fixtures expecting the old floor.

## Phase 4 — Hardening

Verified, by impact-to-effort. Grouped into PRs: **PR A** (hygiene: 1,2,5,6) ✅ DONE;
**PR B** (sync-git 3); **PR C** (flock 4); **PR D** (confidence 7, wired as demote).

### PR A — Hygiene ✅ DONE (branch `phase4-hygiene`)

1. ✅ Temp-dir leak `rg-rev-*` (`orchestrator.ts`) — `try/finally rmSync` around the
   per-reviewer runDir. ALSO fixed: all 4 adapter `preflight()` temp dirs
   (`rg-{codex,gem,cl,oc}-pf-*`) now `finally rmSync`. (`rg-critic-*` already removed
   in Phase 1.) Verified by `tests/unit/temp-cleanup.test.ts` (TMPDIR-isolation).
2. ✅ Silent config fallback (`global.ts`) — `console.warn` with the offending zod
   field path (`describeConfigError`) before degrading to defaults.
5. ✅ Determinism: `localeCompare` → `compareCodeUnits` (`src/utils/compare.ts`,
   locale-independent UTF-16 code-unit order) in `aggregator.ts`; `RG_VERSION`
   derived from `package.json` (`src/version.ts`) — feeds cache key AND the CLI
   `--version` (a SECOND hardcoded `0.1.0-m1` in `cli/index.ts` was also unified).
   JSON import verified to survive `bun build --compile`.
6. ✅ Dual `ReviewgateConfig` type — `defaults.ts` now `satisfies ReviewgateConfig`
   (type-only import from `define-config.ts`, no runtime cycle); orphan
   `export type … = typeof defaultConfig` removed. zod schema is the single source.
   DoD: Codex PASS + Claude PASS; full suite 764 pass / 0 fail; binary verified.

### PR B — Sync-git → async ✅ DONE (branch `phase4-async-git`)

3. ✅ All Stop-hook-hot-path `spawnSync` calls converted to async via a new
   `src/utils/spawn-capture.ts` (`spawnCapture`: detached process group,
   per-command SIGKILL timeout, bounded stdout w/ `truncated` flag, `AbortSignal`
   support). Converted: `git.ts` (collectDiff/gitHeadSha/collectChangedFileContents/
   collectGitInfo), `symbol-graph.ts` rg, `research-writer.ts` gitLog, and
   `review-plan.ts` synthDiff. Now: a hung git/rg can't block the event loop, so
   the `loop.runTimeoutMs` deadline CAN fire; the abort **propagates** into the
   research subprocesses (loops break on `signal.aborted`, no fallback scan when
   aborted). Hardening from review: `collectDiff` untracked loop has a 60s
   aggregate budget; a truncated/timed-out/budget-capped diff is marked INCOMPLETE
   and surfaced to reviewers as **TRUSTED** context BEFORE the untrusted fence
   (not buried inside it). DoD: Codex PASS + Claude PASS; 777 pass / 0 fail; binary
   E2E re-verified (async git/rg run correctly in the compiled binary).

### PR C — flock stale-lock recovery ✅ DONE (branch `phase4-flock-stale`)

4. ✅ `flock.ts` rewritten with **provably race-safe** dead-holder recovery (5
   review rounds; Codex found 4 successive races, Claude 1). Key decisions:
   - Acquire via the atomic **link() protocol** (write full pid/ts/token to a
     unique temp → `link()` into place) → the lock file is never observable
     empty/partial (closes the create→write TOCTOU a plain `O_EXCL` open leaves).
   - **Dead-pid-only reclaim** (`process.kill(pid,0)` → ESRCH). NO TTL stealing:
     reclaiming a still-LIVE holder is a double-acquire by definition. A
     crashed-then-pid-reused holder degrades to the acquire timeout (= old
     behaviour, not a regression).
   - One race-safe removal primitive `reclaimIfDead` (rename-to-private
     single-winner → delete only the private copy → never `unlink(path)` after
     vacating → a fresh legit lock at `path` is never clobbered; live-grab →
     restore-or-orphan, never destroy a live lock), used for BOTH the main lock
     AND the steal-mutex's own dead recovery.
   - Steals serialized through a steal-mutex; `release()` ownership-token-checked.
   - User decision 2026-05-24: chose the provably-safe path over a pragmatic+
     documented one. DoD: Codex PASS + Claude PASS; 9 flock tests (incl. 8-way
     concurrent steal, maxActive===1) stable 5×; full suite 785 pass / 0 fail.
   - Known platform note: on Windows a dead pid may report EPERM (not ESRCH) → no
     fast reclaim, degrades to the acquire timeout (safe fallback).

### PR D — confidence as a demote signal ✅ DONE (branch `phase4-confidence-demote`)

7. ✅ `confidence` is now wired into the verdict (was parsed but unused — a 0.2
   finding blocked like a 0.99). `phases.review.confidenceFloor` (default **0.3**):
   an UNCORROBORATED finding whose **cluster-max** confidence (representative +
   all merged members) is below the floor is demoted to INFO + tagged
   `low_confidence` (advisory, never dropped). Exempt: corroborated findings
   (majority/unanimous) and CRITICAL clusters touching security/correctness.
   `floor:0` disables (exact back-compat). Members now carry per-member
   `confidence` so a co-located high-confidence member is never masked by a
   low-confidence representative.
   - Surfaced + fixed a LATENT pre-existing bug: the verdict's always-block
     security/correctness FAIL (and the critic exemption) checked only the
     representative category → a CRITICAL security/correctness concern merged as a
     MEMBER under another category could PASS. All three sites (critic exemption,
     confidence-demote exemption, verdict gate) now share one member-aware
     `touchesSecurityOrCorrectness` helper.
   - DoD: Codex PASS + Claude PASS (Codex found 3 escalating issues, Claude 2);
     804 pass / 0 fail. User decision 2026-05-24: wire it (behaviour change).

## Phase 4 — COMPLETE ✅

All seven verified Phase-4 hardening points shipped across PRs A–D (each its own
branch → green DoD → FF-merge to master). Remaining lower-confidence items below
are still **verify-first** before any change.

### Lower-confidence — VERIFIED at the code 2026-05-24

- greedy first-match clustering (`aggregator.ts`) — **by-design** (first-match+break,
  but tight 5-line window + 0.6 jaccard → mis-merges rare). Not a bug; left as is.
- `line_start/line_end` single-line schema at codex (`review-output`) — **REAL,
  low-med**: reviewers emit a single `line` → `line_start===line_end`. Deferred to a
  later PR (touches the codex strict-mode schema + prompt; needs a real-codex check).
- decisions-file read race (`loop-driver`) — **NOT real**: the agent writes decisions
  during its turn; the Stop hook reads after the turn ends (sequential).
- parse-cache staleness (`symbol-graph`) — **NOT real**: `parseCache` is a per-process
  Map and the gate is one-shot per Stop → always fresh.

### PR E — backlog cleanup ✅ DONE (branch `phase4-cleanup`)

- loop-driver **cost-cap** escalation was untested (stuck/convergence/reject-rate
  already covered) → added tests.
- `buildSymbolGraph` file-parse loop now breaks on `signal.aborted` (was rg-loop only).
- `spawnCapture` stderr now bounded at `maxBytes` (was unbounded).
- gate HEAD-advanced path computed `collectDiff(last)` twice → compute once + reuse.
- DoD: Codex PASS + Claude PASS; 808 pass / 0 fail; binary smoked.

### PR F — optional multi-line finding ranges ✅ DONE (branch `phase4-multiline-ranges`)

- `#2` Reviewers can now report a multi-line range. `REVIEW_OUTPUT_SCHEMA` findings
  gain `line_end` (in `required`, nullable type `["integer","null"]` — strict-mode
  compliant). `mapReviewOutputToFindings` resolves `line_end = max(line,
  trunc(line_end))` when finite, else `line` (null/absent/backwards/garbage →
  single-line, back-compatible — single-line signatures are byte-identical, so
  cache/FP-ledger keys don't shift). Both prompt preambles document it;
  report-writer renders `file:start-end` for multi-line. Verified strict-mode
  validity with a REAL `codex exec --output-schema` call (emitted line/line_end,
  no HTTP 400). DoD: Codex PASS + Claude PASS; 810 pass / 0 fail.

**Backlog fully worked through (2026-05-24): Phases 1–4 + PR E cleanup + PR F.**

NOTE (deferred, lower-priority follow-ups surfaced by PR B review): tree-sitter
`parseFile` loop in `buildSymbolGraph` doesn't abort early; `spawnCapture` stderr
is unbounded (stdout is capped); the HEAD-advanced gate path calls `collectDiff`
twice. None block the deadline; track for a later pass.

Lower-confidence (agent-reported, not yet line-verified): greedy first-match
clustering (`aggregator.ts:117`), `line_start/line_end` single-line schema,
decisions-file read race, loop-driver test gaps (cost-cap/stuck/convergence/reject-rate),
orchestrator god-class refactor, parse-cache staleness in a long-lived process.
