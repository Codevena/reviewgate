# Precision remediation — evidence unit, reputation eligibility, critic

_2026-08-05. Follows `docs/dev/2026-08-05-pilot-01-result.md` (pilot-01 baseline)._
_Task (a) from `NEXT_SESSION.md`, re-scoped after the measurement below contradicted its premise._

## Why this exists

Pilot-01 reported M6 suppression `critic 0 · reputation 0 · fp-ledger 0` and an M2 FP-burden
slope of **+0.0239/turn**, against the registered direction. The handoff attributed this to
FP-ledger promotion being unreachable on a 2-reviewer panel and proposed making promotion
easier.

**Measuring this repo's live ledger contradicted that proposal.** The numbers below are read
off `.reviewgate/learnings/known_fp.jsonl` (29 entries, 30 rejects, 2026-06-03 → 2026-07-31,
10 sessions) and cross-checked against `reviewgate learn status`, which reports the same
values independently.

## The measurement

| Question | Answer |
|---|---|
| Entries | 29 — **all `candidate`**, 0 active, 0 sticky |
| Signatures rejected more than once | **1 of 29** (FP-001) |
| Cross-**session** recurrence | **0 of 29** |
| Distinct runs contributing to any one cluster | **1 — for all five clusters, no exception** |
| Brain curator | 122 of 139 decisions failed quorum, **every one exactly 1 provider short** |
| `openrouter:security` reputation | trust **0.30** vs floor 0.45 — not demoted (decayed samples 5.6 < `minSamples` 8) |

The decisive row is **"distinct runs per cluster"**. Clustering the ledger under C4's rule (same
file, same category, ≥2 shared canonical tokens) yields **five** clusters — every one of them
sourced from a single gate run:

| Cluster | Members | Rejects | Distinct sessions | Distinct run_ids | Providers |
|---|---|---:|---:|---:|---|
| `src/rig/driver.ts` (pipe/deadlock) | 3 | 3 | 1 | **1** | claude-code, ollama |
| `src/core/fact-check.ts` | 2 | 2 | 1 | **1** | openrouter |
| `src/diff/sanitizer.ts` | 2 | 2 | 1 | **1** | codex |
| `bin-templates/user-gate.sh` | 2 | 2 | 1 | **1** | claude-code, ollama |
| `src/core/lore/approve.ts` (tty-guard) | 2 | 2 | 1 | **1** | claude-code |

**These are not repetitions. They are one review round emitting several differently-phrased
findings about the same thing, rejected by the agent in one batch.**

> **Correction.** An earlier draft of this table listed four rows and reported reject counts of
> 3–4 with `sanitizer.ts` at 2 sessions / 2 runs. Those were the **file+category** groups from
> the exploratory pass, not the C4 clusters, and `bin-templates/user-gate.sh` was missing
> entirely. Re-derived from the ledger under the actual C4 predicate, `sanitizer.ts`'s cluster is
> `FP-014`+`FP-015` (both codex, one run) — `FP-009` is a singleton. The one apparent
> counterexample to "every cluster is a single run" was an artefact of mixing the two groupings.
> The corrected data makes the argument stronger, not weaker. Found by the gate's own review of
> this spec (F-001).

### What that invalidates

The first fix drafted in this session — replacing the brittle `ruleIdToken0` cluster key with
canonical token matching — would have promoted the `driver.ts` cluster to `active` (3 rejects ×
2 providers). That promotion would rest on **a single review round**, converting one round of
panel chatter into permanent suppression. The FP-ledger demote pass (`aggregator.ts:724`) has
**no severity or category ceiling** — unlike the `cycleRejected` pass beside it, which refuses
to auto-hide CRITICAL or security/correctness under G0b. So that change was a fail-open, and it
is not in this design.

The `ACTIVE_REJECTS = 3` threshold is plainly intended as *temporal* recurrence. Counted across
a cluster it stops measuring recurrence and starts measuring how verbose the panel was.

### What it means for M2

The FP-ledger can only suppress what comes back. In two months of dogfooding, essentially
nothing came back — the gate reviews the **diff**, so code that is reviewed, dispositioned and
committed does not reappear in the next diff. Lowering thresholds or improving grouping does not
create evidence; it only makes one round look like three. **No change to the FP-ledger will move
the M2 slope at this repo's scale, and this design does not claim otherwise.**

