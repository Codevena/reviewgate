# Stats Precision Metric Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a precision metric (real-fixed vs confirmed-false-positive) to `reviewgate stats` by wiring the currently-unemitted `decision.applied` audit event so the human decision outcome becomes durable across sessions.

**Architecture:** When the decisions-gate for an iteration passes, `loop-driver` emits one `decision.applied` audit event per finalized decision (joined against `pending.json` for severity + providers), guarded by a per-cycle state watermark for exactly-once emit. `stats` reads those events over its time window and computes precision = TP/(TP+FP) overall, by severity, and by provider. Measurement only — no gate-behavior change.

**Tech Stack:** Bun, TypeScript, Zod schemas, `bun test`. Run `bunx tsc --noEmit` and `bun run lint` before every commit.

**Spec:** `docs/superpowers/specs/2026-06-11-stats-precision-metric-design.md` (read it first).

---

## File Structure

- **Create** `src/core/decision-outcome.ts` — pure classification + provider normalization. One responsibility: turn a `(DecisionEntry, Finding)` pair into a `DecisionOutcome`.
- **Modify** `src/schemas/audit-event.ts` — add `DecisionOutcomeSchema` + an optional `decision_outcome` field on `AuditEventSchema`.
- **Modify** `src/schemas/state.ts` — add the `decisions_emitted_through_iter` watermark field + `initialState`.
- **Modify** `src/core/loop-driver.ts` — add exported `emitDecisionOutcomes()`, wire it (watermark guard) into `run()`, add the watermark to the 3 re-arm reset sites.
- **Modify** `src/stats/load.ts` — collect `decision.applied` events and window them by event `ts`; expose on `AuditWindow`.
- **Modify** `src/stats/aggregate.ts` — accept decisions (optional param) and compute the `precision` block.
- **Modify** `src/stats/render.ts` — render a "Precision" section.
- **Modify** `src/cli/commands/stats.ts` + `src/stats/weekly-assemble.ts` — pass `window.decisions` into `aggregate()`.

Key existing anchors (verified against source):
- `AuditLogger.append(input)` — `src/audit/logger.ts:49`; input type allows any optional `AuditEvent` field.
- `lastDecisionsById(repoRoot, iter): Map<string, DecisionEntry>` — `src/core/loop-driver.ts:291` (last-wins per finding_id).
- `readPendingReport(repoRoot): { findings: Finding[] }` — `src/core/loop-driver.ts:321` (findings carry `severity`, `reviewer.provider`, `members[].provider`).
- decisions-gate pass point — `src/core/loop-driver.ts:925-953`; the `fp_counted_through_iter` watermark pattern to mirror — `src/core/loop-driver.ts:988-1013`.
- re-arm reset sites — `src/core/loop-driver.ts:651-652`, `695-696`, `1173-1174`.
- `DecisionEntrySchema` actions — `src/schemas/decision.ts:16-21` (`fixed`, `addressed-elsewhere`, `deferred-with-followup`, `acknowledged-low-value`).
- `Severity` enum (uppercase) — `src/schemas/finding.ts:3`.

---

## Task 1: `decision_outcome` audit payload schema

**Files:**
- Modify: `src/schemas/audit-event.ts`
- Test: `tests/unit/audit-event.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/audit-event.test.ts`:

```ts
import { AuditEventSchema, DecisionOutcomeSchema } from "../../src/schemas/audit-event.ts";

describe("decision_outcome payload", () => {
  it("accepts a valid decision_outcome", () => {
    const res = DecisionOutcomeSchema.safeParse({
      finding_id: "F-001",
      severity: "CRITICAL",
      bucket: "tp",
      providers: ["codex", "gemini"],
    });
    expect(res.success).toBe(true);
  });

  it("rejects a lowercase severity", () => {
    const res = DecisionOutcomeSchema.safeParse({
      finding_id: "F-001",
      severity: "critical",
      bucket: "tp",
      providers: [],
    });
    expect(res.success).toBe(false);
  });

  it("is strict — rejects unknown keys", () => {
    const res = DecisionOutcomeSchema.safeParse({
      finding_id: "F-001",
      severity: "WARN",
      bucket: "fp",
      reviewer_was_wrong: true,
      providers: ["codex"],
      bogus: 1,
    });
    expect(res.success).toBe(false);
  });

  it("rides on a decision.applied AuditEvent", () => {
    const res = AuditEventSchema.safeParse({
      schema: "reviewgate.audit.v1",
      ts: "2026-06-11T00:00:00.000Z",
      run_id: "s1",
      iter: 2,
      event: "decision.applied",
      trigger: "stop-hook",
      decision_outcome: { finding_id: "F-002", severity: "WARN", bucket: "declined", providers: ["codex"] },
      prev_event_hash: "",
      this_event_hash: "x",
    });
    expect(res.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/audit-event.test.ts -t "decision_outcome"`
Expected: FAIL — `DecisionOutcomeSchema` is not exported.

- [ ] **Step 3: Implement the schema**

In `src/schemas/audit-event.ts`, add an import of the shared `Severity` enum at the top (after the `zod` import):

```ts
import { Severity } from "./finding.ts";
```

Add the schema + type immediately before `export const AuditEventSchema` (around line 102):

