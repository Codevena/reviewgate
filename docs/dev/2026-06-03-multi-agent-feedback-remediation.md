# Reviewgate — Multi-Agent Feedback: Analysis & Remediation Roadmap

**Date:** 2026-06-03
**Source:** 6 independent field reports from agents/users running Reviewgate (3 first batch + 3 live follow-ups).
**Method:** 13 parallel read-only investigation agents, one per problem domain, each producing root-cause + file:line evidence + ranked fixes. This document synthesises them into a prioritised, shippable plan.

---

## 0. Executive summary

17 distinct issues were extracted and investigated. **14 confirmed**, **3 partially-already-handled**. They cluster into four themes:

> **Headline (highest severity): I-16 — the gate sometimes silently fails OPEN.** A review gate that ends a turn with no verdict (no GATE OPEN/CLOSED, the stop-hook "just disappears") ships un-reviewed code silently — the exact opposite of its purpose. This is P0-above-P0; see M-A0.

1. **Multi-session orchestration is actively broken** (the dominant pain). A *global per-repo lock* held for the entire multi-minute review starves all parallel sessions; a *hung reviewer at 0 % CPU* holds that lock for up to 14 min with no peer-reclaim; a *rebase* silently re-points the diff base so the gate reviews 26 foreign already-merged commits. In the worst observed case this chain — lock-starvation → findings unaddressable → `decisions-unaddressed` escalation → **good review output discarded** — is a clean causal proof.
2. **Correlated false-confidence & wolf-cry** erode trust: reviewers emit WARN/CRITICAL on things they explicitly didn't verify; "consensus" is treated as independent evidence when it is correlated error; security CRITICALs claim "committed/exposed, rotate now" on never-committed non-secrets; rejected false-positives recur verbatim because prior decisions never reach the reviewer.
3. **Error-path UX & liveness gaps**: `ERROR`+0-findings dead-ends the documented unblock path; verdict messages don't match the docs/CLAUDE.md trigger string; infra-error streaks escalate with a code-focused (dishonest) message; timing budgets are invisible.
4. **Correctness blind spot**: the gate is purely semantic — it never runs `tsc`/tests, so plausible-but-broken changes pass green.

**Priority:** P0 = theme 1 (it's destroying real work in the user's primary environment). P1 = theme 2 (trust). P2 = theme 3. P3 = theme 4 (opt-in feature).

---

## 1. Issue catalogue (verdict + root cause + chosen fix)

> Each issue cites the investigating agent's key findings. "Fix" = the recommended primary remediation; alternatives are in §2 milestones.

### Theme 1 — Multi-session orchestration & safety

**I-16 · Silent fail-OPEN — the gate sometimes emits no verdict at all** — **Confirmed (highest severity).**
Three real non-emitting termination paths, all → un-reviewed turn:
- **No top-level fail-closed catch-all.** `src/cli/index.ts` calls `await runGate(...)` with no surrounding try/catch; any uncaught throw (zod parse, fs error, an `writeFileAtomic` throw at `gate.ts:155`, an adapter-build error) propagates to citty, which prints the stack to **stderr** and `process.exit(1)` — **empty stdout → no `{"decision":"block"}` → fail-open.**
- **Pre-deadline setup is NOT bounded by `runTimeoutMs`.** The 840 s self-deadline only wraps the reviewer panel. Everything before it — `flock` (10 s) + `state.loadOrRecover` (30 s) + `collectGitInfo` (3× `git`, up to 90 s) + `collectDiff` (up to 120 s incl. the 60 s untracked budget) — runs *outside* the deadline. Under multi-agent `index.lock` contention this setup can eat the entire 60 s margin (900 s OS Stop-hook timeout − 840 s); the OS SIGKILLs the gate mid-run → empty stdout → fail-open. Worst-case math: ~250 s setup + 840 s = 1090 s ≫ 900 s. **This is the most likely cause of the live "2/3 then disappears" report.**
- **`await runP` after abort is unbounded.** On self-deadline, `loop-driver.ts:809` does `ac.abort()` then `await runP` with no timeout. The comment claims post-verdict work is `curatorTimeoutMs`-bounded, but `pairActiveFpEntries` (`orchestrator.ts:1319-1331`, `src/core/brain/fp-coupling.ts`) is **not** `withTimeout`-wrapped and **doesn't check the abort signal** — with many accumulated FP entries it can run N×20 s past the deadline → OS kill → fail-open (even though a verdict was already on disk).
The memory note "self-deadline fixed it" is **real but incomplete** — it bounds the panel, not setup or post-abort work, and there's no process-level catch-all.