The lever that *is* measured sits switched off: `phases.critic` defaults to `null`, was off in
this repo and off in the preregistered pilot config — which is why its M6 delta was zero *by
construction*.

The repo's own published evidence (`docs/evidence.md`, Alpha.12 benchmark v2: 30 cases × 3
repeats, critic 86/86 eligible) measures the critic as:

| variant | precision | recall | clean-case FP rate |
|---|---:|---:|---:|
| baseline | 0.3505 | 0.8095 | 0.7292 |
| without critic | 0.3091 | 0.8095 | 0.8958 |

**+4.1pp precision, −16.7pp clean-case FP rate, recall unchanged.** That doc's own caveat
carries over: across the three repeats the clean-FP rate ranges 0.625–0.875 (0.729 ± 0.106), so
this is a small-sample central tendency, not a fixed figure.
`docs/superpowers/plans/2026-07-03-field-report-calibration-remediation.md:208` already
recommends enabling it per-repo, citing the older Alpha.11 18-case smoke (−8 FPs, zero recall
cost) — a different, smaller run than the table above; the two should not be quoted as one
result.

## Scope

Four changes. One is expected to move the metric; three are correctness fixes with no expected
metric movement, stated as such in advance so pilot-02 cannot be read ambiguously.

### C1 — Enable `phases.critic` in this repo (config only)

```ts
critic: { provider: "openrouter", persona: "fp-filter" }
```

Provider rationale — this is the **same critic configuration the measurement above was made
with**, not a fresh guess: `bench/results/alpha12-v2/attempt-09/MANIFEST.md:21` records
"`openrouter` critic (`deepseek/deepseek-v4-flash` via `alibaba`): 86/86 eligible,
authoritative". Adopting a different provider would mean the +4.1pp/−16.7pp figures no longer
describe what is being switched on.

It is also the right choice on its own merits: `codex` is in quota cooldown until
2026-08-08T11:07Z (`.reviewgate/quota-cooldowns.json`); `claude-code` and `ollama` are panel
reviewers here, and a critic drawn from the panel is not independent; `gemini`/agy has documented
hang modes on non-agentic calls. `openrouter` is a subprocess-free HTTP adapter, already wired
for `grounding` in this repo, and is **not** a panel reviewer.

**`model` is deliberately omitted from the snippet, and that resolves correctly — verified.**
`phases.critic.model` is optional (`defaults.ts:159-163`) and `orchestrator.ts:2328` resolves it
as `criticCfg.model ?? cProviderCfg.model`. This repo's `providers.openrouter.model` is
`"deepseek/deepseek-v4-flash"`, so omitting it yields exactly the bench model. Pinning it
inline would duplicate the value and let the two drift; the argument that "a different model
invalidates the cited figures" is why this must be *checked*, not why it must be *restated*.
Re-verify this resolution if `providers.openrouter.model` is ever changed for grounding's sake —
that would silently re-model the critic too.

The provider block already pins `openrouterProvider: { only: ["alibaba"] }`, which the bench run
also used — leave it alone. Note this repo's own comment calls deepseek-flash "low-precision" and
excludes it as a *reviewer*; that is consistent, because the critic is a demote-only keep/likely_fp
classifier, not a finding generator, and its errors are bounded by the exemptions below.

Safety is already in place and is *not* modified: the critic is demote-only, and
`aggregator.ts:604-618` exempts CRITICAL+security/correctness, corroborated
(unanimous/majority) findings, and high-precision protected reviewers.

Implementation note, verified: `persona` is **required** by the config type
(`defaults.ts:159-163`) but is read by **nothing** on the critic path — `orchestrator.ts:2301-2328`
passes only `provider` and `model` to `runCritic`, whose prompt comes from the hardcoded
`buildCriticPrompt`. Supply a value to satisfy the schema; do not go looking for a persona file
to edit, and do not expect the string to change behaviour.

**Repo-local only.** The `init` scaffold default stays off until pilot-02 confirms the effect.
Editing `reviewgate.config.ts` arms the control-plane path — this is a phase *addition*, so it
needs `reviewgate config approve` on a TTY.

### C2 — Evidence unit becomes the distinct run

`src/core/fp-ledger/store.ts:recompute` and `src/core/fp-ledger/clusters.ts` currently threshold
on the **count of reject events**. Both switch to counting **distinct `run_id`s** within the
window:

```
active:  >= 3 distinct run_ids in 60d  AND >= 2 distinct providers
sticky:  >= 5 distinct run_ids in 90d  AND >= 2 distinct providers
```

The provider requirement is unchanged. `pinned_by` still forces `sticky`. The promote-only
guard in `recordReject` and the demotion ownership in `decayPass` / `activeSnapshot` are
unchanged.

**Concrete change, per file.** The two files threshold independently on different inputs and must
both be edited; neither calls the other:

- `store.ts:recompute` — operates on **one entry's** `e.rejects`. `win90.length >= STICKY_REJECTS`
  becomes `new Set(win90.map(r => r.run_id)).size >= STICKY_RUNS`, and likewise for
  `win60`/`ACTIVE_RUNS`. The `distinct(...)` provider helper is untouched.
- `clusters.ts:computeFpClusters` — operates on the **union of all member entries'** rejects
  (already deduped by `(signature, provider, ts)`). `win60.length`/`win90.length` become the
  same distinct-`run_id` set sizes. Its `reject_count_*` fields stay as they are (they are
  reported to the CLI); add `distinct_runs_active_window` / `_sticky_window` alongside them
  rather than redefining an existing field, and update `isNearActive` to test the run count.

**Window semantics are unchanged and stay on `reject.ts`.** The 60d/90d filter continues to use
each reject event's own `ts` (`store.ts:60-61`); the run_id is used *only* for the distinctness
count after filtering. It is never parsed for a timestamp. Stated explicitly because a run_id is
an opaque `<ulid>:<iter>:<seq>` string here and must not be confused with the rig driver's
ISO-stamped run ids.

`run_id` is `z.string()` and **required** in `FpRejectSchema` (`src/schemas/fp-ledger.ts:4-9`),
and every load goes through `FpLedgerIndexSchema.parse`. A reject without a run_id therefore
cannot exist in a valid ledger — no defaulting or back-fill path is needed. Rename constants to
`ACTIVE_RUNS`/`STICKY_RUNS` so no reader mistakes them for event counts.

**Expected effect on today's data: nothing promotes — before or after.** The change removes a
latent fail-open rather than altering current behaviour. It becomes load-bearing if a future
change ever wires cluster-level evidence into suppression (explicitly *not* C4, see below), or
when a larger panel makes multi-finding rounds routine.

Note `recordReject`'s existing dedup key is `(run_id, provider)`, so one provider already cannot
contribute two rejects to one signature in one run. C2 extends that same intent from the
per-signature level to the threshold level.

### C3 — Reputation eligibility uses the raw sample count

`src/core/reputation/store.ts:143` derives `samples` as
`decayedCount(correct) + decayedCount(wrong)` and `isUnreliable` compares it to `minSamples`.
That mixes two questions. Split them:

- **Eligibility** ("is there enough evidence to judge at all") → **raw** `correct.length + wrong.length`
- **Trust** ("how reliable lately") → decayed, unchanged

Self-correcting: as evidence ages, `decayedCount → 0` and `trustScore → (0+1)/(0+0+2) = 0.5`,
which is above the 0.45 floor — an old-bad reviewer drifts back to neutral and stops being
demoted, without the raw count ever needing to shrink.

**`RepDerived` is never persisted — verified, not assumed.** `grep -rn "RepDerived" src` returns
exactly four hits, all in-memory: the interface declaration (`score.ts:38`), the `isUnreliable`
parameter (`score.ts:43`), the import and the private `derive()` return type
(`store.ts:7,140`). It is computed per call from the persisted `Reputation` object and never
serialised, so adding a field cannot leave stale objects on disk whose missing `evidence` would
compare as `NaN >= minSamples` (false) and silently suppress every future demotion. That failure
mode is real for persisted types; it does not reach this one.

`RepDerived.samples` has exactly **one** consumer: `score.ts:44` (`isUnreliable`). _(Corrected
2026-08-05 — this first claimed two, naming `cli/commands/learn-status.ts:463` as the second.
That is wrong: `learn-status.ts:268-280` builds its own row objects by calling
`decayedCount`/`trustScore` directly and never imports `RepDerived`. The single consumer is why
`samples` can keep its meaning untouched while `evidence` takes over eligibility.)_ The displayed value must stay
interpretable, so `RepDerived` gains a second field rather than having `samples` silently change
meaning: `samples` (decayed, displayed) and `evidence` (raw integer, used for eligibility).
`isUnreliable`'s signature changes to read `evidence`; `learn-status` additionally prints the raw
count so the two are never confused in the field.

