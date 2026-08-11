# Reviewgate — Next-Session Handoff

_Last updated: 2026-08-11. Supersedes all earlier content._

## One-line state

**Policy Accountability & Pruning Slice 1 is implemented on
`feat/policy-accountability-trace` through core commit `2355ac0` and CLI-help contract commit
`fa68dfa`; this documentation commit closes its handoff and verification. The next milestone is
Slice 2 measurement and pruning design—not pass deletion.**

## Checkout and publication state

| | |
|---|---|
| branch | `feat/policy-accountability-trace` |
| isolated worktree | `/Users/markus/.config/superpowers/worktrees/reviewgate/policy-accountability-trace` |
| implementation boundary | `9bc72c1..fa68dfa` (Slice-1 code/tests and authoritative replay help; this handoff is the following documentation commit) |
| pushed? | **NO**—do not push without Markus's explicit permission |
| main checkout | out of scope; preserve its foreign `.reviewgate/lore/approvals.jsonl` |

## What Slice 1 delivered

- A closed `reviewgate.policy-catalog.v1` with 18 ablatable outcome-changing passes in fixed order
  and two non-ablatable explanatory stages: `aggregation.cluster`, `verdict.compute`.
- Full ordered evaluations and compact material effects, opportunity/activation/protection counters,
  exact lineage and final verdict identity.
- Canonical mode-`0600`, content-addressed Audit traces bound into `run.complete`; production trace
  errors/overflow remain fail-open with respect to the already-computed policy verdict.
- Exact authoritative Bench pairing: only the baseline calls live providers; variants consume the
  same captured logical responses and change only the internal ablation set.
- Exact Rig capture/replay: Cassette call identities, response order, source commit/diff and state
  digests are bound; persistent baseline/counterfactual scratch branches are isolated from the
  measured checkout and from each other.
- An 18-row production contract harness, four-class offline replay and ten mutation-proven
  accountability boundaries.

## Hard limits—carry these into every Slice-2 claim

- Zero opportunities mean **no evidence**, not evidence that a pass is useless.
- Lore is additive and excluded from the 18 demoters; measure its added review/decision load
  separately.
- Stateful history passes require seeded multi-turn sequences. A fresh per-case Bench makes them
  inert by construction.
- Slice 1 ranked and deleted **no** pass and changed no intended production finding/verdict.
- `ImplicitOutcomeStore` is branch-locally preserved during replay, but current production only
  writes it; no later policy input reads it back. Its divergent row count is persistence evidence,
  not a demonstrated downstream review effect.
- One-pass leave-one-out is insufficient for interacting policy. At minimum measure critic ×
  confidence × reputation; diff × delta × session scope; cycle × region × FP history; and fact
  location × token/LLM grounding × redaction × self-refutation.
- Authoritative Bench/Rig evidence is all-or-nothing. Missing/corrupt/overflowed/cross-catalog or
  identity-mismatched artifacts invalidate the measurement with exit `4`; never coerce them to zero.

## Next concrete task: specify and preregister Slice 2

Start from `src/core/policy/catalog.ts` and
`docs/superpowers/specs/2026-08-09-policy-accountability-trace-design.md` § Slice-2 handoff. Before
running or deleting anything:

1. Write a Slice-2 measurement/pruning spec and implementation plan.
2. Freeze the 30-case × 3-repeat stateless replay corpus, seeded multi-turn Rig/Cassette sequences,
   dogfood disposition source, opportunity minima and precision/recall/no-unique-contribution
   deletion criteria.
3. Preregister the interaction groups above and define how multiple-testing/rare-pass uncertainty is
   reported.
4. Pass the normal executable plan gate. Only then run measurements.

Slice 2 owns rankings, interaction measurements and delete/consolidate decisions. Slice 3 extracts
only surviving policy and removes obsolete config/schema/marker/test/documentation surfaces.

## Reverification commands

```bash
bun test tests/unit/policy-catalog.test.ts tests/unit/policy-trace-schema.test.ts tests/unit/policy-trace-recorder.test.ts tests/unit/policy-pass-contract-matrix.test.ts tests/integration/policy-trace-equivalence.test.ts tests/integration/policy-trace-offline-replay.test.ts tests/unit/bench-matrix.test.ts tests/unit/rig-replay.test.ts tests/unit/audit-verify-corruption.test.ts
bunx tsc --noEmit
bun run lint
bun test
bun run build
./dist/reviewgate bench matrix --help
./dist/reviewgate rig replay --help
./dist/reviewgate audit --help
```

The last four commands are build/help smokes only. Do not start a live Bench, Rig replay or provider
operation as part of handoff verification.

## Read first

1. `docs/superpowers/specs/2026-08-09-policy-accountability-trace-design.md`
2. `docs/superpowers/plans/2026-08-09-policy-accountability-trace.md`
3. `docs/dev/2026-08-10-policy-trace-mutation-evidence.md`
4. `docs/architecture.md` and `TEST_PLAN.md`
