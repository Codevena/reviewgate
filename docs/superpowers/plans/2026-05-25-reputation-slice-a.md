# Reputation Slice A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound `reputation.json` growth via on-write event-pruning, and surface `phases.reputation` as an on/off toggle in `reviewgate setup` — neither touching the scoring/demotion algorithm.

**Architecture:** `ReputationStore.record` gains an optional `{ now, halfLifeDays }` and drops time-decayed-negligible events (age > 6×halfLifeDays) from every bucket before the atomic write; `learnReputationFromDecisions` forwards `halfLifeDays` (optional, default 45) from `loop-driver`. The setup wizard mirrors the existing `fpLedger` wiring across `prefill.ts` / `build-config.ts` / `setup.ts`.

**Tech Stack:** Bun, TypeScript, zod, `@clack/prompts`. Tests via `bun test`.

Spec: `docs/superpowers/specs/2026-05-25-reputation-slice-a-design.md`.

---

## File Structure

- `src/core/reputation/store.ts` — add `PRUNE_HALF_LIVES` const, a `pruneBucket` helper, and the `opts?: { now?; halfLifeDays? }` param on `record`; prune all buckets before `writeAtomic`.
- `src/core/reputation/learn.ts` — add optional `halfLifeDays?: number` to the input; forward `{ now: new Date(nowIso), halfLifeDays }` to `record`.
- `src/core/loop-driver.ts` — pass `halfLifeDays: this.i.config.phases.reputation.halfLifeDays` into the existing `learnReputationFromDecisions` call.
- `src/cli/setup/prefill.ts` — `WizardDefaults.reputation`, `RECOMMENDED_DEFAULTS.reputation = true`, `answersFromConfig` returns it.
- `src/cli/setup/build-config.ts` — `CustomAnswers.reputation`, emit `phases.reputation` in both `buildQuickPreset` and `buildCustomConfig`.
- `src/cli/commands/setup.ts` — one `confirm` after the fpLedger confirm, threaded into `buildCustomConfig`.
- Tests: `tests/unit/reputation-store.test.ts`, `tests/unit/reputation-learn.test.ts`, `tests/unit/setup-prefill.test.ts`, `tests/unit/setup-build-config.test.ts`, `tests/unit/config-diff-serialize.test.ts`.

---

## Task 1: Event-pruning in `ReputationStore.record`

**Files:**
- Modify: `src/core/reputation/store.ts`
- Test: `tests/unit/reputation-store.test.ts`

- [ ] **Step 1: Write the failing tests**

Append these three `it` blocks inside the existing `describe("ReputationStore", () => { ... })` in `tests/unit/reputation-store.test.ts` (before its closing `});`):

```ts
  it("prunes events older than 6x halfLifeDays on write, keeps recent ones", async () => {
    const r = repo();
    const s = new ReputationStore(r);
    const now = new Date("2026-05-25T00:00:00Z");
    const halfLifeDays = 45;
    const DAY = 86_400_000;
    const old = new Date(now.getTime() - 7 * halfLifeDays * DAY).toISOString(); // 315d > 270d horizon
    const recent = new Date(now.getTime() - 10 * DAY).toISOString();
    await s.record(
      [
        { provider: "codex", outcome: "wrong", eid: "old", ts: old },
        { provider: "codex", outcome: "wrong", eid: "recent", ts: recent },
      ],
      { now, halfLifeDays },
    );
    const eids = ((await s.snapshot()).reviewers.codex?.wrong ?? []).map((e) => e.eid);
    expect(eids).toContain("recent");
    expect(eids).not.toContain("old");
  });

  it("keeps future-dated and unparseable ts events (treated as fresh)", async () => {
    const r = repo();
    const s = new ReputationStore(r);
    const now = new Date("2026-05-25T00:00:00Z");
    const future = new Date(now.getTime() + 86_400_000).toISOString();
    await s.record(
      [
        { provider: "codex", outcome: "correct", eid: "future", ts: future },
        { provider: "codex", outcome: "correct", eid: "bad", ts: "not-a-date" },
      ],
      { now, halfLifeDays: 45 },
    );
    const eids = ((await s.snapshot()).reviewers.codex?.correct ?? []).map((e) => e.eid);
    expect(eids).toContain("future");
    expect(eids).toContain("bad");
  });

  it("pruning on a write does not drop another reviewer's recent events", async () => {
    const r = repo();
    const s = new ReputationStore(r);
    const now = new Date("2026-05-25T00:00:00Z");
    await s.record([{ provider: "gemini", outcome: "wrong", eid: "g1", ts: now.toISOString() }], {
      now,
      halfLifeDays: 45,
    });
    await s.record([{ provider: "codex", outcome: "wrong", eid: "c1", ts: now.toISOString() }], {
      now,
      halfLifeDays: 45,
    });
    expect((await s.snapshot()).reviewers.gemini?.wrong).toHaveLength(1);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/unit/reputation-store.test.ts`
