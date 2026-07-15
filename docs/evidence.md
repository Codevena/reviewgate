# Reviewgate evidence

Reviewgate is alpha software. This page separates reproducible artifacts from
historical field notes and small-sample measurements so a good story is never
presented as stronger evidence than it is.

## Evidence map

| Evidence | What it supports | What it does not support |
| --- | --- | --- |
| [Alpha.11 recorded replay](../assets/demo/README.md) | The released gate can block a real finding, consume an explicit fixed decision, re-review the changed diff, pass, and verify its audit chains. | It is one model, one bug and one deterministic replay—not a broad accuracy benchmark. |
| [18-case bench smoke](../bench/README.md) | On one published run, the configured panel found all 8 seeded bugs; the critic reduced clean-case false positives from 9/10 to 4/10. | The corpus is hand-written, the run is single-pass and no raw result JSON was committed. It is not a leaderboard or a statistically stable estimate. |
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

The published bench report describes one representative run at commit
[`75d3142`](https://github.com/Codevena/reviewgate/commit/75d3142), with 10 clean
and 8 seeded-bug cases, a Codex + Claude Code panel and an OpenRouter/DeepSeek
critic:

- recall: 8/8 (Wilson 95% CI 0.68–1.00);
- precision: 8/12 (0.67; CI 0.39–0.86);
- clean-case false-positive rate: 4/10 (0.40; CI 0.17–0.69);
- without the critic: 8/20 precision and 9/10 clean-case false positives, with
  the same 8/8 recall.

These are useful smoke signals, not settled model-quality numbers. LLM outputs
vary, the cases are hand-authored and the repository currently publishes the
report and corpus but not the raw result artifact from that historical run. A
repeated, raw-artifact benchmark remains future evidence—not a completed claim.

Reproduce a current run with your own authenticated providers:

```bash
reviewgate bench run --corpus bench/cases --repeat 3 --out repeat.json
reviewgate bench report repeat.json
```

Provider versions, model names, roster, corpus tree and output JSON should travel
together with any number quoted from a new run.

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