**Expected effect — corrected 2026-08-05 by the plan gate. It is NOT "none".** This section first
said "none today". That understated the blast radius: `raw ≥ decayed` always holds, so the change
can only **grow** the demote-eligible set, and it does so in every repo the rebuilt binary
reaches. Two paths consume that set:

- `unreliableReviewers()` → the aggregator's reputation demote. `phases.reputation.enabled`
  defaults to **true** (`src/config/defaults.ts:211`), so this is live everywhere, not opt-in.
- `quarantinedReviewers()` (`store.ts:167-170`) → `selectActiveReviewers`, which removes a
  reviewer from the panel **entirely**, so its true positives are never generated at all.

Measured against this repo's real `.reviewgate/reputation.json`: `openrouter:security` flips
`demoting` false→true (intended — trust 0.30 against a 0.45 floor) and `codex:plan` crosses the
eligibility bar for the first time (raw 8 ≥ `minSamples` 8 vs decayed 5.22), harmless only
because its trust is 0.86. None of this repo's three panel keys (`codex:security`,
`claude-code:security`, `ollama:security`) flips.

Honest statement: **widens demote-eligibility everywhere; verified a no-op for this repo's
panel.** The verification is mandatory, and it must read `demoting` from `forDoctor` —
`learn status` does not print that field, so it cannot show this effect.

### C4 — Cluster key: canonical token matching, diagnosis only

`ruleIdToken0` (first hyphen segment) is brittle: `pipe-buffer-deadlock` and `pipe-deadlock`
cluster, `piped-stdout-undrained-deadlock` — one character apart — does not.

Replace with: same `file`, same `category`, and **≥2 shared canonical tokens**, transitively
closed via union-find (named so the closure is reproducible — a different closure strategy over
the same pairwise predicate can yield different clusters). Canonicalisation reuses
`normalizeRuleId`'s tokeniser and its `RULE_ID_NOISE` set (`src/diff/signature.ts:29-60` — 28
connectors and generic finding nouns: `via`, `with`, `risk`, `issue`, `potential`, `unsafe`, …),
plus light suffix folding (`ing`/`ed`/`s`, then a trailing `e`) so `pipe`/`piped` → `pip` and
`defang`/`defanged` → `defang`.

**The noise list does not carry the safety burden — the conjunction does.** Domain nouns like
`buffer`, `race` or `write` are deliberately *not* noise, so two unrelated rules sharing two such
tokens could merge. Three conditions bound that: same file, same category, and ≥2 shared tokens
simultaneously. On the 29 real entries no such false merge occurs, and the surface is
diagnosis-only.

**Transitive closure is the residual risk, and it is accepted rather than solved.** A–B sharing
two tokens and B–C sharing two *different* tokens forces A–C into one cluster even with zero
tokens in common. That is exactly how the rejected `≥1 shared token` variant chain-merged all
four `approve.ts` entries. At `≥2` it does not occur on today's data, but the structure permits
it, so the test suite must include a synthetic transitive chain (below) and the surface stays out
of the suppression path.

Measured on the real 29 entries: **5 clusters, zero false merges.** `approve.ts` splits
correctly — the TTY-guard pair merges, while `toctou-challenge-verify-to-write` and
`weak-challenge-entropy` stay separate. The naive `≥1 shared token` variant chain-merges all
four of `approve.ts` and is rejected for that reason.

**This feeds `reviewgate fp clusters` and `learn status` only.** It does *not* feed
`fpActiveClusters` in the aggregator: with C2 in place a cluster still needs ≥3 distinct runs to
suppress anything, and no cluster in this repo has more than 2. Wiring a better key into
suppression before that evidence exists is precisely the fail-open C2 removes.

## Out of scope, deliberately

- **Brain curator quorum** (122 fails, all 1 provider short). Shares the ≥2-provider rule with
  the FP-ledger, but promotes *knowledge* rather than suppressing findings — it cannot move M2,
  and `phases.brain` is default-off, so a fix benefits this repo alone. Documented as a
  follow-up.
- **A unified corroboration abstraction** across FP-ledger / curator / reputation. Reputation's
  blocker (C3) is a unit mismatch, not a corroboration rule; only two of the three subsystems
  share the rule. Unifying them would couple three subsystems to serve two.
