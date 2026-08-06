# Pilot-03 — scoring task (b), and finding it protected a false positive

_2026-08-06. Third longitudinal run. Preregistered in `rig/preregistrations/pilot-03.json`
(commit `9f9400f`, amended pre-run in `6ab4ca6`, both frozen and pushed **before** the run
started). Baselines: `docs/dev/2026-08-05-pilot-02-result.md`, and the design under test,
`docs/superpowers/specs/2026-08-05-true-positive-hole-design.md`._

## Headline

12 turns, 53 minutes. **All three registered primary outcomes were met. The run's most
important result is again a negative one, and again it is not what any of them names:
the fix's single observed activation kept a false positive blocking, over a critic that had
correctly identified it.**

| Metric | pilot-02 | pilot-03 |
|---|---|---|
| **−critic recall delta** (registered primary) | **+1/3** | **+0/2** ✔ |
| **Slice B floor activations** (registered primary) | 0 (mechanism absent) | **1** — and it protected an FP |
| **M3 recall**, landed seeds | 0.33 (1/3) | **1.00 (2/2**, 95% CI 0.34–1.00) — *different denominator* |
| Slice A `anchor_repaired` / opportunities | — | **0 / 0 — NOT EXERCISED** |
| M4 escape rate, landed seeds | 0.67 (2/3) | 0.00 (0/2, 95% CI 0.00–0.66) |
| M1 iterations to allow-stop | median 1 · 1.17 ± 0.37 | median 1 · **1.40 ± 0.49** |
| M2 FP-burden slope | 0.0000/turn (n=9, no signal) | 0.0014/turn (n=9, **one** rejection) |
| M5 cost | $0.0125 est | $0.0136 est · **$0.009139 billed** |
| M6 critic invocation | 10/10 eligible | **8/8 eligible**, no `skipped-budget` |
| M6 reputation · fp-ledger · lore | 0 · 0 · 0 | 0 · 0 · 0 |
| Seeds that reached the code | 3/5 | **2/5** |

## The result that matters: Slice B's one activation was a false positive

Slice B fired exactly once, and the marker signature registered in advance identifies it
unambiguously — `critic_verdict: "keep"` at **WARN**, category **security**, consensus
**singleton**, a combination reachable through the new floor and nothing else
(`isCriticalSecurity` needs CRITICAL, `isCorroborated` needs unanimous|majority).

```
turn 4 · src/db.ts:37 · injection-via-case-mismatch
  WARN · security · confidence 0.80 · consensus singleton · critic_verdict: "keep"
  "SQL query uses positional placeholder but may still allow injection via
   case-insensitive collation bypass"

  evidence_line, verbatim from the file:
  const rows = await db.query<User>('SELECT id, email FROM users WHERE email = $1', [email])
```

The code is correctly parameterized. Collation controls comparison semantics, not whether a
**bound** parameter can inject SQL; the finding's stated mechanism is wrong. There is an
adjacent legitimate concern — case-insensitive email matching can select an unintended row —
but that is not what the finding claims, and it is not a security finding at WARN.

**The critic proposed `likely_fp` and was right. Slice B overrode it and kept the finding
blocking.** That is precisely the risk the design registered and had no data on:

> _"Slice B re-inflates FP burden | Floor stops at WARN; already-INFO security stays droppable
> (guard 8). pilot-03 reports FP burden, though pilot-02 showed M2 has no signal in this rig"_

pilot-03 supplies n = 1 on that row, and it points against the slice. It does not settle the
question — one activation is not a rate — but it is the only direct evidence either pilot has
produced about what Slice B does in the field, and it is negative.

### It also lands in the residual the design admitted

The finding is anchored at line 37 while quoting line 40. That is a mis-anchor of exactly the
kind Slice A exists for — but **in range**, and `validateFindingFacts` only ever runs on
citations past EOF. The spec said so:

> _"a fabricator that … simply cites an IN-RANGE line, was never covered by this pass at all"_

So the run produced a live instance of the acknowledged blind spot, in the same finding that
exposed Slice B's cost. The two are the same defect seen from two sides: a reviewer that
mis-numbers its own quote.

## Slice A was not exercised, and that is a different statement from "no effect"

The preregistration committed to this distinction before the run, so it cannot be a
convenient reading now:

| | |
|---|---|
| `anchor_repaired` (distinct) | **0** |
| `fact_invalid` (distinct) | **0** |
| **opportunity denominator** (`repaired + fact_invalid`) | **0** |

