# Qwen3.8-Max as a measured reviewer — design

- **Date:** 2026-08-07
- **Status:** Design approved by Markus. **Plan-Gate PENDING** — no code yet.
- **Author:** Markus (via Claude)

## 1. Motivation

The gate's Slot A (the *executing* reviewer) currently has exactly one viable
vendor. `codex` is effectively unavailable — it sits at its usage cap most of the
time — which leaves the Claude reviewer subagent as the only reviewer that can
read the repo *and run the code a claim is about*. The global CLAUDE.md rule
"vendor diversity is the GOAL, execute access is the CONDITION" is therefore only
half-satisfied: the condition holds, the goal does not.

`qwen3.8-max`, reached through the `opencode` CLI, is the first candidate in
months that could satisfy both: it is a different vendor **and** it runs inside an
agent harness with Bash/Read/Edit, so it executes rather than merely reads. GLM-5.2
cannot fill that slot — it is a pure completion that only ever sees an inline diff.

That is the hypothesis. It is not evidence. This repo already owns the instrument
that turns one into the other (`bench/`, 30 labelled cases, precision/recall/FP with
Wilson CIs), and the same instrument produced the critic's published +4.1pp
precision claim. So the question "does Qwen deserve a reviewer slot" gets answered
the way every other such question in this repo gets answered: by measurement against
ground truth, with the acceptance bar written down **before** the run.

## 2. Goals / non-goals

**Goals**

- Produce a reproducible, attributable measurement of `qwen3.8-max` as a RAW
  reviewer on `bench/cases`, comparable in the same run against the incumbents it
  would join or replace.
- Close the one gap that makes such a measurement impossible today: the bench
  cannot pin a reviewer's model (§4).
- Keep the credit exposure bounded and observable at every step, given a hard
  2,500-credit / 7-day ceiling whose per-call cost is unpublished (§5, §7).

**Non-goals**

- Rolling Qwen out to the 19 repos that carry a `.reviewgate/`. That is a separate
  spec, written only after the measurement lands.
- Changing the shipped `init` scaffold defaults.
- Deciding the final panel position. Phase 4 does that, informed by the numbers.
- Re-benchmarking the incumbents for publication. They ride along in the same run
  for comparison; their numbers are a by-product, not the deliverable.

## 3. Established context

Verified during design (2026-08-07), not assumed:

**The plan and its endpoint.** The subscription is an Alibaba *Token Plan*
(Personal, Lite tier), not a *Coding Plan* — two different products on two
different endpoints. Live model listings with the actual key:

| Endpoint | Models | `qwen3.8-max` |
| --- | --- | --- |
| `coding-intl.dashscope.aliyuncs.com/v1` | 10 | no |
| `token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` | 11 | **yes** |
| `dashscope-intl.aliyuncs.com/compatible-mode/v1` | — | `invalid_api_key` |

Local wiring done: `alibaba-token-plan` added to
`~/.local/share/opencode/auth.json` (backup `auth.json.bak.20260807024336`),
`~/.config/opencode/opencode.jsonc` default set to
`alibaba-token-plan/qwen3.8-max`, end-to-end verified via `opencode run`.

**The budget.** Lite plan, per Alibaba's own docs: 5-hour window 700 credits
(*currently suspended by a promotion*), **7-day window 2,500 credits** — this is
the binding constraint, not the advertised "~10,000/month", which is just 4×2,500.
Unused quota does not carry over. Concurrent agents: 1–2. Escape hatch: Extra
Bundle, $15 for 20,000 credits, exempt from the window limits, up to 5 held at
once. Region: Singapore only, which matches the `ap-southeast-1` endpoint above.

**The unpublished number.** Alibaba does not publish a credits-per-token
coefficient. The docs state only that credits are "dynamically determined by model
type, token usage, thinking mode, and tool calls" and point at the console's usage
details. The `/chat/completions` response carries no quota headers (checked). Any
cost estimate therefore has to be *measured*, which is why Phase 0 exists.

**Reviewgate already accommodates this.** Every slot in the config schema takes an
optional per-slot model — `src/config/define-config.ts:54` (reviewers), `:193`
(critic), `:197` (triage), `:204` (grounding), `:212` (brain.curator). The
`opencode` adapter honours it: `src/providers/opencode.ts:103` appends `-m <model>`
whenever the model is not the sentinel `"default"`, and `:185` stamps the model
into the finding provenance. **The runtime gate needs no code change.**

