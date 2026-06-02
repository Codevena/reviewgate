# Fix-Verification (§4.3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the "did-the-fix-work?" loop at the gate level — when a finding the agent marked `accepted`/`action:"fixed"` in an earlier iteration of the current cycle RECURS (same signature) later, re-flag it as still-blocking so the agent can't paper over a real finding.

**Architecture:** Mirror the existing 2b `cycle_rejected_signatures` plumbing. The loop-driver folds the prior iteration's `accepted`+`action:"fixed"` decisions into a new `state.claimed_fixed_signatures` (signature → earliest iter) map, passes it through the orchestrator into `aggregate()`, where detected recurrences are PINNED before the demote chain: the critic / confidence-floor / reputation passes skip a pinned finding so it keeps its blocking severity. Tie-break: a signature the agent has since contested (`cycleRejected`) is NOT pinned — cycleRejected wins, keeping the escape hatch open. Out-of-diff recurrences still scope-demote (pin does NOT cover `scopeFindings`).

**Tech Stack:** Bun, TypeScript, zod schemas, biome. Tests via `bun test`. Spec: `docs/superpowers/specs/2026-06-02-fix-verification-design.md`.

---

## File Structure

- `src/schemas/state.ts` — add `claimed_fixed_signatures` field + `initialState()` entry (Task 1).
- `src/schemas/finding.ts` — add `claimed_fixed_recurred` tag (Task 2).
- `src/core/aggregator.ts` — `AggregateInput.claimedFixed`, compute `pinned` set + tag, guard 3 demote passes (Task 3).
- `src/core/orchestrator.ts` — `runIteration` opts gain `claimedFixedSignatures`; pass into `aggregate()` (Task 4).
- `src/core/loop-driver.ts` — `priorIterationClaimedFixedSignatures` helper, fold into the SAME `state.update` as 2b, reset at 3 sites, pass to both `runIteration` calls (Task 5).
- `src/core/report-writer.ts` — `demoteBadges()` entry for the recurrence tag (Task 6).
- Tests: `tests/unit/aggregator-claimed-fixed.test.ts` (new), `tests/unit/loop-driver.test.ts` (append), `tests/unit/report-writer.test.ts` (append, if present).

---

### Task 1: State schema field + initialState

**Files:**
- Modify: `src/schemas/state.ts:70` (add field after `cycle_rejected_signatures`), `src/schemas/state.ts:111` (add to `initialState()`).
- Test: `tests/unit/state-schema.test.ts` (create if absent, else append).

- [ ] **Step 1: Write the failing test**

Create or append to `tests/unit/state-schema.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { ReviewgateStateSchema, initialState } from "../../src/schemas/state.ts";

describe("claimed_fixed_signatures field", () => {
  it("defaults to {} for state.json written before the field existed", () => {
    const base = initialState("01HXTEST");
    // Simulate an older persisted state missing the field.
    const { claimed_fixed_signatures, ...older } = base;
    const parsed = ReviewgateStateSchema.parse(older);
    expect(parsed.claimed_fixed_signatures).toEqual({});
  });

  it("initialState() includes claimed_fixed_signatures: {}", () => {
    expect(initialState("01HXTEST").claimed_fixed_signatures).toEqual({});
  });

  it("rejects a non-positive iteration value", () => {
    expect(() =>
      ReviewgateStateSchema.parse({ ...initialState("x"), claimed_fixed_signatures: { sig: 0 } }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/state-schema.test.ts`
Expected: FAIL — `claimed_fixed_signatures` is `undefined` (field not yet on the schema), and the destructure leaves it undefined.

- [ ] **Step 3: Add the schema field**

In `src/schemas/state.ts`, immediately after the `cycle_rejected_signatures` field (line 70), add:

```typescript
  // §4.3 Fix-Verification: signatures the agent marked accepted/action:"fixed" in
  // an EARLIER iteration of the CURRENT cycle, mapped to the EARLIEST iteration the
  // claim was made. A later recurrence of the same signature is re-flagged as
  // still-blocking by the aggregator (the claimed fix did not resolve it). `positive`
  // because a claim only follows iteration ≥1's findings. Reset on re-arm.
  // `.default({})` for back-compat with state.json written before this field.
  claimed_fixed_signatures: z.record(z.string(), z.number().int().positive()).default({}),
```

