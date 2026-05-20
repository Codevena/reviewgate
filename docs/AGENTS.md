# Reviewgate — Guide for AI Coding Agents

This document tells an AI coding agent (e.g. Claude Code) **exactly** how to behave
when working in a repository that has Reviewgate installed. Read it once at the
start of a session in such a repo.

## What Reviewgate does to you

Reviewgate is wired into two Claude Code hooks:

- **`PostToolUse`** — after every `Edit`/`Write`/`MultiEdit`/`NotebookEdit`, a
  background hook marks the repo "dirty". You do not need to do anything.
- **`Stop`** — when you try to end your turn, Reviewgate reviews your
  uncommitted changes (`git diff HEAD`) with an LLM reviewer. If it finds
  blocking issues, **your turn is blocked**: you will receive a `Stop`-hook
  message with `decision: "block"` and a `reason`, and you must keep working.

You cannot finish your turn while there are unaddressed blocking findings. Do not
try to disable the hook, delete `.reviewgate/`, or otherwise bypass the gate —
fix the underlying issues instead.

## The block message

When blocked, the `reason` looks like:

> Reviewgate FAIL — iteration 1 of 3. See `.reviewgate/pending.md`. Append
> per-finding decisions to `.reviewgate/decisions/1.jsonl`.

The number (`1`) is the **current iteration index**. Use it as the decisions
filename: iteration 1 → `.reviewgate/decisions/1.jsonl`.

## Multi-reviewer panel (M2)

From M2 onwards Reviewgate runs a panel of reviewers in parallel (Codex, Gemini,
Claude, or any OpenRouter model). You may see two extra fields on findings in
`pending.md`:

- **`confirmed_by`** — lists the providers that independently reported the same
  finding. A finding confirmed by multiple reviewers carries higher confidence and
  should be prioritised for fixing over singleton findings.
- **`critic_verdict`** — when a critic phase is configured, the critic may mark a
  finding `"likely_fp"` (a likely false-positive), which demotes its severity one
  level (CRITICAL→WARN→INFO). A demoted finding is still present in `pending.md`
  so you can review it, but it weighs less toward a blocking verdict. The critic
  can never demote a CRITICAL security/correctness finding or one all reviewers
  agreed on.

The response protocol (read `pending.md`, write `decisions/<iter>.jsonl`) is
unchanged regardless of how many reviewers ran.

## Adaptive pipeline (M3)

From M3 onwards Reviewgate applies triage and research before running the panel:

- **Trivial diffs may pass without a review.** If the diff touches only
  documentation or non-executable files, Reviewgate issues an automatic PASS at
  $0 and your turn is allowed to end immediately — no reviewer spawned.
- **Finding signatures are now symbol-relative.** The `file:line` in a finding
  references the changed function or method name, not an absolute line number.
  This makes finding IDs more stable across edits: if you refactor surrounding
  lines the finding still points to the right place.
- **`research.md` is written before reviewers run.** If you see
  `.reviewgate/research.md` in the repo, it contains the symbol-graph context
  each reviewer received. You do not need to read or edit it; it is informational.

The response protocol (read `pending.md`, write `decisions/<iter>.jsonl`) is
unchanged.

---

## Your response protocol

1. **Read `.reviewgate/pending.md`** with your Read tool. It lists every finding,
   grouped by severity (CRITICAL ●, WARN ▲, INFO ·), each with an `id` like
   `F-001`, a `file:line`, a `rule_id`, a `message`, and `details`.

2. **For each finding**, decide one of two things:
   - **Fix it** — make the code change that resolves the finding.
   - **Reject it** — only if the finding is genuinely wrong or inapplicable.
     Rejecting requires a real, specific reason (≥ 20 characters). Do not reject
     just to make the gate pass.

3. **Record every decision** by appending exactly one JSON line per finding to
   `.reviewgate/decisions/<iter>.jsonl` (one finding `id` per line). The gate
   will not unblock until **every** finding `id` from the current iteration has a
   decision.

4. **Try to stop again.** The Stop hook re-fires, Reviewgate re-reviews, and if
   everything is addressed (and no new blocking findings appear) your turn is
   allowed to end.

## Decision file format

`.reviewgate/decisions/<iter>.jsonl` — one JSON object per line.

**Accepted (you fixed it):**

```json
{"schema":"reviewgate.decision.v1","finding_id":"F-001","verdict":"accepted","action":"fixed","files_touched":["src/auth.ts"]}
```

- `action` is required for accepted decisions: one of
  `"fixed"`, `"addressed-elsewhere"`, `"deferred-with-followup"`.
- `files_touched` and `commit_message_hint` are optional.

**Rejected (the reviewer is wrong):**

```json
{"schema":"reviewgate.decision.v1","finding_id":"F-002","verdict":"rejected","reason":"This Promise.all null-guard is intentional; the upstream type guarantees non-null — see src/cart.ts:40.","reviewer_was_wrong":true}
```

- `reason` is required and must be ≥ 20 characters and substantive.
- `reviewer_was_wrong: true` flags the finding as a false-positive candidate.

One line per finding. Match `finding_id` to the `id` shown in `pending.md`.

## Worked example

You edited `src/token.ts`. On stop you get:

> Reviewgate FAIL — iteration 1 of 3. See `.reviewgate/pending.md`.

You read `pending.md` and see one finding:

```
### F-001  ▲ WARN  ·  src/token.ts:2  ·  token-loose-equality
Loose equality (`==`) in a token comparison allows type coercion …
```

You change `==` to a constant-time comparison, then append to
`.reviewgate/decisions/1.jsonl`:

```json
{"schema":"reviewgate.decision.v1","finding_id":"F-001","verdict":"accepted","action":"fixed","files_touched":["src/token.ts"]}
```

You stop again → Reviewgate re-reviews → PASS → your turn ends.

## The "✅ PASS — acknowledge" message (acknowledgePass mode)

If the repo runs with `loop.acknowledgePass: true`, a PASSING review blocks your
turn ONCE with a message like:

> ✅ Reviewgate PASS on iteration 1 — the review is complete and clean, no
> findings to address. No action needed: simply end your turn again to finish.

This is NOT a failure and there is nothing to fix. Do not edit code, do not write
a decisions file. Optionally confirm the pass to the user in one short line, then
just end your turn again — Reviewgate will let you stop.

## Verdicts you may encounter

- **PASS / SOFT-PASS** — you are allowed to stop (SOFT-PASS = only minor WARNs).
- **FAIL** — blocked; follow the protocol above.
- **ESCALATE** — Reviewgate gave up after repeated rounds (max iterations, no
  progress, cost cap, or you ended a re-prompted turn without addressing the
  findings). It writes `.reviewgate/ESCALATION.md` and lets you stop. Surface the
  escalation to the human; do not silently move on.
- **ERROR** — the reviewer could not run (crash/timeout, or a sandbox mode it
  cannot satisfy). You are blocked, fail-closed. Tell the human to run
  `reviewgate doctor`; do not treat this as a pass.

## Rules

- **Never** edit, delete, or game `.reviewgate/` to escape the gate.
- **Never** mark a finding `rejected` without a genuine, specific reason.
- Prefer fixing over rejecting. Reject only when you can defend it to a human.
- Reviewgate only reports — **you** make the fixes, and the human commits.
- If you believe the gate itself is malfunctioning (not just a finding you
  disagree with), stop and tell the human rather than working around it.