**I-09 · Global lock starves parallel sessions** — **Confirmed (biggest pain).**
`gate.lock` is keyed per-repo (`src/utils/paths.ts` `gateLockPath`) and wraps the *entire* `runStopGate` body including reviewer subprocesses (`src/cli/commands/gate.ts:86-101`). Acquire timeout is a flat 10 s (`GATE_LOCK_ACQUIRE_TIMEOUT_MS`, `gate.ts:27`); on failure it returns `decision:"block"` "another gate run is in progress … Re-run" (`gate.ts:93-95`) — **indistinguishable from a findings block**, with no backoff/queue/defer. With ~10 agents on one checkout, peers loop block→re-stop→block, burning turns/tokens.

**I-11 · Hung-holder deadlock** — **Confirmed (worst escalation, field incident).**
`flock` reclaims **dead-PID holders only** (`src/utils/flock.ts:40-58`), by design (no TTL-steal → no double-acquire). A hung-but-alive holder at 0 % CPU is never reclaimed. The zero-byte watchdog (`src/utils/spawn.ts:202-209`) is evaded by a streaming provider (codex `--json`) that dribbles a token every <60 s, so it runs to its `timeoutMs` (300 s); the only backstop is the loop self-deadline `runTimeoutMs` = **840 s = 14 min** (`src/config/defaults.ts:132`), during all of which the global lock is held. There is **no heartbeat** in the lock file, so peers cannot tell "reviewing" from "hung". Observed: PID 81419, 8 min @ 0 % CPU, blocking every other session.

**I-12 · Review-base drift on rebase** — **Confirmed (new bug).**
`base_sha` is the pre-batch HEAD frozen at the first edit (`src/hooks/handlers.ts:33-40`) and used directly by `collectDiff` (`src/utils/git.ts:101-119`) with no ancestry check. A rebase moves HEAD forward N commits without a `PostToolUse`; the frozen base now predates those N foreign commits, so `git diff <stale_base>..HEAD` silently includes them. The stale-base fallback (`git.ts:116`) only fires when the ref is *gone* — a reflog-reachable SHA exits 0. There is **zero** code referencing `origin/main`, `@{u}`, `merge-base`, or `is-ancestor` (grep-confirmed). Result: a 2-commit change blocked by 6 findings in 26 foreign, already-merged commits.

**I-05B · Gate runs work even on no-edit turns** — **Partially-already-handled.**
`LoopDriver` *does* fast-path `allow_stop` when no `dirty.flag` (`src/core/loop-driver.ts:401-409`) — so no-edit turns are **not blocked**. But the lock is acquired (`gate.ts:88`) and `collectGitInfo`+`collectDiff` run (`gate.ts:120-166`) *before* that check, so every no-edit stop pays lock-contention + git I/O for nothing.

### Theme 2 — Correlated false-confidence & wolf-cry

**I-04 · Security claims unverified against git reality** — **Confirmed.**
Untracked files enter the diff via `git diff --no-index` (`src/utils/git.ts:126-158`) labelled only `new file mode` — ambiguous between "untracked, never committed" and "committed this batch". `research.md` shows *absence* of git log, not an authoritative label (`src/research/research-writer.ts:99-125`). The security persona ("hostile senior auditor", `src/core/personas.ts:8`) gets **no instruction** to verify "committed/exposed" claims; UUIDs pass the entropy redactor (entropy ~3.6 < 4.0 threshold, `src/diff/sanitizer.ts:80-91`); no aggregator/critic pass cross-checks exposure claims. → predictable false "secret committed, rotate immediately" CRITICAL.