Expected: the two pruning tests FAIL (the `old` event is still present because `record` does not yet prune; `record` also doesn't accept a second `opts` arg — a TS error or the arg is ignored). The "future/unparseable" and "other reviewer" tests may pass incidentally — that's fine.

- [ ] **Step 3: Implement pruning in `store.ts`**

In `src/core/reputation/store.ts`, add the constant + helper just above the `export class ReputationStore` line:

```ts
// Events whose time-decayed weight is negligible are dropped on write to keep
// reputation.json bounded. At 6 half-lives the weight is 0.5^6 ≈ 0.0156; the effect
// on the derived score is bounded and immaterial (both buckets prune proportionally,
// so `trust` stays near-invariant). Storage hygiene, not a scoring change.
const PRUNE_HALF_LIVES = 6;
const DEFAULT_HALF_LIFE_DAYS = 45; // mirrors the phases.reputation schema default

function pruneBucket(
  events: { ts: string; eid: string }[],
  now: Date,
  halfLifeDays: number,
): { ts: string; eid: string }[] {
  const horizonMs = PRUNE_HALF_LIVES * halfLifeDays * 24 * 60 * 60 * 1000;
  return events.filter((e) => {
    const ageMs = now.getTime() - Date.parse(e.ts);
    // Keep unparseable (NaN) and future/negative-age events — mirrors decayedCount,
    // which treats a non-finite/negative age as "fresh" (weight 1); they never age out.
    if (!Number.isFinite(ageMs) || ageMs < 0) return true;
    return ageMs <= horizonMs;
  });
}
```

Then replace the existing `record` method with:

```ts
  async record(
    events: RecordInput[],
    opts?: { now?: Date; halfLifeDays?: number },
  ): Promise<void> {
    if (events.length === 0) return;
    const now = opts?.now ?? new Date();
    const halfLifeDays = opts?.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;
    const lock = await flock(reputationLockPath(this.repoRoot));
    try {
      const rep = await this.snapshot();
      for (const ev of events) {
        let entry = rep.reviewers[ev.provider];
        if (!entry) {
          entry = { correct: [], wrong: [] };
          rep.reviewers[ev.provider] = entry;
        }
        const bucket = ev.outcome === "correct" ? entry.correct : entry.wrong;
        if (bucket.some((e) => e.eid === ev.eid)) continue;
        bucket.push({ ts: ev.ts, eid: ev.eid });
      }
      // Prune every reviewer's buckets (the write is happening anyway → keep the whole
      // file bounded). Negligible score effect; see PRUNE_HALF_LIVES note above.
      for (const provider of Object.keys(rep.reviewers)) {
        const entry = rep.reviewers[provider];
        if (!entry) continue;
        entry.correct = pruneBucket(entry.correct, now, halfLifeDays);
        entry.wrong = pruneBucket(entry.wrong, now, halfLifeDays);
      }
      this.writeAtomic(ReputationSchema.parse(rep));
    } finally {
      await lock.release();
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/unit/reputation-store.test.ts`
Expected: PASS (all 5 tests — the 2 original + 3 new).

- [ ] **Step 5: Typecheck + lint**

Run: `bunx tsc --noEmit && bun run lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/core/reputation/store.ts tests/unit/reputation-store.test.ts
git commit -m "feat(reputation): prune time-decayed-negligible events on write"
```

---

## Task 2: Thread `halfLifeDays` through `learn.ts` and `loop-driver.ts`

**Files:**
- Modify: `src/core/reputation/learn.ts`, `src/core/loop-driver.ts`
- Test: `tests/unit/reputation-learn.test.ts`

- [ ] **Step 1: Write the failing test**

Append this `it` block inside the existing `describe("learnReputationFromDecisions", () => { ... })` in `tests/unit/reputation-learn.test.ts` (before its closing `});`):

```ts
  it("forwards halfLifeDays to record so stale events are pruned", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-replearn3-"));
    mkdirSync(join(repo, ".reviewgate"), { recursive: true });
    writeFileSync(
      pendingJsonPath(repo),
      JSON.stringify({
        findings: [
          { id: "F-001", severity: "CRITICAL", reviewer: { provider: "gemini" }, members: [] },
        ],
      }),
    );
    const dp = decisionsPath(repo, 1);
    mkdirSync(dirname(dp), { recursive: true });
    writeFileSync(
      dp,
      `${JSON.stringify({
        schema: "reviewgate.decision.v1",
        finding_id: "F-001",
        verdict: "rejected",
        reason: "false positive verified by reading the diff",
        reviewer_was_wrong: true,
      })}\n`,
    );
    const store = new ReputationStore(repo);
    // Seed a 26-year-old gemini event WITHOUT pruning it (large halfLife, contemporaneous now).
    await store.record(
      [{ provider: "gemini", outcome: "wrong", eid: "stale", ts: "2000-01-01T00:00:00Z" }],
      { now: new Date("2000-01-02T00:00:00Z"), halfLifeDays: 45 },
    );
    // learn records a fresh event NOW with a tiny halfLifeDays → the stale event must be pruned.
    await learnReputationFromDecisions({
      repoRoot: repo,
      iter: 1,
      sessionId: "S",
      cycleSeq: 0,
      store,
      nowIso: new Date().toISOString(),
      halfLifeDays: 1,
    });
    const wrong = (await store.snapshot()).reviewers.gemini?.wrong ?? [];
    expect(wrong.map((e) => e.eid)).not.toContain("stale"); // pruned via forwarded halfLifeDays
    expect(wrong).toHaveLength(1); // only the freshly-learned event remains
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/unit/reputation-learn.test.ts`
Expected: FAIL — `halfLifeDays` is not yet a field on the input (TS error) and is not forwarded, so the `stale` event is NOT pruned (`wrong` has length 2 and contains `"stale"`).

- [ ] **Step 3: Forward `halfLifeDays` in `learn.ts`**

In `src/core/reputation/learn.ts`, change the input type and the `record` call. Update the function signature input object:

```ts
export async function learnReputationFromDecisions(input: {
  repoRoot: string;
  iter: number;
  sessionId: string;
  cycleSeq: number;
  store: ReputationStore;
  nowIso: string;
  halfLifeDays?: number;
}): Promise<void> {
  const { repoRoot, iter, sessionId, cycleSeq, store, nowIso, halfLifeDays } = input;
```

And change the final call from `await store.record(events);` to:

```ts
  await store.record(events, { now: new Date(nowIso), halfLifeDays });
```

(`halfLifeDays` is optional; when omitted, `record` applies its own `45` default. Existing test call sites that omit it keep compiling.)

- [ ] **Step 4: Pass `halfLifeDays` from `loop-driver.ts`**

In `src/core/loop-driver.ts`, in the `learnReputationFromDecisions({ ... })` call (the block guarded by `if (this.i.config.phases.reputation?.enabled)`, ~line 426), add the `halfLifeDays` field:

```ts
        await learnReputationFromDecisions({
          repoRoot: this.i.repoRoot,
          iter: state.iteration,
          sessionId: state.session_id,
          cycleSeq: state.reputation_cycle_seq,
          store: new ReputationStore(this.i.repoRoot),
          nowIso: new Date().toISOString(),
          halfLifeDays: this.i.config.phases.reputation.halfLifeDays,
        }).catch(() => undefined);
```

(`phases.reputation` is non-null here — the surrounding `?.enabled` guard is truthy and the field has a zod `.default(...)`.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test tests/unit/reputation-learn.test.ts`
Expected: PASS (all 3 tests — the 2 original still pass because `halfLifeDays` is optional).

- [ ] **Step 6: Typecheck + lint**

Run: `bunx tsc --noEmit && bun run lint`
Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add src/core/reputation/learn.ts src/core/loop-driver.ts tests/unit/reputation-learn.test.ts
git commit -m "feat(reputation): thread halfLifeDays from loop-driver into prune"
```

---

## Task 3: Setup-wizard toggle (prefill + build-config + setup.ts)

**Files:**
- Modify: `src/cli/setup/prefill.ts`, `src/cli/setup/build-config.ts`, `src/cli/commands/setup.ts`
- Test: `tests/unit/setup-prefill.test.ts`, `tests/unit/setup-build-config.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/unit/setup-prefill.test.ts`, add assertions:

In the `it("matches today's fresh-setup recommendation ...")` block, after the `expect(RECOMMENDED_DEFAULTS.contextDocs).toBe(false);` line, add:

```ts
    expect(RECOMMENDED_DEFAULTS.reputation).toBe(true);
```

In the `it("extracts reviewers ... toggles")` block, after `expect(d.contextDocs).toBe(true);`, add:

```ts
    expect(d.reputation).toBe(true);
```

In the `it("defaults/empty config => ...")` block, after `expect(d.brainCurator).toBeNull();`, add:

```ts
    // phases.reputation defaults ON in the schema, so a bare config reads back enabled.
    expect(d.reputation).toBe(true);
```

Add a new `it` inside `describe("answersFromConfig", ...)` (covers the disabled case the spec requires):

```ts
  it("reads reputation:false when explicitly disabled", () => {
    const cfg = defineConfig({
      phases: { reputation: { enabled: false } },
    } as Parameters<typeof defineConfig>[0]);
    expect(answersFromConfig(cfg).reputation).toBe(false);
  });
```

In `tests/unit/setup-build-config.test.ts`, **first** keep the existing 6 `buildCustomConfig({ ... })` calls compiling: `CustomAnswers.reputation` becomes a required field (Step 4), so add `reputation: false,` to every existing `buildCustomConfig({ ... })` call object in this file — there are 6, each already ending its answer object with a `contextDocs: <bool>,` line; insert `reputation: false,` immediately after that `contextDocs:` line in each. (These tests don't assert reputation, and `reputation:false` only adds `phases.reputation.enabled:false` to the partial, which none of their assertions read — so they keep passing.)

Then add a new `it` inside `describe("buildQuickPreset", ...)`:

```ts
  it("enables reputation on the returned partial", () => {
    const partial = buildQuickPreset({ openrouterKeyPresent: false }) as {
      phases?: { reputation?: { enabled?: boolean } };
    };
    expect(partial.phases?.reputation?.enabled).toBe(true);
  });
```

And a new `it` inside `describe("buildCustomConfig", ...)`:

```ts
  it("emits phases.reputation.enabled reflecting the answer", () => {
    const off = buildCustomConfig({
      reviewers: [{ provider: "codex", persona: "security", model: "" }],
      critic: null,
      brain: null,
      fpLedger: false,
      contextDocs: false,
      reputation: false,
    }) as { phases?: { reputation?: { enabled?: boolean } } };
    expect(off.phases?.reputation?.enabled).toBe(false);
    const on = buildCustomConfig({
      reviewers: [{ provider: "codex", persona: "security", model: "" }],
      critic: null,
      brain: null,
      fpLedger: false,
      contextDocs: false,
      reputation: true,
    }) as { phases?: { reputation?: { enabled?: boolean } } };
    expect(on.phases?.reputation?.enabled).toBe(true);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/unit/setup-prefill.test.ts tests/unit/setup-build-config.test.ts`
Expected: FAIL — `RECOMMENDED_DEFAULTS.reputation` / `d.reputation` are `undefined`, the `reputation` arg is not on `CustomAnswers` (TS error), and the partials lack `phases.reputation`.

- [ ] **Step 3: Add `reputation` to `prefill.ts`**

In `src/cli/setup/prefill.ts`:

Add to the `WizardDefaults` interface (after `contextDocs: boolean;`):
```ts
  reputation: boolean;
```

Add to `RECOMMENDED_DEFAULTS` (after `contextDocs: false,`):
```ts
  reputation: true,
```

Add to the object returned by `answersFromConfig` (after `contextDocs: Boolean(cfg.phases.contextDocs?.enabled),`):
```ts
    reputation: Boolean(cfg.phases.reputation?.enabled),
```

- [ ] **Step 4: Add `reputation` to `build-config.ts`**

In `src/cli/setup/build-config.ts`:

Add to the `CustomAnswers` interface (after `contextDocs: boolean;`):
```ts
  reputation: boolean;
```

In `buildQuickPreset`, add to the returned `phases` object (after the `fpLedger: { enabled: true },` line, before `...brainPhase,`):
```ts
      reputation: { enabled: true },
```

In `buildCustomConfig`, add to the `phases` object initializer (after `fpLedger: { enabled: a.fpLedger },`):
```ts
    reputation: { enabled: a.reputation },
```

- [ ] **Step 5: Add the confirm to `setup.ts`**

In `src/cli/commands/setup.ts`, inside `runCustom`, directly after the `fpLedger` confirm block (the `const fp = await confirm({ ... "Enable the FP-ledger ..." }); if (isCancel(fp)) return null;`) and before the `contextDocs` confirm (`const ctx = ...`), insert:

```ts
  const rep = await confirm({
    message: "Enable reviewer reputation (down-weight a chronically-wrong reviewer)?",
    initialValue: defaults.reputation,
  });
  if (isCancel(rep)) return null;
```

Then in the closing `return buildCustomConfig({ ... })` call, add the field (after `contextDocs: Boolean(ctx),`):

```ts
    reputation: Boolean(rep),
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test tests/unit/setup-prefill.test.ts tests/unit/setup-build-config.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck + lint**

Run: `bunx tsc --noEmit && bun run lint`
Expected: both clean. (`tsc` also confirms `setup.ts`'s `buildCustomConfig` call now type-checks with the new required `reputation` field — `setup.ts` itself has no direct unit test, consistent with existing coverage.)

- [ ] **Step 8: Commit**

```bash
git add src/cli/setup/prefill.ts src/cli/setup/build-config.ts src/cli/commands/setup.ts tests/unit/setup-prefill.test.ts tests/unit/setup-build-config.test.ts
git commit -m "feat(reputation): surface phases.reputation as a setup-wizard toggle"
```

---

## Task 4: Diff-serialize coverage + full verification

**Files:**
- Test: `tests/unit/config-diff-serialize.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/unit/config-diff-serialize.test.ts`, add a new `it` inside `describe("diffFromDefaults", ...)`:

```ts
  it("strips reputation enabled:true (default-on) and emits enabled:false", () => {
    // reputation defaults ON, so enabling is default-equivalent → no diff line.
    const on = defineConfig({ phases: { reputation: { enabled: true } } });
    expect("reputation" in (diffFromDefaults(on).phases ?? {})).toBe(false);
    // disabling differs from the default → one line.
    const off = defineConfig({ phases: { reputation: { enabled: false } } });
    expect(diffFromDefaults(off)).toEqual({ phases: { reputation: { enabled: false } } });
  });
```

- [ ] **Step 2: Run the test to verify it passes (or fails meaningfully)**

Run: `bun test tests/unit/config-diff-serialize.test.ts`
Expected: PASS immediately — `diffFromDefaults` already handles default-equivalence generically, so this test documents/locks reputation's behavior rather than driving new code. If it FAILS, the diff logic does not treat `reputation` like other default-on features and the discrepancy must be investigated before proceeding.

- [ ] **Step 3: Run the full suite + static checks**

Run: `bunx tsc --noEmit && bun run lint && bun test`
Expected: all green. The known intermittent "compiled binary > doctor" test is unrelated — if it flakes, re-run `bun test` once.

- [ ] **Step 4: Commit**

```bash
git add tests/unit/config-diff-serialize.test.ts
git commit -m "test(reputation): lock setup toggle diff-serialize behavior"
```

---

## Final Verification (before the cross-agent review gate)

- [ ] `bunx tsc --noEmit` clean
- [ ] `bun run lint` clean
- [ ] `bun test` green (full suite)
- [ ] Manual sanity: `bun run dev doctor` still prints the `reviewer reputation` line; `bun run dev setup --print` (in a scratch dir, or via the prefill/build-config tests) reflects the toggle.

Then run the Definition-of-Done review pipeline (Codex ×2 → Claude ×2) per the repo conventions, fix any findings, and stop for push approval.
