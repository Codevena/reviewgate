# Precision Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the FP-ledger count evidence honestly (distinct runs, not reject events), split reputation eligibility from trust, add a semantic cluster view for diagnosis, and switch on the one precision layer that is actually measured (the critic).

**Architecture:** Four independent changes against `docs/superpowers/specs/2026-08-05-fp-ledger-evidence-unit-design.md`. C2 and C3 are threshold-semantics fixes in two small pure modules. C4 adds a *second* clustering function rather than changing the existing one, because `computeFpClusters` feeds the aggregator's suppression path and the spec requires C4 to stay diagnosis-only. C1 is a config edit plus a global binary deploy, which is why it is last and carries a rollback.

**Tech Stack:** Bun, TypeScript, zod schemas, `bun test` (bun:test `describe`/`it`/`expect`), biome.

## Global Constraints

- Runtime is **Bun**. Use `bun`/`bunx`, never `npm`/`node`/`npx`. Tests are `bun test`, never jest/vitest.
- `bunx tsc --noEmit` **and** `bun run lint` must both be clean before any task is considered done.
- **Never `git add -A` at the repo root** — it stages `.reviewgate/` runtime state. Always `git add` explicit paths.
- **Do not run `bun run build` until Task 5.** The build overwrites `~/.local/bin/reviewgate` via symlink and deploys to *every* repo on this machine.
- **Never put `*.test.ts` under `rig/results/`** — `bun test` runs every test file in the tree regardless of `.gitignore`.
- Every behaviour-guarding test must be seen RED once before its implementation lands (steps below enforce this).
- Do not copy `.reviewgate/learnings/known_fp.jsonl` into `tests/` — it is gitignored runtime state whose `rejects[].reason` fields carry verbatim reviewer output. Hand-write fixtures.
- **If anything in this plan is contradictory or incomplete: ask before guessing.** Earlier implementers on this project found real errors that way; reporting a contradiction is a gate stage, not a delay.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/core/fp-ledger/store.ts` | Modify: per-entry stage thresholds count distinct runs | 1 |
| `tests/unit/fp-ledger-store.test.ts` | Modify: active/sticky fixtures + new run-unit guards | 1 |
| `src/core/fp-ledger/clusters.ts` | Modify: cluster stage thresholds count distinct runs; `FpCluster` gains run fields | 2 |
| `tests/unit/fp-ledger-clusters.test.ts` | Modify: existing promotion test now needs 3 runs; new guards | 2 |
| `src/core/reputation/score.ts` | Modify: `RepDerived.evidence` + `isUnreliable` reads it | 3 |
| `src/core/reputation/store.ts` | Modify: `derive()` populates `evidence` | 3 |
| `src/cli/commands/learn-status.ts` | Modify: print raw evidence alongside decayed samples | 3 |
| `tests/unit/reputation-score.test.ts` | Modify: eligibility guards | 3 |
| `src/diff/signature.ts` | Modify: export `canonicalRuleTokens` (single source of truth for the noise list) | 4 |
| `src/core/fp-ledger/clusters.ts` | Modify: add `computeFpSemanticClusters` | 4 |
| `src/cli/commands/fp.ts` | Modify: `fp clusters` uses the semantic view | 4 |
| `src/cli/commands/learn-status.ts` | Modify: `learn status` uses the semantic view | 4 |
| `tests/unit/fp-ledger-semantic-clusters.test.ts` | Create: grouping, no-false-merge, transitive-chain guards | 4 |
| `reviewgate.config.ts` | Modify: enable `phases.critic` | 5 |

**Why C4 adds a function instead of changing one.** `computeFpClusters` has exactly three callers: `orchestrator.ts:2364` (feeds the aggregator's `fpActiveClusters` **suppression** path), `cli/commands/learn-status.ts:255`, and `cli/commands/fp.ts:128` (both **diagnosis**). The spec requires the new key to reach diagnosis only. Changing the existing function in place would silently re-key suppression too.

There is a fourth, **implicit** consumer that makes this stricter than a call-site count suggests: `src/core/aggregator.ts:783` independently reconstructs the lookup key as `` `${ruleIdToken0(rid)}@${f.file}` `` to probe `fpActiveClusters`. So the suppression key format is frozen at *both* ends — producer and consumer derive it separately. Any change to `ruleIdToken0` or to `computeFpClusters`' key would have to be mirrored there or the map would silently never match. Leaving both untouched is what makes C4 safe.

---

### Task 1: C2 — per-entry evidence unit becomes the distinct run

**Files:**
- Modify: `src/core/fp-ledger/store.ts:12-15` (constants), `:58-69` (`recompute`)
- Test: `tests/unit/fp-ledger-store.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `recompute` semantics used by Task 2's mirror. Exported surface is unchanged — `FpLedgerStore` keeps every method signature.