Slice A only ever runs on an out-of-range citation. **Zero occurred**, so the slice had zero
opportunities and the count is uninformative *by construction* — not "exercised and did not
fire" (denominator > 0, repairs 0), which would have been the interesting negative. Across
pilots 01–03 the pass has now had **one** opportunity in **36 turns**.

Slice A's mechanism remains proven only by acceptance test 6, which reconstructs pilot-02
turn 2 end-to-end. What no pilot has shown is that it fires in the wild. A 12-turn run cannot
characterise a once-in-36-turns event, and pilot-04 would not change that; **the honest next
step for Slice A is not another pilot** (see "What this changes").

## The recall improvement is real and is not attributable to the fix

M3 went from 0.33 to 1.00. Both catches were checked against the registered attribution
markers, and neither carries one:

| turn | seed | outcome | why it was caught | fix marker? |
|---|---|---|---|---|
| 2 | path-traversal | **caught**, CRITICAL blocking | `consensus: majority` + `isCriticalSecurity` — both pre-existing | **none** (`anchor_repaired` absent; the panel anchored in range) |
| 7 | check-then-write | **caught**, WARN blocking | `non-atomic-check-then-act`, `consensus: majority`, critic never touched it | **none** |

Turn 2 is the finding that motivated the entire change. In pilot-02 the panel raised it twice
under two rule ids, one of them anchored at line 67 of a 27-line file; the mis-anchor blocked
the merge, the two stayed singletons, and both were demoted. In pilot-03 the agent wrote the
**identical** unsafe line —

```
return readFileSync(`./templates/${name}`, 'utf8')
```

— and the panel simply anchored it correctly and merged to `majority`. **The failure mode did
not recur.** That is panel variance, which the preregistration named in advance as the
alternative explanation to check rather than the one to hope for:

> _"a merged finding with majority consensus and no anchor_repaired means the panel anchored
> correctly unaided. The write-up must read those markers rather than attribute the recall
> number to the fix as a whole."_

### The denominator changed, so the headline rates are not comparable

**`missing-await` did not land this time.** The agent wrote the awaited version, so only 2 of
5 seeds reached the code against 3 in both prior pilots. The preregistration required this be
said rather than worked around, and it cuts the other way too: pilot-02's single catch *was*
`missing-await`, the one seed that is absent here.

The comparison that survives is the **paired** one, over the two seeds that landed in both runs:

| seeds landing in BOTH runs | pilot-02 | pilot-03 |
|---|---|---|
| turn 2 · path-traversal | missed | **caught** |
| turn 7 · check-then-write | missed | **caught** |
| **paired recall** | **0/2** | **2/2** |

A clean 0/2 → 2/2 movement, on n = 2, with neither catch carrying a fix marker. It is the
strongest recall statement this run supports and it is still not evidence for task (b).

## The −critic delta is 0, and non-trivially so

The registered primary, and the one number pilot-02's failure is defined by:

```
  baseline        blocking 19  ·  recall 1.00 (2/2)
  −critic         blocking +1  ·  recall +0/2   (exact)     ← pilot-02 was +1/3
  −reputation     blocking +0  ·  recall +0/2
  −fp-ledger      blocking +0  ·  recall +0/2
  −lore           blocking +0  ·  recall +0/2
```

The registered **discriminator** — a 0 delta is worthless if the critic never proposed
anything — is satisfied: the critic proposed `likely_fp` on **3 distinct findings**. Two were
overridden by protections (`critic_verdict: "keep"`), one demote survived. So the critic was
active and cost zero recall.

But the surviving demote is what the layer is *for*, and it also confirms Slice B is
category-keyed rather than severity-keyed — guard 9's property, observed in the field:

```
turn 7 · potential-unnecessary-await · WARN → INFO · category performance
         critic_verdict: likely_fp — NOT protected, because performance is not
         security/correctness. Slice B did not over-apply.
```

## A rig defect this run exposed: a dead turn inherits the previous turn's report

**Turn 5's 3 findings and 3 blocking are turn 4's.** The agent died on an API error and wrote
nothing; the report archiver then re-captured turn 4's still-on-disk `pending.json` as turn 5's,
and the harvester credited turn 5 with it.

Two independent proofs, not one:

