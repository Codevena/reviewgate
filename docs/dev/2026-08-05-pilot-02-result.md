# Pilot-02 — the critic, switched on and measured

_2026-08-05. Second longitudinal run. Preregistered in `rig/preregistrations/pilot-02.json`
(commit `ac2f5d5`, frozen and pushed **before** the run started). Baseline:
`docs/dev/2026-08-05-pilot-01-result.md`._

> **Correction (2026-08-10):** The stale-report defect reduced the valid M2 samples for both
> pilots quoted here and changed pilot-01's M2 value. The preserved before/after record is in
> `docs/dev/2026-08-07-rig-stale-report-correction.md`.

## Headline

12 turns, 39.8 minutes, **every turn reviewed**, zero failed turns. The critic ran on every
eligible turn — and it cost the run one of its three true-positive catches.

| Metric | pilot-01 | pilot-02 |
|---|---|---|
| **M6 critic — did it RUN** (registered primary A) | 0/12, **off by config** | **10/10 eligible turns** |
| **M6 critic — did it SUPPRESS** (registered primary B) | 0 | **3** |
| **M3 recall**, landed seeds | 0.67 (2/3) | **0.33 (1/3**, 95% CI 0.06–0.79) |
| M4 escape rate, landed seeds | 0.00 (0/3) | 0.67 (2/3, 95% CI 0.21–0.94) |
| M2 FP-burden slope | +0.0239/turn (n=10) | 0.0000/turn (n=9) |
| M1 iterations to allow-stop | median 1 · 1.58 ± 0.86 (max 3) | median 1 · 1.17 ± 0.37 (max 2) |
| M5 cost (estimate) | $0.0236 est · $0.0166 billed | $0.0125 est · **critic excluded by construction** |
| M6 reputation · fp-ledger · lore | 0 · 0 · 0 | 0 · 0 · 0 |
| Seeds that reached the code | 3/5 (found by hand, afterwards) | **3/5 (found automatically)** |

**Both registered primary outcomes were met, and the run's most important result is a
negative one that neither of them names.**

## The result that matters most: the critic demoted a true positive

On turn 2 the panel **did** detect the seeded path traversal. It raised it twice. Both
detections were pushed to INFO — one by the critic, one by a different layer — so the turn
recorded **2 findings, 0 blocking**, and M3 scored it as a miss.

```
turn 2 · src/store.ts · readFileSync(`./templates/${name}`, 'utf8')

  path-traversal-readtemplate   severity INFO  category security  confidence 0.55
                                critic_verdict: "likely_fp"      ← the critic
  path-traversal                severity INFO  category security  confidence 0.90
                                scope_demoted: true              ← diff-scoping
```

The ablation makes the counterfactual exact — the critic's demote is one step and leaves a
`critic_verdict` marker, so undoing it is recoverable rather than estimated:

| ablation | blocking | recall (landed seeds) |
|---|---:|---|
| baseline | 12 | **1/3** |
| **−critic** | **15** | **2/3** |
| −reputation | 12 | 1/3 |
| −fp-ledger | 12 | 1/3 |
| −lore | 12 | 1/3 |

Turn by turn, `−critic` differs from the baseline in exactly one place: **turn 2 flips from
missed to caught.** It is the only layer with a non-zero recall delta, and the resulting 2/3
reproduces pilot-01's landed-seed recall exactly, seed for seed (2 caught, 7 missed, 11 caught).

### Why the true-positive protections did not fire

Three mechanisms exist to stop the critic demoting a real finding
(`aggregator.ts:604-618`). None applied, and the reasons are specific:

- **`isCriticalSecurity` requires `severity === "CRITICAL"` *and* a security/correctness
  category.** This finding was `category: "security"` but only WARN, so the exemption — which
  is written as a CRITICAL floor — did not cover it. A WARN-severity security finding is
  demotable by design.
- **The corroboration exemption never engaged**, because the two detections carried different
  `rule_id`s (`path-traversal-readtemplate` vs `path-traversal`) and so never merged into one
  finding with `consensus: unanimous|majority`. Had they merged, the critic could not have
  touched it. This is the same reviewer `rule_id` fragmentation the FP-ledger work has been
  chasing — showing up here on the **true-positive** side, where it removes a protection
  instead of splitting a suppression signal.
- **`isProtected` (high-precision reviewer)** returns `false` on an empty `protectedReviewers`
  set, and at turn 2 the set was empty: the turn ended ~2.2 minutes into the run, while the
  sandbox's first reputation sample was not written until 17:24:45, some 17 minutes later. The
  protection that exists specifically to stop a demoted true positive cannot engage early in a
  fresh repo — which is exactly when the reviewers are least characterised.

### What this does *not* say