- [ ] **Step 4: Add to initialState()**

In `src/schemas/state.ts`, in the `initialState()` return object, immediately after `cycle_rejected_signatures: [],` (line 111), add:

```typescript
    claimed_fixed_signatures: {},
```

- [ ] **Step 5: Run test + typecheck to verify it passes**

Run: `bun test tests/unit/state-schema.test.ts && bunx tsc --noEmit`
Expected: PASS, no type errors. (Without the `initialState()` entry, tsc fails because the return type now requires the field.)

- [ ] **Step 6: Commit**

```bash
git add src/schemas/state.ts tests/unit/state-schema.test.ts
git commit -m "feat(state): add claimed_fixed_signatures field (§4.3)"
```

---

### Task 2: Finding recurrence tag

**Files:**
- Modify: `src/schemas/finding.ts:99` (add field before the closing `});` of `FindingSchema`).
- Test: `tests/unit/finding-schema.test.ts` (create if absent, else append).

- [ ] **Step 1: Write the failing test**

Create or append to `tests/unit/finding-schema.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { FindingSchema } from "../../src/schemas/finding.ts";

const base = {
  id: "F-001",
  signature: "s",
  severity: "WARN" as const,
  category: "quality" as const,
  rule_id: "r",
  file: "a.ts",
  line_start: 1,
  line_end: 1,
  message: "m",
  details: "d",
  reviewer: { provider: "codex", model: "m", persona: "security" },
  confidence: 0.9,
  consensus: "singleton" as const,
};

describe("claimed_fixed_recurred tag", () => {
  it("accepts an optional { iter } tag with a positive iter", () => {
    const f = FindingSchema.parse({ ...base, claimed_fixed_recurred: { iter: 2 } });
    expect(f.claimed_fixed_recurred?.iter).toBe(2);
  });

  it("is optional (absent → undefined)", () => {
    expect(FindingSchema.parse(base).claimed_fixed_recurred).toBeUndefined();
  });

  it("rejects a non-positive iter", () => {
    expect(() => FindingSchema.parse({ ...base, claimed_fixed_recurred: { iter: 0 } })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/finding-schema.test.ts`
Expected: FAIL — first test: `claimed_fixed_recurred` is stripped (unknown key → undefined); third test: does not throw.

- [ ] **Step 3: Add the schema field**

In `src/schemas/finding.ts`, immediately before the `contradicts_memory` field (line 94) — i.e. inside `FindingSchema`, add:

```typescript
  // §4.3 Fix-Verification: set by the aggregator when this finding's signature was
  // marked accepted/action:"fixed" in an earlier iteration of the current cycle and
  // has RECURRED. The finding is PINNED (critic/confidence/reputation demote passes
  // skip it) so an ineffective "fix" stays blocking. `iter` = earliest iteration the
  // fix was claimed. Rendered as a blocking-section badge by report-writer.
  claimed_fixed_recurred: z.object({ iter: z.number().int().positive() }).optional(),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/finding-schema.test.ts && bunx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/schemas/finding.ts tests/unit/finding-schema.test.ts
git commit -m "feat(finding): add claimed_fixed_recurred tag (§4.3)"
```

---

### Task 3: Aggregator pin (the teeth)

**Files:**
- Modify: `src/core/aggregator.ts:54` (add `claimedFixed` to `AggregateInput`), `src/core/aggregator.ts:304-308` (compute `pinned` + tag, change critic loop source + guard), `src/core/aggregator.ts:434` (confidence guard), `src/core/aggregator.ts:467` (reputation guard).
- Test: `tests/unit/aggregator-claimed-fixed.test.ts` (create).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/aggregator-claimed-fixed.test.ts`:

```typescript
// tests/unit/aggregator-claimed-fixed.test.ts
import { describe, expect, it } from "bun:test";
import { aggregate } from "../../src/core/aggregator.ts";
import type { Finding } from "../../src/schemas/finding.ts";

