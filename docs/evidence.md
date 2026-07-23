# Reviewgate evidence

Reviewgate is alpha software. This page separates reproducible artifacts from
historical field notes and small-sample measurements so a good story is never
presented as stronger evidence than it is.

## Evidence map

| Evidence | What it supports | What it does not support |
| --- | --- | --- |
| [Alpha.11 recorded replay](../assets/demo/README.md) | The released gate can block a real finding, consume an explicit fixed decision, re-review the changed diff, pass, and verify its audit chains. | It is one model, one bug and one deterministic replay—not a broad accuracy benchmark. |
| [Alpha.12 benchmark v2 Attempt 09](../bench/results/alpha12-v2/attempt-09/MANIFEST.md) | A preregistered 30-case × 3-repeat run reached full reviewer and critic coverage, published raw artifacts, and measured critic impact. | The corpus is hand-written, the clean-FP rate remains high, and the result is not a leaderboard or a statistically stable model-quality estimate. |
| Historical dogfood incidents below | Review and field use exposed concrete fail-open and hook-hardening defects that were then fixed and regression-tested. | Git commits prove the fixes; reviewer attribution comes from the project session record, not cryptographic commit metadata. |

## Reproducible Alpha.11 gate run

On 2026-07-13, a disposable repository installed the exact registry release
`reviewgate@0.1.0-alpha.11`, initialized Claude Code + Codex hooks and recorded an
initial `APPROVED` policy. A security reviewer then inspected a Java repository
function containing SQL string concatenation.

The real sequence was:

1. OpenRouter `deepseek/deepseek-v4-flash`, pinned to upstream `alibaba`, returned
   one CRITICAL `sql-injection` finding.
2. Reviewgate returned `GATE CLOSED` on iteration 1.
3. The decision ledger recorded F-001 as `accepted` / `fixed`.
4. The query changed to a bind parameter.
5. The same released gate returned `GATE OPEN — PASS` on iteration 2.
6. Both final audit JSONL chains verified with every event hash matching.

The production gate, policy control plane, trigger, Stop-hook, decision handling,
re-review and audit verifier all execute live in `assets/demo/demo.sh`. Only the
two recorded provider responses are replayed so the public demo is deterministic.
The script verifies the cassette SHA-256 and aborts before showing a verdict on
prompt drift or a missing response.

Run it with the exact release installed:

```bash
npm i -g reviewgate@0.1.0-alpha.11
bash assets/demo/demo.sh
```

Full version, npm-integrity, model, upstream, policy fingerprint, baseline and
cassette hashes are in the [demo provenance record](../assets/demo/README.md).
The cassette contains no API key.

### Clean-room install and Codex trust

A separate fresh registry consumer installed Alpha.11 plus the Darwin arm64
platform package, reported npm audit 0, completed
`reviewgate init --quick --host codex`, and recorded its initial policy as
`APPROVED`. A human then inspected and trusted the exact Codex project-hook hash
through `/hooks`. After a full Codex restart, SessionStart, PostToolUse and Stop
each reported `Installed 1 / Active 1`.

That last checkpoint is intentionally human and cannot be verified or approved by
Reviewgate itself. See [Codex host activation](codex-host.md).

## Historical catches from dogfooding

### 1. Broken-pipe fail-open and the listener-order race

Field use on a diff larger than 1 MB exposed an unhandled `EPIPE` when a reviewer
process exited before consuming a streamed prompt. The gate process could die
without returning a block decision—the exact fail-open class Reviewgate exists to
prevent.

