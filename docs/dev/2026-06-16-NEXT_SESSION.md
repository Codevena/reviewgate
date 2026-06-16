# NEXT SESSION — flashbuddy field-report remediation (remaining #4/#5/#7/#8/#10)

Paste the prompt below to start the next session. Full status + per-item detail + lessons live in
`docs/dev/2026-06-16-flashbuddy-field-report-remediation.md` (read it first).

---

## Prompt to paste

```
We're continuing the flashbuddy field-report remediation in the Reviewgate repo
(/Users/markus/Developer/reviewgate). Reviewgate is a code-review gate that dogfoods itself — a
.reviewgate/ dir is present and the Stop hook reviews your own turns here.

5 of 10 field-report recommendations are SHIPPED (#1 redaction-demote, #2 file-context scoping,
#3 dep-surface injection, #6 diff-size warn, #9 test-file severity). 5 remain. Before doing
anything, READ:
- docs/dev/2026-06-16-flashbuddy-field-report-remediation.md  (the roadmap: each item, status,
  partial state, and the recurring engineering lessons)
- the three specs/plans under docs/superpowers/{specs,plans}/2026-06-16-* (the shipped patterns)
- your memory index (MEMORY.md) — the project_* entries for the shipped work + the gotchas

Remaining items (detail + partial state in the roadmap doc):
- #10  Don't escalate on a quota-degraded panel — defer until quota reset. (Most tractable; the
       degradation is already detected, just stop escalating on an incomplete panel.)
- #8   Calibrate confidence/block-force per provider — wire the existing `reviewgate stats`
       precision metric (TP/(TP+FP) per provider) into the aggregator's block weighting.
- #7   Don't review in-flight/half-finished states — detect uncommitted churn / a recent-write
       window / an active background workflow before spawning the panel (partial: mtime-gate).
- #5   Break the iteration treadmill — cap same-signature re-raises harder; net-diff posture
       (partial: review-base, convergence-grace, fp-streak).
- #4   Persist adjudications across iterations / fix the FP-ledger signature fragmentation (the
       hardest — a durable cross-iteration suppressor; documented in house-rules.ts).

Suggested order: #10 → #8 → #7 → #5 → #4 (tractable → hard). Do ONE item at a time. Start by
asking me which item to tackle first (recommend #10).

MANDATORY workflow per item (same as the shipped ones — it works and the reviews caught real bugs):
1. superpowers:brainstorming — explore the current code FIRST, then present a design; for #3 the
   honest scope assessment + pivot saved an unsound feature, so surface walls, don't paper over.
2. Write the spec → review it with codex AND opus before the plan:
   - codex: write the prompt to a file, then run `codex exec "$(<file)" </dev/null` in its OWN Bash
     call (foreground, stdin closed — a heredoc/&&-compound backgrounds it to a 0-byte hang).
   - opus: dispatch an opus agent (model: opus) as an independent senior reviewer.
   - Fix every CRITICAL/WARN; re-run until PASS. Verify each finding against the code — don't blindly
     comply, but don't loop for green against a correct reviewer either.
3. superpowers:writing-plans → superpowers:subagent-driven-development: fresh subagent per task
   (sonnet), two-stage review (spec-compliance then code-quality) between tasks, then a final opus
   whole-branch review.
4. Each feature on its own branch (feat/...). Merge with `git merge --no-ff` using EXPLICIT paths
   (NEVER `git add -A` — it sweeps local .reviewgate/ dogfood state; master tracks only
   .reviewgate/personas/).
5. The dogfood gate reviews your branch on turn-end. Address findings via the decisions protocol.
6. After the final opus PASS + gate PASS, STOP and ask me before push/deploy.

Conventions & gotchas (cost real time last session — honor them):
- `bun run build` DEPLOYS via the ~/.local/bin/reviewgate → dist symlink to ALL repos. Do NOT build
  before merge + my OK; the dogfood gate should review with the trusted (merged) dist, not the
  branch's own unreviewed logic.
- A review/impl subagent's `git checkout <sha>` DETACHES the main HEAD (subagents share the working
  tree). Re-verify `git branch --show-current` after git-touching subagents before committing/merging.
- Run the full suite as `bun test tests/unit --timeout 20000` — the default 5s per-test timeout makes
  some unrelated subprocess-spawn tests flake under load (not real failures).
- Design principle proven this remediation: a suppressor that demotes/drops must FAIL SAFE — require a
  POSITIVE "safe-to-suppress" signal so unrecognized cases stay blocking; an exclusion-only rule fails
  open. If sound verification needs something out of reach (e.g. TS type resolution for #3), pivot to a
  non-suppressing approach (context injection) rather than ship an unsound demote.
- Use bun/bunx (not npm/node); `bunx tsc --noEmit` + `bun run lint` (biome) must be clean before "done".

Note: the roadmap doc commit (71405f9) and this NEXT_SESSION doc may be local-only on master (1+
ahead of origin) — check `git status` / `git log origin/master..master` and push if I approve.
```
