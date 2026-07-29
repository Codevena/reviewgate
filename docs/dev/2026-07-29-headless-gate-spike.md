# Spike — does the Reviewgate gate fire under headless `claude -p`?

_2026-07-29. Task 1 of `docs/superpowers/plans/2026-07-29-longitudinal-effectiveness-rig.md`.
Everything below was observed in a throwaway repo, not reasoned about._

## Verdict: YES — and the plan's harvest source was wrong

Hooks fire under `claude -p`, the FAIL → decision → re-review loop runs **in-chain within a
single invocation**, and the recording cassette captures every reviewer call. The rig is
feasible. But running it invalidated one of the plan's core assumptions (finding 2 below),
which would have produced empty metrics for every turn that ends green.

## The working invocation

```bash
cd <throwaway-repo>
export REVIEWGATE_CASSETTE="record:$PWD/cassette.jsonl"
claude -p '<the turn prompt>' --permission-mode acceptEdits </dev/null
```

`reviewgate init --host claude </dev/null` arms the repo **fully non-interactively** — the
plan's fallback to `tests/helpers/arm.ts` is not needed. `--permission-mode acceptEdits` is
required or the agent cannot edit files.

## What one turn produced

Seeded prompt: add `readTemplate(name)` reading `./templates/<name>` with **no path
validation** (a `path-traversal` seed).

| Observation | Value |
|---|---|
| `PostToolUse` trigger fired | ✅ `dirty.flag` written |
| `Stop` gate ran | ✅ `pending.json` + `pending.md`, `verdict: FAIL` |
| Seeded defect caught | ✅ `F-001` CRITICAL, `rule_id: path-traversal`, `src.ts:8` |
| Block loop in-chain | ✅ agent wrote `decisions/1.jsonl` and ended the turn for re-review, same `claude -p` |
| Re-review | ✅ iteration 2, `verdict: PASS` |
| Cassette | ✅ 4 entries over the 2 reviews |
| Review duration | 28.3s then 18s (single openrouter reviewer) |

The `rule_id` matched the `tags` any-of list the pilot turn-script uses, so the
label-matching approach behind M3 works as designed.

## Findings that change the plan

**1. The plan's `reviewgate.config.ts` was invalid.** `phases.review.reviewers` takes
**objects** (`{ provider, persona }`), not provider-id strings, and `providers.codex` is
**required** (not `.optional()`) in the providers schema. The plan's Task 1 Step 2 snippet
fails validation. Good news on the way through: the invalid config **failed closed** and
wrote nothing — no `.reviewgate/` was created. The working shape:

```ts
export default {
  providers: {
    codex: { enabled: false, auth: "oauth", model: "gpt-5.4-codex", timeoutMs: 300000 },
    openrouter: { enabled: true, auth: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY",
                  model: "anthropic/claude-sonnet-4.5", timeoutMs: 300000 },
  },
  phases: { review: { reviewers: [{ provider: "openrouter", persona: "security" }] } },
  loop: { runTimeoutMs: 600000 },
}
```

**2. CRITICAL for the rig — `state.json` and `decisions/` are WIPED on a clean-PASS
re-arm.** After the turn ended green, the sandbox showed `iteration: 0`,
`iteration_stats: []`, `decision_history: []`, and **no `decisions/` directory at all**. The
plan's Task 3 snapshots `.reviewgate/` *after* the agent exits — which for every successful
turn would harvest an empty state. M1 (iterations), M2 (FP burden, from decisions) and M5
(cost) would all silently read zero on exactly the turns that work.

What survives is the **hash-chained audit log**, one file per gate process under
`.reviewgate/audit/<YYYY>/<MM>/<DD>/*.jsonl`. Across the two files from this turn:

```
file 1: iter 1  brain.egress
        iter 1  run.complete   {"verdict":"FAIL","counts":{"critical":1,...},"cost_usd":0,"duration_ms":28…}
file 2: iter 1  decision.applied  {"finding_id":"F-001","severity":"CRITICAL","bucket":…}
        iter 2  brain.egress
        iter 2  run.complete   {"verdict":"PASS","counts":{"critical":0,"warn":0,"info":0},…}
        iter 2  gate.decision
```

That is the complete per-iteration history, and being hash-chained it is tamper-evident —
strictly better as a study artifact than the mutable state file. **The harvester must read
the audit log**, and the snapshot must collect *all* audit files (they are per-process, so
one turn yields several).

**3. `cost_usd` is 0 unless `costPerMTokensUsd` is configured.** Both `run.complete` events
report `cost_usd: 0`. The field is derived from the provider's configured price, which the
spike config omitted. M5 is unmeasurable without it — the pilot config must set
`costPerMTokensUsd` for every panel provider.

**4. A single-reviewer panel makes three of the measured layers inert.** Both `doctor` and
`pending.md` said so explicitly: with one reviewer, consensus, FP-ledger promotion and
reputation-demote are all inert. Those are exactly the layers M6 counts and two of the four
ablations toggle. The pilot panel must be **≥2 distinct providers** — not as a preference,
but because otherwise M6 and half the ablation matrix are structurally empty.

**5. Seeded turns end in a REJECT, not a fix — and the metric survives it.** Because the
prompt instructs the unsafe construction, the agent correctly declined to "fix" it and
rejected the finding with `reviewer_was_wrong: false` and a 698-char reason. M2 counts only
rejects **with** `reviewer_was_wrong: true`, so this does not pollute the FP burden — the
definition holds. Two consequences to write into the plan: seeded turns inflate M1 (they
always cost a block + re-review cycle), and a rig run must never treat "rejected" alone as
an FP signal.

## The most interesting result: a real protocol gap, on turn one

Unprompted, the agent reported a gap in Reviewgate's own decision vocabulary:

> The protocol has no clean disposition for "reviewer is right, human directed it anyway."
> `acknowledged-low-value` is barred for CRITICAL/security, `verified-not-applicable` needs
> evidence it's moot (it isn't — the function is exported), and `rejected` nudges toward
> `reviewer_was_wrong: true`. I used `rejected` with the flag explicitly `false`; if the
> validator insists on `true`, that's a gap worth closing, because the honest answer would
> be unrepresentable.

It also stated why it did not take the easy path: marking the finding a false positive
"would have poisoned the FP ledger to buy myself a green gate."

This is the desired behaviour and a genuine finding: for an intentionally-directed exposure,
the honest disposition is not expressible. It is also exactly the class of insight the rig's
interview component exists to capture — and it arrived in the first turn, before any metric
existed. Worth its own investigation independent of the rig.

## Cost of the spike

Two reviews, single openrouter reviewer, ~46s of review wall-clock, one nested `claude -p`
turn. Cheap enough that a 12-turn pilot is not a budget concern; the binding constraint is
the nested agent's own quota, not the panel.