**I-03 · Rejected FPs recur verbatim next iteration** — **Confirmed.**
`cycle_rejected_signatures` are used **only for post-hoc aggregator demotion** (`src/core/aggregator.ts:419-433`), never injected into the reviewer prompt — the reviewer has no memory of prior rejections (`src/core/orchestrator.ts` prompt assembly). The only prompt-side FP suppression (`fpFewShot`) requires the FP-ledger `active` stage = **≥3 rejects from ≥2 distinct providers** (`src/core/fp-ledger/store.ts:54-55`), unreachable on a first-cycle single rejection. Worse: `computeSignature` buckets line numbers in groups of 10 (`src/diff/signature.ts:83`), so a line-jittered recurrence (e.g. the "leading-space import" diff-context FP) crosses a bucket and **even the post-hoc demotion misses it → returns BLOCKING**.

**I-02 · Reviewers WARN on things they didn't verify** — **Confirmed.**
The preamble only mandates verification for "undefined/missing symbols" (`src/core/orchestrator.ts:175-177`); nothing tells reviewers to read a referenced *non-changed* file before flagging it, or to demote unverified suspicions to INFO. Only *changed* files are injected (`src/utils/git.ts:171-243`) — a referenced `globals.css`/`theme.css` is absent. codex (`--sandbox read-only --cd repo`) and agy *can* read files but aren't told to; claude runs in a temp dir and *can't*. No `verified`/`evidence` schema field; `confidenceFloor` defaults to 0 (`src/core/orchestrator.ts:1229`) so it's inert.

**I-01 · Correlated consensus = false strength** — **Confirmed.**
`computeConsensus` is purely count-based (`src/core/aggregator.ts:81-86`); `confirmed_by` stores only `provider:persona` strings with no basis-of-agreement. `majority`/`unanimous` findings are **unconditionally exempt** from critic-demote (`aggregator.ts:362-363`), confidence-floor (485), reputation (511) and hard-FAIL the verdict (568-585). The critic can't even see `confirmed_by` (`src/core/critic.ts:18-21`). So N reviewers sharing one pre-training blind spot (e.g. Tailwind-v3 HSL convention) look like N independent confirmations. (NB: only happens with multi-slot configs; the single-primary dogfood config never produces multi-reviewer consensus.)

**I-05A · Scope-mixing: introduced vs surfaced** — **Confirmed.**
`scopeFindings` is binary (`aggregator.ts:190-224`): inside any changed hunk → blocking, outside → INFO. A single changed line "unlocks" a whole 200-line function so a pre-existing bug nearby blocks as if introduced (`src/diff/hunks.ts:58-62`). No `introduced_by_diff` flag, no report separation. Plus parallel-session untracked files are working-tree-global (`git ls-files --others`, `git.ts:126`) — another session's file is reviewed as yours.

**I-17 · Out-of-diff exploration findings & no self-allowlist** — **Confirmed (sharp instance of I-05A + I-02).**
Field meta-moment: Reviewgate's own reviewer raised a **CRITICAL "repo-local-hook-RCE"** (conf 0.91) on `.reviewgate/bin/*` + `.claude/settings.json` for a branch that only adds a spec `.md`. Two facts compose: (1) reviewers have filesystem access (codex `--sandbox read-only --cd repo`, agy agentic) and **explore beyond the diff** — `.reviewgate/**` is excluded from the *diff* (`EXCLUDE_PATHSPEC`, `git.ts:57-64`) but **not** from the reviewer's file exploration; (2) `scopeFindings` exempts `outOfDiffBlocking` categories (security/correctness) from scope-demotion, so an off-diff **security** CRITICAL stays blocking instead of being demoted to INFO. Net: every branch in any Reviewgate-enabled repo "eats" the same CRITICAL on Reviewgate's own machinery. The *detector itself is genuinely valuable* (correctly spots the supply-chain pattern) — the bug is scoping. Needs: (a) a self-allowlist for `.reviewgate/**` + `reviewgate.config.ts`; (b) tighter handling of off-diff findings even for security (demote-to-INFO unless the file is in the diff, or at least tag "pre-existing, not introduced by this change").