**Background the implementer needs.** `FpRejectSchema` (`src/schemas/fp-ledger.ts:4-9`) is `{ run_id: string; provider: string; ts: string; reason: string }` — `run_id` is **required**, so no defaulting path is needed. `recordReject` already dedups on `(run_id, provider)`, so one provider cannot contribute two rejects to one signature in one run. Today the promotion threshold counts reject *events*, which means three providers answering in a single review round reads as three independent pieces of evidence. It is not. The 60d/90d window keeps filtering on each reject's own `ts`; `run_id` is counted for distinctness **after** filtering and is never parsed for a timestamp.

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/fp-ledger-store.test.ts`, inside the existing `describe("FpLedgerStore lifecycle", ...)`:

```ts
  it("3 rejects from 2 providers in ONE run stay candidate (evidence unit is the run)", async () => {
    const s = new FpLedgerStore(repo());
    const t = "2026-05-21T00:00:00Z";
    // One review round: three reviewers, one run_id. Under the old event-count
    // rule this promoted to `active` off a single round of panel chatter.
    await s.recordReject(sig, meta, { run_id: "r1", provider: "codex", reason: "x" }, t);
    await s.recordReject(sig, meta, { run_id: "r1", provider: "gemini", reason: "x" }, t);
    await s.recordReject(sig, meta, { run_id: "r1", provider: "claude-code", reason: "x" }, t);
    const e = (await s.snapshot()).entries[0];
    expect(e?.rejects).toHaveLength(3);
    expect(e?.stage).toBe("candidate");
  });

  it("the same 3 rejects across 3 runs reach active", async () => {
    const s = new FpLedgerStore(repo());
    const t = "2026-05-21T00:00:00Z";
    await s.recordReject(sig, meta, { run_id: "r1", provider: "codex", reason: "x" }, t);
    await s.recordReject(sig, meta, { run_id: "r2", provider: "gemini", reason: "x" }, t);
    await s.recordReject(sig, meta, { run_id: "r3", provider: "claude-code", reason: "x" }, t);
    expect((await s.snapshot()).entries[0]?.stage).toBe("active");
  });

  it("5 rejects spread over only 4 runs is active, not sticky; a 5th run makes it sticky", async () => {
    const t = "2026-05-21T00:00:00Z";
    // 5 reject EVENTS but only 4 distinct runs (r1 carries two providers).
    // Old rule: 5 events >= STICKY_REJECTS -> sticky. New rule: 4 runs < 5 -> active.
    // The two values differ, so this test is non-vacuous on paper.
    const four = new FpLedgerStore(repo());
    for (const [run_id, provider] of [
      ["r1", "codex"],
      ["r1", "gemini"],
      ["r2", "codex"],
      ["r3", "gemini"],
      ["r4", "codex"],
    ] as const)
      await four.recordReject(sig, meta, { run_id, provider, reason: "x" }, t);
    const e = (await four.snapshot()).entries[0];
    expect(e?.rejects).toHaveLength(5);
    expect(e?.stage).toBe("active");

    const five = new FpLedgerStore(repo());
    for (const [run_id, provider] of [
      ["r1", "codex"],
      ["r2", "codex"],
      ["r3", "codex"],
      ["r4", "gemini"],
      ["r5", "gemini"],
    ] as const)
      await five.recordReject(sig, meta, { run_id, provider, reason: "x" }, t);
    expect((await five.snapshot()).entries[0]?.stage).toBe("sticky");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/unit/fp-ledger-store.test.ts`

Expected, per test:
- Test 1 (3 rejects / 1 run) **FAILS**: `expected "candidate", received "active"`. That failure IS the fail-open this task closes.
- Test 2 (3 rejects / 3 runs) **PASSES** already — a pure regression guard; its passing now is expected.
- Test 3 **FAILS** on its first half: `expected "active", received "sticky"`, because 5 reject events clear the old `STICKY_REJECTS` bar while only 4 distinct runs miss the new one. Its second half passes both before and after.

If test 3's first half passes before the implementation, the fixture is wrong — the two providers must share `r1` — and the test is vacuous. Fix the fixture, do not proceed.

- [ ] **Step 3: Change the thresholds to count distinct runs**

In `src/core/fp-ledger/store.ts`, rename the constants so no reader mistakes them for event counts:

```ts
const ACTIVE_RUNS = 3;
const ACTIVE_DAYS = 60;
const STICKY_RUNS = 5;
const STICKY_DAYS = 90;
```

Replace `recompute` (currently lines 58-69) with:

```ts
function recompute(e: FpLedgerEntry, nowMs: number): FpLedgerEntry {
  if (e.pinned_by) return { ...e, stage: "sticky" };
  const within = (days: number) =>
    e.rejects.filter((r) => nowMs - Date.parse(r.ts) <= days * DAY_MS);
  const providers = (rs: typeof e.rejects) => new Set(rs.map((r) => r.provider)).size;
  // Evidence unit = the distinct gate RUN, not the reject event. Three reviewers
  // answering in one round is ONE observation of this FP class, not three: the
  // threshold is meant to measure temporal recurrence, and counting events let a
  // single verbose round promote a signature to permanent suppression.
  // The 60d/90d window still filters on each reject's own `ts`; run_id is only
  // counted for distinctness afterwards and is never parsed as a timestamp.
  const runs = (rs: typeof e.rejects) => new Set(rs.map((r) => r.run_id)).size;
  const win90 = within(STICKY_DAYS);
  const win60 = within(ACTIVE_DAYS);
  let stage: FpLedgerEntry["stage"] = "candidate";
  if (runs(win90) >= STICKY_RUNS && providers(win90) >= 2) stage = "sticky";
  else if (runs(win60) >= ACTIVE_RUNS && providers(win60) >= 2) stage = "active";
  return { ...e, stage, distinct_providers: [...new Set(e.rejects.map((r) => r.provider))] };
}
```

Nothing else in the file changes: the promote-only guard in `recordReject`, `pin`/`unpin`, `decayPass` and `activeSnapshot` all call `recompute` and inherit the new rule.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/unit/fp-ledger-store.test.ts`
Expected: all PASS.

- [ ] **Step 5: Run the neighbouring suites that depend on these thresholds**

Run: `bun test tests/unit/fp-ledger-store.property.test.ts tests/unit/fp-ledger-learn.test.ts tests/unit/aggregator-fp.test.ts tests/unit/fp-cli.test.ts`

Expected: PASS. If a test fails because its fixture reached `active` via several providers inside one `run_id`, that fixture encoded the old semantics — give each reject its own `run_id` and note the change in the commit body. **Do not** relax the new rule to keep an old fixture green.

**One of these passes for the wrong reason and must be tightened.** `tests/unit/fp-ledger-store.property.test.ts:115` asserts `inWindow.length >= 3` as its active-stage oracle. Run-counting strictly implies that (`runs ≤ events`), so the property stays green while providing **zero** evidence for the new rule — it goes vacuous the moment C2 lands. Tighten it to the run-based invariant:

```ts
    expect(new Set(inWindow.map((r) => r.run_id)).size).toBeGreaterThanOrEqual(3);
```

Still a valid necessary condition (`active` needs ≥3 runs in 60d, and 60d ⊆ 90d; `sticky` needs ≥5), and it now actually exercises C2. Include this file in the Step 6 commit.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
bunx tsc --noEmit && bun run lint
git add src/core/fp-ledger/store.ts tests/unit/fp-ledger-store.test.ts tests/unit/fp-ledger-store.property.test.ts
git commit -m "fix(fp-ledger): count distinct runs, not reject events, for promotion

Three reviewers answering in ONE review round is one observation of an FP
class, not three. Counting events let a single verbose round promote a
signature to permanent suppression through a demote pass that has no
severity or category ceiling.

Window semantics unchanged: the 60d/90d filter still uses each reject's own
ts; run_id is counted for distinctness only and never parsed for a time."
```

---

### Task 2: C2 — mirror the evidence unit at cluster level

**Files:**
- Modify: `src/core/fp-ledger/clusters.ts` (constants, `FpCluster`), (aggregation), `isNearActive`
- Test: `tests/unit/fp-ledger-clusters.test.ts`

**Interfaces:**
- Consumes: the evidence-unit rule from Task 1 (same thresholds, independently implemented — `clusters.ts` does not import from `store.ts`).
- Produces: `FpCluster` gains `distinct_runs_active_window: number` and `distinct_runs_sticky_window: number`. Task 4's `computeFpSemanticClusters` returns the same `FpCluster` type.

**Background.** `computeFpClusters` aggregates rejects across *all* member entries of a `(rule_id_token0, file)` group, so the event-count inflation Task 1 fixed is strictly worse here — that is the exact path by which `src/rig/driver.ts` (3 rejects, 2 providers, **one** run) would have promoted to `active` and fed the aggregator's suppression map. Its internal `allRejects` array currently carries only `{ts, provider}` and must carry `run_id` too.

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/fp-ledger-clusters.test.ts`:

```ts
describe("computeFpClusters — evidence unit is the distinct run", () => {
  it("3 rejects from 2 providers in ONE run stay candidate", () => {
    const out = computeFpClusters(
      [
        mkEntry({ id: "FP-001", signature: "s1", rule_id: "prisma-attribute-corruption" }),
        mkEntry({
          id: "FP-002",
          signature: "s2",
          rule_id: "prisma-corrupted-attribute",
          rejects: [
            { run_id: "R1", provider: "claude-code", ts: "2026-05-25T03:00:00.000Z", reason: "h" },
            { run_id: "R1", provider: "codex", ts: "2026-05-25T03:00:00.000Z", reason: "h" },
          ],
          distinct_providers: ["claude-code", "codex"],
        }),
      ],
      NOW,
    );
    const c = out[0];
    expect(c?.reject_count_active_window).toBe(3);
    expect(c?.distinct_runs_active_window).toBe(1);
    expect(c?.stage).toBe("candidate");
    expect(isNearActive(c as NonNullable<typeof c>)).toBe(true);
  });

  it("the same 3 rejects across 3 runs reach active", () => {
    const out = computeFpClusters(
      [
        mkEntry({ id: "FP-001", signature: "s1", rule_id: "prisma-attribute-corruption" }),
        mkEntry({
          id: "FP-002",
          signature: "s2",
          rule_id: "prisma-corrupted-attribute",
          rejects: [
            { run_id: "R2", provider: "claude-code", ts: "2026-05-25T03:00:00.000Z", reason: "h" },
            { run_id: "R3", provider: "codex", ts: "2026-05-25T03:00:00.000Z", reason: "h" },
          ],
          distinct_providers: ["claude-code", "codex"],
        }),
      ],
      NOW,
    );
    const c = out[0];
    expect(c?.distinct_runs_active_window).toBe(3);
    expect(c?.stage).toBe("active");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/unit/fp-ledger-clusters.test.ts`
Expected: FAIL — first on `distinct_runs_active_window` being `undefined` (the field does not exist yet), and on `stage` being `"active"` where `"candidate"` is expected.

- [ ] **Step 3: Implement**

In `src/core/fp-ledger/clusters.ts`, rename the constants:

```ts
const ACTIVE_RUNS = 3;
const ACTIVE_DAYS = 60;
const STICKY_RUNS = 5;
const STICKY_DAYS = 90;
```

Add to the `FpCluster` interface, directly after `distinct_providers_active_window`:

```ts
  /** Distinct gate RUNS contributing rejects inside the 60-day active window.
   *  This — not `reject_count_active_window` — is what the promotion threshold
   *  reads: several reviewers answering in one round is ONE observation. */
  distinct_runs_active_window: number;
  /** Distinct gate RUNS inside the 90-day sticky window. */
  distinct_runs_sticky_window: number;
```

Carry `run_id` through the reject collection (currently `:105-114`):

```ts
    const seen = new Set<string>();
    const allRejects: { ts: string; provider: string; run_id: string }[] = [];
    for (const m of members) {
      for (const r of m.rejects) {
        const k = `${m.signature} ${r.provider} ${r.ts}`;
        if (seen.has(k)) continue;
        seen.add(k);
        allRejects.push({ ts: r.ts, provider: r.provider, run_id: r.run_id });
      }
    }
```

Replace the staging block (the staging block):

```ts
    const win60 = inWindow(ACTIVE_DAYS);
    const win90 = inWindow(STICKY_DAYS);
    const distinct60 = new Set(win60.map((r) => r.provider));
    const distinct90 = new Set(win90.map((r) => r.provider));
    const runs60 = new Set(win60.map((r) => r.run_id));
    const runs90 = new Set(win90.map((r) => r.run_id));
    const distinct_all = [...new Set(allRejects.map((r) => r.provider))].sort();

    let stage: FpLedgerStage = "candidate";
    if (runs90.size >= STICKY_RUNS && distinct90.size >= 2) stage = "sticky";
    else if (runs60.size >= ACTIVE_RUNS && distinct60.size >= 2) stage = "active";
```

Populate the two new fields in the returned object, next to `distinct_providers_active_window`:

```ts
      distinct_runs_active_window: runs60.size,
      distinct_runs_sticky_window: runs90.size,
```

Update `isNearActive` to test the run count instead of the event count:

```ts
export function isNearActive(c: FpCluster): boolean {
  if (c.stage !== "candidate") return false;
  const haveProvs = c.distinct_providers_active_window >= 2;
  const haveRuns = c.distinct_runs_active_window >= ACTIVE_RUNS;
  // Exactly one missing dimension = "near" — not both, not neither.
  return haveProvs !== haveRuns;
}
```

Leave `reject_count_total` / `reject_count_active_window` / `reject_count_sticky_window` in place and unchanged — the CLI prints them, and they stay honest as *event* counts.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/unit/fp-ledger-clusters.test.ts`

Expected: the new tests PASS, and **exactly three pre-existing tests in this file FAIL**. All three were confirmed by applying the patch in a scratch copy. Each needs a *different* repair — do not apply one blanket remedy:

1. **`"would-be active when a second provider's entry joins the cluster"` (`:120-147`)** — its fixture has run_ids `R1`, `R1`, `R5` = 2 distinct runs, so it is now `candidate`. Correct new behaviour. **Repair:** give the two `prisma-attribute*` entries distinct run_ids (`R1` and `R4`) so the cluster has three; keep `expect(c?.stage).toBe("active")`; add a comment that the fixture now needs three distinct runs.

2. **`"4× same-provider rule_id_token0 burst…"` (`:117`)** — `isNearActive` flips true→false, because a one-run burst is now short on **both** dimensions (providers *and* runs) and `isNearActive` requires exactly one to be missing. **Repair: KEEP the single `run_id`** — a burst genuinely *is* one round, and that is the semantic C2 exists to encode. Flip the assertion to `expect(isNearActive(c as NonNullable<typeof c>)).toBe(false)` and comment why.

   ⚠ **Do NOT give the burst fixture distinct run_ids to make it green.** That converts a fixture whose entire point is "one round, one provider" into exactly the evidence shape C2 exists to reject, and no later gate catches a guard test doctored into vacuity. If you feel pulled toward that repair, stop and ask.

3. **`isNearActive > "is true only when exactly one promotion dimension is missing (windowed)"` (`:282`)** — its inputs are object literals cast `as Parameters<typeof isNearActive>[0]`, so **`tsc` will not flag the missing `distinct_runs_active_window`**; at runtime `undefined >= 3` silently evaluates false. **Repair:** add an explicit `distinct_runs_active_window` to *every* literal in that `describe` block (audit all of them, not just the failing one), choosing the value each case's intent implies.

- [ ] **Step 5: Run the dependent suites**

Run: `bun test tests/unit/aggregator-fp-cluster.test.ts tests/unit/orchestrator-fp-cluster-clock.test.ts tests/unit/fp-cli.test.ts tests/unit/learn-status.test.ts`

Expected: `tests/unit/learn-status.test.ts` FAILS at `:336` — its `near_active` count drops 1→0 for the same `isNearActive` reason as `:117`. Update the expectation to `0`. The other three PASS.

Any *other* failure caused by a fixture whose rejects share a `run_id` gets distinct run_ids — but only where the fixture's intent is genuinely "several rounds". Where the intent is "one round", change the expectation instead.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
bunx tsc --noEmit && bun run lint
git add src/core/fp-ledger/clusters.ts tests/unit/fp-ledger-clusters.test.ts
git commit -m "fix(fp-ledger): cluster promotion counts distinct runs too

The cluster path aggregates rejects across member entries, so event-counting
inflated evidence worse than at signature level: driver.ts (3 rejects, 2
providers, ONE run) would have promoted to active and fed the aggregator's
suppression map off a single review round.

FpCluster gains distinct_runs_{active,sticky}_window; isNearActive now tests
the run count. reject_count_* stay as honest event counts for the CLI."
```

---

### Task 3: C3 — reputation eligibility uses raw evidence, trust stays decayed

**Files:**
- Modify: `src/core/reputation/score.ts` (`RepDerived` + `isUnreliable`)
- Modify: `src/core/reputation/store.ts` (`derive`)
- Modify: `src/cli/commands/learn-status.ts` (reputation row rendering)
- Test: `tests/unit/reputation-score.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `RepDerived` becomes `{ trust: number; samples: number; evidence: number }`. `isUnreliable(d: RepDerived, minSamples: number, trustFloor: number): boolean` keeps its signature and reads `d.evidence`.

**Background.** `derive()` currently sets `samples` to the *decay-weighted* event sum and `isUnreliable` compares that to `minSamples` (default 8). Those answer two different questions. Measured live in this repo: `openrouter:security` has 13 raw events (3 correct / 10 wrong) and trust **0.30** — far below the 0.45 floor — but decays to **5.6** samples, so it never qualifies to demote. A reviewer used intermittently sheds decayed samples faster than it accrues them and can sit below the floor indefinitely.

This is self-correcting rather than sticky: as evidence ages, `decayedCount → 0` and `trustScore → (0+1)/(0+0+2) = 0.5`, which is above the floor — an old-bad reviewer drifts back to neutral without the raw count needing to shrink.

`RepDerived` is **never persisted** (verified: `grep -rn "RepDerived" src` returns only the interface declaration, the `isUnreliable` parameter, and store.ts's import + private `derive()` return type), so adding a field cannot leave stale on-disk objects whose missing `evidence` would compare as `NaN >= minSamples`.

**Correction to the spec's C3 section:** it says `RepDerived.samples` has two consumers, `score.ts:44` and `learn-status.ts:463`. The second is wrong. `learn-status.ts:268-275` builds its own row objects by calling `decayedCount`/`trustScore` directly and never touches `RepDerived`. So `RepDerived.samples` has exactly **one** consumer — `isUnreliable` — which is why `samples` can keep its meaning untouched while `evidence` takes over eligibility. The display edit in Step 3 works off the row's existing raw `correct`/`wrong` fields and needs no new plumbing.

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/reputation-score.test.ts`:

```ts
describe("isUnreliable — eligibility is raw evidence, trust is decayed", () => {
  // Mirrors the live openrouter:security shape measured 2026-08-05: 13 raw
  // events spread over ~2 months decay to ~5.6 weighted samples at a 45d
  // half-life, while trust sits at ~0.30 — far below the 0.45 floor. Under the
  // old rule the decayed count (5.6) lost to minSamples (8) and it never demoted.
  it("demotes a reviewer with enough RAW events even when the decayed sum is below minSamples", () => {
    const d = { trust: 0.3, samples: 5.6, evidence: 13 };
    expect(isUnreliable(d, 8, 0.45)).toBe(true);
  });

  it("still refuses to demote a cold-start reviewer with too little raw evidence", () => {
    const d = { trust: 0.3, samples: 2.0, evidence: 3 };
    expect(isUnreliable(d, 8, 0.45)).toBe(false);
  });

  it("does not demote an eligible reviewer whose trust is at or above the floor", () => {
    const d = { trust: 0.45, samples: 5.6, evidence: 13 };
    expect(isUnreliable(d, 8, 0.45)).toBe(false);
  });
});
```

Then add the wiring guard to `tests/unit/reputation-store.test.ts`. `derive()` is private; its only public surface is `forDoctor()`, which exposes `demoting` (literally `isUnreliable(d, cfg.minSamples, cfg.trustFloor)`) and `unreliableReviewers()`. Use `forDoctor` — do not export the private method just to test it.

Real signatures, verified: `record(events: RecordInput[], opts?: { now?: Date; halfLifeDays?: number })` where `RecordInput = { reviewerKey: string; outcome: "correct" | "wrong"; eid: string; ts: string }`; and `forDoctor(cfg: ReputationConfig, now: Date)` returning rows of `{ reviewer, correct, wrong, trust, demoting, quarantined }`.

```ts
  it("demotes on raw evidence even when the decayed sum is below minSamples", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-rep-"));
    const store = new ReputationStore(dir);
    // 13 events far outside a 45d half-life: raw 13 >= minSamples 8, but the
    // decayed sum is well under 8. Trust lands at 3c/10w -> ~0.30 < 0.45.
    const ts = "2026-05-01T00:00:00.000Z";
    const events = [
      ...Array.from({ length: 10 }, (_, i) => ({
        reviewerKey: "openrouter:security",
        outcome: "wrong" as const,
        eid: `w${i}`,
        ts,
      })),
      ...Array.from({ length: 3 }, (_, i) => ({
        reviewerKey: "openrouter:security",
        outcome: "correct" as const,
        eid: `c${i}`,
        ts,
      })),
    ];
    await store.record(events, { now: new Date(ts), halfLifeDays: 45 });
    const rows = await store.forDoctor(
      { enabled: true, minSamples: 8, trustFloor: 0.45, halfLifeDays: 45 },
      new Date("2026-08-05T00:00:00.000Z"),
    );
    const row = rows.find((r) => r.reviewer === "openrouter:security");
    expect(row?.correct).toBe(3);
    expect(row?.wrong).toBe(10);
    expect(row?.trust).toBeLessThan(0.45);
    expect(row?.demoting).toBe(true);
  });
```

**If `ReputationConfig` requires fields beyond those four**, read the interface at `src/core/reputation/store.ts:16` and supply them — do not weaken the assertions to route around a type error.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/unit/reputation-score.test.ts tests/unit/reputation-store.test.ts`

Expected: FAIL on the **assertion**, not on types. `bun test` strips types without checking them, and `const d = { … }` is a variable rather than a direct argument, so TypeScript's excess-property check does not fire — the extra `evidence` key is accepted even before the change. The real signal is `isUnreliable` still reading `samples` (5.6 < 8 → false) where the test expects `true`.

Note also that predicate tests 2 and 3 return `false` both before and after — they are **regression guards**, not the discriminating pair. Only test 1 and the `forDoctor` store test flip. Add a comment saying so, so a later reader does not mistake them for evidence the change works.

- [ ] **Step 3: Implement**

In `src/core/reputation/score.ts`:

```ts
export interface RepDerived {
  /** Beta(1,1)-smoothed, decay-weighted trust in [0,1]. */
  trust: number;
  /** Decay-weighted event sum. DISPLAY ONLY — recency-weighted opinion. */
  samples: number;
  /** Raw event count. ELIGIBILITY ONLY — "is there enough evidence to judge
   *  at all", which decay must not erode: a reviewer used intermittently sheds
   *  decayed samples faster than it accrues them and would otherwise sit below
   *  the trust floor forever without ever qualifying to demote. Self-correcting
   *  via `trust`, which drifts back to the neutral 0.5 as evidence ages. */
  evidence: number;
}

export function isUnreliable(d: RepDerived, minSamples: number, trustFloor: number): boolean {
  return d.evidence >= minSamples && d.trust < trustFloor;
}
```

In `src/core/reputation/store.ts`, `derive()`:

```ts
    const samples =
      decayedCount(e.correct, now, halfLifeDays) + decayedCount(e.wrong, now, halfLifeDays);
    return { trust, samples, evidence: e.correct.length + e.wrong.length };
```

In `src/cli/commands/learn-status.ts`, print both so the two can never be confused in the field. Replace the reviewer line (the reputation row) with:

```ts
    const trustStr = rev.trust.toFixed(2);
    const samplesStr = rev.samples.toFixed(1);
    lines.push(
      `  ${rev.key.padEnd(28)}  trust ${trustStr}  samples ${samplesStr.padStart(5)} decayed / ${String(rev.correct + rev.wrong).padStart(3)} raw  (${rev.correct}c/${rev.wrong}w)`,
    );
```

- [ ] **Step 4: Run the tests to verify they pass, and fix the one pre-existing breakage**

Run: `bun test tests/unit/reputation-score.test.ts tests/unit/reputation-store.test.ts`

Expected: the new tests PASS, and the **pre-existing** `"isUnreliable requires BOTH enough samples AND trust below floor"` (`tests/unit/reputation-score.test.ts:27-31`) **FAILS** — its three `{ trust, samples }` literals leave `evidence` undefined, and `undefined >= 8` is false. This is a runtime failure; `bunx tsc --noEmit` additionally reports three `TS2345` errors at `:28-30` (the only type breaks in the tree).

Repair: add an explicit `evidence` to each of those three literals, set to the raw count each case's intent implies (a case meaning "enough samples" gets a value ≥ `minSamples`; a case meaning "too few" gets one below it). Re-run until green.

- [ ] **Step 5: Run every reputation-touching suite**

Run: `bun test tests/unit/reputation-quarantine.test.ts tests/unit/reputation-corroboration.test.ts tests/unit/reputation-learn.test.ts tests/unit/reputation-config.test.ts tests/unit/reputation-score.property.test.ts tests/unit/aggregator-reputation.test.ts tests/unit/doctor-reputation.test.ts`

Expected: PASS. Any other test constructing a `RepDerived` literal needs the new `evidence` field, set consistently with that test's intent.

Note: `src/core/reputation/quarantine.ts` does **not** import `isUnreliable` — it is a pure filter. Quarantine eligibility lives at `src/core/reputation/store.ts:167-170` (`quarantinedReviewers`), which calls `reviewersBelow` with the quarantine floor and therefore *does* inherit the new eligibility rule. That is the path Step 6 measures.

- [ ] **Step 6: Measure the eligibility change — do not assert it**

This change can only **grow** the demote-eligible set (`raw ≥ decayed` always), in every repo the rebuilt binary reaches. `learn status` cannot show that: it prints trust and samples but **not** `demoting`, which exists only on `forDoctor`. Use `doctor`, and capture before/after.

Before applying Step 3 (or from a clean stash), capture the baseline:

```bash
bun run dev doctor 2>&1 | grep -iA20 reputation > /tmp/rep-before.txt
```

After Step 3:

```bash
bun run dev doctor 2>&1 | grep -iA20 reputation > /tmp/rep-after.txt
diff /tmp/rep-before.txt /tmp/rep-after.txt
```

Expected diff, measured in advance against this repo's real `reputation.json`:
- `openrouter:security` → `demoting` false→true. **Intended** — trust 0.30 against a 0.45 floor, 13 raw events. This is the bug being fixed.
- `codex:plan` → newly eligible (raw 8 ≥ `minSamples` 8 vs decayed 5.22), but `demoting` stays **false** because trust is 0.86.
- **None of the three panel keys — `codex:security`, `claude-code:security`, `ollama:security` — may flip.** If any of them does, stop: the change would be removing a working reviewer from this repo's panel, which is a fail-open, not a fix.

Then run `bun run dev learn status` and confirm the reputation block shows both counts, e.g. `openrouter:security  trust 0.30  samples   5.6 decayed /  13 raw  (3c/10w)`. Both commands are read-only.

- [ ] **Step 7: Typecheck, lint, commit**

```bash
bunx tsc --noEmit && bun run lint
git add src/core/reputation/score.ts src/core/reputation/store.ts src/cli/commands/learn-status.ts tests/unit/reputation-score.test.ts tests/unit/reputation-store.test.ts
git commit -m "fix(reputation): eligibility reads raw evidence, trust stays decayed

minSamples was compared against the DECAY-WEIGHTED event sum, so a reviewer
used intermittently sheds samples faster than it accrues them. Measured here:
openrouter:security sits at trust 0.30 against a 0.45 floor with 13 raw events
that decay to 5.6 — permanently below minSamples 8, so it never demoted.

Eligibility ('is there evidence to judge at all') is a raw count; trust ('how
reliable lately') stays decayed. Self-correcting: as evidence ages trust drifts
back to the neutral 0.5 and rises above the floor. learn status now prints both."
```

---

### Task 4: C4 — semantic cluster view for diagnosis only

**Files:**
- Modify: `src/diff/signature.ts` (export `canonicalRuleTokens`)
- Modify: `src/core/fp-ledger/clusters.ts` (add `computeFpSemanticClusters`)
- Modify: `src/cli/commands/fp.ts:125-155`, `src/cli/commands/learn-status.ts:255`
- Create: `tests/unit/fp-ledger-semantic-clusters.test.ts`

**Interfaces:**
- Consumes: `FpCluster` including Task 2's `distinct_runs_*` fields; Task 2's `isNearActive`.
- Produces:
  - `canonicalRuleTokens(raw: string): Set<string>` from `src/diff/signature.ts`
  - `computeFpSemanticClusters(entries: FpLedgerEntry[], nowIso: string): FpCluster[]` from `src/core/fp-ledger/clusters.ts`

**Background.** `ruleIdToken0` takes the first hyphen segment, so `pipe-buffer-deadlock` and `pipe-deadlock` cluster while `piped-stdout-undrained-deadlock` — one character apart — does not. Measured on this repo's 29 live entries, the replacement predicate (same file, same category, ≥2 shared canonical tokens, union-find closure) yields **5 clusters with zero false merges**, and correctly splits `src/core/lore/approve.ts` into the TTY-guard pair plus two singletons where a `≥1 shared token` rule chain-merges all four.

**This must not reach the suppression path.** `computeFpClusters` stays exactly as it is for `orchestrator.ts:2364`. Only the two CLI diagnosis surfaces switch.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/fp-ledger-semantic-clusters.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { computeFpSemanticClusters } from "../../src/core/fp-ledger/clusters.ts";
import { canonicalRuleTokens } from "../../src/diff/signature.ts";
import type { FpLedgerEntry } from "../../src/schemas/fp-ledger.ts";

const NOW = "2026-08-05T00:00:00.000Z";

function mk(id: string, rule_id: string, over: Partial<FpLedgerEntry> = {}): FpLedgerEntry {
  return {
    id,
    signature: `sig-${id}`,
    rule_id,
    category: "correctness",
    file: "src/rig/driver.ts",
    symbol: "",
    stage: "candidate",
    rejects: [
      { run_id: `R-${id}`, provider: "claude-code", ts: "2026-07-29T22:47:57.000Z", reason: "fp" },
    ],
    distinct_providers: ["claude-code"],
    first_seen_at: "2026-07-29T22:47:57.000Z",
    last_seen_at: "2026-07-29T22:47:57.000Z",
    created_at: "2026-07-29T22:47:57.000Z",
    ...over,
  };
}

describe("canonicalRuleTokens", () => {
  it("folds suffix variants so pipe and piped unify", () => {
    expect(canonicalRuleTokens("pipe")).toEqual(new Set(["pip"]));
    expect(canonicalRuleTokens("piped")).toEqual(new Set(["pip"]));
    expect(canonicalRuleTokens("defanged")).toEqual(new Set(["defang"]));
    expect(canonicalRuleTokens("deleted")).toEqual(new Set(["delet"]));
    expect(canonicalRuleTokens("delete")).toEqual(new Set(["delet"]));
  });
  it("drops the shared RULE_ID_NOISE words", () => {
    expect(canonicalRuleTokens("path-traversal-via-unsafe-join")).toEqual(
      new Set(["path", "traversal", "join"]),
    );
  });
});

describe("computeFpSemanticClusters", () => {
  it("clusters the pipe/deadlock trio that ruleIdToken0 splits on pipe vs piped", () => {
    const out = computeFpSemanticClusters(
      [
        mk("FP-021", "pipe-buffer-deadlock"),
        mk("FP-022", "pipe-deadlock"),
        mk("FP-023", "piped-stdout-undrained-deadlock", {
          rejects: [
            { run_id: "R-FP-023", provider: "ollama", ts: "2026-07-29T22:47:57.000Z", reason: "fp" },
          ],
          distinct_providers: ["ollama"],
        }),
      ],
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.member_ids.sort()).toEqual(["FP-021", "FP-022", "FP-023"]);
  });

  it("does NOT merge semantically distinct rules in the same file (no false merge)", () => {
    // The four real src/core/lore/approve.ts entries. Only the TTY-guard pair is
    // one class; toctou-challenge and weak-challenge-entropy are separate concerns.
    const f = { file: "src/core/lore/approve.ts", category: "security" as const };
    const out = computeFpSemanticClusters(
      [
        mk("FP-026", "no-tty-guard-on-write-path", f),
        mk("FP-027", "core-approve-fn-no-tty-guard", f),
        mk("FP-028", "toctou-challenge-verify-to-write", f),
        mk("FP-029", "weak-challenge-entropy", f),
      ],
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.member_ids.sort()).toEqual(["FP-026", "FP-027"]);
  });

  it("never clusters across different files or categories", () => {
    expect(
      computeFpSemanticClusters(
        [
          mk("FP-A", "pipe-buffer-deadlock", { file: "a.ts" }),
          mk("FP-B", "pipe-buffer-deadlock", { file: "b.ts" }),
        ],
        NOW,
      ),
    ).toHaveLength(0);
    expect(
      computeFpSemanticClusters(
        [
          mk("FP-C", "pipe-buffer-deadlock", { category: "security" }),
          mk("FP-D", "pipe-buffer-deadlock", { category: "correctness" }),
        ],
        NOW,
      ),
    ).toHaveLength(0);
  });

  it("documents the accepted transitive-closure behaviour", () => {
    // A-B share {beta, guard}; B-C share {gamma} only -> the chain does NOT close.
    const open = computeFpSemanticClusters(
      [
        mk("FP-A", "alpha-beta-guard"),
        mk("FP-B", "beta-guard-gamma"),
        mk("FP-C", "gamma-delta-epsilon"),
      ],
      NOW,
    );
    expect(open).toHaveLength(1);
    expect(open[0]?.member_ids.sort()).toEqual(["FP-A", "FP-B"]);

    // Now B-C share {gamma, guard} -> all three merge, even though A and C share
    // only {guard}. This is transitive closure working as specified, not a bug.
    const closed = computeFpSemanticClusters(
      [
        mk("FP-A", "alpha-beta-guard"),
        mk("FP-B", "beta-guard-gamma"),
        mk("FP-C", "gamma-delta-guard"),
      ],
      NOW,
    );
    expect(closed).toHaveLength(1);
    expect(closed[0]?.member_ids.sort()).toEqual(["FP-A", "FP-B", "FP-C"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/unit/fp-ledger-semantic-clusters.test.ts`
Expected: FAIL — neither `canonicalRuleTokens` nor `computeFpSemanticClusters` exists yet.

- [ ] **Step 3: Export the canonical tokeniser from `signature.ts`**

Append to `src/diff/signature.ts` (it already owns `RULE_ID_NOISE`, keeping one source of truth):

```ts
// Light suffix folding on top of the noise-filtered tokeniser: reviewers phrase
// the same concept as `pipe`/`piped` and `defang`/`defanged`, which normalizeRuleId's
// exact token-set equality treats as different rules. Strip one inflection, then a
// trailing `e`, so both sides land on the same stem (`pip`, `defang`). Deliberately
// cruder than a real stemmer — it only has to make paraphrases of one rule collide.
function foldSuffix(token: string): string {
  let s = token;
  for (const suf of ["ing", "ed", "s"]) {
    if (s.length - suf.length >= 3 && s.endsWith(suf) && !s.endsWith("ss")) {
      s = s.slice(0, -suf.length);
      break;
    }
  }
  return s.length > 3 && s.endsWith("e") ? s.slice(0, -1) : s;
}

/** Canonical token SET for a rule_id: the normalizeRuleId tokeniser and its
 *  RULE_ID_NOISE filter, plus suffix folding. Used for semantic FP clustering;
 *  NOT part of computeSignature, whose identity must stay exact. */
export function canonicalRuleTokens(raw: string): Set<string> {
  const out = new Set<string>();
  for (const t of raw.toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length === 0 || RULE_ID_NOISE.has(t)) continue;
    out.add(foldSuffix(t));
  }
  return out;
}
```

- [ ] **Step 4: Add `computeFpSemanticClusters`**

Append to `src/core/fp-ledger/clusters.ts` (import `canonicalRuleTokens` from `../../diff/signature.ts`):

```ts
const MIN_SHARED_TOKENS = 2;

/** Semantic cluster view: same file, same category, and >= 2 shared canonical
 *  rule_id tokens, closed transitively by union-find. Replaces ruleIdToken0's
 *  brittle first-segment match (`pipe` vs `piped` are one character apart and do
 *  not group under it).
 *
 *  DIAGNOSIS ONLY. computeFpClusters remains the function the orchestrator feeds
 *  to the aggregator's suppression map; this one is consumed exclusively by
 *  `reviewgate fp clusters` and `learn status`. Broadening the suppression key is
 *  a fail-open and is deliberately not done here.
 *
 *  Safety rests on the CONJUNCTION (same file AND same category AND >= 2 shared
 *  tokens), not on the noise list: domain nouns like `buffer` or `write` are not
 *  noise, so any one of the three conditions alone would over-merge. Transitive
 *  closure can still chain A-C together through B with no tokens in common; that
 *  is accepted and covered by an explicit test. */
export function computeFpSemanticClusters(entries: FpLedgerEntry[], nowIso: string): FpCluster[] {
  const parent = new Map<number, number>();
  const find = (i: number): number => {
    let r = i;
    while (parent.get(r) !== r) {
      const p = parent.get(r) as number;
      parent.set(r, parent.get(p) as number);
      r = parent.get(r) as number;
    }
    return r;
  };
  entries.forEach((_, i) => parent.set(i, i));
  const tokens = entries.map((e) => canonicalRuleTokens(e.rule_id));

  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i] as FpLedgerEntry;
      const b = entries[j] as FpLedgerEntry;
      if (a.file !== b.file || a.category !== b.category) continue;
      let shared = 0;
      for (const t of tokens[i] as Set<string>) if ((tokens[j] as Set<string>).has(t)) shared++;
      if (shared < MIN_SHARED_TOKENS) continue;
      const ra = find(i);
      const rb = find(j);
      if (ra !== rb) parent.set(ra, rb);
    }
  }

  const groups = new Map<number, FpLedgerEntry[]>();
  entries.forEach((e, i) => {
    const r = find(i);
    const arr = groups.get(r);
    if (arr) arr.push(e);
    else groups.set(r, [e]);
  });

  const out: FpCluster[] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    out.push(buildCluster(labelFor(members), members, nowIso));
  }
  return sortClusters(out);
}

/** Representative label: the canonical token shared by the most members, ties
 *  broken lexicographically, so the key is deterministic and human-readable
 *  (e.g. `deadlock@src/rig/driver.ts`). */
function labelFor(members: FpLedgerEntry[]): string {
  const freq = new Map<string, number>();
  for (const m of members)
    for (const t of canonicalRuleTokens(m.rule_id)) freq.set(t, (freq.get(t) ?? 0) + 1);
  let best = "";
  let bestN = -1;
  for (const [t, n] of [...freq.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (n > bestN) {
      best = t;
      bestN = n;
    }
  }
  return best;
}
```

**Refactor note — do this rather than copy-pasting:** the per-cluster body of the existing `computeFpClusters` (reject dedup, windowing, stage computation, first/last seen, object construction) and its final sort must be extracted into `buildCluster(label, members, nowIso)` and `sortClusters(list)`, and `computeFpClusters` rewritten to call them. Both functions must produce byte-identical output to today's `computeFpClusters` for the same input — `tests/unit/fp-ledger-clusters.test.ts` is the guard, and apart from the three fixture repairs made in Task 2 it must stay green without further edits.

`buildCluster`'s first parameter is a **label**, not a `ruleIdToken0`: `computeFpClusters` passes the first hyphen segment, `computeFpSemanticClusters` passes `labelFor`'s most-shared canonical stem. Update the `FpCluster.rule_id_token0` doc comment accordingly — today it reads "first '-' segment of rule_id", which becomes false for half the callers:

```ts
  /** Cluster label token: the first hyphen segment for computeFpClusters, the
   *  most-shared canonical STEM for computeFpSemanticClusters (so live keys read
   *  `deadlock@…`, `delet@…`, `spac@…` — stems, not dictionary words). */
  rule_id_token0: string;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test tests/unit/fp-ledger-semantic-clusters.test.ts tests/unit/fp-ledger-clusters.test.ts`
Expected: both files PASS — the new suite proves the new behaviour, the old suite proves the refactor was behaviour-preserving.

- [ ] **Step 6: Switch the two diagnosis surfaces**

In `src/cli/commands/fp.ts`, change the import to `computeFpSemanticClusters` and use it at `:128`. Update the two user-facing strings so they describe the real rule:

```ts
      "No multi-entry FP clusters found (a cluster requires ≥2 entries in the same file and category sharing ≥2 canonical rule_id tokens).\n",
```

```ts
    `FP clusters — derived view, no schema change (same file+category, ≥2 shared canonical rule_id tokens; ${filtered.length} of ${clusters.length} shown):\n\n`,
```

Add the run count to the per-cluster output, directly after the `rejects:` line, since it is now what decides promotion:

```ts
    out(
      `  runs: ${c.distinct_runs_active_window} distinct in active-window (60d), ${c.distinct_runs_sticky_window} in sticky-window (90d)\n`,
    );
```

In `src/cli/commands/learn-status.ts`, change the import and the `:255` call to `computeFpSemanticClusters`. Leave `orchestrator.ts` untouched.

- [ ] **Step 7: Run the dependent suites**

Run: `bun test tests/unit/learn-status.test.ts tests/unit/fp-cli.test.ts`

Expected: `tests/unit/learn-status.test.ts` **FAILS at `:337`**. Its asserted cluster key `"prisma@prisma/schema.prisma"` becomes **`"attribut@prisma/schema.prisma"`** under the semantic view, because `labelFor` returns the most-shared canonical stem rather than the first hyphen segment. Update the expectation.

⚠ **Do NOT "fix" this by making `labelFor` fall back to `ruleIdToken0`.** That would silently undo C4 while leaving every new test in Task 4 green — the failure is legitimate, so change the expectation, never the label function. The `<canonical-stem>@<file>` key format is a **sanctioned user-visible change** to `fp clusters` and `learn status` output.

- [ ] **Step 8: Verify against the live ledger**

Run: `bun run dev fp clusters`

Expected: **5 clusters**, not the 2 that `ruleIdToken0` finds — `src/rig/driver.ts` (FP-021, FP-022, FP-023), `src/core/fact-check.ts`, `src/diff/sanitizer.ts`, `bin-templates/user-gate.sh`, `src/core/lore/approve.ts` (FP-026 + FP-027 only). Live keys will read `deadlock@`, `delet@`, `defang@`, `spac@`, `guard@` — stems, not words; that is expected output, not a defect.

**The stop condition is: no cluster reports `active`.** Every cluster must be `[candidate]`. If any reports `active`, stop — that contradicts the measurement this whole design rests on.

Run counts are *not* uniform, so do not assert `runs: 1` everywhere: four clusters show `runs: 1 distinct in active-window (60d)`, but **`delet@src/core/fact-check.ts` shows `runs: 0` in-window and `1` in the sticky window** — its single reject (2026-06-05T12:38Z) passed 60 days old on 2026-08-04 and has aged out. That is correct windowing, not a bug.

Then run: `bun test` (the full suite). Every remaining failure is real — there are no phantom failures to wave away.

- [ ] **Step 9: Typecheck, lint, commit**

```bash
bunx tsc --noEmit && bun run lint
git add src/diff/signature.ts src/core/fp-ledger/clusters.ts src/cli/commands/fp.ts src/cli/commands/learn-status.ts tests/unit/fp-ledger-semantic-clusters.test.ts tests/unit/learn-status.test.ts
git commit -m "feat(fp-ledger): semantic cluster view for diagnosis

ruleIdToken0 matches the first hyphen segment, so pipe-buffer-deadlock and
pipe-deadlock group while piped-stdout-undrained-deadlock — one character
apart — does not. Same file + same category + >=2 shared canonical tokens,
closed by union-find: 5 clusters and zero false merges on this repo's 29 live
entries, and lore/approve.ts correctly splits into the tty-guard pair plus two
singletons where a >=1-token rule chain-merges all four.

DIAGNOSIS ONLY: computeFpClusters still feeds the aggregator's suppression map.
Broadening a suppression key on single-run evidence is the fail-open this
milestone exists to remove."
```

---

### Task 5: C1 — enable the critic, deploy, verify, and be able to roll back

**Files:**
- Modify: `reviewgate.config.ts`
- Create (untracked): `dist/reviewgate.prev`

**Interfaces:**
- Consumes: Tasks 1-4 must be committed and green before the build, because the build deploys all of them at once.
- Produces: nothing importable. This task changes runtime policy for this repo and rebuilds the shared binary.

**Background.** `phases.critic` defaults to `null` and was off here and in the pilot, which is why pilot-01's M6 critic delta was zero *by construction*. `bench/results/alpha12-v2/attempt-09/MANIFEST.md:21` records the measured configuration as "`openrouter` critic (`deepseek/deepseek-v4-flash` via `alibaba`): 86/86 eligible, authoritative", at +4.1pp precision and −16.7pp clean-case FP rate with recall unchanged. Using any other provider means those figures no longer describe what is being switched on.

`model` is deliberately omitted: `phases.critic.model` is optional and `orchestrator.ts:2328` resolves `criticCfg.model ?? cProviderCfg.model`, and `providers.openrouter.model` here is already `"deepseek/deepseek-v4-flash"`. Pinning it inline would duplicate the value and let the two drift.

`persona` is required by the config type but is read by nothing on the critic path — the prompt comes from the hardcoded `buildCriticPrompt`. Supply a value; do not go looking for a persona file.

- [ ] **Step 1: Capture the rollback target BEFORE building**

```bash
shasum -a 256 dist/reviewgate | tee /tmp/reviewgate-prev.sha256
cp dist/reviewgate dist/reviewgate.prev
```

This is the restore target. **Not** the pilot-01 pin `sha256:6f52c766…`, which predates several shipped fixes and would reintroduce them.

- [ ] **Step 2: Enable the critic**

In `reviewgate.config.ts`, add inside `phases`, directly above the `fpLedger` entry:

```ts
    // Adversarial demote-only FP filter. Measured in bench/results/alpha12-v2/attempt-09:
    // +4.1pp precision, -16.7pp clean-case FP rate, recall unchanged, 86/86 eligible.
    // openrouter is NOT a panel reviewer here, so the critic stays independent of the
    // panel it filters; model resolves to providers.openrouter.model (deepseek-v4-flash),
    // which is the exact model that benchmark used. Repo-local dogfood — the init
    // scaffold default stays off until pilot-02 confirms the effect.
    critic: { provider: "openrouter", persona: "fp-filter" },
```

- [ ] **Step 3: Typecheck and run the full suite**

```bash
bunx tsc --noEmit && bun run lint && bun test
```

Expected: all green. `reviewgate.config.ts` is data-parsed, never imported, so a config edit cannot break the suite — a failure here means something from Tasks 1-4 regressed.

- [ ] **Step 3.5: Confirm no other session is mid-gate**

`bun run build` rewrites `dist/reviewgate` **in place**, and `~/.local/bin/reviewgate` symlinks to that exact path. A Stop hook firing in any other repo during the build would exec a partially-written binary. Confirm no other Claude Code or Codex session is running a gate right now before proceeding. If one is, wait for it.

- [ ] **Step 4: Build and verify the build actually took**

```bash
bun run build
shasum -a 256 dist/reviewgate
```

Expected: a hash **different** from `/tmp/reviewgate-prev.sha256`. An unchanged hash means the build did not take — the exact silent failure that burned three pilot-01 attempts. Do not proceed until the hash changes.

Note this deploys to every repo on this machine via the `~/.local/bin/reviewgate` symlink.

- [ ] **Step 5: Approve the policy change on a TTY**

```bash
reviewgate config approve
```

Adding a phase is a control-plane change and **no agent can run this** — it is TTY-only. Until it is approved, the gate keeps reviewing under the last-known-good policy and will not adopt the critic. If the agent is driving this plan, stop here and hand the command to the human.

- [ ] **Step 6: Verify the critic actually runs**

End a turn in this repo so the Stop hook fires, then:

```bash
python3 -c "import json;d=json.load(open('.reviewgate/pending.json'));print(d.get('critic'))"
```

Expected: a `critic` object whose `status` is `"ran"` — **not** `"skipped-budget"`, `"misconfigured"`, `"error"` or `"empty"`. `"misconfigured"` means the adapter has no `complete()`; `"error"` most often means `OPENROUTER_API_KEY` is not reaching the hook environment.

If the gate PASSes without findings there may be no `pending.json`; in that case run `bun run dev learn status` and confirm no new errors, then re-check on the next blocking round.

- [ ] **Step 7: Commit**

```bash
git add reviewgate.config.ts
git commit -m "chore(config): enable phases.critic (openrouter) for this repo

The one precision layer with a measured effect was switched off — which is why
pilot-01's M6 critic delta was zero by construction, not by measurement.
bench/results/alpha12-v2/attempt-09 records +4.1pp precision and -16.7pp
clean-case FP rate at unchanged recall for exactly this provider/model.

Repo-local dogfood; the init scaffold default stays off until pilot-02."
```

**Rollback, if any of this misbehaves:**

- **Code (Tasks 1-4) — cheap and agent-executable.** `cp dist/reviewgate.prev dist/reviewgate`. The symlink points at the path, not the content, so it needs no change. `bun run build` does not `rm -rf dist/`, so the `.prev` copy survives the build.
- **Config (C1) — NOT cheap, and NOT agent-executable.** Removing the `critic:` line is *itself* an `approval-required` control-plane change and needs a **second** human `reviewgate config approve` at a TTY.

**Correction to an earlier claim (found by the plan-gate, verified by execution).** This plan and the spec both said reverting a config to its last-known-good value "needs no new TTY approval and touches no `.reviewgate/` state". **Both halves are false.** `safeStrengthening` (`src/config/control-plane.ts:121-152`) auto-classifies exactly four paths — `sandbox.mode`, `sandbox.writablePaths`, `sandbox.deniedReads`, `loop.softPassPolicy`. Everything else, **in both directions**, is `approval-required`. And `ControlPlaneStateSchema` (`src/schemas/control-plane.ts:26`) holds a single `approved_config` with no history, so once Step 5's approval lands, the with-critic config **becomes** the last-known-good and "restore the LKG" has no meaning to the system.

Consequences to plan around:
- The revert writes `pending` into `.reviewgate/control-plane.json` plus a policy-change report — state *is* touched.
- It blocks the agent once.
- **The gate keeps reviewing under the with-critic policy until a human approves the revert.** The original claim, "a bad build cannot force the critic back off", is inverted: the real hazard is that nothing but a human at a TTY can turn it off.

So the two rollbacks are asymmetric, not independent: the binary can be reverted in seconds by anyone, the critic cannot be reverted without Markus at a terminal. If pilot-02 must start before that approval is available, run it **with** the critic and record that as the registered configuration rather than waiting.

**Housekeeping:** `dist/reviewgate.prev` is ~65 MB and untracked. Delete it once pilot-02 concludes and the change is settled — not before, since it is the only rollback target.

---

## Not in this plan

- **pilot-02 itself.** It needs a fresh preregistration with `landedPattern` on all five seeds, the new binary hash pinned, and codex explicitly excluded from the panel (its quota cooldown ends 2026-08-08, and a panel that gains a reviewer measures two changes at once). Separate session.
- **Brain curator quorum** (122 fails, every one exactly one provider short). Shares the ≥2-provider rule with the FP-ledger but promotes knowledge rather than suppressing findings, and `phases.brain` is default-off.
- **Wiring `computeFpSemanticClusters` into suppression.** Deliberately withheld until real cross-run recurrence exists.

---

## Plan-gate findings mapping — round 1 (2026-08-05)

Two executing Claude reviewers (Slot A: claims-about-existing-code; Slot B: safety/blast-radius).
Both **FAIL**: 1 CRITICAL, 6 WARN, 11 INFO. Every finding below was verified by the reviewer
running code, and each fix was applied to the plan or spec.

| # | Sev | Finding | Fix | Where |
|---|---|---|---|---|
| B1 | CRITICAL | Reverting `phases.critic` is itself `approval-required` (only 4 sandbox/loop paths auto-classify), and `ControlPlaneStateSchema` keeps ONE `approved_config` with no history — so after approval the with-critic config IS the LKG. "Rolls back independently, no TTY, no state touched" was false in both directions. | Rewrote the rollback as **asymmetric**: binary reverts in seconds, critic needs a SECOND human TTY approval; with-critic policy stays in force until then. | Task 5 rollback; spec §Rollback 4 |
| A1/B2 | WARN | Task 2 predicted ONE pre-existing failure; there are THREE (+`learn-status.test.ts:336`). `:282`'s `as Parameters<…>` casts hide the missing field so `tsc` stays silent and `undefined >= 3` is silently false. `:117`'s natural repair would doctor a guard test into vacuity. | Named all three with **per-case** repairs; explicit ⚠ forbidding distinct run_ids on the burst fixture; added the learn-status failure to Step 5. | Task 2 Steps 4-5 |
| A2 | WARN | Task 4 Step 7's live expectation wrong: `delet@src/core/fact-check.ts` reports `runs: 0` in-window, not 1 — its only reject passed 60d old on 2026-08-04. | Stop condition narrowed to "no cluster reports `active`"; the 0-vs-1 split spelled out as correct windowing. | Task 4 Step 8 |
| A3/B3 | WARN | Task 4 changes the user-visible cluster key (`prisma@` → `attribut@`), breaking `learn-status.test.ts:337` — a file the plan never listed, whose failure Step 7 pre-labelled "phantom". | Added a dependent-suite step, declared the `<stem>@<file>` format a sanctioned change, and forbade the `labelFor`→`ruleIdToken0` fallback repair that would silently undo C4. | Task 4 Step 7 |
| B4 | WARN | C3 strictly **widens** demote-eligibility in every repo (raw ≥ decayed), feeding both the aggregator demote (`phases.reputation` defaults ON) and `quarantinedReviewers` (drops a reviewer from the panel). `learn status` cannot show it — `demoting` lives on `forDoctor`. Spec's "expected effect: none" was asserted, never measured. | Step 6 now diffs `doctor` before/after with named expected flips and a hard stop if any panel key flips; spec's expected-effect paragraph rewritten; quarantine reference repointed to `store.ts:167-170`. | Task 3 Steps 5-6; spec C3 |
| A4/B5 | INFO | `reputation-score.test.ts:27-31` breaks at **runtime** (not compile — `bun test` strips types, and a `const` literal gets no excess-property check). | Moved the repair into Step 4 with the exact location; corrected Step 2's stated failure mechanism. | Task 3 Steps 2, 4 |
| B6 | INFO | `fp-ledger-store.property.test.ts:115` goes **vacuous** under C2 — its `inWindow.length >= 3` oracle is implied by run-counting. | Tightened the oracle to the distinct-run set size. | Task 1 Step 5 |
| A5/B7 | INFO | `FpCluster.rule_id_token0`'s doc lies for the semantic path; `buildCluster`'s first arg is a label, not a token0. `labelFor` emits stems (`delet@`, `spac@`), not words. | Doc comment rewritten; refactor note clarified; Step 8 states stems are expected output. | Task 4 |
| B8 | INFO | `bun run build` rewrites `dist/reviewgate` in place while the symlink points at it — a concurrent gate could exec a half-written binary. No cleanup for the 65 MB `.prev`. | Added Step 3.5 (quiescence check) and a housekeeping note. | Task 5 |
| A6 | INFO | `aggregator.ts:783` independently reconstructs the cluster key — a fourth, implicit consumer freezing the format at both ends. | Named it in "Why C4 adds a function". | File Structure |
| A7 | INFO | Line-reference slop across four spots; spec called `RULE_ID_NOISE` 25 words (it holds 28). | Over-precise ranges dropped, noise count corrected. | plan + spec |

**Verified-correct and not re-litigated** (both reviewers, by execution): C2 is strictly
promotion-hardening (`runs ≤ events`); C4 genuinely stays out of suppression; every
`canonicalRuleTokens` expectation computes correctly against the real `RULE_ID_NOISE`; the
central 5-clusters/zero-false-merges claim reproduces exactly on the live 29-entry ledger; all
six Task-4 expectations including both transitive shapes; the `buildCluster`/`sortClusters`
extraction is behaviour-preserving; Task 1's fixtures are non-vacuous and fail exactly as
predicted; Task 3's store fixture yields `demoting true` after / `false` before; every C1 config
fact including that `bun run build` does not wipe `dist/`.