- [`705bcda`](https://github.com/Codevena/reviewgate/commit/705bcda) added the
  destination-stdin error handling and a large-stream regression test.
- During review of that fix, the independent reviewer identified that installing
  the swallow listener after `pipe()` / `end()` still left a race window.
- [`f19eae5`](https://github.com/Codevena/reviewgate/commit/f19eae5) moved the
  listeners before the flow begins.
- Alpha.10 released both changes; Alpha.11 contains them.

The field report found the original defect. The review loop found the residual
race in the first fix. Those are deliberately different claims.

### 2. Codex fail-closed fallback quoting

During Alpha.11 pre-release self-review, a reviewer noted that the generated
Codex fail-closed JSON happened to be shell-safe at the time but a future
apostrophe in its message would break a single-quoted shell literal. The hook
generator now serializes the JSON and applies explicit POSIX single-quote
escaping. Its regression test contains the literal `Reviewgate's`, executes the
real Bash fallback and parses the result as a blocking decision.

The fix and test shipped as part of
[`69ccf26`](https://github.com/Codevena/reviewgate/commit/69ccf26). That commit is
a combined Codex-host/control-plane change, so the reviewer attribution is a
session record rather than something Git itself proves.

## Benchmark evidence and limits

The current published benchmark is Alpha.12 benchmark v2, Attempt 09. It was run
from clean commit
[`50f01fc`](https://github.com/Codevena/reviewgate/commit/50f01fcf088c2419ebac1a9a3e283debc5840a35)
with a preregistered 30-case corpus, three repeats, a Codex + Claude Code
reviewer panel and an OpenRouter/DeepSeek critic pinned to the `alibaba`
upstream.

Raw artifacts:

- [`matrix.json`](../bench/results/alpha12-v2/attempt-09/matrix.json)
- [`baseline.result.json`](../bench/results/alpha12-v2/attempt-09/baseline.result.json)
- [`no-critic.result.json`](../bench/results/alpha12-v2/attempt-09/no-critic.result.json)
- [`reviewer-responses.sha256.json`](../bench/results/alpha12-v2/attempt-09/reviewer-responses.sha256.json)
- [`MANIFEST.md`](../bench/results/alpha12-v2/attempt-09/MANIFEST.md)
- [`SHA256SUMS.txt`](../bench/results/alpha12-v2/attempt-09/SHA256SUMS.txt)

Hard-gate outcome:

- matrix authoritative: `true`;
- Codex reviewer coverage: 90/90;
- Claude Code reviewer coverage: 90/90;
- OpenRouter critic coverage: 86/86 eligible calls;
- repository dirty at run time: `false`;
- provider calls used by the baseline: 270/450;
- retry protocol: up to 2 physical attempts per reviewer and per critic call
  (preregistered; every attempt is budget-counted). The coverage above is under
  this protocol — a single-attempt run (the production default) records lower
  reviewer coverage whenever a reviewer transiently misses a case.

Headline values from the matrix:

| variant | precision | recall | clean-case FP rate |
| --- | ---: | ---: | ---: |
| baseline | 0.3505 | 0.8095 | 0.7292 |
| without critic | 0.3091 | 0.8095 | 0.8958 |

In this run, the critic improved aggregate precision by about 4.1 percentage
points and reduced clean-case false positives by about 16.7 percentage points,
without changing recall. The absolute clean-FP rate remains high. Treat these as
alpha benchmark evidence for this corpus and provider roster, not as settled
model-quality numbers or a leaderboard.

Stability across the three repeats (same protocol, mean ± sd, min–max) shows the
metrics are not point-stable — the clean-FP rate in particular ranges widely:

- precision: 0.353 ± 0.034 (0.306–0.379);
- recall: 0.810 ± 0.034 (0.786–0.857);
- clean-case FP rate: 0.729 ± 0.106 (0.625–0.875).

So read each headline as a small-sample central tendency with real run-to-run
variance, not a fixed figure.

Historical note: an older Alpha.11 single-pass smoke on an 18-case labelled
corpus caught 8/8 seeded bugs and showed the critic reducing clean-case false
positives from 9/10 to 4/10. That run remains useful as early smoke evidence, but
Attempt 09 is the first repeated raw-artifact benchmark to cite.

Reproduce a current run with your own authenticated providers:

```bash
reviewgate bench run --corpus bench/cases --repeat 3 --out repeat.json
reviewgate bench report repeat.json
```

Provider versions, model names, roster, corpus tree, preregistration and output
JSON should travel together with any number quoted from a new run.

## Known provider caveat from the Alpha.11 recording

Alpha.11's interactive OpenRouter model probe used a role-blind free-form
completion. On 2026-07-13, the wizard-suggested `deepseek` upstream passed that
probe but rejected the real review's strict `response_format`. Pinning `alibaba`
for the same model completed both review requests.

Alpha.12 changes the wizard: reviewer/fallback probes use the actual strict
structured review path, while critic/curator probes use their production
free-form shape. Calls are disclosed, repository-free, capped at 15 seconds and
256 output tokens, and deduplicated per successful paid request tuple (purpose,
model, auth, route and probe bounds).
That closes the Alpha.11 shape mismatch; upstream capabilities can still change,
so a successful probe remains a dated capability observation rather than a
permanent provider guarantee.

On 2026-07-14 the exact Alpha.12 reviewer probe for
`deepseek/deepseek-v4-flash` via `alibaba` completed and parsed successfully with
the 256-token ceiling. A preceding 64-token diagnostic returned HTTP 200 but
spent the entire completion on reasoning and emitted no review JSON; the larger
bounded ceiling is therefore regression-tested rather than an arbitrary increase.

See the [OpenRouter-only quickstart](openrouter-quickstart.md) for the tested path
and the exact route history.