### Theme 3 — Error-path UX & liveness

**I-06A · ERROR+0-findings dead-end** — **Confirmed.**
`pending.md` renders "## Required actions / refuses to unblock until every finding has a decision" **unconditionally** (`src/core/report-writer.ts:108-120`), even with 0 findings (ERROR coerces verdict→FAIL at `orchestrator.ts:1660`). The ERROR block message (`loop-driver.ts:964-967`) points to that misleading section and to `doctor`, but never says "nothing to triage — end your turn to re-run".

**I-06C · Docs vs real message mismatch** — **Confirmed.**
Global CLAUDE.md triggers on `"Reviewgate FAIL …"`; **no** real message contains that substring. Real prefixes: `🟢/🟡 Reviewgate · GATE OPEN`, `🔴 Reviewgate · GATE CLOSED` (both FAIL *and* ERROR), `🟠 GATE DEFERRED`, `🟠 GATE ESCALATED`. `docs/AGENTS.md` lists ERROR but shows no ERROR/DEFERRED example and no unblock instruction.

**I-06B · Timing budgets invisible** — **Partially-handled.**
`formatErrorBreakdown` shows per-reviewer elapsed ("errored after 320.1s", `loop-driver.ts:373-386`) but never the configured budget; `doctor`'s hook-timeout check (`doctor.ts:261-301`) is a passive warn, not auto-fix; no "elapsed vs budget" pairing.

**I-07 · Infra-error streak liveness** — **Partially-already-handled.**
Quota → defer/allow (`handleAllQuotaLocked`, `loop-driver.ts:1043`); timeout → dedicated `incomplete_runs` counter, escalate after 2 (`handleIncompleteRun`, 1058-1093). But a *plain* ERROR (exit-0-no-JSON, crash) has **no dedicated counter** — it ages the shared `iteration` counter and after 3 escalates `max-iterations` with the **dishonest** message "real findings not decreasing" (`loop-driver.ts:569-574`). Within-iteration failover (fallback chain + `LAST_RESORT_ORDER`) already exists and is thorough. The gate does **terminate** (not infinite) — the gaps are the dishonest message and budget-sharing with real FAILs.

### Theme 4 — Correctness

**I-08 · exit-0-but-no-valid-JSON** — **Confirmed (nuanced).**
Every adapter already classifies exit-0-unparseable as `status:"error"` → excluded from `okRuns` → triggers failover (NOT a silent pass). But **only codex retries** in-process (`RETRY_DIRECTIVE`, `src/providers/codex.ts:241-264`); claude/opencode/gemini have **zero** retries. Only codex (`--output-schema`) and openrouter (`json_schema` strict) force structured output; gemini/opencode can't, claude's `--output-format json` envelope wraps free text.

**I-10 · Semantic-only review, no build/tests** — **Confirmed.**
The pipeline never spawns `tsc`/`bun test`/lint (`src/core/orchestrator.ts` triage→research→panel→critic→aggregate→report). codex has `--disable shell_tool --sandbox read-only`; claude disallows Bash. No `checks`/`commands` config exists (`src/config/define-config.ts`). 4 PRs passed green then broke on integrated `tsc`+suite. By design, but unlabelled.

---

## 2. Remediation roadmap (prioritised milestones)

Effort: S ≤ ½ day · M ≈ 1–2 days · L ≈ 3+ days. Each task lists files + risk + DoD signal.

### M-A0 · Fail-CLOSED hardening (P0-above-P0) — *a gate that fails open is worse than no gate*

