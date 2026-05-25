# Reputation Slice B (Persona-Granularity) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-key reviewer reputation from bare `provider` to `provider:persona`, derived from the existing `finding.confirmed_by`, so a provider's noisy persona no longer drags down its reliable one.

**Architecture:** `confirmed_by` already holds the deduped `provider:persona` keys a finding was reported by (set by the aggregator, persisted in `pending.json`). Slice B switches `learn.ts` and the aggregator reputation demote-pass to derive contributor keys from `confirmed_by`, stores reputation under those composite keys (renaming the store API for honesty), and filters legacy bare-provider keys so old data is inert. Demote-only; no scoring/consensus/config change.

**Tech Stack:** Bun, TypeScript, zod. Tests via `bun test`.

Spec: `docs/superpowers/specs/2026-05-25-reputation-slice-b-design.md`.

---

## File Structure

- `src/core/reputation/store.ts` — rename `RecordInput.provider`→`reviewerKey`, `unreliableProviders`→`unreliableReviewers`, `forDoctor` row field `provider`→`reviewer`; (Task 2) skip legacy keys lacking `:`.
- `src/core/reputation/learn.ts` — derive contributor keys from `confirmed_by` (fallback to representative `provider:persona`); eid appends the composite key.
- `src/core/aggregator.ts` — reputation demote-pass derives keys from `confirmed_by` (same key space as the store).
- `src/core/orchestrator.ts` — `unreliableProviders`→`unreliableReviewers` call + comment.
- `src/cli/commands/doctor.ts` — render `r.reviewer` instead of `r.provider`.
- `src/schemas/reputation.ts` — **comment-only**: the `reviewers` field comment must stop saying "keyed by provider id (NOT provider::persona …)" (false after Slice B).
- No change: `src/schemas/finding.ts`, `src/core/reputation/score.ts`.
- Tests: `tests/unit/reputation-store.test.ts`, `reputation-learn.test.ts`, `aggregator-reputation.test.ts`, `doctor-reputation.test.ts`, `orchestrator.test.ts`.

---

## Task 1: Core re-keying (rename + confirmed_by-derived composite keys)

This task switches the whole reputation path to `provider:persona` keys in one coherent change. After it, behavior is persona-keyed and the suite is green. (No legacy-key filter yet — old bare keys are harmlessly non-intersecting; the explicit filter + its test are Task 2.)

**Files:**
- Modify: `src/core/reputation/store.ts`, `src/core/reputation/learn.ts`, `src/core/aggregator.ts`, `src/core/orchestrator.ts`, `src/cli/commands/doctor.ts`, `src/schemas/reputation.ts` (comment-only)
- Test: `tests/unit/reputation-store.test.ts`, `reputation-learn.test.ts`, `aggregator-reputation.test.ts`, `doctor-reputation.test.ts`, `orchestrator.test.ts`

- [ ] **Step 1: Update tests to the composite-key API (write the failing tests first)**

