# Plan — revert Slice B (the critic WARN security/correctness floor)

_2026-08-07. Evidence: `docs/dev/2026-08-07-slice-b-critic-floor-counterfactual.md`.
Original design: `docs/superpowers/specs/2026-08-05-true-positive-hole-design.md` §Slice B._

## Why

Slice B bars the critic from demoting a **WARN** security/correctness finding below WARN. Measured
over the whole recorded corpus (pilot-02 as an unbiased counterfactual — its binary predated the
floor — plus pilot-03 as a reproduction check):

| | |
|---|---:|
| activations | **3** |
| protected a **true** positive | **0** |
| protected a **false** positive | **3** |
| times the critic proposed demoting a catch of a seed that actually LANDED | **1** |
| …of which the FLOOR was the mechanism that saved it | **0** (corroboration did) |

**The evidence is bounded and the plan does not overstate it:** 3 activations and exactly **one**
exercised protective opportunity across 13 turns of a single panel configuration. That bounds the
floor's benefit; it does not prove the benefit is zero in general.

Narrowing instead of reverting was considered and **refuted by execution**: the existing
`HYPOTHETICAL` detector matches 0 of 3 activations, and that pass refuses to touch
security/correctness by design (`hypothetical-demote.ts:60`). Any other narrowing is a **new**
text-signal suppressor over exactly the two categories the codebase never softens on a text signal.

## Scope

One expression in `src/core/aggregator.ts`, plus the tests that pin it. **No schema change** — Slice
B has no dedicated marker field (its observable is `critic_verdict:"keep"`, which the
`isCorroborated` and `isCriticalSecurity` branches also produce). **No config key** — it was always
always-on. **No `pending.md` / report change.**

### Explicitly out of scope

- `isCriticalSecurity` (CRITICAL + security/correctness) — **pre-existing**, predates Slice B, stays.
- `isCorroborated` — pre-existing, stays. It is what actually saved the one real catch.
- `isProtected` / `protected_high_precision` — a different mechanism, untouched.
- Slice A (`reanchorByEvidence`) — unrelated and independently justified; **do not touch**. Note it
  is also NOT a substitute here: Slice A helps a finding reach corroboration by repairing an anchor
  so it can MERGE with a second detection. A lone WARN security finding with no second detection has
  nothing to merge with, so Slice A cannot protect the case this revert exposes.

## Task 1 — remove the floor

`src/core/aggregator.ts:611-619`. Delete `isBlockingSecurity` and its comment block; collapse:

```ts
const isSecurityProtected = f.severity === "CRITICAL" && touchesSecurityOrCorrectness(f);
```

Replace the removed comment with one recording the reversal and its evidence, so the next reader
finds the measurement rather than re-deriving the motivation from pilot-02 turn 2 alone.

## Task 2 — invert the two tests that pin the floor

`tests/unit/aggregator-critic.test.ts`, describe `"critic — security/correctness floor (pilot-02
turn 2)"`. Two tests assert the floor; both invert. Rename the describe to record the reversal —
and when you do, **also update `tests/unit/anchor-repair-cascade.test.ts:127-128`**, whose comment
quotes that describe name verbatim as a cross-reference; after the rename it would point at a string
that no longer exists.

**Every guard test carries its two numbers — WITH the mechanism and WITHOUT:**

| test | WITH floor (today) | WITHOUT floor (after revert) | vacuous on paper? |
|---|---|---|---|
| WARN **security** + critic `likely_fp` | `severity WARN`, `critic_verdict "keep"` | `severity INFO`, `critic_verdict "likely_fp"` | **no** — both fields differ |
| WARN **correctness** + critic `likely_fp` | `severity WARN`, `critic_verdict "keep"` | `severity INFO`, `critic_verdict "likely_fp"` | **no** — both fields differ |

These two are the mutation check for Task 1: restoring `isBlockingSecurity` must turn them red.

## Task 3 — confirm the three neighbouring guards stay green UNCHANGED

They pin the boundaries the revert must **not** move. Each is listed with the number that proves it
is not vacuous under this change:

| test | asserts | why the revert cannot move it |
|---|---|---|
| GUARD 8 — already-INFO security `likely_fp` | `criticDroppedCount === 1` | INFO never entered the floor branch (`severity === "WARN"` gate) |
| GUARD 9 — WARN **quality** `likely_fp` | demoted to `INFO` | quality is not security/correctness, so the floor never applied |
| `anchor-repair-cascade.test.ts` "repairs, merges, corroborates, stays blocking" | 1 blocking WARN | its comment (`:123-127`) already states the bar is **corroboration**, not Task 4's floor, and that it passes with Task 4 reverted |