> **Status (2026-06-03):** A0.1 ✅, A0.2 ✅, A0.3 ✅, A0.4 ✅ — **M-A0 COMPLETE** on branch `fix/m-a0-fail-closed-hardening`. TDD throughout; tsc + lint clean, full suite 1344 pass/0 fail (7 new tests). Budget constants extracted to `src/config/budgets.ts`; doctor derives its fail-open margin from them (no drift). **Full reviewer DoD PASSED:** Codex found 3 real CRITICALs + 1 boundary WARN across passes (all fixed) + rejected 1 sandbox false-positive; final Codex PASS; Claude PASS. Next: M-A1/A2/A3 (lock / defer / hung-holder).

> Distinction: a **controlled** defer (A2, with `deferred.flag` eventual-review guarantee) is acceptable; a **silent uncontrolled** fail-open (crash / OS-kill, no record, change never reviewed) is never acceptable.

**A0.1 — Top-level fail-closed catch-all** [S] — wrap the `gate` command's `run()` (and add `process.on('uncaughtException')`) so ANY error emits `{"decision":"block","reason":"🔴 … internal error: <msg>. Run reviewgate doctor; re-run to retry."}` to stdout and `exit(0)`. Never let an exception reach citty's stderr+exit(1).
*Files:* `src/cli/index.ts`, `src/cli/commands/gate.ts`. *Risk:* low (strictly safer direction). *DoD:* test that forces `runGate` to throw asserts a block JSON on stdout.

**A0.2 — Bound pre-deadline setup work** [M] — start a wall-clock budget at the top of `runStopGate` covering config+git+state load, sized so `setup + runTimeoutMs + post-abort ≤ OS Stop-hook timeout − margin`. Lower `GIT_TIMEOUT_MS` (30 s→10 s) and/or enforce a setup AbortController; a setup overrun fails CLOSED with a clear block, never a silent kill.
*Files:* `src/utils/git.ts`, `gate.ts`, `defaults.ts`. *Risk:* medium (more `diffIncomplete` markers in slow FS — already self-labelled, preferable to a kill). *DoD:* slow-`collectGitInfo` test fails closed.

**A0.3 — Bound `await runP` after abort + propagate signal** [S] — wrap the post-abort settle in its own hard timeout; wrap `pairActiveFpEntries` in `withTimeout(curatorTimeoutMs)` and pass `opts.signal` so the FP-brain coupling loop short-circuits on abort.
*Files:* `loop-driver.ts:809`, `orchestrator.ts:1319`, `src/core/brain/fp-coupling.ts`. *Risk:* low. *DoD:* abort terminates the coupling loop in a test.

**A0.4 — Margin audit** [S] — reduce default `loop.runTimeoutMs` (840 s→~720 s) to restore a ≥120 s setup+settle margin under the 900 s OS timeout; make `doctor` warn when `OS_timeout − runTimeoutMs < MIN_SETUP_MARGIN`. Document the relation in the init scaffold.
*Files:* `defaults.ts`, `doctor.ts`, `init.ts`. *Risk:* low. *DoD:* doctor flags an under-margin config.

### M-A · Multi-session survival (P0) — *fixes the actively-broken environment*

**A1 — Pre-lock empty-diff fast-path** [S]
Before `flock` in `runGate`, `existsSync(dirtyFlagPath)`; if absent and HEAD hasn't advanced past `last_reviewed_head_sha`, return `allow_stop` with **no lock and no git I/O**.
*Files:* `src/cli/commands/gate.ts`. *Risk:* low (LoopDriver already does the semantic check). *DoD:* unit test asserts flock not attempted on no-dirty-flag stop.

**A2 — Defer-on-contention (never block on a busy/hung lock)** [S–M]
On acquire-timeout, instead of `decision:"block"`, write a `deferred.flag` and return `allow_stop` "🟠 GATE DEFERRED — another review in progress; this turn not reviewed, will be reviewed next turn." Treat `deferred.flag` like `dirty.flag` so the change is **guaranteed** reviewed later; clear it on PASS and on `reset`. Model exactly on `handleAllQuotaLocked`.
*Files:* `gate.ts`, `src/utils/paths.ts` (+`deferredFlagPath`), `src/core/loop-driver.ts` (honour deferred flag), `src/hooks/handlers.ts` (clear on reset). *Risk:* **security tradeoff** — a contended turn ends un-reviewed (eventual-review guarantee instead of every-turn). Decision D-1. *DoD:* contended-lock test returns allow_stop + deferred.flag; next run reviews; reset clears.

