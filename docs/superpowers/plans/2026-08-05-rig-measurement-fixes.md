# Rig measurement fixes — the three bugs pilot-02 exposed

_2026-08-05, after `docs/dev/2026-08-05-pilot-02-result.md`. Task (a) from `NEXT_SESSION.md`._

## Why this exists

pilot-02 ran clean and produced three defects **in the measurement tooling**, not in the gate.
They are being fixed before the substantive change they would be used to measure (the critic's
true-positive hole), because a fix measured with a broken instrument is not measured.

Every claim below is verifiable by a command, listed with it.

| # | Defect | Status in this plan |
|---|---|---|
| 1 | `rig ablate` recall/escape denominator ignores `seedLanded` | **FIXED here** |
| 2 | M5 cannot see critic cost (`criticCostUsd` is `const 0`) | **NOT fixed here** — made loud; real fix is a provider-contract change, scoped out below |
| 3 | `RigResult` carries no critic *invocation* status | **FIXED here** |

## T1 — `rig ablate` must use the same denominator as `rig harvest`

**The defect, verified.** `src/rig/ablate.ts:207` is

```ts
const seeded = turns.filter((t) => t.seededId !== null);
```

while `src/rig/harvest.ts:509` is

```ts
const seededTurns = turns.filter((t) => t.seeded !== null && t.record.seedLanded !== false);
```

`renderAblationMatrix` (`ablate.ts:307-310`) then computes `loRecall - baseRecall.num` where
`loRecall` is the ablated numerator over **all seeded** turns and `baseRecall.num` is the
harvested numerator over **landed** turns, and prints the difference over `baseRecall.den`.

Verify the defect on the recorded run (no rebuild needed):

```bash
./dist/reviewgate rig ablate --result rig/results/pilot-02/result.json --script rig/scripts/pilot-02.json
```

Today this prints `−reputation … recall +1/3` for a layer whose `blocking` delta is `+0`. A
layer that suppressed nothing cannot have changed recall; the `+1` is turn 4's spurious catch
(seed never landed) entering the ablated numerator but not the harvested baseline.

**The fix.** One filter, and it fixes recall and escape together because both read the same
array:

```ts
// Same predicate as harvest.ts: a seed that provably never reached the code is not a
// detection opportunity, so it belongs in NEITHER denominator. `null` (UNKNOWN) stays in,
// because "we could not check" must not silently become "it did not happen".
const seeded = turns.filter((t) => t.seededId !== null && t.seedLanded !== false);
```

`seedLanded` is already on `RigTurnRecord` (`src/schemas/rig-result.ts:68`) and `rebuild()`
copies every turn with `...t`, so the field is present — no plumbing needed.

**Guard test, with its two numbers.** A fixture with 2 seeded turns: turn A `seedLanded: false`
carrying a blocking finding that matches its seed tags (a spurious catch, pilot-01/02 turn 4),
and turn B `seedLanded: true` whose seed-matching finding the layer suppressed to INFO.

Baseline (harvest semantics, landed only) is **0/1** — B's only detection is suppressed, so
nothing is caught. Then:

