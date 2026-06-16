# flashbuddy Field-Report Remediation — Roadmap & Status

**Date:** 2026-06-16
**Source:** A field report from running the deployed Reviewgate binary on the **flashbuddy** project (a ~10-iteration session: 170-file audit PR + 23-PR test-backlog merge). The report praised the real bugs caught but flagged high false-positive rate, context-blind reviews, an iteration treadmill, and timeouts on large PRs, with 10 prioritised recommendations.

This doc tracks each recommendation → triage verdict → ship status. **6 of 10 shipped** (#1, #2, #3, #6, #9, #10); 4 remain (#4, #5, #7, #8).

## Shipped

| # | Recommendation | What shipped | Where |
|---|---|---|---|
| **1** | Fix the redaction-artifact FP (reviewer flags Reviewgate's own `<REDACTED:…>` placeholder as a CRITICAL bug) | Aggregator **demotes** a finding whose subject targets the `<REDACTED:…>` placeholder, gated by a POSITIVE code-hallucination signal (fail-safe; security/secret-word findings stay blocking). 3 dogfood-gate iterations hardened it (drop → demote → positive-signal gate). | master `4aab4e3` (tier-1 merge). `src/core/aggregator.ts` `isRedactionArtifact`, `redaction_demoted`. |
| **9** | Scale severity by file type (test-mock secret ≠ prod CRITICAL) | Security findings on `classify()==="tests"` files → INFO, only when the whole cluster is security (no inverse-masking). Config `phases.review.demoteTestSecurity` (default true). | master `4aab4e3`. `src/core/aggregator.ts` `test_severity_demoted`. |
| **6** | Couple timeout to diff size / warn early | `computeLargeDiff` in `gate.ts` (outside the loop self-deadline) → stderr warn + `pending.md` banner when the diff exceeds `loop.diffWarnBytes` (600k) / `diffWarnFiles` (80). WARN-only, no auto-scaling (the OS-hook fail-open risk). | master `4aab4e3`. `src/cli/commands/gate.ts`, `report-writer.ts`. |
| **2** | Give reviewers full file/function context, not just the diff hunk | `collectFileContext`: small files whole; large files → symbol outline + enclosing function/component/class bodies of the changed ranges (overlap selection, nesting collapsed) + line-window fallback. Per-language tree-sitter queries (TS arrow-const/class; Python def/class = net-new). Grounding corpus kept whole-file (zero regression). Config `fileContextPerFileBytes` (8000) / `fileContextWindowLines` (40). | master `7cfa892`. `src/research/file-context.ts`, `symbol-graph.ts`. |
| **10** | Don't escalate on a quota-degraded panel — defer instead | **Bounded defer (Approach 1, defer-only):** when a give-up escalation (the soft `max-iterations` non-progressing case, or `stuck-signatures`) would fire while a configured reviewer is in cooldown (quota cap **or** timeout/error backoff — `quotaDegradationNote`), `escalateAndDecide` DEFERS instead: `allow_stop`, dirty flag KEPT, `iteration` NOT advanced, no escalation state set. Bounded by a new `consecutive_quota_defers` counter + `loop.quotaDeferMaxConsecutive` (default 3, `0` disables) → escalates as a fail-closed backstop once the cap is exhausted; resets on escalation-proceed + on the normal post-review update. New `deferableOnQuota` param on `escalateAndDecide`, set `true` at ONLY the soft-max-iter + stuck call sites (hard-cap/cost-cap/decisions-unaddressed/timeout/infra/fp-streak/reject-rate stay non-deferable). Mirrors the infra-defer pattern. | master `742a26d` (merge). `src/core/loop-driver.ts` `escalateAndDecide`; `src/schemas/state.ts`; `src/config/{define-config,defaults}.ts`. |
| **3** | Ground "API doesn't exist" claims against the installed dependency version | **SOFT injection** (pivoted from an unsound hard-verify demote — a `.d.ts` grep can't prove member-of-binding without TS type resolution → would suppress real findings): inject the installed package's export surface as ADVISORY reviewer context. `collectDepSurface` (entry resolution + bounded re-exports; IDENT-whitelisted names + best-effort members; injection-proof). Config `depSurface` (default true) / `depSurfaceBudgetBytes` (4000). | master `d993737`. `src/research/dep-surface.ts`, `imports.ts`. |

All five went through the full chain: brainstorm → spec → codex(+opus) spec review → plan → subagent-driven build (per-task spec+quality review) → final opus whole-branch review → dogfood gate. Each merged + pushed + dist deployed.

## Remaining (next-roadmap candidates)

| # | Recommendation | Notes / partial state |
|---|---|---|
| **4** | Persist adjudications across diff changes (a rejected FP must not return as a fresh CRITICAL) | Partial today: `renderAdjudications` injects prior-iteration decisions (prompt-soft) + FP-ledger. Real residual: the **FP-ledger signature fragmentation** (a hallucination class whose `rule_id`/signature fragments so the ledger never promotes+suppresses it — documented in `house-rules.ts`). A durable fix likely needs signature-class clustering or a stronger cross-iteration suppressor. |
| **5** | Break the iteration treadmill (review net-diff vs original base; cap re-raises) | Partial: review-base sha in `dirty.flag` (covers commit-per-task), signature dedup, convergence-grace, reviewer-fp-streak. Field experience still showed large changesets treadmilling. Candidate: cap same-signature re-raises harder; surface a "stop changing code, only reject" off-ramp. |
| **7** | Don't review in-flight / half-finished states | Partial: P1 untracked-scope mtime-gate (2026-06-05). Residual: no awareness of an active background workflow still writing files. Candidate: detect uncommitted churn / a recent-write window before spawning the panel. |
| **8** | Calibrate confidence per provider/persona (openrouter minority ≠ codex unanimous) | Partial: reputation (demote-only, lone non-security). Not yet a precision-weighted block-force per provider in the CRITICAL/WARN bucket. The `reviewgate stats` precision metric (TP/(TP+FP) per provider) now exists and is the data source — wire historical precision into the aggregator's block weighting. |

## Recurring engineering lessons from this remediation

- **An exclusion-based suppressor fails OPEN; require a positive "safe-to-suppress" signal** so unmatched cases fail closed (redaction gate-4; also the dep-verify pivot).
- **A heuristic that can suppress a real finding is unacceptable** for the gate — when soundness needs TS type resolution (out of reach), pivot to non-suppressing context injection (#3).
- **`bun run build` deploys via the `~/.local/bin/reviewgate` → dist symlink to ALL repos** — never build before merge + user OK; the dogfood gate should review with the *trusted* (merged) dist, not the branch's own unreviewed logic.
- **Never `git add -A` here** — it sweeps local `.reviewgate/` dogfood state into the commit (master tracks only `.reviewgate/personas/`); stage explicit paths.
- **Subagents share the git working tree** — a reviewer subagent's `git checkout <sha>` detaches the main HEAD; re-verify the branch after git-touching subagents.
- The **dogfood gate earned its keep**: it drove real hardening beyond the static codex+opus reviews (redaction drop→demote→gate-4 over 3 iterations; test-severity inverse-masking) and PREVENTED shipping the unsound #3 hard-verify demote.