- **Lowering `trustFloor`** to catch the pilot's 0.476-vs-0.45 near-miss. Tuning a threshold to
  a single observation on n=21 samples is fitting noise.

## Testing

Per change, plus the mutation requirement (every guard test seen red once, in a copy):

- **C2 / `store.ts` active tier** — a fixture with 3 rejects, 2 providers, **one** `run_id` must
  stay `candidate`; the same 3 rejects spread over 3 `run_id`s must reach `active`. Guarded
  quantity: **1 distinct run → candidate; 3 distinct runs → active.** Values differ, so
  non-vacuous on paper.
- **C2 / `store.ts` sticky tier** — separate fixture, since the boundary is not the active one:
  5 rejects, 2 providers, **4** distinct run_ids within 90d → `active` (meets 3-run active, not
  5-run sticky); the same 5 rejects over **5** distinct run_ids → `sticky`. Guarded quantity:
  **4 distinct runs → active; 5 distinct runs → sticky.**
- **C2 / `clusters.ts` mirror** — the cluster path aggregates across members, so it needs its own
  fixture rather than a re-run of the above: two entries with distinct signatures in the same
  file+category, contributing 3 rejects total from 2 providers within **one** run_id →
  `computeFpClusters` reports `stage: "candidate"` and `isNearActive` false-on-run-count; the
  same two entries with those 3 rejects across 3 run_ids → `stage: "active"`. Guarded quantity:
  **cluster with 3 rejects / 1 run → candidate; 3 rejects / 3 runs → active.** This is the test
  that would have caught the fail-open in the rejected first draft.
- **C3** — a reviewer with 13 raw events decayed to 5.6 samples and trust 0.30 must be
  `isUnreliable` after the change and must **not** be before it (with `minSamples: 8`). Values:
  **raw 13 ≥ 8 → demote; decayed 5.6 < 8 → no demote.**
- **C4** — a **synthetic** fixture reproducing the shapes measured here: `driver.ts` yields one
  3-member cluster; `approve.ts` yields the TTY-guard pair **plus two singletons** (the
  no-false-merge assertion, which a cluster count alone would not catch); the `≥1 shared token`
  variant would chain-merge all four and must fail the test. **Do not copy
  `.reviewgate/learnings/known_fp.jsonl` into `tests/`** — it is gitignored runtime state and its
  `rejects[].reason` fields carry verbatim reviewer output. Hand-write the rule_ids instead.
- **C4 / transitive chain** — an explicit adversarial fixture, since today's data does not
  contain one: `alpha-beta-guard`, `beta-guard-gamma`, `gamma-delta-epsilon` in one file+category.
  A–B share `{beta, guard}`, B–C share `{gamma}` only (1 token) → the chain must **not** close,
  yielding one 2-member cluster plus a singleton. Then `beta-guard-gamma` → `gamma-delta-guard`
  so B–C share `{gamma, guard}` → all three merge despite A–C sharing only `{guard}`. Assert the
  second shape explicitly: it documents the accepted transitive behaviour rather than pretending
  it cannot happen.
- **C1** — no new test; covered by the existing critic suite. Verify by running the gate once
  and confirming `critic.status` in `pending.json` is not `skipped-*`.

## Measurement — pilot-02

Preregistered **before** the run, per `rig/preregistrations/`, with `landedPattern` on all five
seeds (pilot-01 had none; two of five seeds never landed and were scored against the gate).

Registered expectation, in advance:

> **Any M2 movement comes from C1 (critic), not from C2–C4.** C2–C4 are correctness fixes with
> no expected effect on today's data. If M6 shows `fp-ledger > 0` in pilot-02, that is a signal
> something promoted on evidence this design predicts does not exist — investigate before
> celebrating.
>
> **M6 `critic > 0` is the primary registered outcome, not the M2 slope.** Whether the critic
> fires at all is directly observable and robust at n=12. The slope is not: pilot-01 derived
> +0.0239/turn from 10 points, and the bench's own clean-FP rate varies 0.625–0.875 across
> identical repeats. A single 12-turn run cannot separate a real slope change from that
> variance, and a favourable slope in pilot-02 must **not** be reported as evidence the critic
> lowered FP burden. Registering this in advance so a lucky number cannot be promoted to a
> finding after the fact.