## 4. The provenance gap (the only thing to build)

`buildBenchConfig` (`src/bench/runner.ts`) deliberately starts from
`defaultConfig`, **never** from `loadEffectiveConfig(cwd=sandbox)` — a
case-supplied `reviewgate.config.ts` would execute case-controlled code. Editing
the repo's own `reviewgate.config.ts` therefore has no effect on a bench run.

And `defaultConfig.providers.opencode.model` is the sentinel `"default"`
(`src/config/defaults.ts:52`), meaning "use opencode's own configured default".

The consequence is subtle and bad: `bench run --providers opencode` **would
already measure Qwen today** — because the design step above changed opencode's
global default — while writing `model: "default"` into the provenance. The result
would be unattributable, irreproducible by anyone else, and it would silently
change meaning the next time that `~/.config/opencode/opencode.jsonc` is edited.
For a harness with committed preregistrations, SHA256 manifests and an
`--authoritative` mode, that is not an acceptable input.

The bench CLI has `--critic-model`. It has no reviewer equivalent.

| | Approach | Verdict |
| --- | --- | --- |
| **A** | Add `--provider-model <provider>=<model>`, mirroring `--critic-model`: threaded through `BenchConfigOptions`, applied to `base.providers[p].model`, stamped into provenance. | **Chosen.** Small, and follows a pattern already in the file |
| B | Rely on opencode's own default | Rejected — the failure described above |
| C | Edit `reviewgate.config.ts` | Rejected — bench does not read it, by design |

## 5. Phases

**Phase 0a — cost model. DONE, measured 2026-08-07.** The console reported
**2.38 % of the weekly quota** consumed, against **50.5 K tokens** in the
02:00–03:00 bucket. opencode's own session DB attributes that to two
`qwen3.8-max` calls:

| call | total | input | output | reasoning | cache read |
| --- | --- | --- | --- | --- | --- |
| 1 | 25,629 | 23,544 | 15 | 22 | 2,048 |
| 2 | 23,414 | 23,238 | 13 | 163 | 0 |

Sum 49,043 tokens, matching the console to within the two bare `curl` probes.
`0.0238 × 2,500 = 59.5 credits`, so the coefficient Alibaba does not publish is
**≈ 1.21 credits per 1 K tokens**. The prompt for both calls was *"reply only
with: OK"*.

The consequence is the central finding of this design: **~24 K tokens per call is
pure opencode harness overhead** — system prompt plus tool schemas, before the
reviewer sees a single line of diff. The bench corpus is irrelevant next to it:
all 30 diffs together are 18.7 KB, median 360 bytes. The 32 KB
`fileContextBudgetBytes` is a ceiling that is never approached here.

| | credits | share of the 2,500 weekly window |
| --- | --- | --- |
| one `opencode run`, any size | **~30** | 1.2 % |
| the entire weekly window | 2,500 | **≈ 83 opencode calls, total** |
| bench, 30 cases × 1 repeat | ~900 | 36 % |
| bench, 30 × 3 (authoritative) | ~2,700 | **108 % — does not fit** |

**Phase 0b — reduce the overhead, then re-measure.** The authoritative run is
impossible at 30 credits per call, so the harness cost is the thing to attack
before anything is benchmarked. Two levers, both **unverified**:

1. **Tool surface.** The adapter invokes `opencode run --dangerously-skip-permissions
   --format default` with the default agent. An `--agent` with a reduced tool set
   should shrink the schema portion of the system prompt. A reviewer needs read and
   execute; it does not need the full write/edit surface — which also narrows the
   `sandbox.mode: off` exposure noted in §7.
2. **Prompt caching.** Call 2 read only 2,048 of 23,238 input tokens from cache
   (~9 %). Thirty bench calls share an identical system prompt, so the cacheable
   fraction should be near-total. If caching engages, the run cost collapses;
   if it does not, that is itself the answer.

Re-measure after each lever with the same DB-plus-console method as Phase 0a.
**Stop condition:** if per-case cost cannot be brought under **20 credits**, the
opencode path cannot carry an authoritative run, and the choice reverts to the
three alternatives weighed in §5a.

