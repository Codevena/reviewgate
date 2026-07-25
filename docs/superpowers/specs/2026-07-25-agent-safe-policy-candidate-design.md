# Agent-safe pending policy candidate (arming slice 3)

_Date: 2026-07-25 · Status: implemented (`b8565fa`, `d6b3631`, `1a832d1`, `81606ae`, `f789f6b`)_

## Problem

An agent that edits `reviewgate.config.ts` in a way the control plane classifies
as `approval-required` puts the gate into an unbounded block loop. The agent
cannot escape it: adopting the candidate requires `reviewgate config approve`,
which is TTY-only by design.

Field case (FlashBuddy): the FP-fragmentation banner told the agent to add
house-rules to `reviewgate.config.ts`. That is a non-monotonic policy change →
`approval-required`. Every subsequent turn-end re-blocked with a message the
agent had no way to act on.

### Mechanism

Two independent facts combine into the loop.

1. **A pending candidate forces a full review on every stop.**
   `gate.ts:413` — `const probe = policy?.change ? "review" : await stopProbe(...)`.
   `resolveControlPlaneConfig` keeps returning a non-null `change` for as long as
   the candidate differs from the approved policy; it never consults
   `reviewed_under_lkg_at` (`control-plane.ts:384–415`). So the cheap
   `skip-clean` fast-exit is unreachable while a candidate is pending.

2. **`approval-required` is converted into a block on every completed pass.**
   `gate.ts:1163–1178` — the `allow_stop` path calls
   `finalizeControlPlaneReview`, and an `approval-required` result is returned as
   `{"decision":"block"}`.

Together: `stop → forced review → clean PASS under LKG → finalize →
approval-required → block → stop → …`, with no bound. `LoopDriver`'s escalation
counters never fire, because the driver itself returned `allow_stop` and re-armed;
the block is layered on afterwards by `gate.ts`.

### `loop.acknowledgePass` is not the cause

`acknowledgePass:true` only changes *which* message the agent sees — the
block-path notice at `gate.ts:1131` instead of the `approvalMessage` at
`gate.ts:1175`. The recommended configuration (`acknowledgePass:false` +
`notify.desktop:true`) loops identically. The `acknowledgePass` block itself is
loop-safe in isolation: `loop-driver.ts:2141` deletes the dirty flag, so the
agent's re-stop would hit the "no changes → allow" branch — it never gets there
because fact (1) forces a review before that branch is reached.

Corollary: the fix belongs at the shared `approval-required` junction in
`gate.ts`, not in the `acknowledgePass` branch of `loop-driver.ts`.

## Goal

Once the code has passed under the last-known-good policy and the only open item
is a candidate that needs a human at a terminal, the gate stops driving the agent
loop: **one** blocking notice per candidate, then quiet visibility.

## Non-goals

- Approving, adopting, or weakening any policy from inside the agent loop.
- Removing or discouraging `loop.acknowledgePass`. This makes
  `acknowledgePass:true` survivable for an agent; `acknowledgePass:false` +
  `notify.desktop:true` remains the recommended configuration and `doctor`
  continues to warn.
- Changing how `equivalent` / `strengthening` candidates auto-adopt.
- Escalation (`ESCALATION.md`) for a long-unapproved candidate. Waiting on a
  human is not a stuck review.

## Invariants preserved

1. A non-monotonic policy change is never adopted without an interactive
   `reviewgate config approve`.
2. Code is always reviewed under the approved LKG policy while a candidate is
   pending.
3. A run that did not complete with PASS/SOFT-PASS never marks a candidate
   reviewed (`policyReviewPassed !== true` → "GATE POLICY PENDING" block, marker
   stays `null`).
4. An `invalid` config fails closed on every stop. Unlike approval, fixing an
   invalid config *is* something the agent can do, so there is nothing to bound.
5. `changed-during-review` keeps blocking (retry semantics).

## Design

Once-ness is derived from the existing `pending.reviewed_under_lkg_at` field. No
new persisted state. The field is already candidate-keyed: `persistPending`
(`control-plane.ts:281–290`) carries it forward only when
`source_fingerprint` **and** `effective_fingerprint` both match, and nulls it
otherwise — so a re-edited config re-arms the notice for free.

