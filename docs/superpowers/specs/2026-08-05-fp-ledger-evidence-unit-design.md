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
| Distinct runs contributing to any one cluster | **1**, except `sanitizer.ts` (2) |
| Brain curator | 122 of 139 decisions failed quorum, **every one exactly 1 provider short** |
| `openrouter:security` reputation | trust **0.30** vs floor 0.45 — not demoted (decayed samples 5.6 < `minSamples` 8) |

The decisive row is **"distinct runs per cluster"**. Grouping the ledger by file + category shows
five clusters whose rejects are *plausibly* one FP class each — but their reject timestamps are
identical:

| Cluster | Rejects | Distinct sessions | Distinct run_ids |
|---|---|---|---|
| `src/rig/driver.ts` (pipe/deadlock) | 3 | 1 | 1 |
| `src/core/lore/approve.ts` | 4 | 1 | 1 |
| `src/core/fact-check.ts` | 3 | 1 | 1 |
| `src/diff/sanitizer.ts` | 3 | 2 | 2 |

**These are not repetitions. They are one review round emitting several differently-phrased
findings about the same thing, rejected by the agent in one batch.**

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

`RepDerived.samples` has exactly two consumers, verified: `score.ts:44` (`isUnreliable`) and
`cli/commands/learn-status.ts:463` (display, `.toFixed(1)`). The displayed value must stay
interpretable, so `RepDerived` gains a second field rather than having `samples` silently change
meaning: `samples` (decayed, displayed) and `evidence` (raw integer, used for eligibility).
`isUnreliable`'s signature changes to read `evidence`; `learn-status` additionally prints the raw
count so the two are never confused in the field.

**Expected effect here: none today.** `openrouter:security` (3c/10w, trust 0.30) would become
eligible and demote — but openrouter is no longer a panel reviewer in this repo, so no panel
finding changes. The fix matters for repos where a weak reviewer *is* on the panel.

### C4 — Cluster key: canonical token matching, diagnosis only

`ruleIdToken0` (first hyphen segment) is brittle: `pipe-buffer-deadlock` and `pipe-deadlock`
cluster, `piped-stdout-undrained-deadlock` — one character apart — does not.

Replace with: same `file`, same `category`, and **≥2 shared canonical tokens**, transitively
closed. Canonicalisation reuses `normalizeRuleId`'s tokeniser and noise list, plus light suffix
folding (`ing`/`ed`/`s`, then a trailing `e`) so `pipe`/`piped` → `pip` and
`defang`/`defanged` → `defang`.

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

- **C2** — a fixture with 3 rejects, 2 providers, **one** `run_id` must stay `candidate`; the
  same fixture spread over 3 `run_id`s must reach `active`. Guarded quantity with/without the
  mechanism: **1 distinct run → candidate; 3 distinct runs → active.** Both values differ, so
  the test is non-vacuous on paper. Mirror at cluster level in `clusters.ts`.
- **C3** — a reviewer with 13 raw events decayed to 5.6 samples and trust 0.30 must be
  `isUnreliable` after the change and must **not** be before it (with `minSamples: 8`). Values:
  **raw 13 ≥ 8 → demote; decayed 5.6 < 8 → no demote.**
- **C4** — a **synthetic** fixture reproducing the shapes measured here: `driver.ts` yields one
  3-member cluster; `approve.ts` yields the TTY-guard pair **plus two singletons** (the
  no-false-merge assertion, which a cluster count alone would not catch); the `≥1 shared token`
  variant would chain-merge all four and must fail the test. **Do not copy
  `.reviewgate/learnings/known_fp.jsonl` into `tests/`** — it is gitignored runtime state and its
  `rejects[].reason` fields carry verbatim reviewer output. Hand-write the rule_ids instead.
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

The preregistration must re-pin the binary hash (`bun run build` is required for C1–C4 to reach
the gate, so the pilot-01 pin `sha256:6f52c766…` no longer applies). Note the build deploys to
every repo via the `~/.local/bin/reviewgate` symlink.

## Risks

| Risk | Handling |
|---|---|
| C2 makes a suppression layer that already never fires fire even less | Accepted and stated. Correctness over reach — the alternative is manufacturing evidence. |
| C1 costs an extra LLM call per round | Repo-local only; the whole pilot cost $0.0166. Critic clamps to the remaining deadline budget and is skipped below its floor. |
| C1's critic demotes a true positive | Pre-existing exemptions (CRITICAL+security/correctness, corroborated, protected reviewers) are unchanged. Demote-only, never drop, except INFO+likely_fp. |
| C4's canonicalisation over-merges on data not seen here | Only diagnosis surfaces consume it; no suppression path. |
| Config edit blocks the agent on control-plane approval | Expected — a phase addition needs `reviewgate config approve` on a TTY, once. |
