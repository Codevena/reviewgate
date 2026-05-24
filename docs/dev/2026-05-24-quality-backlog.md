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

## Phase 2 — Diff-scoping + path normalization (NEXT)

**Decision: demote out-of-diff to INFO + config escape-hatch** (security/correctness
or symbol-anchored findings stay configurably blocking).

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

## Phase 3 — Brain candidate→active promotion (verified DEAD)

- `curator.ts:346-353` (dedup-merge on re-proposal) bumps `referenced_count` but
  does NOT add the new run's providers to `referencing_reviewers` → that set is
  frozen at creation (≤2 via quorum, usually 1 under the failover chain).
- `lifecycle.ts:11` promotes only if `referenced_count>=3 && referencing_reviewers.length>=3`
  → the `>=3` reviewer floor is structurally unreachable. Candidates never reach active.
- Fix: (a) UNION `providersIn(newEvidence)` into `referencing_reviewers` inside the
  store mutation (via the dup id, using `providerOf`, deterministically sorted);
  (b) lower the floor to `referenced_count>=3 && distinctProviders>=2`. Compute
  distinctness defensively in lifecycle. Update fixtures expecting the old floor.

## Phase 4 — Hardening (DEFERRED, own round later)

Verified, by impact-to-effort:
1. Temp-dir leak `rg-rev-*` (`orchestrator.ts:584`) — `try/finally rmSync`.
   (`rg-critic-*` already removed in Phase 1.)
2. Silent config fallback to defaults on zod failure (`global.ts:62`) — add `console.warn`.
3. Sync git on the Stop-hook hot path (`utils/git.ts spawnSync`) — blocks the event
   loop, can prevent `runTimeoutMs` firing. Convert hot-path calls to async. Medium risk.
4. `flock.ts` — no stale-lock recovery (writes pid, never checks liveness/TTL).
5. Determinism: `localeCompare` (`aggregator.ts:103`) → codepoint compare;
   `RG_VERSION="0.1.0-m1"` (`orchestrator.ts:142`) → derive from package metadata.
6. Dual `ReviewgateConfig` type (`defaults.ts:137` vs `define-config.ts:149`) — unify.
7. `confidence` field unused in verdict/dedup — wire as a demotion signal OR rename advisory.

Lower-confidence (agent-reported, not yet line-verified): greedy first-match
clustering (`aggregator.ts:117`), `line_start/line_end` single-line schema,
decisions-file read race, loop-driver test gaps (cost-cap/stuck/convergence/reject-rate),
orchestrator god-class refactor, parse-cache staleness in a long-lived process.