### Change 1 — `finalizeControlPlaneReview` distinguishes first from repeat

`control-plane.ts:516` currently overwrites `reviewed_under_lkg_at` with `now` on
every pass. Change it to preserve an existing timestamp and report which case
occurred:

```ts
| { kind: "approval-required"; message: string; alreadyNotified: boolean }
```

This is the `approval-required` member of the existing `ControlPlaneFinalizeResult`
union (`control-plane.ts:41–46`); the other four members are untouched. The change
is **additive** — every existing `finalized.kind === "approval-required"` check
still compiles and narrows, and nothing destructures the union exhaustively. There
are exactly two production call sites, `gate.ts:1116` and `gate.ts:1163`, both
covered by change 3; the four test call sites read only `.kind`.

- `reviewed_under_lkg_at === null` → set it to now, `alreadyNotified: false`,
  `message` = the existing loud `approvalMessage`. **Revised post-review:** the
  non-invalid branch of `approvalMessage` gained one more sentence telling the
  agent explicitly that it has nothing to do here — the original text pointed
  only at the TTY-only `reviewgate config approve`, which an agent reading the
  block reason could misread as something to act on (retry the command, or
  re-edit `reviewgate.config.ts`, which only mints a new candidate and earns
  another block). The `invalid` branch is untouched: an agent *can* and should
  fix an invalid config, so no such disclaimer belongs there.
- already set → leave it, `alreadyNotified: true`, `message` = the quiet pending
  notice produced by the shared renderer of change 4 (one text, one source —
  the loud first-contact `approvalMessage` and the quiet repeat notice must not
  drift apart into two hand-maintained strings).

Preserving the timestamp also fixes a smaller honesty bug: the report line
"Reviewed under last-known-good policy: yes (…)" currently drifts to the latest
stop instead of naming when the candidate actually first passed.

### Change 2 — a settled candidate no longer forces a review

`gate.ts:413`:

```ts
const forcesReview = policy?.change
  ? policy.change.classification === "invalid" ||
    policy.change.reviewed_under_lkg_at === null
  : false;
const probe = forcesReview ? "review" : await stopProbe(input.repoRoot);
```

No coverage hole. The config bytes are outside the working-tree fingerprint
(`workingTreeStateHash` → `collectDiff`, which excludes `reviewgate.config.ts`),
which is exactly why the force exists — but `resolveControlPlaneConfig` runs
*before* the probe (`gate.ts:336–354`) and has already persisted any new
candidate with `reviewed_under_lkg_at: null` by the time the probe reads it. A
second config edit therefore forces a review again.

### Change 3 — block only on the first notice

`gate.ts:1167–1178` (the `allow_stop` path): block when `kind` is `invalid` or
`changed-during-review`, or when `approval-required && !alreadyNotified`.
When `approval-required && alreadyNotified`, append the quiet notice to `signal`
and fall through to `allow_stop`.

`gate.ts:1108–1133` (the block path, reached when the driver blocks for its own
reason — `acknowledgePass`, `forceSoftAck`, findings): unchanged in shape; it
uses whichever message `finalize` returned. It remains a block because the turn
was already being blocked; no new loop is introduced, because change 2 makes the
following idle stop take `skip-clean`.

Two properties of that path matter and must survive:

- The block reason is composed as `${decision.reason}${policyNotice}`
  (`gate.ts:1134`). The quiet notice is therefore never the *sole* explanation of
  a block — the driver's own reason ("…end your turn again to pass through", or
  the findings summary) always precedes it and explains why the turn stopped.
- The `else` branch at `gate.ts:1130–1131` (reached when
  `policyReviewPassed !== true`) keeps its own hardcoded text and deliberately
  does **not** adopt the shared renderer of change 4: it describes a review that
  did not complete cleanly, not a settled candidate, and saying "pending human
  approval" there would be wrong. Add a one-line comment recording that.

### Change 4 — a shared pending-policy suffix