**A3 — Hung-holder recovery & diagnostics** [M]
(a) Lock-holder **heartbeat**: holder rewrites `gate.lock` mtime/`heartbeat_ts` every ~30 s during the run; peers reclaim when heartbeat is stale (≥3 missed) **and** PID unresponsive — preserving "never steal a live, progressing holder". (b) Include holder **PID + age** in the contention message so a human can `kill`. (c) **SIGTERM handler** in the gate process: abort reviewers, release lock, exit — so `kill -TERM` cleanly unblocks peers. (d) Add a **wall-time hard cap** independent of byte streaming in `spawnSafely`, and lower the default `loop.runTimeoutMs` (840 s → e.g. 600 s) / make the acquire timeout configurable.
*Files:* `src/utils/flock.ts`, `src/utils/spawn.ts`, `gate.ts`, `loop-driver.ts`, `src/config/defaults.ts`. *Risk:* medium — heartbeat-reclaim must not regress the dead-PID-only exclusivity invariant (gate behind both conditions). *DoD:* deterministic test: stale-heartbeat + unresponsive PID → reclaim; live heartbeat → no reclaim; SIGTERM releases lock.

**A4 — State namespacing for true isolation** [L] — *Decision D-2*
Namespace `.reviewgate/` per **worktree** (clean: each worktree = own working tree = own diff + own state — already the recommended pattern) and/or per **session** (isolates lock+counters on a shared checkout, but the *diff* is still the shared working tree — surface that caveat). `reviewgateDir()` gains a namespace resolved pre-lock from `git rev-parse --git-common-dir`/worktree path or the hook-stdin `session.id`.
*Files:* `src/utils/paths.ts` (+~40 call sites), `gate.ts`, `handlers.ts`, `init.ts`. *Risk:* high (broad call-site change; per-branch alone doesn't help same-branch agents). *DoD:* two worktrees review concurrently with zero lock contention.

**A5 — Review-base anti-drift** [M]
At `handleTrigger`, also capture `fork_point_sha = git merge-base HEAD @{u}` (locally-cached upstream tip — survives later rebase). At stop, prefer the *more recent* of `fork_point_sha` and `base_sha` as the diff base (rebase → fork_point excludes foreign commits; normal session → base_sha preserves commit-per-task). Fall back cleanly when no upstream. Add a "HEAD jumped > N commits since base" guard that warns/resets.
*Files:* `src/hooks/handlers.ts`, `src/utils/git.ts` (+`gitMergeBase`, `commitCountBetween`), `gate.ts`, `src/schemas/state.ts`/dirty-flag shape. *Risk:* medium (stale `@{u}`, no-remote, detached HEAD all need graceful fallback). *DoD:* integration test: rebase-onto-moved-main → diff contains only the user's commits; commit-per-task still reviewed.

### M-B · False-confidence & wolf-cry (P1) — *restores trust*

**B1 — Security-claim verification** [M]
(a) Inject authoritative per-file git status into `research.md` trusted context: `[UNTRACKED — never committed]` / `[TRACKED]` (use `git log -- <file>` + the untracked set already computed in `collectDiff`). (b) Preamble + security persona guard: verify "committed/exposed/baked-into-history" against those labels before CRITICAL+rotate; "a project UUID is not a credential". (c) Deterministic belt-and-suspenders: demote security CRITICALs whose message matches `committed|version control|baked|rotate|exposed` **and** whose file is in the never-committed set.
*Files:* `research-writer.ts`, `git.ts` (expose untracked set), `orchestrator.ts` (preamble), `personas.ts`, `aggregator.ts`. *Risk:* low–medium (keyword filter scoped by dual condition). *DoD:* test: untracked-UUID file → no "committed" CRITICAL.

**B2 — Cross-iteration FP propagation** [M]
(a) Inject a "## Prior-iteration rejections (do not re-raise without new evidence)" prompt section built from `cycleRejectedSignatures` + the prior `pending.json` (file/rule/reason/line) — sanitized like `fpFewShot`. (b) Harden `cycleRejected` matching: store the rejected finding's line range and match on (file, normalizedRuleId, category) within a proximity window, so a line-jittered recurrence is still demoted.
*Files:* `orchestrator.ts` (prompt), `loop-driver.ts` (carry line ranges), `aggregator.ts`, `signature.ts`. *Risk:* low for (a); medium for (b) — add line-distance guard to avoid suppressing genuinely distinct same-rule findings. *DoD:* test: finding rejected iter1 → INFO (not blocking) in iter2 even at a jittered line; reviewer prompt contains the rejection note.

**B3 — Read-before-WARN discipline** [S]
Preamble + persona reaffirm: "If a finding concerns a file you have not read, either read it and confirm, or emit INFO (confidence ≤ 0.4) stating the file was not inspected — never WARN/CRITICAL on an unconfirmed cross-file suspicion." Consider a non-zero `confidenceFloor` default (gated by corroboration/security exemptions).
*Files:* `orchestrator.ts`, `personas.ts`, optionally `defaults.ts`. *Risk:* low (prompt). *DoD:* preamble-contains test; behaviour validated on a real CLI run.

**B4 — Correlated consensus down-weighting** [M]
(a) Count distinct **model families** (openai/google/anthropic/openrouter), not raw `provider:persona`, in `computeConsensus` — same-family agreement caps at `majority`. (b) Give the critic `confirmed_by` + a "shared unverified assumption" detector; relax the `isCorroborated` exemption **only** for a new `correlated_fp` critic verdict (never for security/correctness). (c) Advisory "⚠ near-identical wording across reviewers" badge in `pending.md` using the existing `jaccard()`.
*Files:* `aggregator.ts`, `critic.ts`, `finding.ts`, `report-writer.ts`. *Risk:* medium — demote-only, must not silently kill real corroborated bugs. *DoD:* same-family unanimous → majority; correlated_fp path covered by tests.

**B5 — Introduced-vs-surfaced tagging + off-diff scoping + self-allowlist** [M]
(a) Compute literally-added lines (not just hunk range) in `hunks.ts`; tag findings `introduced_by_diff` vs `surfaced_by_proximity`; render in separate `pending.md` sub-sections.
(b) **I-17 fix:** stop off-diff **security/correctness** findings from blocking unconditionally. Either narrow `outOfDiffBlocking` so a finding on a file *not in the diff at all* is demoted to INFO (tag "pre-existing, not introduced"), or require an off-diff CRITICAL to be re-confirmed against the diff before blocking.
(c) **Self-allowlist:** suppress findings whose file is under `.reviewgate/**` or `reviewgate.config.ts` (already excluded from the diff, but reviewers explore them off-diff) — a Reviewgate-enabled repo must not make every branch "eat" a CRITICAL on Reviewgate's own machinery. Keep the *detector* (it's valuable) but scope it out of self-review.
(Optionally, config to demote `surfaced_by_proximity` one severity step — separate decision.) Foreign-untracked exclusion is largely handled by A5 + A4.
*Files:* `hunks.ts`, `aggregator.ts` (scopeFindings + self-allowlist), `git.ts` (allowlist set), `finding.ts`, `report-writer.ts`. *Risk:* low–medium (must not blind the gate to genuine in-diff security issues — allowlist is path-scoped, off-diff demote is diff-scoped). *DoD:* test: spec-only branch in a Reviewgate repo produces no CRITICAL on `.reviewgate/bin/*`; an in-diff security bug still blocks.