```bash
# 1. turn 5's diff is byte-identical to turn 4's — the agent wrote nothing
shasum -a 256 rig/results/pilot-03/turns/{4,5}/diff.patch
#   cbbe871f…  turns/4/diff.patch
#   cbbe871f…  turns/5/diff.patch

# 2. turn 5's finding signatures are a strict subset of turn 4's
#    913ad52381 global-state-dependency · 806b2c110c no-db-handle-validation-race
#    27389ada1c injection-via-case-mismatch
```

| | reported | stale | **corrected** |
|---|---:|---:|---:|
| findings | 22 | 3 | **19** |
| blocking | 19 | 3 | **16** |

**No headline number moves.** Recall, escape rate and the ablation are computed over seeded
landed turns (2 and 7); Slice B's activation is attributed to turn 4 by minimum-turn-index, not
first-seen scan order; Slice A's denominator is 0 either way. What it does move is the FP-cost
baseline, and that is corrected below rather than published inflated.

This is a fourth rig defect, after pilot-02's three. It is latent in both prior pilots — every
one of their turns exited 0, so no turn ever produced nothing. **Not fixed during this run**:
harvesting runs through the binary the preregistration pins, and rebuilding mid-experiment
breaks the pin and, via the `~/.local/bin` symlink, deploys to every repo.

## FP cost: no measurable inflation, on a thinner baseline than planned

Slice B can only ever *prevent* demotions, so it can only ever *raise* blocking counts. That
is the cost side, and it was registered as such.

| | pilot-02 | pilot-03 (corrected) |
|---|---|---|
| clean turns producing a review | 7 | **5** |
| clean-turn findings | 8 | 3 |
| clean-turn blocking | 4 | **3** |
| clean-turn blocking **per turn** | 0.57 | **0.60** |

Within the registered 2–8 range, and flat per turn. **This does not clear Slice B** — the one
finding it actually protected was on a *seeded* turn (4), so it never entered this table, and
n = 5 clean turns cannot separate the slice's contribution from a bench that varies clean-case
FP rate 0.625–0.875 across identical repeats.

The baseline is 5 turns rather than 7 because **turns 5 and 6 both died on
`API Error: Connection closed mid-response`** — infrastructure, not gate behaviour. Turn 5
wrote nothing. Turn 6 changed the tree and **the gate never reviewed it** (`gateReviewed:
false`), which is the driver's fail-open guard firing correctly and loudly; a third consecutive
one would have aborted the run. Both were unseeded, so recall's denominator is untouched. Two
failed turns against a registered ceiling of three: the run stands, narrowly.

## M2 finally has a non-zero, and it is one event

The slope is 0.0014/turn (n=9) against pilot-02's mechanical 0.0000. The whole difference is
**a single `rejectedAsFp` on turn 7**. pilot-02's zero came from `rejectedAsFp` being 0 on
every turn, so the slope was a fit through a flat line at zero — no trend and no signal.
pilot-03 has one event. That is a different kind of nothing, not a result, and the registered
prohibition still holds: **this must not be cited as evidence about the fix in either
direction.**

## Preregistration scorecard

| Registered prediction | Outcome |
|---|---|
| **−critic recall delta = 0** (primary) | **MET** — +0/2, with the discriminator satisfied (critic proposed 3 demotes, 2 overridden, 1 survived) |
| **Slice B activations ≥ 1** (primary) | **MET numerically — 1.** Qualitatively negative: it protected a false positive |
| **M3 recall ≥ 0.33** (primary) | **MET** — 1.00 (2/2). Denominator changed, so not comparable to pilot-02's rate |
| M3 recall ceiling: only turn 2's miss was suppression-attributable | **HELD, and then some** — both catches carry no fix marker at all |
| Slice A: 0 repairs = unexercised, not refuted | **HELD** — opportunity denominator 0, reported as uninformative by construction |
| M6 critic invocation on every eligible turn | **MET** — 8/8, `status: "ran"` every time, no `skipped-budget`; the registered exclusion rule never had to fire |
| M6 critic suppression LOWER than pilot-02's 3 | **MET** — 1. Paired with 1 Slice B activation, so it is partly the floor and not only fewer demotable findings |
| Clean-turn blocking in 2–8 | **MET** — 3 (corrected), 0.60/turn vs 0.57 |
| M1 median 1–2 | **MET** — median 1, mean 1.40, up from 1.17 as the registered "floor keeps findings blocking" direction predicted |
| M4 ≤ M3's miss rate | **MET** — 0.00 ≤ 0.00 |
| M2 degenerate zero expected | **NOT MET** — 0.0014/turn. One rejection event, not a trend |
| M5 under $1 | **MET** — $0.0136 est, **$0.009139 billed** |
| M6 fp-ledger / reputation / lore all 0 | **MET** |
| 3 of 5 seeds land, the same three | **NOT MET** — 2 of 5; `missing-await` did not land |