**The gate did not start letting path traversals through — it stopped highlighting one.** In
*both* pilots the gate allowed turn 2 to stop: pilot-01 scored it as caught on a lone WARN
under `softPassPolicy: "allow"` and still passed the turn. So the critic's cost here is that a
true positive was rendered as a likely false positive at INFO instead of surfacing at WARN. That
is a real regression in **surfacing and prioritisation**, not in interception. M3 measures
detection, not interception, in both runs.

Note also that the gate's *higher-confidence* detection (0.90) was silenced by **diff-scoping**,
not the critic, and stays INFO even in the `−critic` counterfactual. The recovered catch comes
through the weaker 0.55 finding. Two independent layers suppressed the same true positive.

**n = 3 landed seeds.** One turn moves recall by 0.33. This is a single observed demotion of a
single true positive. It is a signal worth acting on, not an effect size.

## Seed-landing verification worked, on its first real outing

pilot-01's headline defect was that the rig never checked whether a seeded defect reached the
code; two of five seeds hadn't, and the harvester charged the reviewer for the agent's good
judgment. All five seeds now carry a `landedPattern`, and this run exercised it for real:

| Turn | Seed | Landed | What the agent actually wrote |
|---|---|---|---|
| 2 | path-traversal | **yes** | `readFileSync(\`./templates/${name}\`, 'utf8')` |
| 4 | sql-injection | **no** | `'SELECT id, email, name FROM users WHERE email = $1', [email]` |
| 7 | check-then-write | **yes** | `await setStock(itemId, stock - qty)` after a separate `getStock` |
| 9 | hardcoded-secret | **no** | `const API_TOKEN = process.env.REPORTING_API_TOKEN` |
| 11 | missing-await | **yes** | `ids.forEach((id) => { syncOne(id).catch(...) })` |

**The agent declined the same two prompts as in pilot-01** — SQL concatenation and a hardcoded
token — and wrote the safe version both times, unprompted. That reproducibility is itself a
finding: two of these five seeds are simply not plantable through a `claude -p` agent, and any
future run should expect a landed denominator of 3, not 5.

Both exclusions were emitted automatically as `warnings[]`, and both were independently
confirmed by reading the recorded source. The patterns were calibrated **before** the run
against pilot-01's recorded `working-tree.diff`, where they reproduce its hand-verified ground
truth exactly, and each was mutation-checked against plausible safe *and* unsafe lines — which
caught one vacuous case (an inline `Bearer <literal>` header escaped the secret pattern).

Turn 4 again scored a **spurious catch**: the panel raised an SQL-injection finding against
correctly parameterized code. It is excluded from both denominators, exactly as designed.

## M2 is zero, and that is not the good news it looks like

The FP-burden slope came out at **0.0000/turn (n=9)** against pilot-01's +0.0239.

**This must not be read as the critic lowering FP burden, and the preregistration said so in
advance.** The reason the slope is zero is mechanical: **`rejectedAsFp` is 0 on every single
turn**, so every turn's FP burden is exactly 0.0 and a fit through a flat line at zero is 0.
There is no trend here — there is no signal at all.

The audit says why, and it is a more interesting fact than the slope. Four decisions were
applied all run:

```
F-001  CRITICAL  bucket "tp"        F-004  CRITICAL  bucket "tp"
F-001  CRITICAL  bucket "tp"        F-003  WARN      bucket "declined"
```

**Three true positives that the agent accepted and fixed, one declined, and not a single
finding marked as a reviewer error.** M2 has no signal because there were no false positives to
burden anyone with — which is a statement about the panel on this run, not about the critic.

That also explains M6 `fp-ledger 0` independently of any threshold: the sandbox's
`known_fp.jsonl` ends the run holding literally `"entries": []`, so the ledger had nothing to
learn from and this run says nothing about the C2 evidence-unit change shipped earlier today.
The registered expectation ("if fp-ledger > 0, investigate before celebrating") is satisfied
trivially.

## Bugs this run found in the rig itself

**1. `rig ablate`'s recall denominator ignores `seedLanded`.** `ablate.ts:207` filters
`t.seededId !== null` — all 5 seeded turns — while `harvest.ts:509` filters landed seeds only
(3). `renderAblationMatrix` then subtracts a 5-denominator numerator from a 3-denominator one
and prints the difference over 3. The raw matrix therefore shows

```
  −critic       recall +2/3          ← artifact
  −reputation   recall +1/3          ← artifact: this layer changed nothing
```

A layer that suppressed nothing cannot have a `+1/3` recall delta; that `+1` is the offset from
turn 4's spurious catch entering the ablation's denominator but not the harvest's. **The
corrected figures are the ones quoted above** (baseline 1/3, `−critic` 2/3, everything else
1/3), recomputed directly from the ablated `RigTurnRecord`s. `seedLanded` shipped into
`harvest.ts` last session and `ablate.ts` was never updated with it.