If any of the three changes, Task 1 removed more than the floor — stop and re-scope.

## Task 4 — record the reversal in the design spec

Append a dated note to `docs/superpowers/specs/2026-08-05-true-positive-hole-design.md` §Slice B:
reverted, with the counterfactual numbers and a pointer to the write-up. **Correct in place, do not
silently delete** the original rationale — the design's reasoning was sound on the evidence it had
(one observed WARN-security demote); what changed is the evidence.

## Verification

1. `bunx tsc --noEmit` and `bun run lint` clean.
2. `bun test` full — expect **3191 pass / 12 skip / 0 fail**, i.e. unchanged, since Task 2 rewrites
   two existing tests rather than adding any.
3. **Mutation check in a COPY of the repo:** restore `isBlockingSecurity`; the two Task-2 tests must
   go **red**. Discard the copy, `git diff` to confirm the original is untouched.
4. `bun run rig/scripts/critic-floor-replay.ts` — its `isFloorActivation` marker is computed from
   `aggregate()` output, so after the revert the **3 activations must become 0**. This is a live
   end-to-end check of the revert against the real corpus, and it is the reason that script is
   committed. Note its self-check "pilot-03 reproduces its 1 field activation" will then FAIL by
   design — update that assertion to expect 0 in the same commit, or the instrument aborts.
5. **Do NOT run `bun run build`** — it re-pins the binary and deploys machine-wide via the
   `~/.local/bin/reviewgate` symlink. Installed binary stays `sha256:fc9b8c18…`.

## Risks

| risk | mitigation |
|---|---|
| A real uncorroborated WARN security TP gets demoted in future | This is the accepted cost, and it is the floor's *stated* purpose. Measured: 0 occurrences in 13 turns of critic activity; the one real catch was corroborated. Reversible in one line if the field shows otherwise. |
| Single-reviewer panels have no corroboration to fall back on | Real gap, and **not introduced by this revert** — it is the pre-existing state the floor tried to patch. **There is one partial net, and it is not nothing:** `isProtected` / `protected_high_precision` (`aggregator.ts:630`) fires in exactly this branch (`!isSecurityProtected && !isCorroborated`) and keeps a high-precision reviewer's blocking finding at full severity against a critic `likely_fp`. **But it is cold-start-inert** — it requires the reviewer to be above `HIGH_PRECISION_FLOOR` with at least `PROTECT_MIN_DECISIONS` samples, so a fresh repo has no net at all. Net effect after the revert: an uncorroborated WARN security finding from an unproven reviewer, called `likely_fp` by the critic, goes to INFO with **no downstream gate**. That is the accepted cost, stated plainly rather than left implicit. |
| The rig replay's reproduction self-check turns into a false alarm | Verification step 4 updates it in the same commit. |

## Unverified until implementation

Step 4's claim that the replay reports **0** activations after the revert is a runtime prediction —
`isFloorActivation` also filters on consensus and category, so a finding could in principle still
match the marker via `isCorroborated`. **Marked unverified until Task 1 is done and the script is
re-run;** if it does not reach 0, the discrepancy is a finding about the marker, not about the revert.


## Findings mapping — round 1

| # | finding | reviewer | fix | task |
|---|---|---|---|---|
| 1 | [WARN] single-reviewer / uncorroborated WARN security demotions have no downstream gate; plan does not name the reliance on high-precision protection | agy (Slot B) | Risks table row rewritten: names `isProtected`/`protected_high_precision` (`aggregator.ts:630`) as the partial net, states it fires in exactly this branch, and states it is **cold-start-inert** — so the residual case is "unproven reviewer + uncorroborated + critic likely_fp → INFO, no downstream gate" | Risks |
| 2 | [INFO] evidence bounded by n=1 exercised opportunity | agy (Slot B) | added to §Why, stated as a bound on the benefit rather than a proof of zero | Why |
| 3 | [INFO] Slice A does not cover lone single-detection catches | agy (Slot B) | added to §Scope out-of-scope: Slice A works via repair→merge→corroboration and cannot help a finding with nothing to merge with | Scope |
| 4 | [INFO] Task 2's rename orphans the cross-reference comment at `anchor-repair-cascade.test.ts:127-128` | claude (Slot A, executing) | Task 2 now requires updating that comment in the same change | Task 2 |

**Round 1 verdicts:** Slot A (Claude, executing) **PASS** — verified by execution in a repo copy:
both Task-2 numbers non-vacuous (WARN/"keep" → INFO/"likely_fp"), all three Task-3 guards green
after a simulated revert, 159 further tests green, and the "unverified" replay prediction confirmed
(3 → 0 activations once the reproduction assertion is updated). Slot B (agy) **FAIL** on finding 1.