### M-C · Error-path UX & liveness (P2)

**C1 — ERROR+0-findings clarity** [S] — suppress "## Required actions" when 0 blocking findings (`report-writer.ts`); append "No findings to triage — end your turn again to re-run the review." to the ERROR message (`loop-driver.ts:966`).
**C2 — Timing transparency** [S] — show reviewer budget alongside elapsed in ERROR/incomplete messages; doctor emits a concrete corrective Stop-hook timeout value.
**C3 — Docs alignment** [S] — `docs/AGENTS.md`: add ERROR + DEFERRED examples and the real prefix set; document that user CLAUDE.md should trigger on `🔴 Reviewgate · GATE CLOSED` / `🟠 GATE ESCALATED` / `🟠 GATE DEFERRED`, not "Reviewgate FAIL".
**C4 — Infra-error liveness** [M] — add a `consecutive_errors` state counter (reset on any non-ERROR verdict); after K, escalate with an honest `reviewer-error-streak` reason ("reviewer infrastructure failed repeatedly — run doctor"); decide block vs allow_stop-with-warning (Decision D-1 family). Render ERROR rows honestly in `ESCALATION.md`.

### M-D · Reviewer robustness (P2)

**D1** [S] — generalise the codex `RETRY_DIRECTIVE` in-process retry to `claude.ts` + `opencode.ts`.
**D2** [S] — add a `parse-error` `ReviewStatus` distinct from generic `error` for observability (failover already covers it).
**D3** [M] — enforce structured output on claude via a `submit_review` tool-call (verify `claude -p` tool support first).
**D4** [S] — extend the strict-mode schema CI guard to the `memory_proposals.evidence` subtree.

