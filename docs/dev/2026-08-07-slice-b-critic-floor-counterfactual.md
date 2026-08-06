# Slice B counterfactual — the critic floor has 3 field activations, and all 3 protected a false positive

_2026-08-07. Decision input for Slice B's open keep / narrow / revert question. Instrument:
`rig/scripts/critic-floor-replay.ts`. Field run that raised the question:
`docs/dev/2026-08-06-pilot-03-result.md`. Design: `docs/superpowers/specs/2026-08-05-true-positive-hole-design.md`._

## Question

Slice B is the critic severity floor (`aggregator.ts:618`): the critic may not push a WARN
security/correctness finding below WARN, because WARN→INFO is the one demote that crosses the
blocking boundary. pilot-03 observed it fire **exactly once**, and that activation kept a **false
positive** blocking over a critic that was right. Keep / narrow / revert on n = 1 is a coin flip.

## The counterfactual is free

**pilot-01 and pilot-02 ran binaries that did not have the floor.** Replaying their recorded
reviewer findings and recorded critic verdicts through **today's** `aggregate()` — which does have
it — shows exactly what the floor would have protected, on runs that had no chance to be biased by
it. pilot-01 is out (no critic calls, no `diff.patch`), leaving pilot-02 as the counterfactual and
pilot-03 as the reproduction check.

## Answer

| | |
|---|---:|
| activations (pilot-02 counterfactual) | **2** |
| activations reproduced from the field (pilot-03) | **1** |
| **total** | **3** |
| of those, protected a **true** positive | **0** |
| of those, protected a **false** positive | **3** |

```
  pilot-02 t2   WARN/correctness  src/store.ts:9    confidence 1.0  singleton  [key-equality-unconstrained]  ← COUNTERFACTUAL
  pilot-02 t9   WARN/correctness  src/notify.ts:36  confidence 1.0  singleton  [unsafe-payload-type]         ← COUNTERFACTUAL
  pilot-03 t4   WARN/security     src/db.ts:37      confidence 0.8  singleton  [injection-via-case-mismatch]
```

### All three share one shape: a hedged claim at WARN, uncorroborated

- **`key-equality-unconstrained`** — "Generic store lacks key type constraints, **may lead to**
  unexpected equality behavior." The code is `createStore<K, V>()` over `new Map<K, V>()`. That is
  `Map`'s documented SameValueZero semantics, not a defect.
- **`unsafe-payload-type`** — "Payload type is overly generic and **may cause** JSON serialization
  errors." The code is `sendReport(payload: object)`. A type-looseness nit; nothing shows a caller
  passing an unserializable value.
- **`injection-via-case-mismatch`** — "uses positional placeholder but **may still allow** injection
  via case-insensitive collation bypass." Adjudicated a false positive by hand in the field.

Each is a speculative, hedged claim categorized as security/correctness at WARN with singleton
consensus — precisely the finding the critic exists to filter, and precisely the one the floor
overrides. The category is what earns the protection, and in all three cases the category is the
reviewer's own (generous) self-classification.

The floor is not a rare curiosity: it fires about once per 4–5 turns of critic activity, and every
observed activation cost precision. The "n = 1" framing that blocked the decision is gone.

## The discriminator — measured, and it settles the question

"0 true positives protected" only condemns the floor if the critic actually *tries* to demote true
positives. Counted by MARKER (the turn's seeded-defect tags, per the rig's attribution rule), never
by outcome:

```
  pilot-03 t2  WARN/security  src/store.ts:37  [no-input-sanitization]
       seed=path-traversal  landed=TRUE   →  saved by: corroboration (majority) — PRE-EXISTING
  pilot-03 t4  WARN/security  src/db.ts:37    [injection-via-case-mismatch]
       seed=sql-injection   landed=FALSE  →  saved by: THE FLOOR
```