One renderer, `renderPendingPolicyNotice(policy)`, appended at **all four** gate
exits so the pending candidate stays visible on every message:

| Exit | Site | Today |
| --- | --- | --- |
| `skip-clean` | `gate.ts:414–420` | hardcoded green string, no `policy` reference — must be threaded |
| `skip-escalated` | `gate.ts:421–432` | hardcoded orange string, no `policy` reference — must be threaded |
| `allow_stop` | `gate.ts:1184–1186` (`signal`) | reached via change 3 |
| block-path notice | `gate.ts:1116–1129` (`policyNotice`) | `finalize` supplies the text |

The `skip-clean` and `skip-escalated` branches return *before* the lock and
currently never read `policy`; threading it in is the one piece of net-new
plumbing in this design. Content: the candidate is pending human approval, the
approved fingerprint the code was reviewed under, and the path to
`policy-change.md`.

Desktop notifications stay exactly where they are today (block and `allow_stop`).
`skip-clean` carries the suffix silently — notifying on every idle turn would be
noise, and the human already got one blocking notice plus a notification.

## Resulting turn sequence

| Stop | Today | After |
| --- | --- | --- |
| 1 — config + code edited | forced review → block | forced review → **block once** (loud, marker set) |
| 2 — idle | forced review → block | `skip-clean` → 🟢 + suffix, **no reviewer runs** |
| 3 — more code | forced review → block | normal review → `allow_stop` + quiet suffix |
| config edited again | forced review → block | marker nulls → forced review → **block once** again |
| human runs `config approve` | adopts | adopts (unchanged) |

## Failure modes

- **Reviewer error / quota during the first pass** → `policyReviewPassed !== true`
  → existing "GATE POLICY PENDING" block, marker stays `null`, notice still
  pending. Invariant 3.
- **Config becomes invalid after being reviewed** → new candidate (different
  source fingerprint) → marker nulls → `invalid` → blocks every stop until fixed.
- **Concurrent stop hooks** → `finalizeControlPlaneReview` does its read-modify-
  write under `controlPlaneLockPath`; the null→set transition is decided inside
  that lock, so exactly one of two racing stops sees `alreadyNotified: false`.
- **Candidate reverted to LKG** → `clearRevertedCandidate` → `change` is null →
  normal probe, no suffix. Unchanged.
- **`control-plane.json` deleted** → `resolveControlPlaneConfig` throws
  `ControlPlaneBootstrapRequiredError`. Unchanged.

## Testing

Every test below is mutation-checked: the bug is re-introduced in a *copy* of the
repo, the test is confirmed red, the copy is discarded, and `git diff` confirms
the original is untouched.

Integration (`tests/integration/control-plane-gate.test.ts`):

1. First clean pass under LKG blocks once with the loud message and sets
   `reviewed_under_lkg_at`.
2. A following idle stop is a `skip-clean` exit and does not force a real
   review. The discriminator is **not** a call-counting stub — a call count
   cannot tell a fixed run from a buggy one, because `Orchestrator.runIteration()`'s
   cache-hit branch (`src/core/orchestrator.ts:1474`) serves a cached verdict
   without ever calling `reviewer.review()`, so the count sits flat either way.
   What shipped instead: snapshot `.reviewgate/pending.json` before the second
   stop and assert it is byte-identical after. A full lock+orchestrator pass
   rewrites that file unconditionally — even a cache hit swaps in a fresh
   `generated_at` and a synthetic `reviewers[0].id` of `"reviewgate"` — while
   the pre-lock skip-clean exit in `gate.ts` returns before the orchestrator is
   ever reached and leaves the file untouched.
3. A following stop *with* a code change runs the panel, passes, and allows with
   the quiet suffix — no block.
4. Editing the config again nulls the marker, forces a review, and blocks once
   more.
5. `acknowledgePass:true` + settled candidate + idle stop → green `skip-clean`,
   no acknowledge block. (The FlashBuddy loop.)
6. An `invalid` candidate blocks on every stop (regression guard for invariant 4).

Unit (`tests/unit/control-plane.test.ts`):

7. `finalizeControlPlaneReview` returns `alreadyNotified:false` then `true`
   across two calls, and the second call does **not** refresh the timestamp.