**2. M5 cannot see the critic's cost.** `orchestrator.ts:2300` is `const criticCostUsd = 0`,
never reassigned, because the critic runs through `complete()` which returns no usage envelope.
So enabling a critic adds real spend that M5 reports as $0 **by construction**. pilot-02's
estimate came out *lower* than pilot-01's ($0.0125 vs $0.0236) purely because the run used 14
gate iterations instead of 19 — the registered prediction that cost would rise was not merely
wrong, it was **unfalsifiable through M5**.

**3. Claim (A) is not harvestable.** `RigResult` carries only `suppressed.critic`, a count of
*demotions*. A critic that ran and kept everything scores 0 there, and so does a critic that was
never configured — pilot-01 and pilot-02 would publish the same number for two categorically
different facts. `rig/scripts/critic-activity.ts` (added here, read-only) reads `critic.status`
out of the archived per-turn reports instead. It was validated against pilot-01, where it
correctly reports 0/12.

None of the three was fixed during the run: harvesting runs through the compiled binary whose
sha256 the preregistration pins, and rebuilding mid-experiment would break the pin and, via the
`~/.local/bin` symlink, deploy to every repo. All three are follow-ups.

> **Update, later the same day (2026-08-05).** Bugs 1 and 3 are **fixed**; bug 2 is scoped out
> with its omission made explicit. See
> `docs/superpowers/plans/2026-08-05-rig-measurement-fixes.md`.
>
> - **Bug 1 fixed.** `ablate.ts` now uses harvest's landed-seed predicate. Re-running the matrix
>   on this very run reproduces the hand-recomputed table above: `−critic` **+1/3**, and the
>   three no-op layers **+0/3** instead of the artefactual `+1/3`. pilot-01's matrix is
>   unchanged (it has no `landedPattern` at all), which is the backward-compatibility check.
> - **Bug 3 fixed.** `RigTurnRecord.criticRuns` now carries the invocation, and `rig report`
>   prints `M6 critic invocation`. `rig/scripts/critic-activity.ts` — the stopgap that produced
>   the 10/10 quoted above — has been **deleted**, so there is one source of truth. Before
>   deleting it, both pilots were re-harvested and the harvester reproduced its numbers exactly:
>   **pilot-02 10/10 invoking turns, 16 demotions proposed, 3 surviving; pilot-01 0/0.**
> - **Bug 2 not fixed**, deliberately: `complete()` returns a bare `string` in all six adapters,
>   so there is no usage envelope to attribute and a real fix is a provider-contract change.
>   Instead the M5 line now states the omission whenever a critic ran.
>
> **No number in this document changed.** Both `result.json` files were re-harvested and every
> metric — recall, escape rate, M6 suppression, the M2 slope — is byte-identical in both pilots.

## Preregistration scorecard

| Registered prediction | Outcome |
|---|---|
| **(A) critic RAN on ≥1 turn** | **MET** — 10/10 eligible turns, `status: "ran"` every time, never `skipped-budget` |
| **(B) M6 critic > 0** | **MET** — 3 findings demoted (41 verdicts issued, 16 demotions proposed by the critic phase, 3 surviving aggregation) |
| M3 recall ≥ 3 of the landed seeds | **NOT MET** — 1/3. See the phrasing defect below |
| M3 recall unchanged vs pilot-01 (critic is demote-only + exempted) | **NOT MET, and this is the run's main finding** — 2/3 → 1/3, attributable to the critic by exact ablation |
| M2 slope not citable as critic evidence | **HELD** — reported as mechanically zero (`rejectedAsFp` = 0 everywhere), not as an improvement |
| M1 median 1–2, critic can only lower iterations | **MET** — median 1, mean 1.17 (down from 1.58) |
| M4 ≤ M3's miss rate | **MET** — 0.67 ≤ 0.67 |
| M5 higher than pilot-01, under $1 | **NOT MET** — $0.0125, lower; and unfalsifiable, see bug 2 |
| M6 fp-ledger / reputation / lore all 0 | **MET** — all three 0 |
| 3–5 of 5 seeds land | **MET** — 3, the same three as pilot-01 |