**`tests/unit/aggregator-reputation.test.ts`** — the `finding()` helper sets `reviewer.persona="security"`, so `aggregate()` computes `confirmed_by:["gemini:security"]`. Change every `repUnreliable` set from bare to composite keys:
- In "demotes a lone non-security CRITICAL …": `repUnreliable: new Set(["gemini"])` → `new Set(["gemini:security"])`.
- In "NEVER demotes a security/correctness CRITICAL …": `new Set(["gemini"])` → `new Set(["gemini:security"])`.
- In "does NOT demote a corroborated (majority) finding": `f2` has `persona:"quality"`, so `new Set(["gemini", "codex"])` → `new Set(["gemini:security", "codex:quality"])`.
- In "no effect when the provider is not unreliable": `new Set()` stays `new Set()`.
- In "demotes a lone WARN …": `new Set(["gemini"])` → `new Set(["gemini:security"])`.
- In "does NOT demote when only ONE of several contributing providers is unreliable": `f2` has `persona:"quality"`; `new Set(["gemini"])` → `new Set(["gemini:security"])`. The `members.map((m) => m.provider)` assertion (`["codex","gemini"]`) stays unchanged (members still carry `provider`).
- Add ONE new test proving a legacy bare key cannot demote (structural soft-reset at the aggregator level — holds with or without Task 2's store filter):

```ts
  it("does NOT demote when repUnreliable holds only a legacy bare-provider key", () => {
    // confirmed_by is "gemini:security"; a leftover pre-Slice-B "gemini" key must not match.
    const agg = aggregate({
      findings: [finding({})],
      reviewersTotal: 2,
      repUnreliable: new Set(["gemini"]),
    });
    expect(agg.dedupedFindings[0]?.severity).toBe("CRITICAL");
    expect(agg.dedupedFindings[0]?.reputation_demoted).toBeUndefined();
  });
```

**`tests/unit/reputation-learn.test.ts`** — the fixtures build `pending.json` findings WITHOUT `confirmed_by`, and `reviewer` has no `persona`. The new `learn` derives keys from `confirmed_by`. Add `confirmed_by` to each fixture finding and assert composite keys:
- Test 1 ("credits/debits …"): give `F-001` `reviewer:{provider:"gemini",persona:"security"}` + `confirmed_by:["gemini:security"]`, and `F-002` `reviewer:{provider:"codex",persona:"quality"}` + `confirmed_by:["codex:quality"]`. Change assertions to `snap.reviewers["gemini:security"]?.wrong` toHaveLength 1 and `snap.reviewers["codex:quality"]?.correct` toHaveLength 1. The `F-999` (not-in-pending) assertion stays.
- Test 2 ("idempotent …"): give `F-001` `reviewer:{provider:"gemini",persona:"security"}` + `confirmed_by:["gemini:security"]`; assert `snap.reviewers["gemini:security"]?.wrong` toHaveLength 1.
- Test 3 (the Slice-A "forwards halfLifeDays …" test): give the `F-001` fixture `reviewer:{provider:"gemini",persona:"security"}` + `confirmed_by:["gemini:security"]`; change the pre-seed `store.record([{ provider: "gemini", … }], …)` to `reviewerKey: "gemini:security"`, and the assertions `reviewers.gemini?.wrong` → `reviewers["gemini:security"]?.wrong`.
- Add ONE new test proving multi-persona attribution:

```ts
  it("credits each distinct provider:persona in confirmed_by separately", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-replearn4-"));
    mkdirSync(join(repo, ".reviewgate"), { recursive: true });
    writeFileSync(
      pendingJsonPath(repo),
      JSON.stringify({
        findings: [
          {
            id: "F-001",
            severity: "CRITICAL",
            reviewer: { provider: "codex", persona: "security" },
            confirmed_by: ["codex:security", "codex:architecture"],
            members: [],
          },
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
        reason: "false positive confirmed by reading the code",
        reviewer_was_wrong: true,
      })}\n`,
    );
    const store = new ReputationStore(repo);
    await learnReputationFromDecisions({
      repoRoot: repo,
      iter: 1,
      sessionId: "S",
      cycleSeq: 0,
      store,
      nowIso: new Date().toISOString(),
    });
    const snap = await store.snapshot();
    expect(snap.reviewers["codex:security"]?.wrong).toHaveLength(1);
    expect(snap.reviewers["codex:architecture"]?.wrong).toHaveLength(1);
  });