8. `reviewgate config approve` still succeeds after the quiet path (the marker
   precondition at `control-plane.ts:605` is satisfied).

Existing tests that must stay green unmodified:
`control-plane-gate.test.ts:151` (config-only Bash mutation blocks — this is the
first notice), `:199` (the `419a142` checkpoint-advance), `:233` (quota defer
never marks reviewed).

## Rollout

No config flag. This is a bug fix to blocking semantics, not an opt-in feature —
the current behaviour has no legitimate use. `doctor`'s `acknowledgePass` warning
stays as-is.

## Plan-gate findings mapping

Codex was quota-exhausted (until 2026-07-29), so the gate ran on the documented
fallback chain: **agy/Gemini** (agentic, read the repo) and **GLM-5.2 via Ollama
Cloud** (completion, spec + source excerpts inline) as an independent second voice.

### Round 1 — agy: FAIL · GLM-5.2: PASS (3 INFO)

| # | Finding | Assessment | Action |
| --- | --- | --- | --- |
| agy-1 | [CRITICAL] `ControlPlaneFinalizeResult` and the `finalized.kind` call sites are not updated for the new field | **Rejected — false positive.** The spec's code block *is* the updated union member, and the change is additive: adding a required field to one variant leaves every `kind === "approval-required"` check compiling and narrowing. Verified there are exactly two production call sites (`gate.ts:1116`, `1163`), both covered by change 3, and four test sites that read only `.kind`. | Spec now states the union location, the additive property, and enumerates the call sites. |
| agy-2 | [WARN] `skip-clean` drops the notice, hiding the candidate on idle turns | **Rejected — already specified.** Change 4 already listed the `skip-clean` return as a consumer of the shared renderer; GLM independently read it that way. | Change 4 rewritten as an explicit four-row site table with line numbers, and the `skip-clean`/`skip-escalated` plumbing called out as the design's only net-new wiring. |
| agy-3 | [WARN] On an `acknowledgePass` block turn the quiet notice is wrapped in a block without context | **Rejected — false premise.** `gate.ts:1134` composes `${decision.reason}${policyNotice}`; the driver's own reason always precedes and explains the block. | Spec now records that composition as a property that must survive. |
| glm-1 | [INFO] The `policyReviewPassed !== true` else branch keeps its own hardcoded text instead of the shared renderer | **Accepted.** It describes an incomplete review, not a settled candidate. | Spec now states the exclusion is deliberate and asks for a one-line code comment. |
| glm-2 | [INFO] `skip-escalated` needs `policy` threaded in | **Accepted** (already implied). | Covered by the change-4 table. |
| glm-3 | [INFO] `alreadyNotified` only on the `approval-required` variant is correct narrowing | No action. | — |

No finding changed the design. Three were false positives against text already in
the spec; the accepted ones sharpened wording only.

### Round 2 — delta review: PASS

agy was re-run first and **errored** (`timeout waiting for response`, exit 1, 41-byte
PTY log) after writing an empty-findings `PASS` skeleton. Per the review rules an
errored reviewer is not an approval, so that file was discarded rather than counted.

The delta review was completed by GLM-5.2 (spec + source excerpts inline). Verdict
**PASS**, one INFO confirming each round-1 rejection against the source:

- `ControlPlaneFinalizeResult` is a discriminated union; both production call sites
  narrow on `.kind` and then read `.message`, which is retained — so adding
  `alreadyNotified` to one member is additive, and `finalizeControlPlaneReview` is
  the variant's only constructor. (agy-1 rejection correct.)
- `gate.ts:1134` is exactly `${decision.reason}${policyNotice}`, so the driver's own
  block explanation always precedes the notice. (agy-3 premise false, rejection correct.)
- `persistPending` sets `nextPending = pending` — the fresh candidate with
  `reviewed_under_lkg_at: null` — whenever `sameCandidate` is false, confirming the
  re-arm-on-re-edit behaviour the "once per candidate" design depends on.
- The change-4 four-site table matches the real gate exit points.

Plan-gate closed: implementation may proceed.
