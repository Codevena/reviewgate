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
optional per-slot model — `src/config/define-config.ts:52` (reviewers), `:193`
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

**Phase 0 — cost probe.** Read the Bailian console usage **first and write the
starting number down** (without it there is no delta), run exactly one bench case
against Qwen, read it again. Output: credits per review call — the number Alibaba
does not publish. Stop condition: if the extrapolated cost of Phase 2 exceeds
**600 credits**, stop and re-plan rather than proceed.

*First signal, 2026-08-07 (indicative, NOT a measurement).* The console read
**2.38 % used** after this design session, which spent three Qwen calls: two
trivial `max_tokens: 5` completions and one `opencode run` carrying the full agent
system prompt. Two unknowns make this unattributable — whether the percentage is
against the 2,500-credit 7-day window or the ~10,000 monthly figure, and whether
the counter stood at zero beforehand. Under the two readings that is ~60 or ~238
credits for three calls. A bench call carries strictly more than any of them (up
to 32 KB of diff context plus reasoning output), so a 30-case single-repeat run
plausibly lands between **600 and 2,400 credits** — respectively at the stop
condition and at the entire 7-day window. Phase 0 is therefore not a formality:
it is the phase most likely to end this project, and it must resolve the
denominator question first.

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

- **An empty 7-day window stops the gate for a week.** This is the dominant risk
  and the reason for the staging in §5. Mitigation: per-phase stop conditions, the
  600-credit ceiling, and the $15/20,000 Extra Bundle as a bounded escape hatch.
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