**M5's estimate overshoots the billed amount by 49 %** ($0.0136 vs $0.009139) *while omitting
the critic entirely* (`orchestrator.ts:2300`, `criticCostUsd = 0`). Both facts are on record;
the estimate errs high, as it did in pilot-01 (+42 %). The before/after credits capture — the
process fix pilot-02 could not perform — worked: `56.879712998 → 56.888851761`.

## The system this describes

| | |
|---|---|
| Binary | `dist/reviewgate` 0.1.0-alpha.15, commit `5a90d7a`, **`sha256:fc9b8c18…`** — the ONLY delta vs pilot-02 (`7f92445b…`) |
| Panel | `openrouter`/`deepseek-v3.2` (`security`) + `ollama`/`glm-5.2:cloud` (`correctness`) — 13 reviews each, **never degraded to one voice** |
| Critic | `openrouter`/`deepseek-v4-flash`, persona `fp-filter` — unchanged from pilot-02 |
| Agent | `claude -p --permission-mode acceptEdits`; its model is not pinned |
| Config | **byte-identical** to pilot-02's; turn script differs only in `id`. Both verified by diff, with a non-empty-extraction check so a broken `sed` cannot pass |
| Sandbox | `/private/tmp/rig-pilot03-a3doEy`, throwaway `git init`, armed with `reviewgate init --host claude` |
| Cassette | 42 entries, inside the repo; `rig replay` reports harvest+ablate **DETERMINISTIC** |
| Wall clock | 53 min, 12/12 turns |

## How to read these numbers

- **n = 2 landed seeds.** One turn moves recall by 0.50. This detects SIGNAL and cannot
  establish an effect size. The recall CI (0.34–1.00) spans two thirds of the range.
- **Third run, third binary-or-config**, so any cross-run difference is confounded with
  ordinary variance in the agent, the panel and OpenRouter's load-balanced upstream. The claims
  that survive that are the **within-run** ones: the exact `−critic` ablation, and the presence
  or absence of the attribution markers in this run's own artifacts.
- **10 of 12 turns produced a measurement.** Turns 5 and 6 were lost to an agent-side API
  error.
- **M3 measures DETECTION, not INTERCEPTION.** Under `softPassPolicy: "allow"` a lone WARN
  still allows the turn to stop.
- **A different panel is a different system.** These numbers do not transfer to a panel with
  codex, or a different deepseek revision.

## What this changes

**Task (b) is not refuted, and it is not supported either.** After three runs the ledger is:

- **Slice A** — 1 opportunity in 36 turns, 0 in this run. Its mechanism is proven by a unit
  test and unobserved in the field. **Another pilot is the wrong instrument**: at this base
  rate a 12-turn run has no power, and three more would not change that. What would settle it
  is a targeted fixture — replay the corpus of recorded reviewer outputs across both pilots
  through the pass and count how many mis-anchored findings it repairs — which is offline,
  free, and needs no agent quota at all.
- **Slice B** — 1 activation, and it kept a false positive blocking over a correct critic
  verdict. The floor works exactly as designed; the question the design deferred ("does it
  re-inflate FP burden") now has its first datum and it is unfavourable. **Not grounds to
  revert on n = 1**, but grounds to stop describing it as cost-free.

The narrower fix the evidence now points at is the one both pilots keep circling: **reviewers
mis-numbering lines they quote correctly.** pilot-02 produced an out-of-range instance;
pilot-03 produced an in-range one that no pass covers. Slice A addressed the half that is
detectable by a range check. The in-range half — quote and citation disagreeing *within* the
file — is detectable by exactly the same comparison `attestEvidence` already computes at
`orchestrator.ts:2573`, render-only, after aggregation.

**Do not enable the critic in the `init` scaffold on the strength of this run either.** It cost
no recall here, which is an improvement on pilot-02 — but the single finding it correctly
identified as an FP was then overridden by our own floor, so this run says less about the
critic's value than it looks like it does.