**Codex returns 2026-08-08, before pilot-02 plausibly runs.** The panel it rejoins is a
*different system* from pilot-01's, which measured a codex-free panel. Ruling, registered now
rather than after seeing a number: pilot-02 runs with the **same panel composition as pilot-01**
(codex excluded via the pilot config, not via its quota state), so the critic is the only
deliberate change. If codex is instead allowed back in, the run measures two changes at once and
must not be compared to pilot-01 on M2 or M3 at all. The critic-independence argument is
unaffected either way — `openrouter` is not a panel member in either configuration.

The preregistration must re-pin the binary hash (`bun run build` is required for C1–C4 to reach
the gate, so the pilot-01 pin `sha256:6f52c766…` no longer applies). Note the build deploys to
every repo via the `~/.local/bin/reviewgate` symlink.

## Risks

| Risk | Handling |
|---|---|
| C2 makes a suppression layer that already never fires fire even less | Accepted and stated. Correctness over reach — the alternative is manufacturing evidence. |
| C1 costs an extra LLM call per round | Repo-local only; the whole pilot cost $0.0166. Critic clamps to the remaining deadline budget and is skipped below its floor. |
| C1's critic demotes a true positive | Pre-existing exemptions (CRITICAL+security/correctness, corroborated, protected reviewers) are unchanged. Demote-only, never drop, except INFO+likely_fp. |
| C4's canonicalisation over-merges on data not seen here | Only diagnosis surfaces consume it; no suppression path. Transitive closure is possible by construction and is covered by an explicit adversarial fixture. |
| Config edit blocks the agent on control-plane approval | Expected — a phase addition needs `reviewgate config approve` on a TTY, once. |
| **A C2/C3 logic error ships to EVERY repo the moment `bun run build` runs** | The build overwrites `~/.local/bin/reviewgate` via symlink; there is no per-repo staging. C2 touches the promotion path and C3 the demote-eligibility path, so a granularity error (counting run_ids at entry level where cluster level was meant, or eligibility reading the wrong field) changes suppression everywhere at once, silently — both changes are expected to be no-ops on current data, so nothing visibly breaks. Mitigated by the rollback procedure below, which is mandatory to have in place *before* the build. |
| C2/C3/C4 land without their own failure being observable | Each carries a stated expected-effect of "nothing changes on today's data". That makes them unfalsifiable by observation alone, so the mutation tests are the only evidence they work — they are not optional here. |

## Rollback

Required before `bun run build`, because the build is global:

1. **Record the current binary first:** `shasum -a 256 dist/reviewgate` and copy the file to
   `dist/reviewgate.prev` (untracked). This is the restore target — *not* the pilot-01 pin
   `sha256:6f52c766…`, which predates several shipped fixes and would reintroduce them.
2. **Verify what landed:** `shasum -a 256 dist/reviewgate` after the build, and confirm the value
   differs from step 1. An unchanged hash means the build did not take — the exact silent failure
   that cost three pilot attempts (`docs/dev/2026-08-05-pilot-01-result.md`).
3. **Roll back** by restoring `dist/reviewgate.prev` over `dist/reviewgate`. The symlink needs no
   change; it points at the path, not the content.
4. **C1 does NOT roll back cheaply — corrected 2026-08-05 by the plan gate, verified by
   execution.** This section first claimed reverting `phases.critic` "does not require a new TTY
   approval, and it touches no `.reviewgate/` state". Both halves are false.
   `safeStrengthening` (`src/config/control-plane.ts:121-152`) auto-classifies only
   `sandbox.mode`, `sandbox.writablePaths`, `sandbox.deniedReads` and `loop.softPassPolicy`;
   every other path is `approval-required` **in both directions**. `ControlPlaneStateSchema`
   (`src/schemas/control-plane.ts:26`) stores one `approved_config` with no history, so after the
   enabling approval the with-critic config *is* the last-known-good. Disabling the critic
   therefore writes `pending` state, blocks the agent once, and leaves the with-critic policy in
   force until a **second** human TTY `reviewgate config approve`.

The two rollbacks are **asymmetric, not independent**: the binary reverts in seconds and by
anyone; the critic cannot be turned off without Markus at a terminal. The original conclusion —
"a bad build cannot force the critic back off" — was inverted; the real hazard is that nothing
short of a human can force it off.