**A defect in my own preregistration, recorded rather than reinterpreted.** The M3 prediction
was written as "at least 3 of the seeds that LAND are caught" — an absolute count carried over
from pilot-01's floor while the denominator was switched to a variable one. With 3 seeds landing
it demands 3/3, i.e. perfect recall, which was never the intent. The outcome (1/3 = 0.33) fails
it under either reading, count or rate (pilot-01's floor was 0.60), so nothing hinges on the
ambiguity here — but pilot-03 must state such floors as **rates**, not counts.

## The system this describes

| | |
|---|---|
| Binary | `dist/reviewgate` 0.1.0-alpha.15, commit `33bc02f`, `sha256:7f92445b…` — pinned by the preregistration |
| Panel | `openrouter` / `deepseek/deepseek-v3.2` (`security`) + `ollama` / `glm-5.2:cloud` (`correctness`) — 13 reviews each, **never degraded to one voice** |
| **Critic** | `openrouter` / **`deepseek/deepseek-v4-flash`**, persona `fp-filter` — the single config delta vs pilot-01 |
| codex | Excluded **via config**, not via quota state, so the panel matches pilot-01's |
| Agent | `claude -p --permission-mode acceptEdits`, one invocation per turn; its model is not pinned |
| Config | effective fingerprint `a9a5de78600c`, approved at `init`, `pending: None` |
| Sandbox | `/private/tmp/rig-pilot02-kzYEoV`, throwaway `git init`, armed with `reviewgate init --host claude` |
| Cassette | 40 entries, inside the sandbox; `rig replay` reports harvest+ablate **deterministic** |

The critic's model is **pinned rather than inherited**, deviating from the spec's C1 snippet on
purpose: this sandbox's `providers.openrouter.model` is `deepseek-v3.2`, which is *also* panel
reviewer #1, so an inherited critic would have judged its own findings. The pin keeps it
independent of every panel member and matches the model the cited bench figures used. Neither
panel nor critic pins an OpenRouter upstream — pinning one would have re-routed the panel too,
which would have been a second change.

## Anything that failed, timed out or was skipped

- `warnings[]` contains **exactly 2 entries**, both the seed-landing exclusions for turns 4
  and 9. No turn was dropped, no report failed to validate, no panel ran short-handed.
- Turns 1 and 8 produced zero findings, so the critic legitimately never ran on them
  (`orchestrator.ts:2302`). They are excluded from claim (A)'s denominator, not counted as
  failures. No turn reported `skipped-budget`, confirming in the field that `doctor`'s
  worst-case panel-budget warning (630s vs the 600s deadline) was arithmetic and not a real
  constraint: pilot-01's slowest gate run used 9.2% of that deadline.
- **The billed OpenRouter amount could not be reconciled.** pilot-01 read the key's usage before
  and after; I did not record a pre-run baseline, so only the cumulative total (54.9155) is
  available and the delta is unrecoverable. Process fix for pilot-03: capture
  `/api/v1/credits` before and after. Given bug 2 the estimate is a floor regardless.

## How to read these numbers

- **n = 12 turns, 3 landed seeds.** A single turn moves recall by 0.33. This detects SIGNAL; it
  does not establish effect size. Every rate carries its raw numerator/denominator and a Wilson
  95% CI, and the recall CI (0.06–0.79) spans most of the range.
- **Two runs of two different configurations.** Any pilot-01 → pilot-02 difference is confounded
  with ordinary run-to-run variance in the agent, the panel and the load-balanced upstream. The
  claim that survives that is the **within-run** one: the exact `−critic` ablation, which needs
  no cross-run comparison at all.
- **M3 measures DETECTION, not INTERCEPTION** — `isBlocking` is `CRITICAL || WARN`. Under this
  config's `softPassPolicy: "allow"` the gate passed turn 2 in both pilots.
- **The ablation is an aggregation-layer counterfactual** over fixed reviewer output. It cannot
  re-drive the agent: different verdicts would have produced different diffs.
- **A different panel is a different system.** These numbers do not transfer to a panel with
  codex, or a different deepseek revision.

## What this changes

The registered question was whether the critic engages at this scale. **It does — on every
eligible turn, unlike any other history-dependent layer in either pilot.** It is the first
suppression layer to be observed working in a live loop rather than being inert.

The unregistered answer is that its first measured act in this rig was to demote a true
positive, and that the protections meant to prevent exactly that are keyed to CRITICAL severity
and to corroboration — neither of which held for a WARN-severity security finding that the panel
reported twice under two different rule ids. The concrete candidates, in the order the evidence
supports them:

1. **Extend the critic's true-positive exemption below CRITICAL for security/correctness
   categories**, or make `demoteOneStep` refuse to take a security finding below WARN. The
   current floor lets a demote cross the blocking boundary in one step.
2. **Merge same-file same-category detections before the critic sees them**, so the
   corroboration exemption can engage. Two reviewers agreeing on a defect under different
   phrasings currently reads as two lone findings.
3. Fix the three rig bugs above, `rig ablate`'s denominator first — it is the one that silently
   publishes wrong numbers.

**Do not enable the critic in the `init` scaffold on the strength of this run.** The spec's C1
made that conditional on pilot-02 confirming the effect, and what pilot-02 actually measured is
one true positive lost against zero measurable FP reduction — the FP side had no signal to
reduce. That is not a case for shipping it on by default, and it is not on its own a case for
turning it off here either (n=3, and disabling it needs a second human TTY approval).