function fin(over: Partial<Finding>): Finding {
  return {
    id: "F",
    signature: "s",
    severity: "WARN",
    category: "quality",
    rule_id: "r",
    file: "a.ts",
    line_start: 1,
    line_end: 1,
    message: "m",
    details: "d",
    reviewer: { provider: "codex", model: "m", persona: "security" },
    confidence: 0.9,
    consensus: "singleton",
    ...over,
  };
}

describe("aggregate claimedFixed pin (§4.3)", () => {
  it("keeps a recurrence blocking even when the critic says likely_fp, and tags it", () => {
    const f = fin({ signature: "sig-fix", severity: "WARN" });
    const r = aggregate({
      findings: [f],
      reviewersTotal: 1,
      critic: new Map([["sig-fix", { verdict: "likely_fp" }]]),
      claimedFixed: new Map([["sig-fix", 1]]),
    });
    // Pinned: the critic demote (WARN→INFO) is skipped.
    expect(r.dedupedFindings[0]?.severity).toBe("WARN");
    expect(r.dedupedFindings[0]?.critic_verdict).toBeUndefined();
    expect(r.dedupedFindings[0]?.claimed_fixed_recurred?.iter).toBe(1);
  });

  it("detects a recurrence via a MEMBER signature and tags the earliest iter", () => {
    const rep = fin({ signature: "rep", severity: "WARN", line_start: 1, line_end: 1 });
    const mem = fin({ signature: "mem", severity: "WARN", line_start: 1, line_end: 1 });
    const r = aggregate({
      findings: [rep, mem],
      reviewersTotal: 1,
      critic: new Map([["rep", { verdict: "likely_fp" }]]),
      claimedFixed: new Map([["mem", 2]]),
    });
    expect(r.dedupedFindings).toHaveLength(1);
    expect(r.dedupedFindings[0]?.severity).toBe("WARN");
    expect(r.dedupedFindings[0]?.claimed_fixed_recurred?.iter).toBe(2);
  });

  it("tie-break: a signature in BOTH claimedFixed AND cycleRejected → cycleRejected wins (INFO, not pinned)", () => {
    const f = fin({ signature: "both", severity: "WARN" });
    const r = aggregate({
      findings: [f],
      reviewersTotal: 1,
      claimedFixed: new Map([["both", 1]]),
      cycleRejected: new Set(["both"]),
    });
    expect(r.dedupedFindings[0]?.severity).toBe("INFO");
    expect(r.dedupedFindings[0]?.claimed_fixed_recurred).toBeUndefined();
  });

  it("does NOT exempt scopeFindings: an out-of-diff recurrence still scope-demotes to INFO", () => {
    const f = fin({ signature: "sig-fix", severity: "WARN", file: "a.ts", line_start: 100, line_end: 100 });
    const r = aggregate({
      findings: [f],
      reviewersTotal: 1,
      claimedFixed: new Map([["sig-fix", 1]]),
      changedRanges: new Map([["a.ts", [[10, 14]] as Array<[number, number]>]]),
      scopeToDiff: true,
    });
    expect(r.dedupedFindings[0]?.severity).toBe("INFO");
    expect(r.dedupedFindings[0]?.scope_demoted).toBe(true);
  });

  it("no-op: empty/absent claimedFixed leaves findings untouched", () => {
    const f = fin({ signature: "x", severity: "WARN" });
    const r = aggregate({ findings: [f], reviewersTotal: 1 });
    expect(r.dedupedFindings[0]?.severity).toBe("WARN");
    expect(r.dedupedFindings[0]?.claimed_fixed_recurred).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/aggregator-claimed-fixed.test.ts`
Expected: FAIL — `claimedFixed` is not a known `AggregateInput` key (tsc error in the test) and no pinning occurs (critic demotes to INFO, no tag).

- [ ] **Step 3: Add `claimedFixed` to `AggregateInput`**

In `src/core/aggregator.ts`, inside `interface AggregateInput`, immediately after the `demoteCorrectness?: boolean;` field (line 54), add:

```typescript
  // §4.3 Fix-Verification: signatures the agent marked accepted/action:"fixed" in
  // an EARLIER iteration of the current cycle → earliest claimed iter. A deduped
  // finding whose representative OR any member signature matches (and whose
  // representative signature is NOT in `cycleRejected` — tie-break) is PINNED:
  // the critic, confidence-floor, and reputation demote passes skip it so an
  // ineffective "fix" stays blocking. NOT exempt from scopeFindings/fp passes.
  claimedFixed?: Map<string, number>;
```

- [ ] **Step 4: Compute the `pinned` set + tag, before the critic loop**

In `src/core/aggregator.ts`, between the end of the dedup loop (the `}` closing `for (const { sample, ... } of clusters)` at line 303) and `const critic = input.critic;` (line 305), insert:

```typescript
  // §4.3 Fix-Verification — pin claimed-fixed recurrences UP FRONT (before any
  // demote pass; the passes do not run in a single linear order — critic precedes
  // scope — so the pin must exist before the chain regardless of ordering). A
  // deduped finding matches if its representative OR any member signature is in
  // claimedFixed. Tie-break: a finding whose REPRESENTATIVE signature is in
  // cycleRejected is NOT pinned — the agent has contested it, so cycleRejected wins
  // and the escape hatch stays open. `pinned` stores REPRESENTATIVE signatures
  // (the guards below key on `f.signature`), even when the match was on a member.
  const claimedFixed = input.claimedFixed;
  const pinned = new Set<string>();
  const dedupedPinned: Finding[] =
    claimedFixed && claimedFixed.size > 0
      ? deduped.map((f) => {
          if (input.cycleRejected?.has(f.signature)) return f; // tie-break: cycleRejected wins
          const sigs = [f.signature, ...(f.members?.map((m) => m.signature) ?? [])];
          const iters = sigs
            .map((s) => claimedFixed.get(s))
            .filter((n): n is number => typeof n === "number");
          if (iters.length === 0) return f;
          pinned.add(f.signature);
          return { ...f, claimed_fixed_recurred: { iter: Math.min(...iters) } };
        })
      : deduped;
```

- [ ] **Step 5: Source the critic loop from `dedupedPinned` and guard it**

In `src/core/aggregator.ts`, change the critic loop header (line 308) from:

```typescript
  for (const f of deduped) {
```

to:

```typescript
  for (const f of dedupedPinned) {
    // §4.3: a pinned recurrence keeps its blocking severity — skip the critic demote.
    if (pinned.has(f.signature)) {
      survivors.push(f);
      continue;
    }
```

(The opening `{` of the `for` is replaced by `{` + the guard; the rest of the loop body is unchanged.)

- [ ] **Step 6: Guard the confidence-floor pass**

In `src/core/aggregator.ts`, in the `confScoped` map callback (the arrow starting at line 434 `fpClusterScoped.map((f) => {`), add as the FIRST statement inside the callback:

```typescript
          if (pinned.has(f.signature)) return f; // §4.3: pinned recurrence stays blocking
```

- [ ] **Step 7: Guard the reputation pass**

In `src/core/aggregator.ts`, in the `repScoped` map callback (the arrow starting at line 467 `confScoped.map((f) => {`), add as the FIRST statement inside the callback:

```typescript
          if (pinned.has(f.signature)) return f; // §4.3: pinned recurrence stays blocking
```

- [ ] **Step 8: Run test + typecheck + full aggregator suite to verify**

Run: `bun test tests/unit/aggregator-claimed-fixed.test.ts && bunx tsc --noEmit && bun test tests/unit/aggregator*.test.ts`
Expected: PASS — new file green, no type errors, NO regression in the other aggregator tests (no-op path is reference-identical when `claimedFixed` is absent).

- [ ] **Step 9: Commit**

```bash
git add src/core/aggregator.ts tests/unit/aggregator-claimed-fixed.test.ts
git commit -m "feat(aggregator): pin claimed-fixed recurrences (§4.3)"
```

---

### Task 4: Orchestrator pass-through

**Files:**
- Modify: `src/core/orchestrator.ts:148-155` (interface `runIteration` opts), `src/core/orchestrator.ts:329-334` (impl `runIteration` opts), `src/core/orchestrator.ts:1231-1233` (aggregate call).
- Test: covered by Task 5's loop-driver integration test (the orchestrator change is a pure pass-through; a dedicated test would duplicate Task 3 + Task 5). No new test.

- [ ] **Step 1: Add `claimedFixedSignatures` to the interface opts**

In `src/core/orchestrator.ts`, in the `runIteration` method signature on the INTERFACE (around line 148-155), after `cycleRejectedSignatures?: string[];` (line 154) add:

```typescript
    // §4.3 Fix-Verification: signatures marked accepted/action:"fixed" earlier this
    // cycle → earliest iter. Passed to aggregate() so a recurrence stays blocking.
    claimedFixedSignatures?: Record<string, number>;
```

- [ ] **Step 2: Add `claimedFixedSignatures` to the impl opts**

In `src/core/orchestrator.ts`, in the `async runIteration(opts: { ... })` IMPLEMENTATION signature (around line 329-334), after `cycleRejectedSignatures?: string[];` (line 333) add:

```typescript
    claimedFixedSignatures?: Record<string, number>;
```

- [ ] **Step 3: Pass into `aggregate()`**

In `src/core/orchestrator.ts`, in the `aggregate({ ... })` call, immediately after the `cycleRejected` spread block (lines 1231-1233), add:

```typescript
      ...(opts.claimedFixedSignatures && Object.keys(opts.claimedFixedSignatures).length > 0
        ? { claimedFixed: new Map(Object.entries(opts.claimedFixedSignatures)) }
        : {}),
```

- [ ] **Step 4: Typecheck**

Run: `bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/core/orchestrator.ts
git commit -m "feat(orchestrator): thread claimedFixedSignatures into aggregate (§4.3)"
```

---

### Task 5: Loop-driver accumulation + resets + pass-through

**Files:**
- Modify: `src/core/loop-driver.ts:118-153` (add helper after `priorIterationRejectedSignatures`), `src/core/loop-driver.ts:558-565` (fold both into ONE `state.update`), `src/core/loop-driver.ts:680` + `:721` (pass to both `runIteration` calls), `src/core/loop-driver.ts:379` + `:422` + `:790` (3 resets).
- Test: `tests/unit/loop-driver.test.ts` (append).

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/loop-driver.test.ts` (inside the same top-level `describe` block as the 2b test, or as a new `it` at the end of the file's existing suite — mirror the 2b test at line 1318):

```typescript
  it("folds prior accepted/action:fixed decisions into claimed_fixed_signatures and passes them to the next run (§4.3)", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXCLAIMEDFIX");
    await state.update((cur) => ({ ...cur, iteration: 1 }));
    writeDirty(repo);
    writeFileSync(
      pendingJsonPath(repo),
      JSON.stringify({
        findings: [
          { id: "F-001", signature: "sig-fixed", severity: "WARN" },
          { id: "F-002", signature: "sig-elsewhere", severity: "WARN" },
        ],
      }),
    );
    const dp = decisionsPath(repo, 1);
    mkdirSync(dirname(dp), { recursive: true });
    writeFileSync(
      dp,
      `${JSON.stringify({ schema: "reviewgate.decision.v1", finding_id: "F-001", verdict: "accepted", action: "fixed" })}\n` +
        `${JSON.stringify({ schema: "reviewgate.decision.v1", finding_id: "F-002", verdict: "accepted", action: "addressed-elsewhere" })}\n`,
    );
    let received: Record<string, number> | undefined;
    const stub = {
      runIteration: async (opts: { claimedFixedSignatures?: Record<string, number> }) => {
        received = opts.claimedFixedSignatures;
        return {
          verdict: "FAIL" as const,
          costUsd: 0,
          durationMs: 1,
          signaturesThisIter: ["s"],
          summary: {
            verdict: "FAIL",
            source: "panel",
            counts: { critical: 0, warn: 0, info: 0 },
            cost_usd: 0,
            duration_ms: 1,
            demoted: 0,
            signatures: ["s"],
            providers: [],
          } as RunSummary,
        };
      },
    };
    await new LoopDriver({
      repoRoot: repo,
      config: defaultConfig,
      state,
      audit: new AuditLogger(auditDir(repo)),
      orchestrator: stub,
      stopHookActive: false,
    }).run();
    // Only action:"fixed" is recorded; addressed-elsewhere is NOT.
    expect(received?.["sig-fixed"]).toBe(1);
    expect(received?.["sig-elsewhere"]).toBeUndefined();
    expect((await state.load()).claimed_fixed_signatures["sig-fixed"]).toBe(1);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/loop-driver.test.ts -t "claimed_fixed_signatures"`
Expected: FAIL — `received` is `undefined` (loop-driver does not yet pass `claimedFixedSignatures`), and `state.claimed_fixed_signatures` is empty.

- [ ] **Step 3: Add the accumulation helper**

In `src/core/loop-driver.ts`, immediately after the `priorIterationRejectedSignatures` function closes (line 153, the `}` after `return [...out];`), add:

```typescript
// Signatures of findings the agent marked accepted/action:"fixed" in `prevIter`
// (joins decisions/<prevIter>.jsonl → finding_id → signature via pending.json).
// Folded into state.claimed_fixed_signatures so the next panel re-flags any
// recurrence (§4.3 Fix-Verification). Never throws — returns [] on any gap.
function priorIterationClaimedFixedSignatures(repoRoot: string, prevIter: number): string[] {
  if (prevIter < 1) return [];
  const dp = decisionsPath(repoRoot, prevIter);
  const pp = pendingJsonPath(repoRoot);
  if (!existsSync(dp) || !existsSync(pp)) return [];
  let sigById: Map<string, string>;
  try {
    const report = JSON.parse(readFileSync(pp, "utf8")) as {
      findings?: Array<{ id?: string; signature?: string }>;
    };
    sigById = new Map(
      (report.findings ?? [])
        .filter((f): f is { id: string; signature: string } => !!f.id && !!f.signature)
        .map((f) => [f.id, f.signature]),
    );
  } catch {
    return [];
  }
  const out = new Set<string>();
  for (const line of readFileSync(dp, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const res = DecisionEntrySchema.safeParse(parsed);
    if (!res.success) continue;
    const d = res.data;
    if (d.verdict !== "accepted" || d.action !== "fixed") continue;
    const sig = sigById.get(d.finding_id);
    if (sig) out.add(sig);
  }
  return [...out];
}
```

- [ ] **Step 4: Fold BOTH accumulations into one `state.update`**

In `src/core/loop-driver.ts`, replace the 2b fold block (lines 558-565, the `const priorRejected = ...` through its closing `}`):

```typescript
      const priorRejected = priorIterationRejectedSignatures(this.i.repoRoot, state.iteration);
      if (priorRejected.length > 0) {
        const merged = [...new Set([...state.cycle_rejected_signatures, ...priorRejected])];
        if (merged.length !== state.cycle_rejected_signatures.length) {
          await this.i.state.update((cur) => ({ ...cur, cycle_rejected_signatures: merged }));
          state = { ...state, cycle_rejected_signatures: merged };
        }
      }
```

with the combined fold (one flock cycle, no torn state):

```typescript
      // Per-cycle suppression (2b) + claimed-fixed tracking (§4.3): fold the PRIOR
      // iteration's reviewer_was_wrong rejections AND accepted/action:"fixed"
      // dispositions into their respective cycle-scoped maps in a SINGLE state.update
      // so the two folds can't tear state. The new panel demotes rejected
      // recurrences and re-flags claimed-fixed recurrences. Both reset on re-arm.
      const priorRejected = priorIterationRejectedSignatures(this.i.repoRoot, state.iteration);
      const priorClaimedFixed = priorIterationClaimedFixedSignatures(
        this.i.repoRoot,
        state.iteration,
      );
      const mergedRejected = [...new Set([...state.cycle_rejected_signatures, ...priorRejected])];
      const mergedClaimedFixed: Record<string, number> = { ...state.claimed_fixed_signatures };
      const claimedIter = state.iteration; // the iteration whose decisions we just folded
      for (const sig of priorClaimedFixed) {
        const existing = mergedClaimedFixed[sig];
        // Keep the EARLIEST iteration the fix was claimed (idempotent re-stops + a
        // re-flagged-then-re-fixed signature must not advance its recorded iter).
        if (existing === undefined || claimedIter < existing) mergedClaimedFixed[sig] = claimedIter;
      }
      const rejectedChanged = mergedRejected.length !== state.cycle_rejected_signatures.length;
      const claimedChanged =
        Object.keys(mergedClaimedFixed).length !==
          Object.keys(state.claimed_fixed_signatures).length ||
        Object.entries(mergedClaimedFixed).some(
          ([k, v]) => state.claimed_fixed_signatures[k] !== v,
        );
      if (rejectedChanged || claimedChanged) {
        await this.i.state.update((cur) => ({
          ...cur,
          cycle_rejected_signatures: mergedRejected,
          claimed_fixed_signatures: mergedClaimedFixed,
        }));
        state = {
          ...state,
          cycle_rejected_signatures: mergedRejected,
          claimed_fixed_signatures: mergedClaimedFixed,
        };
      }
```

- [ ] **Step 5: Pass `claimedFixedSignatures` to both `runIteration` calls**

In `src/core/loop-driver.ts`, in the timeout-guarded `runIteration` call (after `cycleRejectedSignatures: state.cycle_rejected_signatures,` at line 680) add:

```typescript
        claimedFixedSignatures: state.claimed_fixed_signatures,
```

And in the no-timeout `runIteration` call (after `cycleRejectedSignatures: state.cycle_rejected_signatures,` at line 721) add the same line:

```typescript
        claimedFixedSignatures: state.claimed_fixed_signatures,
```

- [ ] **Step 6: Reset at the HEAD-move-while-escalated site**

In `src/core/loop-driver.ts`, in the `headMovedWhileEscalated` field block, immediately after `cycle_rejected_signatures: [],` (line 379) add:

```typescript
                claimed_fixed_signatures: {},
```

- [ ] **Step 7: Reset at the escalation re-arm site**

In `src/core/loop-driver.ts`, in the `state.escalated && state.escalation_announced` re-arm block, immediately after `cycle_rejected_signatures: [],` (line 422) add:

```typescript
          claimed_fixed_signatures: {},
```

- [ ] **Step 8: Reset at the clean-PASS re-arm site**

In `src/core/loop-driver.ts`, in the final `state.update` of the iteration path, immediately after the `cycle_rejected_signatures: passed ? [] : cur.cycle_rejected_signatures,` line (line 790) add:

```typescript
        // §4.3: claimed-fixed map is cycle-scoped — cleared on re-arm, preserved across a cycle's FAILs.
        claimed_fixed_signatures: passed ? {} : cur.claimed_fixed_signatures,
```

- [ ] **Step 9: Run the new test + typecheck**

Run: `bun test tests/unit/loop-driver.test.ts -t "claimed_fixed_signatures" && bunx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 10: Run the full loop-driver suite to confirm no regression**

Run: `bun test tests/unit/loop-driver.test.ts`
Expected: PASS (the 2b test still green — the refactored fold is behavior-preserving for the rejected path).

- [ ] **Step 11: Commit**

```bash
git add src/core/loop-driver.ts tests/unit/loop-driver.test.ts
git commit -m "feat(loop-driver): accumulate + reset + thread claimed_fixed_signatures (§4.3)"
```

---

### Task 6: Report-writer badge

**Files:**
- Modify: `src/core/report-writer.ts:43` (add a badge in `demoteBadges`, before the `return`).
- Test: `tests/unit/report-writer.test.ts` (append inside the existing `describe("finding visual cues")` block, reusing its `renderFinding` helper).

Note: `renderMd`/`demoteBadges` are module-private — do NOT try to import them. The established pattern (report-writer.test.ts:101-105) renders via `new ReportWriter(dir).write({ ...baseReport, findings: [...] })` and reads `.reviewgate/pending.md`. The `renderFinding(overrides)` helper already does exactly this; reuse it. The default `baseReport` finding is a CRITICAL (`src/db.ts:42`), so a `claimed_fixed_recurred` override stays a blocking CRITICAL.

- [ ] **Step 1: Write the failing test**

Append this `it` INSIDE the existing `describe("finding visual cues", ...)` block in `tests/unit/report-writer.test.ts` (after the last existing `it`, before that block's closing `});`), reusing the in-scope `renderFinding` helper:

```typescript
    it("claimed_fixed_recurred → renders the recurrence badge (blocking, not advisory)", async () => {
      const md = await renderFinding({ claimed_fixed_recurred: { iter: 2 } });
      expect(md).toContain("claimed fixed @ iter 2");
      // The default fixture finding is CRITICAL; a pinned recurrence is NOT advisory,
      // so it renders in the CRITICAL section, which precedes the Advisory section.
      const findingIdx = md.indexOf("F-001");
      const advisoryIdx = md.indexOf("## Advisory");
      expect(findingIdx).toBeGreaterThan(-1);
      if (advisoryIdx > -1) expect(findingIdx).toBeLessThan(advisoryIdx);
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/report-writer.test.ts -t "claimed_fixed_recurred"`
Expected: FAIL — the badge text "claimed fixed @ iter 2" is absent from the rendered markdown.

- [ ] **Step 3: Add the badge**

In `src/core/report-writer.ts`, in `demoteBadges()`, immediately before the `return badges.length === 0 ? null : ...` line (line 43), add:

```typescript
  if (f.claimed_fixed_recurred)
    badges.push(
      `⚠ claimed fixed @ iter ${f.claimed_fixed_recurred.iter} — still present; the fix did not resolve it`,
    );
```

(No change to `isAdvisory` — a pinned recurrence keeps its CRITICAL/WARN severity and carries no scope/fp demote flag, so it already lands in the blocking section.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/report-writer.test.ts -t "claimed_fixed_recurred"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/report-writer.ts tests/unit/report-writer.test.ts
git commit -m "feat(report-writer): badge claimed-fixed recurrences (§4.3)"
```

---

### Task 7: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Typecheck + lint**

Run: `bunx tsc --noEmit && bun run lint`
Expected: both clean. Fix any issue before proceeding.

- [ ] **Step 2: Full test suite**

Run: `bun test`
Expected: all green. (If a load-induced timeout flake appears in doctor/docreview/stats integration tests, re-run `bun run test:unit` and `bun run test:integration` separately to get a clean signal — see the project memory on this flake.)

- [ ] **Step 3: Rebuild the dist binary (the gate dogfoods this repo via the symlinked binary)**

Run: `bun run build`
Expected: `dist/reviewgate` rebuilt. (Required so the running gate picks up §4.3 — `~/.local/bin/reviewgate` symlinks the repo dist.)

- [ ] **Step 4: No commit** — Task 7 only verifies. Proceed to the DoD review gate.

---

## Self-Review

**1. Spec coverage:**
- Mechanism §1 (track claimed-fixed) → Task 5 (helper + fold + earliest-iter).
- Mechanism §2 (detect recurrence, rep OR member) → Task 3 (`pinned` computation).
- Mechanism §3 (pin-first re-flag) → Task 3 (3 guards) + Task 2 (tag).
- Mechanism §4 (warn badge) → Task 6.
- Exemption scope (scope NOT exempted) → Task 3 step 4 (no scope guard) + aggregator test #4.
- Tie-break (cycleRejected wins) → Task 3 (`if (input.cycleRejected?.has(f.signature)) return f`) + test #3.
- Known limitation (exact-match drift) → no code (documented degradation; no task needed).
- `initialState()` requirement → Task 1 step 4.
- Single `state.update` fold → Task 5 step 4.
- 3 reset sites → Task 5 steps 6-8.
- `iter` `.positive()` → Task 1 (state) + Task 2 (finding).
- Report badge via `demoteBadges` → Task 6.

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code. Task 6 reuses the existing `renderFinding` helper in `report-writer.test.ts` (verified present at lines 101-105) rather than importing the private `renderMd`/`demoteBadges` — no adaptive guesswork remains.

**3. Type consistency:** `claimed_fixed_signatures: Record<string, number>` (state) ↔ `claimedFixedSignatures?: Record<string, number>` (orchestrator opts) ↔ `claimedFixed?: Map<string, number>` (aggregate input, converted via `new Map(Object.entries(...))`) ↔ `claimed_fixed_recurred: { iter: number }` (finding tag). `pinned: Set<string>` of representative signatures; guards key on `f.signature`. Helper `priorIterationClaimedFixedSignatures` returns `string[]`, caller stamps `claimedIter = state.iteration`. All consistent.

---

## Execution Handoff

After all tasks: dispatch a final review per the repo DoD (static checks → Codex ×2 → Claude ×2, all PASS), then commit and ask before pushing. Remove `.review/` before the final commit.