**Phase 0c — one bench case end-to-end** at the tuned settings, to convert the
per-call figure into a real per-case figure (a review prompt is larger than "reply
only with: OK", and its output is reasoning-heavy — our sample produced 15 output
tokens, a real review will produce orders of magnitude more, and output may carry
a different credit weight than input, which this measurement cannot resolve).

**Phase 1 — `--provider-model`.** Implement approach A. Passes through the
PRE-implementation Plan-Gate first, with an *executing* reviewer, per the global
rule. Guard test carries both its numbers before it is written: provenance without
the flag = `"default"`, with the flag = `"alibaba-token-plan/qwen3.8-max"`. Both
values differ, so the test is not vacuous on paper; it is still seen red once in a
copy.

**Phase 2 — exploratory run.** 30 cases × 1 repeat, panel =
`opencode(qwen3.8-max) + ollama(glm-5.2) + claude-code`, RAW per-provider layer.
No `--authoritative`. The incumbents cost no extra credits and yield the
comparison under identical conditions in the same run — which is worth more than
comparing against a historical result from a different corpus revision.

**Phase 3 — authoritative run.** Only if Phase 2 clears the bar in §6 *and* the
remaining window budget covers it: committed preregistration, 3 repeats, the full
`--authoritative` protocol.

**Phase 4 — slot decision.** Separate spec: panel position, the CLAUDE.md Slot A/B
rules, and whether/where to roll out.

## 5a. If the overhead cannot be reduced

Phase 0b's stop condition forces a choice between the options below, weighed and
deliberately not taken now. Recording them here so the fallback is a decision, not
an improvisation.

**Five are listed; four are live.** The pay-per-token DashScope route — which an
earlier draft of this section recommended — was measured on 2026-08-07 and is
**blocked**, so do not route the stop branch there. The live four are:
bare-completion adapter, shrink-the-scope, Extra Bundles, and a plan-tier change;
the last two are supplements to one of the first two, never substitutes.

**Correction (2026-08-07):** an earlier draft of this section treated "direct API"
and "non-executing reviewer" as one option. They are **two independent axes** and
conflating them hid the best available combination:

- *Axis 1 — harness:* opencode (executes; ~24 K tokens of system prompt) vs. a bare
  completion (~2–3 K tokens; cannot run anything).
- *Axis 2 — billing:* token-plan credits (prepaid, 7-day window, 1–2 concurrent
  agents) vs. pay-per-token DashScope (metered, no window, no concurrency cap).

The options below are points in that grid, not a single ladder.

- **Bare-completion adapter on the token plan.** ~2–3 K tokens per review instead
  of ~26 K — roughly **3 credits per case**, which makes both the authoritative run
  and a 19-repo rollout affordable. The cost is the whole strategic point: Qwen
  becomes a pure completion like GLM-5.2, a Slot B voice, and the vendor gap among
  *executing* reviewers stays open.
- ~~**opencode against a pay-per-token DashScope key.**~~ **BLOCKED — measured
  2026-08-07, see Phase 1b in the plan.** A DashScope workspace key lists 156 models
  including `qwen3.8-max` but returns `AccessDenied.Unpurchased` on every completion,
  account-wide (five models tested). Root cause: `RISK.RISK_CONTROL_REJECTION` on the
  account — pay-as-you-go cannot be activated until Alibaba support lifts it. The
  analysis below stands and this becomes live again if that happens; until then it is
  **not** an escalation target. Same harness, same execute
  capability, different meter — it changes only axis 2. At list pricing the
  benchmark costs about **$1.70** for 30 cases × 1 repeat and **$5.10** for the
  authoritative 30 × 3, against 36 % and 108 % of a weekly window respectively.
  Per token this is *more expensive* than the plan (≈$2.00/M vs. ≈$0.73/M at Lite);
  what it buys is the absence of a window and of the 1–2 agent cap. A benchmark is
  a one-off bundled burn, which is precisely the workload profile a prepaid window
  is the wrong instrument for. ~~Recommended shape: keep the plan for day-to-day
  gate traffic, run the benchmark on a metered key.~~ **Withdrawn — this route is
  blocked; see the strikethrough above.**
  **Unverified:** whether DashScope pay-per-token actually serves `qwen3.8-max`.
  models.dev lists it under the `alibaba` provider, but models.dev also claimed 24
  token-plan models where the live API returned 11, and the token-plan key returns
  `invalid_api_key` against that endpoint. A real DashScope key must be created and
  the model list checked before this option is costed as real.
