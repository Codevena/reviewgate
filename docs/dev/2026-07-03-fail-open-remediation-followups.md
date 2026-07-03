# Fail-Open Remediation (S1–S6) — Follow-ups & Handoff

Branch `feat/fail-open-remediation` (4498ee4..ce05213, 19 commits) closed six audit-verified
fail-open defects. Process: 18-round codex Plan-Gate → subagent-driven TDD (10 tasks, per-task
adversarial reviews with 3 empirically-reproduced Criticals caught and fixed) → whole-branch
review (fixes applied) → DoD (codex r1 FAIL→fix→r2 PASS; claude PASS). Suite 2534/0, tsc+lint
clean. Plan: `docs/superpowers/plans/2026-07-03-fail-open-remediation.md`.

## Follow-up tickets (from the reviews — none merge-blocking, all verified non-regressions)

1. **F-005 capture-window race + snapshot-time tree hash** — **LARGELY CLOSED** (dogfood F-001
   fix, `fix(gate): reset never blesses a dirty or escalated tree; tree hash recorded at
   diff-snapshot time`): the tree hash is now memoized ONCE at diff-snapshot time
   (`SetupBundle.snapshotTree`, gate.ts, right after `gatherReviewContext`) and every
   `LoopDriver` write site (head-move record, post-review write, escalation announce) flows
   through it via `this.i.treeHash` — a mid-review concurrent edit yields stored ≠ post-edit
   tree, so the next Stop probe returns `"review"` even though F-005 deletes the flag on PASS
   (pinned end-to-end in `tests/unit/gate-treehash-snapshot.test.ts`). **Residual (still open):
   compare-at-delete only** — `unlinkDirtyFlagIfUnchanged` still compares against the flag
   captured at `run()` start, not the diff-snapshot-time flag state, so a trigger flag landing
   between the diff snapshot and `readDirtyFlag` is still treated as "the batch this run
   reviewed" and deleted on PASS (the tree-hash mismatch now catches the CONTENT, so this is a
   scope/base-bookkeeping nit, not a fail-open). Also a sub-ms residual: an edit landing between
   `collectDiff` inside `gatherReviewContext` and the snapshot hash is still blessed (was a
   minutes-wide window).
2. **SessionStart destroys the loud escalation handoff** — **PARTIALLY CLOSED** (dogfood F-002
   fix, same commit): `handleReset` no longer blesses an unreviewed tree — (a) an ESCALATED
   pre-wipe state's `last_reviewed_head_sha`/`last_reviewed_tree_hash` are CARRIED OVER into
   the fresh seed (the escalated range stays inside the next synthesis diff; escalation-metadata
   hygiene unchanged), and (b) a non-escalated reset seeds the tree hash ONLY when the working
   tree is genuinely clean (empty working-tree diff; dirty/error → null → next Stop probe fails
   toward review). **Residual (still open): ESCALATION.md file preservation** — the reset still
   deletes ESCALATION.md, so the loud human-facing artifact is gone even though the review
   coverage is now safe; direction unchanged (preserve the file or emit a one-time 🟠 notice
   across reset when `escalated=true`).
3. **Verdict-case normalization in `parseReviewOutput`** (whole-branch Minor #4): a reviewer
   emitting `"pass"`/`"Pass"` is coerced to FAIL and, with only advisory findings, now becomes
   a lossy ERROR (fail-closed but churns cooldown/failover). 1-line case-normalize when a field
   report shows ERROR noise from a case-sloppy free-form reviewer.
4. **`consumeDeferredFlag` check-then-write shape** — verified benign (over-review direction,
   under the gate lock), align with `writeFileIfAbsent` for uniformity.
5. **`passLedgerEligible` symmetry** (Task-9 INFO): checks `cycleRejectedSignatures` empty but
   not `claimedFixedSignatures` — safe via the `cfx` segment in `ledgerEnvHash`; align for
   clarity.
6. **Stale ESCALATION.md after latch clear / clean recovery** (whole-branch Minor #7): state
   clears but the file stays; consider stamping/removing on `quotaLatchClears`.
7. Test-polish batch: meta-path exclusion/rename/"gone" tests (T1); key-omission back-compat
   test for the 3 new state fields (T2); dedup-to-SKIP MultiEdit test (T4); Path-A
   announced+post-announce-flag unit test (T5); rawText assertions for gemini/opencode (T6);
   429 "don't simplify back" rationale into source comments (T8); belt `diff_hash` sentinel
   naming (whole-branch Minor #8).

## Next feature (agreed with Markus, design already sketched): Agent Lessons

The gate is currently only reviewer-side intelligent (FP-ledger, reputation, implicit-outcomes,
few-shot, brain — ALL calibrate the panel). Accepted+fixed findings — the highest-value signal
(a verified, categorized, located mistake by the agent) — are only used to credit reviewer
trust; the mistake PATTERN is discarded, and nothing feeds back into Claude across sessions.

Design sketch (mirror of the FP-ledger, agent-facing):
1. **Collect**: on decision-absorb, fold accepted(+fixed) findings → `learnings/agent-lessons.jsonl`
   (category, rule_id, file/symbol, message, signature) — reuse foldLastDecisions/flock/
   prune-at-write/watermark infra 1:1.
2. **Distill**: recurrence (same category/rule/region ≥N across sessions) → one-line imperative
   lessons; optionally via `adapter.complete()` like the curator.
3. **Inject** (both render-only/advisory, NEVER verdict-affecting — house principle):
   a. SessionStart hook stdout = additionalContext (reviewgate already runs there!): top-K
      lessons, e.g. "In diesem Repo bisher 4× gefangen: fehlende additionalProperties:false".
   b. pending.md header on recurrence: "Diesen Fehlertyp hat das Gate hier schon N× gefangen".
4. **Safety**: sanitize like research.md (reviewer text over semi-trusted diffs), size caps,
   TTL pruning, opt-in `phases.agentLessons` (z.…().optional() + defaults.ts convention).
5. **Later**: global tier `~/.reviewgate/lessons` (mistake patterns are often repo-independent).

Write the spec (docs/superpowers/specs/), run it through the Plan-Gate, then implement — same
process as this branch.