```ts
export const DecisionOutcomeSchema = z
  .object({
    finding_id: z.string(), // iteration-local, for debugging — NOT a count/dedup key
    severity: Severity, // uppercase CRITICAL | WARN | INFO
    bucket: z.enum(["tp", "fp", "declined"]),
    reviewer_was_wrong: z.boolean().optional(),
    providers: z.array(z.string()), // normalized, de-duped base provider ids
  })
  .strict();
export type DecisionOutcome = z.infer<typeof DecisionOutcomeSchema>;
```

Add the field inside `AuditEventSchema` (after `run_summary: RunSummarySchema.optional(),` at line 113):

```ts
  decision_outcome: DecisionOutcomeSchema.optional(),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/audit-event.test.ts -t "decision_outcome"`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck, lint, commit**

```bash
bunx tsc --noEmit && bun run lint
git add src/schemas/audit-event.ts tests/unit/audit-event.test.ts
git commit -m "feat(schema): add decision_outcome payload to audit events"
```

---

## Task 2: `decisions_emitted_through_iter` state watermark

**Files:**
- Modify: `src/schemas/state.ts`
- Test: `tests/unit/state-schema.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/state-schema.test.ts`:

```ts
import { initialState, ReviewgateStateSchema } from "../../src/schemas/state.ts";

describe("decisions_emitted_through_iter", () => {
  it("defaults to 0 for back-compat state.json", () => {
    const base = initialState("sess");
    const { decisions_emitted_through_iter, ...withoutField } = base;
    const parsed = ReviewgateStateSchema.parse(withoutField);
    expect(parsed.decisions_emitted_through_iter).toBe(0);
  });

  it("is present in initialState", () => {
    expect(initialState("sess").decisions_emitted_through_iter).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/state-schema.test.ts -t "decisions_emitted_through_iter"`
Expected: FAIL — property does not exist.

- [ ] **Step 3: Implement the field**

In `src/schemas/state.ts`, add the field right after `fp_counted_through_iter` (line 65):

```ts
  // Precision metric: per-cycle watermark — highest iteration whose decisions have
  // already been emitted as decision.applied audit events (idempotency guard so a
  // re-stop of the same iteration can't double-emit). Reset to 0 on re-arm, exactly
  // like fp_counted_through_iter. `.default(0)` for back-compat with older state.json.
  decisions_emitted_through_iter: z.number().int().nonnegative().default(0),
```

In `initialState()` (after `fp_counted_through_iter: 0,` at line 137):

```ts
    decisions_emitted_through_iter: 0,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/state-schema.test.ts -t "decisions_emitted_through_iter"`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck, lint, commit**

```bash
bunx tsc --noEmit && bun run lint
git add src/schemas/state.ts tests/unit/state-schema.test.ts
git commit -m "feat(state): add decisions_emitted_through_iter watermark"
```

---

## Task 3: Pure decision-outcome logic

**Files:**
- Create: `src/core/decision-outcome.ts`
- Test: `tests/unit/decision-outcome.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/decision-outcome.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import {
  buildDecisionOutcome,
  classifyDecision,
  normalizeProviders,
} from "../../src/core/decision-outcome.ts";
import type { DecisionEntry } from "../../src/schemas/decision.ts";
import type { Finding } from "../../src/schemas/finding.ts";

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: "F-001",
    signature: "sig",
    severity: "CRITICAL",
    category: "correctness",
    rule_id: "r",
    file: "a.ts",
    line_start: 1,
    line_end: 1,
    message: "m",
    details: "d",
    reviewer: { provider: "codex", model: "x", persona: "p" },
    confidence: 0.9,
    consensus: "singleton",
    ...over,
  } as Finding;
}

describe("classifyDecision", () => {
  it("accepted+fixed → tp", () => {
    expect(classifyDecision({ schema: "reviewgate.decision.v1", finding_id: "F-001", verdict: "accepted", action: "fixed" } as DecisionEntry)).toBe("tp");
  });
  it("accepted+addressed-elsewhere → tp", () => {
    expect(classifyDecision({ schema: "reviewgate.decision.v1", finding_id: "F-001", verdict: "accepted", action: "addressed-elsewhere" } as DecisionEntry)).toBe("tp");
  });
  it("accepted+deferred-with-followup → declined", () => {
    expect(classifyDecision({ schema: "reviewgate.decision.v1", finding_id: "F-001", verdict: "accepted", action: "deferred-with-followup" } as DecisionEntry)).toBe("declined");
  });
  it("accepted+acknowledged-low-value → declined", () => {
    expect(classifyDecision({ schema: "reviewgate.decision.v1", finding_id: "F-001", verdict: "accepted", action: "acknowledged-low-value" } as DecisionEntry)).toBe("declined");
  });
  it("rejected+reviewer_was_wrong:true → fp", () => {
    expect(classifyDecision({ schema: "reviewgate.decision.v1", finding_id: "F-001", verdict: "rejected", reason: "x".repeat(20), reviewer_was_wrong: true } as DecisionEntry)).toBe("fp");
  });
  it("rejected without reviewer_was_wrong → declined", () => {
    expect(classifyDecision({ schema: "reviewgate.decision.v1", finding_id: "F-001", verdict: "rejected", reason: "x".repeat(20) } as DecisionEntry)).toBe("declined");
  });
});

describe("normalizeProviders", () => {
  it("collects reviewer + members, strips persona, dedups, sorts", () => {
    const f = finding({
      reviewer: { provider: "gemini", model: "m", persona: "p" },
      members: [
        { signature: "s1", provider: "codex", rule_id: "r", category: "correctness" },
        { signature: "s2", provider: "gemini", rule_id: "r", category: "correctness" },
        { signature: "s3", provider: "claude-code:security", rule_id: "r", category: "correctness" },
      ],
    });
    expect(normalizeProviders(f)).toEqual(["claude-code", "codex", "gemini"]);
  });
});

describe("buildDecisionOutcome", () => {
  it("builds a tp outcome with severity + providers", () => {
    const out = buildDecisionOutcome(
      { schema: "reviewgate.decision.v1", finding_id: "F-001", verdict: "accepted", action: "fixed" } as DecisionEntry,
      finding({ severity: "WARN" }),
    );
    expect(out).toEqual({ finding_id: "F-001", severity: "WARN", bucket: "tp", providers: ["codex"] });
  });
  it("carries reviewer_was_wrong on an fp outcome", () => {
    const out = buildDecisionOutcome(
      { schema: "reviewgate.decision.v1", finding_id: "F-001", verdict: "rejected", reason: "x".repeat(20), reviewer_was_wrong: true } as DecisionEntry,
      finding(),
    );
    expect(out.bucket).toBe("fp");
    expect(out.reviewer_was_wrong).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/decision-outcome.test.ts`