- **Accept the cost, shrink the scope.** Keep the opencode path, run only the
  exploratory pass (~900 credits, 36 % of the week), skip the authoritative run,
  and deploy Qwen as a reviewer in **one** repo rather than nineteen. Full Slot A
  capability, minimal reach.
- **Buy Extra Bundles.** $15 per 20,000 credits, window-exempt, up to five held.
  Makes the authoritative run trivial and turns $6/month into $21. It buys
  headroom, not an answer — the "is 24 K tokens of packaging worth it" question
  remains open, so this is a supplement to one of the two options above, never a
  substitute.
- **Move up a plan tier.** At the measured ~30 credits per opencode call, the
  7-day windows translate directly into review throughput:

  | tier | $/month | 7-day window | opencode calls/week | bench 1× (~900 cr) | bench 3× (~2,700 cr) | concurrent agents |
  | --- | --- | --- | --- | --- | --- | --- |
  | Lite (current) | 6 | 2,500 | ~83 | 36 % | **108 % — does not fit** | 1–2 |
  | Standard | 18 | 10,000 | ~333 | 9 % | 27 % | 3–4 |
  | Pro | 68 | 40,000 | ~1,333 | 2.3 % | 6.8 % | 6–8 |

  Standard is the first tier on which the authoritative run and a 3-voice panel
  both fit. **Deliberately not taken before Phase 0b:** a larger plan buys
  headroom, not an answer, and if caching engages the same work may fit inside
  Lite. If a tier change is warranted afterwards it is Standard — Pro solves a
  volume problem that only exists once Qwen has *earned* a slot in many repos,
  which is precisely what has not been measured yet.

## 6. Acceptance bar (preregistered, fixed before any run)

Qwen earns a slot if, on the RAW per-provider layer:

1. it reports **≥1 seeded bug that both GLM-5.2 and claude-code miss**, and
2. its **clean-case FP rate is not higher** than GLM-5.2's.

Rationale, taken from this repo's own `bench/README.md`: *"the panel's value is
recall robustness across heterogeneous models, and the critic is what keeps its
false-positive rate in check."* A third voice does not have to be the best one. It
has to be wrong **differently**. A bar of "strictly better than GLM-5.2 on both
precision and recall" would measure the wrong property and would reject a model
that improves the panel.

At N=30 with wide Wilson CIs this is a screening bar, not a significance claim,
and the spec says so rather than dressing it up.

## 7. Risks

- **An empty 7-day window stops the gate for a week.** Now quantified rather than
  feared: the window holds **≈ 83 opencode calls**. A gate that reviews every turn
  across the 19 repos carrying a `.reviewgate/` would exhaust it inside a single
  working day. This is the dominant risk, it is what Phase 0b exists to attack,
  and it is why the rollout is explicitly out of scope until the per-call cost is
  known. Mitigation: per-phase stop conditions and the window-exempt Extra Bundle.
- **Concurrency 1–2.** `--repeat` and multi-provider panels may run reviewers
  concurrently. Phase 2 must confirm the harness does not exceed the plan's agent
  concurrency, or Qwen will fail in a way that looks like a model defect but is a
  throttle. **Unverified until Phase 2** — this is a runtime property of the
  harness, not something the plan text can prove.
- **Reviewer write access.** `sandbox.mode` defaults to `off`, and Qwen runs
  inside opencode with Bash/Edit. The bench diffs are self-authored, but a
  reviewer with write access to the filesystem is a deliberate choice that belongs
  in the open, not in a footnote.
- **Model drift.** `qwen3.8-max` is a hosted model behind a subscription; the
  measurement is a snapshot. The provenance stamp from Phase 1 is what makes that
  visible later.

## 8. Out of scope — but found on the way

`phases.brain.curator` points at `provider: "opencode"` with
`providers.opencode.model: "minimax-m2"`. The MiniMax plan has expired. Verified:
the call does not error, it **hangs** — killed after 150 s with no output. A gate
component that blocks instead of failing is the worst available failure mode, and
it is independent of anything in this spec. Fix separately; do not bundle it into
the measurement work, where it would confound the credit accounting.