```

**`tests/unit/orchestrator.test.ts`** — the default config runs codex as `persona:"security"`, so the reviewed finding's `confirmed_by` is `["codex:security"]`. Change BOTH seed blocks (the `store.record(Array.from(... { provider: "codex", … }))` at ~177 and ~217) from `provider: "codex"` to `reviewerKey: "codex:security"`.

**`tests/unit/doctor-reputation.test.ts`** — in "flags a demoting provider with warn", change the seed `provider: "gemini"` → `reviewerKey: "gemini:security"`, and the assertion `expect(c?.detail).toContain("gemini")` → `expect(c?.detail).toContain("gemini:security")`.

**`tests/unit/reputation-store.test.ts`** — rename the field and use composite key VALUES (the store treats keys as opaque strings; composite values keep them valid for Task 2's filter). Apply consistently across all tests in the file:
- Every RecordInput literal `provider: "X"` → `reviewerKey: "X:security"` (e.g. `"codex"`→`"codex:security"`, `"gemini"`→`"gemini:security"`).
- The `events(n, base)` helper: `provider: "gemini" as const` → `reviewerKey: "gemini:security" as const`.
- Every `unreliableProviders(...)` call → `unreliableReviewers(...)`, and `toContain("gemini")`/`toContain("codex")` → `toContain("gemini:security")`/`.not.toContain("codex:security")`.
- Every `snap.reviewers.codex` / `snap.reviewers.gemini` → `snap.reviewers["codex:security"]` / `snap.reviewers["gemini:security"]`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/unit/reputation-store.test.ts tests/unit/reputation-learn.test.ts tests/unit/aggregator-reputation.test.ts tests/unit/orchestrator.test.ts tests/unit/doctor-reputation.test.ts`
Expected: FAIL — `reviewerKey`/`unreliableReviewers` don't exist yet (TS errors), `learn` still keys by bare provider, the aggregator demote still matches bare keys (so composite `repUnreliable` sets no longer demote).

- [ ] **Step 3: Rename the store API in `src/core/reputation/store.ts`**

Rename the `RecordInput` field:
```ts
export interface RecordInput {
  reviewerKey: string;
  outcome: "correct" | "wrong";
  eid: string;
  ts: string;
}
```
In `record`, update the two `ev.provider` references:
```ts
      for (const ev of events) {
        let entry = rep.reviewers[ev.reviewerKey];
        if (!entry) {
          entry = { correct: [], wrong: [] };
          rep.reviewers[ev.reviewerKey] = entry;
        }
        const bucket = ev.outcome === "correct" ? entry.correct : entry.wrong;
        if (bucket.some((e) => e.eid === ev.eid)) continue;
        bucket.push({ ts: ev.ts, eid: ev.eid });
      }
```
Rename `derive`'s first param for clarity (cosmetic; keyed by any string):
```ts
  private derive(reviewerKey: string, rep: Reputation, now: Date, halfLifeDays: number): RepDerived {
    const e = rep.reviewers[reviewerKey] ?? { correct: [], wrong: [] };
    const trust = trustScore(e.correct, e.wrong, now, halfLifeDays);
    const samples =
      decayedCount(e.correct, now, halfLifeDays) + decayedCount(e.wrong, now, halfLifeDays);
    return { trust, samples };
  }
```
Rename `unreliableProviders` → `unreliableReviewers`:
```ts
  async unreliableReviewers(cfg: ReputationConfig, now: Date): Promise<Set<string>> {
    const rep = await this.snapshot();
    const out = new Set<string>();
    for (const reviewerKey of Object.keys(rep.reviewers)) {
      if (
        isUnreliable(
          this.derive(reviewerKey, rep, now, cfg.halfLifeDays),
          cfg.minSamples,
          cfg.trustFloor,
        )
      )
        out.add(reviewerKey);
    }
    return out;
  }
```
Rename the `forDoctor` row field `provider` → `reviewer`:
```ts
  async forDoctor(cfg: ReputationConfig, now: Date) {
    const rep = await this.snapshot();
    return Object.entries(rep.reviewers).map(([reviewerKey, e]) => {
      const d = this.derive(reviewerKey, rep, now, cfg.halfLifeDays);
      return {
        reviewer: reviewerKey,
        correct: e.correct.length,
        wrong: e.wrong.length,
        trust: d.trust,
        demoting: isUnreliable(d, cfg.minSamples, cfg.trustFloor),
      };
    });
  }
```

- [ ] **Step 4: Switch `learn.ts` to confirmed_by-derived keys**

In `src/core/reputation/learn.ts`, replace the provider-set derivation + event loop (currently lines ~46-57, the `const providers = [...]` block through the `for (const provider of new Set(providers))` loop) with:

```ts
    const fallbackKey =
      f.reviewer?.provider && f.reviewer?.persona
        ? `${f.reviewer.provider}:${f.reviewer.persona}`
        : null;
    const keys =
      f.confirmed_by && f.confirmed_by.length > 0
        ? f.confirmed_by
        : fallbackKey
          ? [fallbackKey]
          : [];
    for (const reviewerKey of new Set(keys)) {
      events.push({
        reviewerKey,
        outcome,
        eid: `${sessionId}:${cycleSeq}:${iter}:${d.finding_id}:${d.verdict}:${reviewerKey}`,
        ts: nowIso,
      });
    }
```

(`confirmed_by` is the deduped `provider:persona` set the aggregator wrote; the fallback covers a finding that somehow lacks it. A finding with neither `confirmed_by` nor a complete `reviewer` contributes nothing — acceptable edge.)

- [ ] **Step 5: Switch the aggregator reputation demote-pass to confirmed_by keys**

In `src/core/aggregator.ts`, in the reputation demote-pass (the `repScoped` map, currently ~lines 346-347), replace:
```ts
          const provs = [f.reviewer.provider, ...(f.members?.map((m) => m.provider) ?? [])];
          if (!provs.every((p) => repUnreliable.has(p))) return f;
```
with:
```ts
          const keys =
            f.confirmed_by && f.confirmed_by.length > 0
              ? f.confirmed_by
              : [`${f.reviewer.provider}:${f.reviewer.persona}`];
          if (!keys.every((k) => repUnreliable.has(k))) return f;
```
Leave all other guards (INFO/consensus/security exemption/`DEMOTE`) unchanged.

- [ ] **Step 6: Rename the orchestrator call**

In `src/core/orchestrator.ts` (~line 877-885), update the comment and method name:
```ts
    // Reviewer reputation: read the per-repo store and pass the set of currently-unreliable
    // `provider:persona` reviewer keys so the aggregator can demote their lone, non-security
    // findings. Best-effort: never let a reputation read break a review.
    const repCfg = this.input.config.phases.reputation;
    let repUnreliable: Set<string> | undefined;
    if (repCfg?.enabled) {
      repUnreliable = await new ReputationStore(repo)
        .unreliableReviewers(repCfg, new Date())
        .catch(() => undefined);
    }
```
(The `repUnreliable` variable name and the `AggregateInput` field stay — already generic.)

- [ ] **Step 7: Update the doctor render**

In `src/cli/commands/doctor.ts` (`reputationCheck`, ~line 182), change the row field:
```ts
        `${r.reviewer} ${r.correct}✓/${r.wrong}✗ (trust ${r.trust.toFixed(2)})${r.demoting ? " ⚠ demoting" : ""}`,
```

- [ ] **Step 7b: Fix the now-stale schema comment**