Expected: FAIL — module `src/core/decision-outcome.ts` does not exist.

- [ ] **Step 3: Implement the module**

Create `src/core/decision-outcome.ts`:

```ts
// src/core/decision-outcome.ts
// Pure classification of a human decision into a precision bucket, plus base-provider
// attribution. No I/O — emit/aggregation live in loop-driver / stats. See
// docs/superpowers/specs/2026-06-11-stats-precision-metric-design.md.
import type { DecisionOutcome } from "../schemas/audit-event.ts";
import type { DecisionEntry } from "../schemas/decision.ts";
import type { Finding } from "../schemas/finding.ts";

export type DecisionBucket = DecisionOutcome["bucket"];

// TP = the finding was real AND got fixed (anywhere); declined = valid but not fixed;
// FP = the reviewer was wrong.
export function classifyDecision(d: DecisionEntry): DecisionBucket {
  if (d.verdict === "accepted") {
    return d.action === "fixed" || d.action === "addressed-elsewhere" ? "tp" : "declined";
  }
  return d.reviewer_was_wrong === true ? "fp" : "declined";
}

// Base provider ids that raised the finding: reviewer.provider + every members[].provider,
// stripping any `provider:persona` suffix, de-duped and sorted for stable output.
export function normalizeProviders(f: Finding): string[] {
  const set = new Set<string>();
  const addBase = (v: string): void => {
    const i = v.indexOf(":");
    const base = i >= 0 ? v.slice(0, i) : v;
    if (base.length > 0) set.add(base);
  };
  addBase(f.reviewer.provider);
  for (const m of f.members ?? []) addBase(m.provider);
  return [...set].sort();
}

export function buildDecisionOutcome(d: DecisionEntry, f: Finding): DecisionOutcome {
  const base: DecisionOutcome = {
    finding_id: f.id,
    severity: f.severity,
    bucket: classifyDecision(d),
    providers: normalizeProviders(f),
  };
  if (d.verdict === "rejected" && d.reviewer_was_wrong !== undefined) {
    base.reviewer_was_wrong = d.reviewer_was_wrong;
  }
  return base;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/decision-outcome.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Typecheck, lint, commit**

```bash
bunx tsc --noEmit && bun run lint
git add src/core/decision-outcome.ts tests/unit/decision-outcome.test.ts
git commit -m "feat(core): pure decision-outcome classification + provider normalization"
```

---

## Task 4: `emitDecisionOutcomes()` in loop-driver

**Files:**
- Modify: `src/core/loop-driver.ts`
- Test: `tests/unit/loop-driver-emit-decisions.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/loop-driver-emit-decisions.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitDecisionOutcomes } from "../../src/core/loop-driver.ts";
import type { AuditEventInput } from "../../src/audit/logger.ts";
import { decisionsPath, pendingJsonPath } from "../../src/utils/paths.ts";

function seed(): string {
  const root = mkdtempSync(join(tmpdir(), "rg-emit-"));
  mkdirSync(join(root, ".reviewgate", "decisions"), { recursive: true });
  const finding = (id: string, severity: string, provider: string) => ({
    id,
    signature: `sig-${id}`,
    severity,
    category: "correctness",
    rule_id: "r",
    file: "a.ts",
    line_start: 1,
    line_end: 1,
    message: "m",
    details: "d",
    reviewer: { provider, model: "x", persona: "p" },
    confidence: 0.9,
    consensus: "singleton",
  });
  writeFileSync(
    pendingJsonPath(root),
    JSON.stringify({
      findings: [finding("F-001", "CRITICAL", "codex"), finding("F-002", "WARN", "gemini")],
      counts: { critical: 1, warn: 1, info: 0 },
    }),
  );
  writeFileSync(
    decisionsPath(root, 1),
    [
      JSON.stringify({ schema: "reviewgate.decision.v1", finding_id: "F-001", verdict: "accepted", action: "fixed" }),
      JSON.stringify({ schema: "reviewgate.decision.v1", finding_id: "F-002", verdict: "rejected", reason: "x".repeat(25), reviewer_was_wrong: true }),
    ].join("\n"),
  );
  return root;
}

