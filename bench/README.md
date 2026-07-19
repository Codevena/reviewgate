# Reviewgate bench

A **controlled** measurement of the review panel against a labelled ground-truth
corpus. `reviewgate stats` measures *observational* precision from real dogfood
decisions; **bench** measures precision **and recall and false-positive rate** on
diffs whose bugs (and known-clean changes) are known in advance — per provider,
for the aggregated panel, and with the suppression layers **ablated** so you can
see which ones actually move the number.

This is a **small controlled benchmark**, not a public leaderboard: 30
hand-written/mutated cases, with LLM reviewers that vary run-to-run. Every rate is
reported with its raw denominator
and a **Wilson 95% CI**, and `--repeat` reports the run-to-run spread, precisely so
a one-case swing or a lucky run isn't mistaken for signal.

## The corpus

`bench/cases/` — one directory per case (`case.json` + `diff.patch`):

- **16 clean** cases — correct, defect-free changes. Every
  blocking finding on a clean case is a **false positive**. This is where the
  suppression stack is scored.
- **14 seeded-bug** cases — a diff that introduces exactly one real defect,
  including injections/traversal, tenant isolation, concurrency, redirect,
  deserialization and transaction failures. Drives **recall**.

Each `diff.patch` is a self-contained new-file diff (applies to an empty tree);
each `case.json` is validated by the `reviewgate.bench.case.v1` schema. A label's
`tag` may list several phrasings (any-of) so a finding matches however the reviewer
words it. See any case for the shape, e.g. `bench/cases/sql-injection-ts/`.

## Historical Alpha.11 bootstrap result

The following dated single-pass smoke used the older 18-case corpus at commit
`75d3142`, panel =
**codex + claude-code**, critic = **openrouter/deepseek**. Single pass — the CIs are
wide by design at this N, and LLM reviewers vary run-to-run (`--repeat` quantifies
the spread).

**Headline (full suppression):** the panel caught **every seeded bug** at a 40%
clean-FP rate.

| Metric | Value (num/den, 95% CI) |
| --- | --- |
| **Recall** | 1.00 (8/8, CI 0.68–1.00) |
| Precision | 0.67 (8/12, CI 0.39–0.86) |
| **Clean FP-rate** | 0.40 (4/10, CI 0.17–0.69) |

**Does the suppression stack earn its keep?** Ablating the critic (the post-review
LLM false-positive filter):

| variant | precision | recall | clean-FP |
| --- | --- | --- | --- |
| **baseline** (critic on) | 0.67 (8/12) | 1.00 (8/8) | 0.40 (4/10) |
| **− critic** (critic off) | 0.40 (8/20) | 1.00 (8/8) | 0.90 (9/10) |
| **Δ (the critic's effect)** | **+0.27** | **0.00** | **−0.50** |

Turning the critic on **removed 8 of the panel's false positives** (20 → 12
blocking findings; clean-case FPs 9/10 → 4/10) and lifted precision +0.27 — **at
zero recall cost** (it demoted no real bug). That is the empirical answer to *"does
the suppression machinery earn its complexity?"*: on a noisy panel, yes. An earlier
run on a 9-case corpus showed the same direction (+0.16 precision, −0.25 clean-FP),
so the effect corroborates across two independent runs.

_A single precise reviewer (e.g. codex alone) is more precise out of the box; the
panel's value is recall robustness across heterogeneous models, and the critic is
what keeps its false-positive rate in check. Reproduce both below._

It is historical context, not the Alpha.12 headline. Alpha.12 results are accepted
for publication only when the committed preregistration, 30-case × 3-repeat full
coverage gate, compiled-runner hash and paired response-hash manifest all pass.

## Reproduce it

Runtime is [Bun](https://bun.sh); reviewers are OAuth-first ($0 within your
subscription). Log into at least one reviewer CLI (`codex login`, etc.), then:

```bash
# Single reviewer (default: codex), human table + markdown:
reviewgate bench run    --corpus bench/cases --out results.json
reviewgate bench report results.json

# A real heterogeneous panel (1 vs. N reviewers):
reviewgate bench run    --corpus bench/cases --providers codex,gemini,claude-code --out panel.json

# Run-to-run stability (mean ± spread over K repeats):
reviewgate bench run    --corpus bench/cases --repeat 3 --out repeat.json

# Paired critic ablation — reviewers run once; critic-off replays exact responses:
reviewgate bench matrix --corpus bench/cases --providers codex,claude-code \
  --ablate critic --critic openrouter \
  --critic-model deepseek/deepseek-v4-flash \
  --critic-openrouter-provider alibaba --repeat 3 \
  --min-clean 16 --min-seeded 14 --max-failed-frac 0 \
  --critic-max-attempts 2 --reviewer-max-attempts 2 \
  --max-provider-calls 450 --max-output-tokens 2048 \
  --authoritative --preregistration bench/preregistrations/alpha12-v2-attempt-07.json \
  --out bench/results/alpha12-v2/<attempt>/matrix.json
```

`bench run` exits `0` (scored) · `2` (usage) · `3` (no reviewer completed) ·
`4` (benchmark-invalid — e.g. a malformed case, or zero clean/seeded cases). A run
whose corpus had uncommitted edits, or any invalid case, is flagged
**non-authoritative** in the report. The publication protocol is intentionally
matrix-only: `bench matrix --authoritative` additionally requires a semantically
matching committed preregistration, a clean real commit, a hashed compiled runner,
hard call/output bounds, 100% reviewer coverage and 100% eligible-critic coverage.
`bench run` cannot mint an authoritative result on its own.

Benchmark retry limits are explicit protocol inputs. `--critic-max-attempts`
retries empty/unparseable critic completions. `--reviewer-max-attempts` retries a
configured reviewer only after a non-OK raw review status. Every physical retry
consumes the shared `--max-provider-calls` ceiling and is stamped into provenance.

## What bench measures (and what it doesn't)

- **Layers.** *RAW per-provider* = each reviewer's findings before any suppression;
  *aggregated panel* = the final blocking set after critic / consensus / confidence
  / reputation. Ablation operates on the aggregated layer.
- **State isolation.** Every case runs in a fresh sandbox with empty learning
  stores, so results are order-independent and never touch your real `.reviewgate/`.
  A consequence: the *learning* suppressors (FP-ledger, reputation) are inert here
  (empty each case) — the layers that move the number in a single pass are the
  **critic**, **confidence-floor**, and **scope-to-diff**.
- **Not** a public leaderboard, not statistically rigorous at this N, and it does
  not change the gate's runtime behaviour — bench is a read-only offline harness.

## Adding a case

Create `bench/cases/<id>/case.json` (+ `diff.patch`). `kind:"clean"` must have an
empty `expected`; `kind:"seeded-bug"` needs ≥1 `expected` label
(`{tag, file, line, min_severity}`, `tag` a string or any-of array). The diff must
apply to an empty tree. Design spec: `docs/superpowers/specs/2026-07-01-reviewgate-bench-design.md`.