| | ablated recall | printed delta (`loRecall − baseRecall.num` over `baseRecall.den`) |
|---|---|---|
| **WITHOUT the fix** | **2/2** (A's spurious catch + B restored) | `2 − 0 = ` **`+2/1`** — a delta larger than its own denominator |
| **WITH the fix** | **1/1** (B restored) | `1 − 0 = ` **`+1/1`** — the layer cost exactly one catch |

_(Corrected 2026-08-05 by the plan gate, which caught that this first said baseline was 1/1.
It is 0/1: the fixture's whole point is that B's finding is suppressed, so the baseline cannot
have caught it. The corrected figures make the defect starker — the unfixed tool prints a delta
of +2 against a denominator of 1.)_

The two ablated values differ (2/2 vs 1/1) and the printed deltas differ (+2 vs +1), so the
test is non-vacuous on paper. It must be seen red against current code before the fix lands.

**Second guard — the no-op invariant, which is the bug actually observed.** Same fixture but
with the layer suppressing **nothing**, so baseline recall is **1/1** (B caught):

- **WITHOUT the fix:** ablated = 2/2 → printed delta `2 − 1 = ` **`+1/1`** for a layer that
  changed nothing. This is exactly what pilot-02's matrix printed for `−reputation`,
  `−fp-ledger` and `−lore`.
- **WITH the fix:** ablated = 1/1 → printed delta **`+0/1`**.

Generalised: an ablation over a result where a layer suppressed nothing must produce a recall
delta of exactly 0. That is the invariant the printed matrix violated, and the one a future
denominator change would break again.

**Blast radius.** `rig ablate` is read-only analysis over a harvested `result.json`; it writes
nothing and is not on the gate path. Re-running it on `rig/results/pilot-0{1,2}` is free.

## T2 — `RigResult` carries the critic's INVOCATION status

**The defect.** `metrics.suppression.critic` counts findings stamped
`critic_verdict: "likely_fp"` — *demotions*. A critic that ran, judged everything and returned
`keep` scores 0 there, and so does a critic that was never configured. pilot-01 and pilot-02
publish the same `0`/non-zero shape for categorically different facts. Verify:

```bash
grep -n "critic" src/schemas/rig-result.ts     # only suppression.critic, a count
```

**The fix.** `collectTurnFindings` (`harvest.ts:141-190`) already reads and schema-validates
every archived `*-pending.json`; the parsed object carries `.critic`. Extract it there and add
to `RigTurnRecord`:

```ts
/**
 * The critic phase's own report for this turn, from the archived pending.json versions.
 * `null` = no archived report carried a `critic` key at all, which has TWO causes this file
 * cannot separate: the critic was not configured, or it was configured and every round
 * produced zero findings (orchestrator.ts:2302 runs it only when findings > 0). Distinct
 * from `suppression.critic`, which counts DEMOTIONS and is 0 in both of those cases as well
 * as when the critic ran and kept everything.
 */
criticRuns: z.array(z.object({
  provider: z.string(),
  status: z.string(),
  verdicts: z.number().int().nonnegative(),
  demoted: z.number().int().nonnegative().optional(),
}).strict()).optional(),
```

Deduped by content within a turn, because one invocation can appear in several archived
versions (the archiver keys on the whole file's hash). **Optional, not required**, so older
`result.json` files still parse — the same compatibility rule `seedLanded` followed.

`renderRigReport` gains one line under M6, e.g.
`critic: ran on 10/10 eligible turn(s) · 3 demotion(s) survived aggregation`.

**Guard test, with its two numbers.** Two fixtures:

- a turn whose archived reports carry `critic: {status:"ran", verdicts:7, demoted:3}` →
  `criticRuns.length === 1` and the report line reads `1/1 eligible`;
- a turn with findings but **no** `critic` key (pilot-01's shape) → `criticRuns` absent/empty
  and the line reads `0/0 eligible`, **while `suppression.critic` is 0 in both cases**.

That last clause is the point: the guarded quantity is exactly the distinction
`suppression.critic` cannot make. **1 vs 0 eligible turns at an unchanged suppression count of
0** — non-vacuous on paper.

**Retire the stopgap.** `rig/scripts/critic-activity.ts` was written during pilot-02 precisely
because the harvester could not answer this, and keeping both would leave two sources of truth
that can disagree. Once T2 lands: re-harvest pilot-01 and pilot-02, confirm the harvested
numbers equal the ones the script produced (10/10 and 0/12 respectively — this is the
acceptance criterion, not a formality), then delete the script and add a **dated in-place note**
to `docs/dev/2026-08-05-pilot-02-result.md` recording that the extractor was folded into the
harvester and the published numbers were reproduced. Do not silently rewrite the published
numbers.

## NOT in this plan, and why

**M5 cannot see the critic's cost.** `orchestrator.ts:2300` is `const criticCostUsd = 0`,
never reassigned. The cause is a contract, not an oversight:

```bash
grep -n "complete?" src/providers/adapter-base.ts    # complete?(prompt, opts): Promise<string>
grep -ln "async complete" src/providers/*.ts         # six adapters
```

`complete()` returns a bare string — there is no usage envelope to attribute, in **any** of the
six adapters. Fixing it properly means changing that return type and threading usage through
codex, claude, gemini, opencode, openrouter and ollama, of which only the two HTTP adapters get
usage for free. That is a provider-layer slice with its own risk surface, and bundling it into
a rig-tooling fix would put a change to every reviewer's code path inside a change to an
offline analysis script.

**What this plan does instead: makes the gap loud rather than silent.** `renderRigReport`'s M5
line gains an explicit caveat **when and only when** any turn has `criticRuns`, e.g.
`M5 cost … (EXCLUDES critic: complete() returns no usage envelope — see orchestrator.ts:2300)`.
A number that is silently missing a component is worse than one that says what it omits. The
real fix is recorded as a follow-up in `NEXT_SESSION.md`.

## Testing

- Every guard test above is seen **red** first, in a copy of the repo, before its fix lands.
- `bunx tsc --noEmit` and `bun run lint` must be clean. **Note both exclude `rig/scripts/`**
  (tsconfig includes only `src*`/`tests*`), but everything this plan touches is under `src/`
  and `tests/`, so repo-wide green is meaningful here — unlike during pilot-02.
- `bun test` in full, because T2 changes a persisted zod schema.
- Re-harvest both pilots and diff the metrics: **pilot-02's published recall (1/3), escape
  (2/3) and M6 (critic 3) must be byte-identical after the change.** T1 alters only the
  ABLATION path and T2 only adds a field; if a headline metric moves, the change is wrong.

## Risks

| Risk | Handling |
|---|---|
| T1 changes a number in the published pilot-02 write-up | It cannot: the doc already quotes the CORRECTED figures, recomputed by hand from the ablated turn records. T1 makes the tool agree with the doc. Verified by re-running the matrix and comparing against the doc's table. |
| T2's schema change breaks older `result.json` | Field is `.optional()`, mirroring `seedLanded`. Guarded by re-parsing pilot-01's existing result.json unchanged. |
| Deleting `critic-activity.ts` loses the ability to analyse old runs | Harvesting is offline and free; both pilots are re-harvested as the acceptance step BEFORE the deletion. |
| The report's new M5 caveat fires when no critic ran | Gated on `criticRuns` being present on at least one turn, not on config. |

---

## Plan-gate findings mapping — Round 1 (agy/Gemini, 2026-08-05 18:55–18:57Z)

Reviewer verdict: **PASS** (0 CRITICAL, 0 WARN, 1 INFO). Executing reviewer with repo read +
run permission; findings landed at the absolute path given in the prompt (no stray
`~/.gemini/…/scratch/` copy). Codex was unavailable — quota cooldown until 2026-08-08T11:07Z.

| # | Finding | Assessment | Fix |
|---|---|---|---|
| R1-1 | INFO — the T1 guard test says baseline recall is 1/1, but for a fixture whose landed seed's finding is *suppressed* the baseline is 0/1 | **Accepted, and it was a real error.** The fixture's premise is that B's only detection is suppressed, so the baseline cannot have caught it. The reviewer also confirmed the ablated figures (2/2 vs 1/1) are exact and non-vacuous | Rewrote the guard-test block with baseline 0/1, added the printed-delta column (`+2/1` unfixed vs `+1/1` fixed), and split out the no-op invariant as a second guard with its own numbers (`+1/1` unfixed vs `+0/1` fixed) |

**Independently verified by me before implementing, not taken on the reviewer's word** (each by
command, since a PASS is not evidence the claims are true):

- `complete()` returns `Promise<string>` in **all six** adapters — so the M5 scope-out is correct.
- `rebuild()` spreads `...t`, so `seedLanded` reaches the ablated turns; no plumbing needed.
- `RigTurnRecordSchema` is `.strict()`, which rejects unknown keys but not absent optional ones;
  `rig/results/pilot-01/result.json` parses today with `seedLanded` entirely absent, which is the
  precedent T2's optional field follows.

---

## Post-implementation review — 3 rounds, 2 slots

Slot A = `agy`/Gemini (executing: repo read + run). Slot B = GLM-5.2 via Ollama (inline diff
only — a completion, so an extra voice, never the deciding one). **Codex was unavailable all
session — quota cooldown until 2026-08-08T11:07Z**, so Slot A is the executing reviewer.

| Round | Slot A | Slot B | What changed after |
|---|---|---|---|
| 1 | PASS (3 INFO) | **FAIL** — 1 WARN, 3 INFO | the WARN + one INFO |
| 2 | PASS (3 INFO) | PASS (5 INFO) | two INFO-driven robustness fixes |
| 3 | **PASS** (3 INFO) | **PASS** (5 INFO) | — |

**R1-B WARN (accepted, real).** `rig-result.ts`'s `criticRuns` docstring still said "deduped by
content" after the key had been changed to `run_id:iter` — a stale comment I introduced myself,
contradicting the very design decision `harvest.ts` takes pains to justify. Rewritten.

**Two INFOs were acted on because they were real, not to please the reviewer:**

- **`.strict()` was a behaviour change and is reverted.** Extracting `CriticInfoSchema` added
  `.strict()` where the inline declaration had none. The whole `pending.json` goes through ONE
  `safeParse` in `collectTurnFindings`, and a failure there SKIPS the report — so a future
  orchestrator field inside `critic` would not have surfaced as a schema error but as that
  turn's findings vanishing from recall. Restored to non-strict; the reasoning is in the code.
- **The M5 caveat now gates on `criticCalled`, not `criticRan`.** `ran` additionally requires
  ≥1 parsed verdict, so an `empty` or `error` critic — which reached the provider and spent
  tokens — would have suppressed the "excludes critic spend" caveat.

**Found by me, before Slot A reported it, and not left for the reviewer:** the dedupe key was
originally `JSON.stringify(critic)`, which silently collapses two genuinely distinct iterations
that report equal counts (two rounds each judging 2 findings and demoting 1 — not exotic). It
was re-keyed to `run_id:iter`, the actual identity of an invocation, and a second guard test
was added for exactly that case. Slot A independently flagged the same weakness in R1.

**Mutation checks — every new guard test seen red first, in a copy:**

| Test | Mutation | Result |
|---|---|---|
| ablate landed-seed denominator | run against the unfixed filter | RED — `den` 2 vs 1 |
| ablate no-op-layer zero delta | run against the unfixed filter | RED — delta 1 vs 0 |
| criticRuns dedupe | key by report index instead of `run_id:iter` | RED — length 2 vs 1 |
| criticRuns keeps distinct iterations | key by `JSON.stringify(critic)` | RED — length 1 vs 2 |

The original repo was confirmed unmodified after each copy was discarded.

**Acceptance, on real recorded runs rather than fixtures:** both pilots were re-harvested and
the harvester reproduced the deleted stopgap's numbers exactly — **pilot-02 10/10 invoking
turns, 16 demotions proposed, 3 surviving; pilot-01 0/0** — while recall, escape rate, M6
suppression and the M2 slope stayed byte-identical in both. The corrected ablation matrix now
prints what the pilot-02 write-up had recomputed by hand: `−critic +1/3`, no-op layers `+0/3`.