function fakeAudit() {
  const events: AuditEventInput[] = [];
  return {
    events,
    append: async (e: AuditEventInput) => {
      events.push(e);
      return e as never;
    },
  };
}

describe("emitDecisionOutcomes", () => {
  it("emits one decision.applied per joined decision with the right bucket", async () => {
    const root = seed();
    const audit = fakeAudit();
    await emitDecisionOutcomes(root, 1, "sess", audit);
    expect(audit.events).toHaveLength(2);
    const byId = new Map(audit.events.map((e) => [e.decision_outcome?.finding_id, e.decision_outcome]));
    expect(byId.get("F-001")).toEqual({ finding_id: "F-001", severity: "CRITICAL", bucket: "tp", providers: ["codex"] });
    expect(byId.get("F-002")?.bucket).toBe("fp");
    expect(audit.events.every((e) => e.event === "decision.applied")).toBe(true);
  });

  it("skips a decision whose finding_id is not in pending.json", async () => {
    const root = seed();
    writeFileSync(
      decisionsPath(root, 1),
      JSON.stringify({ schema: "reviewgate.decision.v1", finding_id: "F-999", verdict: "accepted", action: "fixed" }),
    );
    const audit = fakeAudit();
    await emitDecisionOutcomes(root, 1, "sess", audit);
    expect(audit.events).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/loop-driver-emit-decisions.test.ts`
Expected: FAIL — `emitDecisionOutcomes` is not exported.

- [ ] **Step 3: Implement the function**

In `src/core/loop-driver.ts`, add the import for the builder near the other `./` imports (after the `./adjudications.ts` import around line 22):

```ts
import { buildDecisionOutcome } from "./decision-outcome.ts";
```

Add the exported function right after `lastDecisionsById` (after line 315, before `readPendingReport`):

```ts
// Precision telemetry: emit one durable `decision.applied` audit event per finalized
// decision of `iter`, joining decisions/<iter>.jsonl (last-wins) against the current
// pending.json findings for severity + providers. Decisions whose finding_id is not in
// the current pending.json are skipped (can't attribute). Best-effort by contract: the
// SOLE caller wraps it so a failure never affects the verdict. Exactly-once across stops
// is the caller's responsibility (decisions_emitted_through_iter watermark).
export async function emitDecisionOutcomes(
  repoRoot: string,
  iter: number,
  sessionId: string,
  audit: Pick<AuditLogger, "append">,
): Promise<void> {
  const decisions = lastDecisionsById(repoRoot, iter);
  if (decisions.size === 0) return;
  const findingsById = new Map(readPendingReport(repoRoot).findings.map((f) => [f.id, f]));
  for (const [id, d] of decisions) {
    const f = findingsById.get(id);
    if (f === undefined) continue;
    await audit.append({
      event: "decision.applied",
      run_id: sessionId,
      iter,
      trigger: "stop-hook",
      decision_outcome: buildDecisionOutcome(d, f),
    });
  }
}
```

Note: `AuditLogger` is already imported as a type (`import type { AuditLogger } from "../audit/logger.ts"`). `AuditEventInput` (used by the test) is already exported from `src/audit/logger.ts:20`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/loop-driver-emit-decisions.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck, lint, commit**

```bash
bunx tsc --noEmit && bun run lint
git add src/core/loop-driver.ts tests/unit/loop-driver-emit-decisions.test.ts
git commit -m "feat(core): emitDecisionOutcomes — durable decision.applied audit events"
```

---

## Task 5: Wire emit + watermark + re-arm resets into `run()`

**Files:**
- Modify: `src/core/loop-driver.ts`
- Test: `tests/unit/loop-driver-emit-decisions.test.ts` (extend with a watermark unit test)

This task wires the emit into the gate flow and resets the watermark on re-arm. The emit itself is already tested (Task 4); here we add the idempotency-guard behavior as a focused assertion on the helper composed with a manual watermark, then make the source edits.

- [ ] **Step 1: Write the failing test (watermark idempotency at the call layer)**

Append to `tests/unit/loop-driver-emit-decisions.test.ts`:

```ts
describe("emit watermark idempotency (call-layer contract)", () => {
  it("a second emit of the same iter still appends — guard MUST live in the caller", async () => {
    // Documents WHY run() needs the decisions_emitted_through_iter guard: the helper
    // itself is not idempotent across calls. The guard is asserted via state below.
    const root = seed();
    const audit = fakeAudit();
    await emitDecisionOutcomes(root, 1, "sess", audit);
    await emitDecisionOutcomes(root, 1, "sess", audit);
    expect(audit.events).toHaveLength(4); // proves the caller-side watermark is required
  });
});
```

- [ ] **Step 2: Run test to verify it passes immediately**

Run: `bun test tests/unit/loop-driver-emit-decisions.test.ts -t "watermark idempotency"`
Expected: PASS — this test documents the contract (the helper is intentionally not self-idempotent). It guards against a future refactor accidentally moving the guard into the helper.

- [ ] **Step 3: Wire the emit into `run()` with the watermark guard**

In `src/core/loop-driver.ts`, immediately after the decisions-gate block closes (after line 953, before the `// (absorbPriorDecisions runs before...` comment at 955), insert:

```ts
      // Precision metric (telemetry only): emit one decision.applied audit event per
      // finalized decision of this iteration, ONCE. Advance the per-cycle watermark
      // in state BEFORE appending → at-most-once: a crash loses at most this iter's
      // events, never double-counts (so stats counts events without dedup). Fully
      // best-effort: a failure here must never change the verdict or block the gate.
      if (state.iteration > state.decisions_emitted_through_iter) {
        try {
          await this.i.state.update((cur) => ({
            ...cur,
            decisions_emitted_through_iter: Math.max(
              cur.decisions_emitted_through_iter,
              state.iteration,
            ),
          }));
          state = await this.i.state.load();
          await emitDecisionOutcomes(
            this.i.repoRoot,
            state.iteration,
            state.session_id,
            this.i.audit,
          );
        } catch {
          /* best-effort precision telemetry */
        }
      }
```

- [ ] **Step 4: Add the watermark to the three re-arm reset sites**

Site 1 — `src/core/loop-driver.ts`, in the `headMovedWhileEscalated` block, after `fp_counted_through_iter: 0,` (line 652):

```ts
                decisions_emitted_through_iter: 0,
```

Site 2 — in the `escalated && escalation_announced` block, after `fp_counted_through_iter: 0,` (line 696):

```ts
          decisions_emitted_through_iter: 0,
```

Site 3 — in the normal post-iteration state update, after `fp_counted_through_iter: passed ? 0 : cur.fp_counted_through_iter,` (line 1174):

```ts
        decisions_emitted_through_iter: passed ? 0 : cur.decisions_emitted_through_iter,
```

- [ ] **Step 5: Run the broader loop-driver suite to verify no regression**

Run: `bun test tests/unit/loop-driver-emit-decisions.test.ts && bun test tests/unit/loop-driver.test.ts`
Expected: PASS for both (emit tests + existing loop-driver behavior unchanged).

- [ ] **Step 6: Typecheck, lint, commit**

```bash
bunx tsc --noEmit && bun run lint
git add src/core/loop-driver.ts tests/unit/loop-driver-emit-decisions.test.ts
git commit -m "feat(core): emit decision outcomes once per iteration + reset watermark on re-arm"
```

---

## Task 6: Collect + window `decision.applied` events in `load.ts`

**Files:**
- Modify: `src/stats/load.ts`
- Test: `tests/unit/stats-load.test.ts`

- [ ] **Step 1: Write the failing test**

Add a writer + test to `tests/unit/stats-load.test.ts` (reuse the file's `seedRepo`/`writeRun` helpers):

```ts
function writeDecision(root: string, ts: string, outcome: Record<string, unknown>): void {
  const d = new Date(ts);
  const dir = join(
    root, ".reviewgate", "audit",
    String(d.getUTCFullYear()),
    String(d.getUTCMonth() + 1).padStart(2, "0"),
    String(d.getUTCDate()).padStart(2, "0"),
  );
  mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({
    schema: "reviewgate.audit.v1",
    event: "decision.applied",
    ts,
    run_id: "s1",
    iter: 1,
    trigger: "stop-hook",
    decision_outcome: outcome,
  });
  writeFileSync(join(dir, "120500.jsonl"), `${line}\n`, { flag: "a" });
}

describe("loadAuditWindow decisions", () => {
  it("collects decision.applied events and windows them by ts via --since", () => {
    const root = seedRepo();
    writeDecision(root, "2026-06-01T12:00:00.000Z", { finding_id: "F-1", severity: "CRITICAL", bucket: "tp", providers: ["codex"] });
    writeDecision(root, "2026-06-05T12:00:00.000Z", { finding_id: "F-2", severity: "WARN", bucket: "fp", reviewer_was_wrong: true, providers: ["gemini"] });
    const win = loadAuditWindow(root, { since: "2026-06-03T00:00:00.000Z" });
    expect(win.decisions).toHaveLength(1);
    expect(win.decisions[0]?.finding_id).toBe("F-2");
  });

  it("returns an empty decisions array when there is no audit dir", () => {
    const root = seedRepo();
    expect(loadAuditWindow(root, {}).decisions).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/stats-load.test.ts -t "decisions"`
Expected: FAIL — `win.decisions` is `undefined`.

- [ ] **Step 3: Implement the collection + windowing**

In `src/stats/load.ts`:

Update the imports (lines 4-5):

```ts
import { DecisionOutcomeSchema, RunSummarySchema } from "../schemas/audit-event.ts";
import type { DecisionOutcome, RunSummary } from "../schemas/audit-event.ts";
```

Extend `AuditWindow` (lines 15-18):

```ts
export interface AuditWindow {
  runs: LoadedRun[];
  escalationCount: number;
  decisions: DecisionOutcome[];
}
```

Update the no-dir early return (line 67):

```ts
    return { runs: [], escalationCount: 0, decisions: [] };
```

Add a collector next to `escalations` (after line 71):

```ts
  const decisions: { ts: string; outcome: DecisionOutcome }[] = [];
```

Add a branch in the event switch (after the `run.complete` branch, before line 105's closing `}`):

```ts
      } else if (obj.event === "decision.applied" && obj.decision_outcome != null) {
        const res = DecisionOutcomeSchema.safeParse(obj.decision_outcome);
        if (res.success) {
          decisions.push({ ts: typeof obj.ts === "string" ? obj.ts : "", outcome: res.data });
        }
```

Add windowing after `escalationsInWindow` (after line 123) and update the return (line 125):

```ts
  let filteredDecisions = since != null ? decisions.filter((d) => d.ts >= since) : decisions;
  if (until != null) filteredDecisions = filteredDecisions.filter((d) => d.ts < until);
  const decisionsInWindow =
    lowerBound != null ? filteredDecisions.filter((d) => d.ts >= lowerBound) : filteredDecisions;

  return {
    runs: windowedRuns,
    escalationCount: escalationsInWindow.length,
    decisions: decisionsInWindow.map((d) => d.outcome),
  };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/stats-load.test.ts -t "decisions"`
Expected: PASS (2 tests). Also run the whole file to confirm no regression: `bun test tests/unit/stats-load.test.ts`.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
bunx tsc --noEmit && bun run lint
git add src/stats/load.ts tests/unit/stats-load.test.ts
git commit -m "feat(stats): collect and time-window decision.applied events"
```

---

## Task 7: Precision computation in `aggregate.ts`

**Files:**
- Modify: `src/stats/aggregate.ts`
- Test: `tests/unit/stats-aggregate.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/stats-aggregate.test.ts` (the file already builds `allRuns`, `fpEntries`, `brainEntries`):

```ts
import type { DecisionOutcome } from "../../src/schemas/audit-event.ts";

describe("precision", () => {
  const decisions: DecisionOutcome[] = [
    { finding_id: "F-1", severity: "CRITICAL", bucket: "tp", providers: ["codex"] },
    { finding_id: "F-2", severity: "CRITICAL", bucket: "fp", reviewer_was_wrong: true, providers: ["codex", "gemini"] },
    { finding_id: "F-3", severity: "WARN", bucket: "declined", providers: ["gemini"] },
    { finding_id: "F-4", severity: "INFO", bucket: "tp", providers: ["codex"] },
  ];

  it("computes overall precision = tp/(tp+fp), counting events (no finding_id dedup)", () => {
    const r = aggregate(allRuns, 1, fpEntries, brainEntries, decisions);
    expect(r.precision.overall.tp).toBe(2);
    expect(r.precision.overall.fp).toBe(1);
    expect(r.precision.overall.declined).toBe(1);
    expect(r.precision.overall.precision).toBeCloseTo(2 / 3);
  });

  it("splits by severity (INFO excluded)", () => {
    const r = aggregate(allRuns, 1, fpEntries, brainEntries, decisions);
    expect(r.precision.bySeverity.CRITICAL).toEqual({ tp: 1, fp: 1, declined: 0, precision: 0.5 });
    expect(r.precision.bySeverity.WARN.declined).toBe(1);
    expect("INFO" in r.precision.bySeverity).toBe(false);
  });

  it("attributes a multi-provider fp to each provider", () => {
    const r = aggregate(allRuns, 1, fpEntries, brainEntries, decisions);
    expect(r.precision.byProvider.gemini.fp).toBe(1);
    expect(r.precision.byProvider.codex.tp).toBe(2);
    expect(r.precision.byProvider.codex.fp).toBe(1);
  });

  it("returns null precision when there are no tp/fp", () => {
    const r = aggregate(allRuns, 1, fpEntries, brainEntries, []);
    expect(r.precision.overall.precision).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/stats-aggregate.test.ts -t "precision"`
Expected: FAIL — `r.precision` is `undefined`.

- [ ] **Step 3: Implement the precision block**

In `src/stats/aggregate.ts`:

Add the import (after line 2):

```ts
import type { DecisionOutcome } from "../schemas/audit-event.ts";
```

Add the cell type + extend `StatsReport` (inside the interface, after the `brain` field at line 34):

```ts
  precision: {
    overall: PrecisionCell;
    bySeverity: { CRITICAL: PrecisionCell; WARN: PrecisionCell };
    byProvider: Record<string, PrecisionCell>;
  };
```

Add the exported cell interface right after `StatsReport` (after line 35):

```ts
export interface PrecisionCell {
  tp: number;
  fp: number;
  declined: number;
  precision: number | null; // tp/(tp+fp); null when tp+fp === 0
}
```

Add the optional param to `aggregate` (change the signature at lines 51-56):

```ts
export function aggregate(
  runs: LoadedRun[],
  escalationCount: number,
  fpEntries: FpEntryLite[],
  brainEntries: BrainEntryLite[],
  decisions: DecisionOutcome[] = [],
): StatsReport {
```

Add the computation right before the final `return {` (after the Brain block, around line 191):

```ts
  // ------------------------------------------------------------------
  // Precision — count events directly; NEVER dedup by finding_id (it is
  // iteration-local and reused across cycles). Each event is one decision.
  // ------------------------------------------------------------------
  const newCell = (): PrecisionCell => ({ tp: 0, fp: 0, declined: 0, precision: null });
  const finalize = (c: PrecisionCell): void => {
    c.precision = c.tp + c.fp === 0 ? null : c.tp / (c.tp + c.fp);
  };
  const overall = newCell();
  const bySeverity = { CRITICAL: newCell(), WARN: newCell() };
  const byProvider: Record<string, PrecisionCell> = {};
  for (const d of decisions) {
    overall[d.bucket] += 1;
    if (d.severity === "CRITICAL") bySeverity.CRITICAL[d.bucket] += 1;
    else if (d.severity === "WARN") bySeverity.WARN[d.bucket] += 1;
    // INFO is non-blocking → excluded from precision.
    for (const p of d.providers) {
      const cell = (byProvider[p] ??= newCell());
      cell[d.bucket] += 1;
    }
  }
  finalize(overall);
  finalize(bySeverity.CRITICAL);
  finalize(bySeverity.WARN);
  for (const cell of Object.values(byProvider)) finalize(cell);
```

Add `precision` to the returned object (after `brain: { byStatus, byType },` at line 220):

```ts
    precision: { overall, bySeverity, byProvider },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/stats-aggregate.test.ts`
Expected: PASS (existing tests still green — the new param defaults to `[]` — plus 4 new precision tests).

- [ ] **Step 5: Typecheck, lint, commit**

```bash
bunx tsc --noEmit && bun run lint
git add src/stats/aggregate.ts tests/unit/stats-aggregate.test.ts
git commit -m "feat(stats): compute precision overall, by severity, and by provider"
```

---

## Task 8: Render the Precision section

**Files:**
- Modify: `src/stats/render.ts`
- Test: `tests/unit/stats-render.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/stats-render.test.ts` (the file constructs a `StatsReport`; build a minimal one or extend the existing fixture — show the precision fields explicitly):

```ts
import { renderStats } from "../../src/stats/render.ts";
import type { StatsReport } from "../../src/stats/aggregate.ts";

function reportWith(precision: StatsReport["precision"]): StatsReport {
  return {
    window: { runCount: 1, firstTs: "2026-06-01T00:00:00Z", lastTs: "2026-06-01T00:00:00Z", bySource: { panel: 1, cache: 0, skipped: 0 } },
    verdicts: { PASS: 1, "SOFT-PASS": 0, FAIL: 0, ERROR: 0 },
    escalationRate: 0,
    cost: { total: 0, avgPerRun: 0, perProvider: {} },
    providers: [],
    topSignatures: [],
    fpLedger: { active: 0, sticky: 0, candidate: 0, perProviderConfirmed: {} },
    brain: { byStatus: {}, byType: {} },
    precision,
  };
}

describe("renderStats precision", () => {
  it("renders a percentage when tp+fp > 0", () => {
    const out = renderStats(reportWith({
      overall: { tp: 2, fp: 1, declined: 1, precision: 2 / 3 },
      bySeverity: { CRITICAL: { tp: 1, fp: 1, declined: 0, precision: 0.5 }, WARN: { tp: 1, fp: 0, declined: 1, precision: 1 } },
      byProvider: { codex: { tp: 2, fp: 1, declined: 0, precision: 2 / 3 } },
    }));
    expect(out).toContain("Precision");
    expect(out).toContain("66.7%");
    expect(out).toContain("codex");
  });

  it("renders an em dash when precision is null", () => {
    const out = renderStats(reportWith({
      overall: { tp: 0, fp: 0, declined: 0, precision: null },
      bySeverity: { CRITICAL: { tp: 0, fp: 0, declined: 0, precision: null }, WARN: { tp: 0, fp: 0, declined: 0, precision: null } },
      byProvider: {},
    }));
    expect(out).toContain("—");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/stats-render.test.ts -t "precision"`
Expected: FAIL — output does not contain "Precision".

- [ ] **Step 3: Implement the section**

In `src/stats/render.ts`, add a helper after `pct` (line 10):

```ts
function pctOrDash(n: number | null): string {
  return n === null ? "—" : pct(n);
}

function cellLine(c: { tp: number; fp: number; declined: number; precision: number | null }): string {
  return `${pctOrDash(c.precision)}  (${c.tp} real / ${c.fp} FP · ${c.declined} declined)`;
}
```

Destructure `precision` from the report (line 38-39):

```ts
  const { window, verdicts, escalationRate, cost, providers, topSignatures, fpLedger, brain, precision } =
    report;
```

Insert the section right before the `return out;` (after the Brain block, line 136):

```ts
  // ── Precision ───────────────────────────────────────────────────────────────
  out += section("Precision");
  out += row("overall", cellLine(precision.overall));
  out += row("CRITICAL", cellLine(precision.bySeverity.CRITICAL));
  out += row("WARN", cellLine(precision.bySeverity.WARN));
  const provEntries = Object.entries(precision.byProvider).sort(([a], [b]) => (a < b ? -1 : 1));
  if (provEntries.length > 0) {
    out += "  by reviewer:\n";
    for (const [provider, cell] of provEntries) {
      out += row(`    ${provider}`, cellLine(cell), 20);
    }
  }
  out += "  (precision = real / (real + FP), windowed by decision time — a rate, not per-run)\n";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/stats-render.test.ts`
Expected: PASS (existing render tests still green + 2 new precision tests).

- [ ] **Step 5: Typecheck, lint, commit**

```bash
bunx tsc --noEmit && bun run lint
git add src/stats/render.ts tests/unit/stats-render.test.ts
git commit -m "feat(stats): render the precision section"
```

---

## Task 9: Pass decisions into both `aggregate()` call sites

**Files:**
- Modify: `src/cli/commands/stats.ts`
- Modify: `src/stats/weekly-assemble.ts`
- Test: `tests/unit/stats-command.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/stats-command.test.ts` (the file already seeds a repo + audit events and calls `runStats`; mirror its existing seeding, adding a decision event so the rendered output shows precision):

```ts
it("surfaces precision from decision.applied events end-to-end", async () => {
  const root = seedRepoWithRun(); // existing helper in this file that writes a run.complete
  // write a decision.applied event into the same day partition
  const ts = new Date().toISOString();
  const d = new Date(ts);
  const dir = join(
    root, ".reviewgate", "audit",
    String(d.getUTCFullYear()),
    String(d.getUTCMonth() + 1).padStart(2, "0"),
    String(d.getUTCDate()).padStart(2, "0"),
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "120600.jsonl"),
    `${JSON.stringify({ schema: "reviewgate.audit.v1", event: "decision.applied", ts, run_id: "s1", iter: 1, trigger: "stop-hook", decision_outcome: { finding_id: "F-1", severity: "CRITICAL", bucket: "tp", providers: ["codex"] } })}\n`,
  );
  const out = await runStats({ repoRoot: root });
  expect(out).toContain("Precision");
  expect(out).toContain("100.0%");
});
```

(If `seedRepoWithRun` is not the exact helper name in the file, use the file's existing repo-seeding helper — it must produce ≥1 `run.complete` so `renderStats` does not short-circuit on `runCount === 0`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/stats-command.test.ts -t "precision"`
Expected: FAIL — precision is empty because `window.decisions` is not passed to `aggregate`.

- [ ] **Step 3: Wire `stats.ts`**

In `src/cli/commands/stats.ts`, update the `aggregate(...)` call (line 44):

```ts
  const report = aggregate(window.runs, window.escalationCount, fpEntries, brainEntries, window.decisions);
```

- [ ] **Step 4: Wire `weekly-assemble.ts`**

In `src/stats/weekly-assemble.ts`, update both `aggregate(...)` calls (lines 76 and 80):

```ts
  const current = aggregate(curWindow.runs, curWindow.escalationCount, fpLite, brainLite, curWindow.decisions);
```

```ts
    ? aggregate(prevWindow.runs, prevWindow.escalationCount, fpLite, brainLite, prevWindow.decisions)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/unit/stats-command.test.ts && bun test tests/unit/weekly-aggregate.test.ts`
Expected: PASS for both (weekly path still produces its existing output; precision now flows into stats).

- [ ] **Step 6: Typecheck, lint, commit**

```bash
bunx tsc --noEmit && bun run lint
git add src/cli/commands/stats.ts src/stats/weekly-assemble.ts tests/unit/stats-command.test.ts
git commit -m "feat(stats): pass decision outcomes into stats and weekly aggregate"
```

---

## Task 10: Full verification + manual smoke

**Files:** none (verification only)

- [ ] **Step 1: Full static gate**

Run: `bunx tsc --noEmit && bun run lint`
Expected: both clean, zero errors.

- [ ] **Step 2: Full test suite**

Run: `bun test`
Expected: all pass, zero failures.

- [ ] **Step 3: Build the binary**

Run: `bun run build`
Expected: produces `dist/reviewgate` with no errors.

- [ ] **Step 4: Manual smoke — precision in stats output**

Run (against this repo, which has audit history):

```bash
bun run dev stats
```

Expected: the output now includes a `── Precision ──` section. If no `decision.applied` events exist yet (none predate this change), it shows `—  (0 real / 0 FP · 0 declined)` and the "windowed by decision time" note — the honest "no decisions recorded yet" state. This confirms the section renders without crashing on an empty signal.

- [ ] **Step 5: Final commit (if build artifacts or nothing else changed, skip)**

```bash
git status   # confirm working tree clean except intended changes
```

No commit needed if Steps 1-4 produced no file changes.

---

## Self-Review

**Spec coverage:**
- Component A (decision_outcome payload) → Task 1.
- Component B (emitDecisionOutcomes, provider normalization, classification, emit timing) → Tasks 3 + 4 + 5.
- Component C (load.ts collection + decision-time windowing) → Task 6.
- Component D (precision math, count-events-not-dedup, multi-provider) → Task 7.
- Component E (render section + caveat note) → Task 8.
- Component F (state watermark + re-arm reset) → Tasks 2 + 5.
- Both aggregate() call sites (INFO 2) → Task 9.
- Testing section items → distributed across Tasks 1,3,4,5,6,7,8,9; emit-timing/idempotency covered in Tasks 4-5; severity uppercase + .strict() in Task 1.

**Type consistency:** `DecisionOutcome` is defined once (Task 1, inferred from `DecisionOutcomeSchema`) and imported everywhere (decision-outcome.ts, load.ts, aggregate.ts, tests). `PrecisionCell` defined once in aggregate.ts (Task 7), consumed in render.ts (Task 8). `emitDecisionOutcomes` signature `(repoRoot, iter, sessionId, audit)` is identical in Task 4 (def) and Task 5 (call). `decisions_emitted_through_iter` spelled identically in schema (Task 2), reset sites + guard (Task 5).

**Placeholder scan:** every code step shows complete code; no TBD/TODO. Test helper names that depend on the existing file (`seedRepoWithRun` in Task 9) are flagged with a fallback instruction.

---

## Execution Handoff

Two execution options — choose one when ready:
1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks.
2. **Inline Execution** — execute tasks in this session with checkpoints.