### M-E · Build/test verification (P3, opt-in) — *Decision D-3*

**E1 — Honest labelling** [S] — preamble + report header: "Semantic diff review only; `tsc`/tests NOT run; DoD step-1 mandatory before accepting PASS."
**E2 — Deterministic checks phase** [M] — opt-in `phases.checks: [{cmd,args,timeoutMs}]`; run before the panel (unsandboxed, as the gate process, own aggregate timeout); non-zero exit → blocking `correctness` CRITICAL `rule_id:"build-check-failed"`; default `null` (no behaviour change). Scaffold in `init`.
**E3 — Attestation** [S–M, optional] — require a `checks_attestation` decision line when `phases.checks.requireAttestation`.

---

## 3. Decisions (made 2026-06-03 by Markus)

- **D-1 · Fail-safe-degrade [CHOSEN].** Defer-on-contention + infra-error → allow_stop, with the `deferred.flag` eventual-review guarantee; never a turn-block from a busy/hung gate. (The silent fail-open I-16 is fixed unconditionally regardless.)
- **D-2 · Defer+Heartbeat now, per-worktree namespacing later [CHOSEN].** Ship A1–A3 first (unblocks shared-checkout immediately), per-worktree namespacing (A4) as a follow-up; per-session namespacing rejected (doesn't fix shared-diff scope-mixing).
- **D-3 · Honest labelling first [CHOSEN].** Ship E1 (clear "semantic review only — tsc/tests NOT run" labelling). E2 deterministic checks phase left open as a later feature; attestation not pursued for now.

---

## 4. Suggested execution order

1. **M-A0** (fail-closed hardening) — **first, non-negotiable.** A silently-fail-open gate makes every other improvement moot. Mostly S, one M.
2. **M-A1, A2, A3** (P0, mostly S/M) — stop the multi-session bleeding (empty-diff fast-path, defer-on-contention, hung-holder recovery). Ship right after A0.
3. **M-A5** (rebase base-drift) — small, high-value, independent.
4. **M-B1, B2, B3, B5** (trust: security wolf-cry, FP recurrence, read-before-WARN, scope+self-allowlist) — mostly S/M, high user-visible payoff. B5(c) self-allowlist is tiny and stops the meta-finding immediately.
5. **M-C** batch (UX/docs) — cheap, ships alongside anything.
6. **M-A4** (namespacing) — larger, after D-2.
7. **M-B4** (consensus) — medium.
8. **M-D** (reviewer robustness).
9. **M-E** (build verification) — per D-3.

Each milestone is independently shippable; run the project's own DoD (`bunx tsc --noEmit` + `bun run lint` + `bun test`, real-CLI verification for provider/prompt changes) and dogfood the gate before merge.