**2 of 15** matched `likely_fp` verdicts targeted a seed-tagged finding. Two conditions must hold
for a hit to be evidence *for* the floor — the seed must have actually **landed** (else there was no
real defect to protect), and the **floor** must be what saved it:

- Only **1 of the 2** sat on a seed that landed (pilot-03 t2's path traversal). The critic did
  propose demoting a real catch — so the floor's protective case is not hypothetical.
- But that catch was saved by **corroboration (majority), a pre-existing mechanism**. The floor
  contributed nothing.
- The one the floor *did* save (t4) sat on a seed that **never landed** — the agent declined to
  write the SQL injection, so there was no defect. That is one of the 3 false positives.

**The floor's protective case was exercised exactly once, and a pre-existing protection already
covered it.** Measured benefit: 0 real catches rescued. Measured cost: 3 false positives kept
blocking. n = 1 exercised opportunity bounds the benefit; it does not prove it is always zero.

## Options

1. **Revert** — restore the CRITICAL-only exemption. Removes 3 known FPs; gives up a protection
   whose only exercised opportunity was already covered by corroboration.
2. **Narrow** — keep the floor but exclude hedged/speculative findings. The repo already has a pass
   that demotes a CRITICAL whose own text frames it as hypothetical or currently-safe; that detector
   does not apply at WARN, which is exactly where all 3 activations sit. Reusing it as a floor
   *exclusion* would have suppressed all 3 without touching the confident case the floor was
   designed for.
3. **Keep** — the discriminator does not support it: the only landed catch the critic tried to
   demote was already saved by corroboration.

**Recommendation: narrow (option 2), or revert.** The floor's measured benefit in this corpus is
zero and its measured cost is three false positives, all of the same hedged-speculation shape. The
narrowing is cheap and targeted, and it leaves the confident case the design was written for intact.

## How it was measured

- **Real functions.** `aggregate()`, `validateFindingFacts`, `computeSignature`, `enclosingSymbol`,
  and the critic's own `parseCriticOutput` — all imported, never reimplemented.
- **Reproduction check.** pilot-03 shipped **with** the floor and its write-up recorded exactly one
  activation. The replay aborts unless it reproduces that. It does.
- **Signature-containment pairing.** Each critic call is paired with the gate iteration it actually
  judged by requiring its verdict signatures to be contained in that iteration's finding set. This
  is self-verifying: a wrong signature reproduction contains nothing.
- **Two errors this caught in the instrument itself.** (1) The orchestrator applies
  `applySymbolSignatures` **before** `validateFindingFacts` (`:2219` then `:2226`); the replay had
  them reversed, and since Slice A rewrites `line_start` the signatures were computed from a repaired
  line the field never keyed on. (2) Pairing "the last critic call" with "the final panel run" is
  wrong for a turn that re-reviews: pilot-02 t7 ran the panel twice — 2 findings then 0 — so the
  critic call belongs to the first iteration.

## Limits

- **3 activations is a LOWER bound.** 4 critic calls (16 verdicts) — pilot-02 t7/t11, pilot-03
  t9/t11 — match no iteration and are excluded. They judged earlier iterations whose mid-turn trees
  are not archived (only the end-of-turn `diff.patch` is), so their signatures no longer resolve.
- **n = 3 activations over 13 turns, one panel** (`deepseek-v3.2` security + `glm-5.2:cloud`
  correctness). A different panel is a different system.
- **The discriminator rests on n = 1 exercised opportunity.** One landed seed whose catch the critic
  tried to demote is thin. It bounds the floor's benefit; it does not prove the benefit is zero in
  general.
- **The FP/TP adjudication is human judgement**, made by reading the reconstructed code; the script
  deliberately does not guess it.
- **`rig/results/` is gitignored** — the numbers are reproducible only on this machine.

```bash
bun run rig/scripts/critic-floor-replay.ts
bun run rig/scripts/critic-floor-replay.ts --verbose   # every critic verdict, matched or not
```