In `src/schemas/reputation.ts`, the `reviewers` field comment (currently
`// keyed by provider id (NOT provider::persona — merged members lack persona)`) is false after
Slice B. Replace it with:
```ts
  // keyed by `provider:persona` (Slice B); legacy bare-provider keys (pre-Slice B) are ignored on read
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `bun test tests/unit/reputation-store.test.ts tests/unit/reputation-learn.test.ts tests/unit/aggregator-reputation.test.ts tests/unit/orchestrator.test.ts tests/unit/doctor-reputation.test.ts`
Expected: PASS.

- [ ] **Step 9: Typecheck + lint**

Run: `bunx tsc --noEmit && bun run lint`
Expected: both clean. `tsc` confirms no other caller of `unreliableProviders` / `RecordInput.provider` / `forDoctor().provider` remains (the rename is complete). Run `bun run format` then re-check if biome flags formatting.

- [ ] **Step 10: Commit**

```bash
git add src/core/reputation/store.ts src/core/reputation/learn.ts src/core/aggregator.ts src/core/orchestrator.ts src/cli/commands/doctor.ts src/schemas/reputation.ts tests/unit/reputation-store.test.ts tests/unit/reputation-learn.test.ts tests/unit/aggregator-reputation.test.ts tests/unit/orchestrator.test.ts tests/unit/doctor-reputation.test.ts
git commit -m "feat(reputation): key reputation by provider:persona via confirmed_by"
```

---

## Task 2: Legacy bare-provider key filter + soft-reset test

Make pre-Slice-B bare-`provider` keys explicitly inert: they neither enter `unreliableReviewers` nor show a phantom `doctor` row. (A composite key always contains `:` because provider IDs are a colon-free fixed enum; a legacy bare key never does.)

**Files:**
- Modify: `src/core/reputation/store.ts`
- Test: `tests/unit/reputation-store.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/reputation-store.test.ts` inside `describe("ReputationStore", ...)`:

```ts
  it("ignores legacy bare-provider keys (no colon) in unreliableReviewers and forDoctor", async () => {
    const r = repo();
    const s = new ReputationStore(r);
    const now = new Date("2026-05-25T00:00:00Z");
    // Seed a below-floor LEGACY bare key ("codex", no persona segment).
    await s.record(
      Array.from({ length: 10 }, (_, i) => ({
        reviewerKey: "codex" as const,
        outcome: "wrong" as const,
        eid: `legacy${i}`,
        ts: now.toISOString(),
      })),
      { now, halfLifeDays: 45 },
    );
    const cfg = { enabled: true, minSamples: 8, trustFloor: 0.35, halfLifeDays: 45 };
    expect(await s.unreliableReviewers(cfg, now)).not.toContain("codex");
    expect((await s.forDoctor(cfg, now)).some((row) => row.reviewer === "codex")).toBe(false);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/unit/reputation-store.test.ts -t "legacy bare-provider"`
Expected: FAIL — without the filter, `unreliableReviewers` contains `"codex"` and `forDoctor` emits a `"codex"` row.

- [ ] **Step 3: Add the legacy-key filter**

In `src/core/reputation/store.ts`:

In `unreliableReviewers`, skip keys without a colon at the top of the loop:
```ts
    for (const reviewerKey of Object.keys(rep.reviewers)) {
      if (!reviewerKey.includes(":")) continue; // legacy bare-provider key (pre-Slice-B) → inert
      if (
        isUnreliable(
          this.derive(reviewerKey, rep, now, cfg.halfLifeDays),
          cfg.minSamples,
          cfg.trustFloor,
        )
      )
        out.add(reviewerKey);
    }
```

In `forDoctor`, filter legacy keys before mapping:
```ts
    return Object.entries(rep.reviewers)
      .filter(([reviewerKey]) => reviewerKey.includes(":")) // hide legacy bare-provider keys
      .map(([reviewerKey, e]) => {
        const d = this.derive(reviewerKey, rep, now, cfg.halfLifeDays);
        return {
          reviewer: reviewerKey,
          correct: e.correct.length,
          wrong: e.wrong.length,
          trust: d.trust,
          demoting: isUnreliable(d, cfg.minSamples, cfg.trustFloor),
        };
      });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/unit/reputation-store.test.ts`
Expected: PASS (all tests, including the new legacy-key test).

- [ ] **Step 5: Typecheck + lint**

Run: `bunx tsc --noEmit && bun run lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/core/reputation/store.ts tests/unit/reputation-store.test.ts
git commit -m "feat(reputation): treat legacy bare-provider keys as inert (soft-reset)"
```

---

## Task 3: Final verification

**Files:** none (verification only).

- [ ] **Step 1: Full suite + static checks**

Run:
```bash
bunx tsc --noEmit
bun run lint
bun test
```
Expected: all green. The known intermittent "compiled binary > doctor" test is unrelated — if (and only if) it flakes, re-run `bun test` once. If any OTHER test fails, STOP and report BLOCKED with details (do not patch unrelated code).

- [ ] **Step 2: Manual doctor sanity (optional but recommended)**

In a scratch repo with a seeded composite key, `bun run dev doctor` should show a `reviewer reputation` line rendering `provider:persona` keys (e.g. `codex:security …`). The reputation-store / doctor unit tests already cover this; this is a final smoke check.

- [ ] **Step 3: No commit (verification task).** Report the suite result and the two task commit SHAs for the final review gate.

---

## Final Verification (before the cross-agent review gate)

- [ ] `bunx tsc --noEmit` clean
- [ ] `bun run lint` clean
- [ ] `bun test` green (full suite)

Then run the cross-agent review (Codex + final Claude over the whole branch), fix findings, and stop for push approval.
