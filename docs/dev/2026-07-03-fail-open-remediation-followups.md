# Fail-Open Remediation (S1–S6) — Follow-ups & Handoff

Branch `feat/fail-open-remediation` (4498ee4..ce05213, 19 commits) closed six audit-verified
fail-open defects. Process: 18-round codex Plan-Gate → subagent-driven TDD (10 tasks, per-task
adversarial reviews with 3 empirically-reproduced Criticals caught and fixed) → whole-branch
review (fixes applied) → DoD (codex r1 FAIL→fix→r2 PASS; claude PASS). Suite 2534/0, tsc+lint
clean. Plan: `docs/superpowers/plans/2026-07-03-fail-open-remediation.md`.

## Follow-up tickets (from the reviews — none merge-blocking, all verified non-regressions)

1. **F-005 capture-window race + snapshot-time tree hash** (whole-branch Important #1 + Task-3
   reviewer Important). A concurrent session's trigger flag landing between the diff snapshot
   and `LoopDriver.run()`'s `readDirtyFlag` is treated as "the batch this run reviewed"; on a
   PASS, `unlinkDirtyFlagIfUnchanged` deletes it and the state write records the POST-edit tree
   hash (`loop-driver.ts` records `treeHash()` at write time) → next Stop can `skip-clean` over
   an edit no panel saw. Pre-existing window (this branch narrowed the adjacent clobber variant
   via `writeFileIfAbsent`); reachable only via a second session racing a seconds-wide window
   AND a PASS. Fix direction: capture the flag at diff-snapshot time (and/or hash the tree at
   snapshot time — strictly safer AND cheaper), compare-at-delete against the flag state the
   diff was computed under.
2. **SessionStart destroys the loud escalation handoff** (whole-branch Important #2, plan-level).
   `handleReset` deletes ESCALATION.md + flag + state and seeds the current (possibly
   unreviewed-dirty) tree as reviewed-through — a new session in a standing-down/quota-latched
   repo silently turns 🟢. Accepted by the plan (open question (c)) but in tension with S3b's
   goal. Direction: preserve ESCALATION.md (or emit a one-time 🟠 notice) across reset when
   `escalated=true`.
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
