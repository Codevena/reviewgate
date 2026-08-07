# Qwen3.8-Max cost decision — Phase 0 go/no-go

- **Date:** 2026-08-07
- **Plan:** `docs/superpowers/plans/2026-08-07-qwen-overhead-and-provider-model.md` Task 5
- **Spec:** `docs/superpowers/specs/2026-08-07-qwen-reviewer-measurement-design.md`
- **Verdict:** **Phase 2 GO. Phase 3 (authoritative) NO-GO at the Lite tier.**

## What was measured

One `reviewgate bench run` over a 2-case corpus (1 clean + 1 seeded), reviewer =
`opencode`, model pinned via the new `--provider-model` flag. Result:
`2/2 cases scored → precision 1, recall 1, clean-FP 0`, exit 0, 75 seconds.

**N=2. That is a smoke test of the pipeline, not evidence about Qwen's review
quality.** The acceptance bar in spec §6 is unaffected and unanswered.

Provenance confirms the flag works end to end — the whole reason Task 4 exists:

```json
{ "id": "opencode", "cli_version": "1.18.10",
  "model": "alibaba-token-plan/qwen3.8-max", "persona": "security" }
```

Not `"default"`. A future run is attributable to a specific model.

## The cost, and the correction it forces

Four LLM calls fell inside the bench window (13:00:40–13:01:55), attributed by
timestamp from opencode's session DB:

| time | uncached | cacheRead | credits |
| --- | --- | --- | --- |
| 13:00:44 | 21,323 | 2,048 | 26.25 (cold cache) |
| 13:01:15 | 10,262 | 12,288 | 15.12 |
| 13:01:26 | 543 | 22,144 | 5.53 |
| 13:01:30 | 1,334 | 22,528 | 6.57 |
| | | **total** | **53.47 for 2 cases** |

**Superseded by a direct console measurement.** The table above converts DB tokens
through a model; the console measures credits directly, and it is the better
number. Reading before the TTL call: **5.55 %** (138.75 credits). Reading after the
bench run: **8.17 %** (204.25 credits) — a delta of **65.5 credits** covering the
TTL call plus the four bench calls. Subtracting the TTL call at the measured
average for comparable calls (~9.2) leaves **≈ 56.3 credits for 2 cases**:

> **≈ 28.2 credits per case** (direct), against ≈ 26.7 from the token model.

The token model runs ~9 % low (predicted 7.95 %, actual 8.17 %), so every
DB-derived figure in this document is a slight underestimate. The direction of
every conclusion below is unchanged, and if anything reinforced.

A case costs roughly **two** LLM calls, not one, and the first call of a run pays
a cold cache.

This supersedes every earlier extrapolation, exactly as the plan said it would:

| stage | credits/unit | 30 × 1 | 30 × 3 |
| --- | --- | --- | --- |
| baseline, default agent (Task 2) | 31.0 /call | 900 (36 %) | 2,700 (108 %) |
| + reduced tool set (Task 2) | 22.9 /call | 686 (27 %) | 2,058 (82 %) |
| + warm cache (Task 3) | 9.2 /call | 275 (11 %) | 825 (33 %) |
| real case, token model (Task 5) | 26.7 /case | 800 (32 %) | 2,400 (96 %) |
| **real case, console-measured (Task 5)** | **28.2 /case** | **846 (34 %)** | **2,538 (102 %)** |

The Task 3 figure was a per-**call** number measured on a 5-output-token prompt.
The plan predicted a realistic output mix would add +3.6 to +7.3 credits. It added
**+17.5**, and the two-calls-per-case structure was not anticipated at all.

## Decision against the stop condition

Spec §5 Phase 0b: stop if per-case cost cannot be brought under **20 credits**.
Measured: **28.2** (console-direct). The condition is **tripped**.

But the consequence is narrower than "stop everything", because the two runs have
very different costs:

- **Phase 2 (exploratory, 30 × 1): GO.** ≈ 846 credits ≈ 34 % of the 2,500-credit
  weekly window. It fits, and it is the only way to answer the actual question in
  spec §6 — whether Qwen finds a seeded bug that GLM-5.2 and claude-code both miss.
  Note the window already stands at 8.17 % used, so budget ~42 % after it.
- **Phase 3 (authoritative, 30 × 3): NO-GO at Lite.** ≈ 2,538 credits ≈ **102 %**
  of the window — it does not fit at all, let alone leave room for day-to-day gate
  traffic.

**Recommended next step: run Phase 2.** It is affordable, it answers the quality
question, and it produces the definitive per-case cost from 30 real cases instead
of the 2-case extrapolation above — which is the number Phase 3 needs.

## Caveats, stated rather than buried

- **Cross-checked against the console — and the token model lost.** Predicted
  7.95 %, actual **8.17 %**: the model (1.21/1K uncached, 0.22/1K cached) runs ~9 %
  low. Attempts to re-fit the two coefficients across three calibration points do
  not converge — the fits disagree wildly (uncached 1.25–1.71/1K, cached
  0.05–0.43/1K) because the console displays only two decimals (±0.125 credits) and
  the sample sizes are small. **Do not trust a fitted coefficient; read the
  console.** The per-case figure used above is console-direct for exactly that
  reason.
- **Cold-start amortisation is unquantified.** Only the first case of a run pays
  the cold cache. If steady state is the last two calls (12.10 credits/case), 30
  cases would be ~380 credits (15 %) and the authoritative run ~1,140 (46 %),
  which would change the Phase 3 verdict. That is an extrapolation from **two**
  data points and is not treated as a result here. Phase 2 settles it.
- **The escape hatches in spec §5a are probably closed.** Extra Bundles and a plan
  tier change are both *orders*, and the account carries a
  `RISK.RISK_CONTROL_REJECTION` block on orders (Task 1b). Unverified — it needs a
  purchase attempt — but do not plan on buying headroom.
- **`--auto` vs `--dangerously-skip-permissions`.** `src/providers/opencode.ts:97`
  now passes `--auto`; the old flag does not exist in opencode 1.18.10 and was
  silently ignored. **`:242` (the `complete()` / critic / curator path) still passes
  the dead flag** and was deliberately left alone — fixing it changes curator
  runtime behaviour and belongs in its own commit with its own gate.
- **The adapter change at `:97` is measurement scaffolding**, not a shipped default.
  It pins `--pure --agent rg-reviewer`, which depends on a user-global file
  (`~/.config/opencode/agent/rg-reviewer.md`) that no other machine has. Revert it
  or make it configurable before this ships.
