# Per-Signature Recurrence Cap + Off-Ramp Guidance (#5) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Break the iteration treadmill where one blocking finding recurs amid a churning finding-set — escalate (fail-safe, surface-to-human) when a single CRITICAL/WARN signature recurs across N consecutive reviewed iterations, and surface a "stop editing, fix-definitively-or-reject" off-ramp tip in pending.md.

**Architecture:** A pure `recurringBlockingSignatures` helper, called from a new escalation precondition in `LoopDriver.run()` (right after `stuck-signatures`) that cross-references the latest pending.json's blocking signatures against `signature_history`, with an off-ramp grace (excludes the just-rejected sigs) and a threshold clamped `> stuckThreshold`. A new `EscalationReason`, a `loop.maxSignatureRecurrence` config, and a render-only report tip.

**Tech Stack:** Bun, TypeScript, zod, `bun test`. Spec: `docs/superpowers/specs/2026-06-17-signature-recurrence-cap-design.md`.

---

## File structure

- `src/core/signature-recurrence.ts` — new: pure `recurringBlockingSignatures`.
- `src/schemas/state.ts` — add `"signature-recurrence"` to `EscalationReason`.
- `src/config/define-config.ts` + `defaults.ts` — `loop.maxSignatureRecurrence` (default 3).
- `src/core/loop-driver.ts` — the per-signature escalation precondition (after stuck-signatures).
- `src/core/report-writer.ts` — the off-ramp tip in the gate-mode "Required actions" block.
- `tests/unit/` — new tests per task.

---

## Task 1: `recurringBlockingSignatures` pure helper

**Files:**
- Create: `src/core/signature-recurrence.ts`
- Test: `tests/unit/signature-recurrence.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/signature-recurrence.test.ts`:

```ts
// tests/unit/signature-recurrence.test.ts
import { describe, expect, it } from "bun:test";
import { recurringBlockingSignatures } from "../../src/core/signature-recurrence.ts";

const B = (...s: string[]) => new Set(s);

describe("recurringBlockingSignatures", () => {
  it("returns a blocking sig present in each of the last K rows", () => {
    const history = [["s1", "a"], ["s1", "b"], ["s1", "c"]];
    expect(recurringBlockingSignatures(history, B("s1"), 3)).toEqual(["s1"]);
  });

  it("excludes a sig that recurs but is NOT in the blocking set (advisory)", () => {
    const history = [["s1", "x"], ["s1", "y"], ["s1", "z"]];
    expect(recurringBlockingSignatures(history, B("x"), 3)).toEqual([]); // x only in row 1
    expect(recurringBlockingSignatures(history, B("nope"), 3)).toEqual([]);
  });

  it("excludes a sig missing from any of the last K rows (a gap breaks the streak)", () => {
    const history = [["s1"], [], ["s1"]]; // empty middle row (ERROR iter)
    expect(recurringBlockingSignatures(history, B("s1"), 3)).toEqual([]);
  });

  it("only considers the LAST K rows", () => {
    const history = [["s1"], ["s1"], ["nope"], ["nope"]]; // last 2 rows lack s1
    expect(recurringBlockingSignatures(history, B("s1"), 2)).toEqual([]);
  });

  it("returns [] when history is shorter than the threshold, or threshold <= 0", () => {
    expect(recurringBlockingSignatures([["s1"]], B("s1"), 3)).toEqual([]);
    expect(recurringBlockingSignatures([["s1"], ["s1"]], B("s1"), 0)).toEqual([]);
  });

  it("returns all recurring blocking sigs, sorted + unique", () => {
    const history = [["s2", "s1"], ["s1", "s2"], ["s2", "s1"]];
    expect(recurringBlockingSignatures(history, B("s1", "s2"), 3)).toEqual(["s1", "s2"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/unit/signature-recurrence.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create the module**

Create `src/core/signature-recurrence.ts`:

```ts
// src/core/signature-recurrence.ts
// #5: detect a single BLOCKING finding that recurs across consecutive reviewed
// iterations (a treadmill the whole-set stuck-signatures check misses). Pure.
// `history` is the per-iteration finding-signature lists (state.signature_history);
// `blocking` is the CURRENTLY-blocking (CRITICAL/WARN) signatures from pending.json.

// Signatures in `blocking` present in EVERY one of the last `threshold` rows of
// `history`. Returns [] if threshold < 1 or history has fewer than `threshold` rows.
// An empty/ERROR row (lacking the signature) breaks its streak. Sorted + unique.
export function recurringBlockingSignatures(
  history: string[][],
  blocking: Set<string>,
  threshold: number,
): string[] {
  if (threshold < 1 || history.length < threshold) return [];
  const window = history.slice(-threshold).map((row) => new Set(row));
  const out: string[] = [];
  for (const sig of blocking) {
    if (window.every((row) => row.has(sig))) out.push(sig);
  }
  return out.sort();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/unit/signature-recurrence.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck + lint + commit**

```bash
bunx tsc --noEmit && bun run lint
git add src/core/signature-recurrence.ts tests/unit/signature-recurrence.test.ts
git commit -m "feat(#5): recurringBlockingSignatures pure helper"
```

(If `bun run lint` flags formatting, run `bun run format`, re-check, then commit.)

---

## Task 2: `EscalationReason` value + `maxSignatureRecurrence` config

**Files:**
- Modify: `src/schemas/state.ts` (add to the `EscalationReason` enum)
- Modify: `src/config/define-config.ts` (loop block) + `src/config/defaults.ts` (loop block)
- Test: `tests/unit/signature-recurrence-config.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/signature-recurrence-config.test.ts`:

```ts
// tests/unit/signature-recurrence-config.test.ts
import { describe, expect, it } from "bun:test";
import { defaultConfig } from "../../src/config/defaults.ts";
import { EscalationReason } from "../../src/schemas/state.ts";

describe("#5 config + escalation reason", () => {
  it("EscalationReason accepts signature-recurrence", () => {
    expect(EscalationReason.parse("signature-recurrence")).toBe("signature-recurrence");
  });

  it("loop.maxSignatureRecurrence defaults to 3", () => {
    expect(defaultConfig.loop.maxSignatureRecurrence).toBe(3);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/unit/signature-recurrence-config.test.ts`
Expected: FAIL — `EscalationReason.parse("signature-recurrence")` throws; `maxSignatureRecurrence` is `undefined`.

- [ ] **Step 3: Add the EscalationReason value**

In `src/schemas/state.ts`, inside the `EscalationReason = z.enum([...])` list, add (after `"stuck-signatures"`):

```ts
  // A single BLOCKING finding's signature recurred across loop.maxSignatureRecurrence
  // consecutive reviewed iterations — a treadmill where one finding sticks while the
  // set churns (the whole-set stuck-signatures check misses it). Surfaced to the
  // human (block-once, like stuck-signatures); never suppresses the finding.
  "signature-recurrence",
```

- [ ] **Step 4: Add the config field + default**

In `src/config/define-config.ts`, inside the `loop` object schema (near `stuckThreshold` / `infraDeferMaxConsecutive`), add:

```ts
    // #5: escalate when a single BLOCKING finding's signature recurs across this many
    // consecutive reviewed iterations (a treadmill where one finding sticks while the
    // set churns — the whole-set stuckThreshold check misses it). Fail-safe (surfaces
    // to the human, never suppresses). 0 disables. The loop-driver clamps the effective
    // value to > stuckThreshold so a low mis-config can't make per-signature the eager trigger.
    maxSignatureRecurrence: z.number().int().nonnegative().default(3),
```

In `src/config/defaults.ts`, inside the `loop` block (near `stuckThreshold: 2`), add:

```ts
    maxSignatureRecurrence: 3,
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test tests/unit/signature-recurrence-config.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Typecheck + lint + commit**

```bash
bunx tsc --noEmit && bun run lint
git add src/schemas/state.ts src/config/define-config.ts src/config/defaults.ts tests/unit/signature-recurrence-config.test.ts
git commit -m "feat(#5): signature-recurrence EscalationReason + maxSignatureRecurrence config"
```

---

## Task 3: loop-driver per-signature escalation precondition

**Files:**
- Modify: `src/core/loop-driver.ts` (import the helper; add the precondition right after the `stuck-signatures` check ~line 909)
- Test: `tests/unit/loop-driver-signature-recurrence.test.ts`

### Context
- The `stuck-signatures` check is at ~895-909; it `return this.escalateAndDecide(state, "stuck-signatures", ...)`. Insert the new check immediately after it (still before the `if (state.iteration > 0)` block at ~913).
- `escalateAndDecide(state, reasonCode, summary, deferableOnQuota = false)` — pass `true` (4th arg) so #10's quota-defer covers it.
- `readPendingReport(repoRoot)` (~350) returns `{ findings: Finding[] }` (validated, with `signature`+`severity`).
- `priorIterationRejectedSignatures(repoRoot, iter)` (used at ~927) returns the `reviewer_was_wrong` rejected signatures from `decisions/<iter>.jsonl`.
- `this.i.config.loop.stuckThreshold` / `maxSignatureRecurrence`; `state.signature_history` (`string[][]`); `state.iteration`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/loop-driver-signature-recurrence.test.ts`:

```ts
// tests/unit/loop-driver-signature-recurrence.test.ts
//
// #5: a single BLOCKING finding's signature recurring across maxSignatureRecurrence
// consecutive reviewed iterations escalates (signature-recurrence), even when the
// whole finding SET churns (so stuck-signatures does not fire).
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLogger } from "../../src/audit/logger.ts";
import { defaultConfig } from "../../src/config/defaults.ts";
import { LoopDriver } from "../../src/core/loop-driver.ts";
import type { IterationResult } from "../../src/core/orchestrator.ts";
import { StateStore } from "../../src/core/state-store.ts";
import type { RunSummary } from "../../src/schemas/audit-event.ts";
import type { Finding } from "../../src/schemas/finding.ts";
import { auditDir, decisionsPath, dirtyFlagPath, pendingJsonPath } from "../../src/utils/paths.ts";

function fakeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-sigrecur-"));
  writeFileSync(join(dir, "foo.ts"), "x");
  return dir;
}

function writeDirty(repo: string): void {
  writeFileSync(dirtyFlagPath(repo), JSON.stringify({ diff_hash: "h", ts: new Date().toISOString() }));
}

function critFinding(signature: string): Finding {
  return {
    id: "F-001", signature, severity: "CRITICAL", category: "security", rule_id: "r",
    file: "foo.ts", line_start: 1, line_end: 1, message: "m", details: "d",
    reviewer: { provider: "codex", model: "m", persona: "security" }, confidence: 0.9, consensus: "singleton",
  };
}

// Write pending.json with the given findings (so readPendingReport sees them).
function writePending(repo: string, findings: Finding[]): void {
  writeFileSync(
    pendingJsonPath(repo),
    JSON.stringify({
      schema: "reviewgate.pending.v1", run_id: "r", iter: 3, max_iter: 10, verdict: "FAIL",
      counts: { critical: findings.filter((f) => f.severity === "CRITICAL").length, warn: 0, info: 0 },
      reviewers: [{ id: "codex", provider: "codex", model: "m", persona: "security", status: "ok", cost_usd: 0, duration_ms: 1 }],
      findings, cost_usd_total: 0, duration_ms_total: 1, generated_at: "2026-06-17T00:00:00Z",
      git: { sha: "abc1234", branch: "main", dirty_files: ["foo.ts"] },
    }),
  );
}

const PASS_SUMMARY: RunSummary = {
  verdict: "PASS", source: "panel", counts: { critical: 0, warn: 0, info: 0 },
  cost_usd: 0, duration_ms: 1, demoted: 0, signatures: [], providers: [],
};
// A stub orchestrator: when the per-signature precondition does NOT fire, run() reaches
// runIteration → PASS → re-arm → allow_stop (no escalation). When it DOES fire, the
// precondition early-returns before runIteration, so this is never called.
const passStub = {
  runIteration: async (): Promise<IterationResult> => ({
    verdict: "PASS" as const, costUsd: 0, durationMs: 1, signaturesThisIter: [], summary: PASS_SUMMARY,
  }),
};

function driver(repo: string, state: StateStore, config = defaultConfig): LoopDriver {
  return new LoopDriver({
    repoRoot: repo, config, state, audit: new AuditLogger(auditDir(repo)),
    orchestrator: passStub, stopHookActive: false,
  });
}

const escMd = (repo: string) => join(repo, ".reviewgate", "ESCALATION.md");
// maxIterations 10 so the max-iterations check never fires; stuckThreshold default 2;
// maxSignatureRecurrence default 3. signature_history rows have DIFFERENT sets (churn)
// sharing only "s1", so whole-set stuck does not fire.
const CFG = { ...defaultConfig, loop: { ...defaultConfig.loop, maxIterations: 10 } };

describe("#5 per-signature recurrence escalation", () => {
  it("escalates signature-recurrence when one blocking sig recurs across the threshold (set churns)", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXSR000001");
    await state.update((cur) => ({ ...cur, iteration: 3, signature_history: [["s1", "a"], ["s1", "b"], ["s1", "c"]] }));
    writePending(repo, [critFinding("s1")]);
    writeDirty(repo);

    const decision = await driver(repo, state, CFG).run();

    expect(decision.kind).toBe("block");
    expect(decision.reason).toMatch(/ESCALATED/);
    expect(decision.reason).toMatch(/signature-recurrence/);
    expect(existsSync(escMd(repo))).toBe(true);
    const st = await state.load();
    expect(st.escalation_reason).toBe("signature-recurrence");
  });

  it("does NOT escalate below the threshold (only 2 recurring rows)", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXSR000002");
    await state.update((cur) => ({ ...cur, iteration: 2, signature_history: [["s1", "a"], ["s1", "b"]] }));
    writePending(repo, [critFinding("s1")]);
    writeDirty(repo);

    await driver(repo, state, CFG).run();
    expect(existsSync(escMd(repo))).toBe(false);
  });

  it("does NOT escalate when the recurring sig is only an INFO/advisory finding (not blocking)", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXSR000003");
    await state.update((cur) => ({ ...cur, iteration: 3, signature_history: [["s1", "a"], ["s1", "b"], ["s1", "c"]] }));
    writePending(repo, [{ ...critFinding("s1"), severity: "INFO" }]); // s1 is INFO → not blocking
    writeDirty(repo);

    await driver(repo, state, CFG).run();
    expect(existsSync(escMd(repo))).toBe(false);
  });

  it("does NOT escalate (off-ramp grace) when the agent rejected the sig in the just-completed iteration", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXSR000004");
    await state.update((cur) => ({ ...cur, iteration: 3, signature_history: [["s1", "a"], ["s1", "b"], ["s1", "c"]] }));
    writePending(repo, [critFinding("s1")]);
    // The agent rejected F-001 (signature s1) in iteration 3's decisions → off-ramp grace.
    writeFileSync(
      decisionsPath(repo, 3),
      `${JSON.stringify({ schema: "reviewgate.decision.v1", finding_id: "F-001", verdict: "rejected", reason: "false positive — the cited symbol is defined two lines above", reviewer_was_wrong: true })}\n`,
    );
    writeDirty(repo);

    await driver(repo, state, CFG).run();
    expect(existsSync(escMd(repo))).toBe(false);
  });

  it("does NOT escalate when maxSignatureRecurrence is 0 (disabled)", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXSR000005");
    await state.update((cur) => ({ ...cur, iteration: 3, signature_history: [["s1", "a"], ["s1", "b"], ["s1", "c"]] }));
    writePending(repo, [critFinding("s1")]);
    writeDirty(repo);
    const cfg = { ...defaultConfig, loop: { ...defaultConfig.loop, maxIterations: 10, maxSignatureRecurrence: 0 } };

    await driver(repo, state, cfg).run();
    expect(existsSync(escMd(repo))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/unit/loop-driver-signature-recurrence.test.ts --timeout 20000`
Expected: FAIL — the first test fails (no `signature-recurrence` escalation yet). (Some negative tests may already pass.)

- [ ] **Step 3: Import the helper**

In `src/core/loop-driver.ts`, add to the imports (near the other `./` core imports):

```ts
import { recurringBlockingSignatures } from "./signature-recurrence.ts";
```

- [ ] **Step 4: Add the precondition after the stuck-signatures check**

In `src/core/loop-driver.ts`, immediately AFTER the `stuck-signatures` block (the one ending `Findings unchanged across ${stuckN} iterations.\`,\n      );\n    }`, ~line 909) and BEFORE the `if (state.iteration > 0) {` block, insert:

```ts
    // #5: per-signature recurrence — break the treadmill where ONE blocking finding
    // recurs amid a churning set (the whole-set stuck check above misses it). Fail-safe:
    // escalate (surface to the human), never suppress.
    const sigRecurCfg = this.i.config.loop.maxSignatureRecurrence;
    if (sigRecurCfg > 0) {
      // Clamp strictly above the (clamped) whole-set stuck threshold so a total stall
      // always escalates faster via stuck-signatures and a low mis-config can't make
      // per-signature the eager dominant trigger.
      const stuckClamp = Math.max(2, this.i.config.loop.stuckThreshold);
      const sigRecurThreshold = Math.max(sigRecurCfg, stuckClamp + 1);
      // Off-ramp grace: exclude signatures the agent rejected (reviewer_was_wrong) in
      // the just-completed iteration — pending.json still lists them as CRITICAL/WARN,
      // but cycleRejected will demote them on the NEXT panel run; escalating here would
      // preempt the off-ramp. (A persistently-rejected-yet-blocking finding is surfaced
      // by reviewer-fp-streak instead.)
      const justRejected = new Set(priorIterationRejectedSignatures(this.i.repoRoot, state.iteration));
      const blocking = new Set(
        readPendingReport(this.i.repoRoot)
          .findings.filter((f) => f.severity === "CRITICAL" || f.severity === "WARN")
          .map((f) => f.signature)
          .filter((s) => !justRejected.has(s)),
      );
      const recurring = recurringBlockingSignatures(
        state.signature_history,
        blocking,
        sigRecurThreshold,
      );
      if (recurring.length > 0) {
        return this.escalateAndDecide(
          state,
          "signature-recurrence",
          `${recurring.length} blocking finding(s) recurred across ${sigRecurThreshold} consecutive reviews without resolving (e.g. \`${recurring[0]}\`). To converge: fix each definitively, or — if it is a false positive — reject it (reviewer_was_wrong) so it is suppressed on recurrence. Further edits spawn fresh reviews and prolong the loop.`,
          true,
        );
      }
    }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test tests/unit/loop-driver-signature-recurrence.test.ts --timeout 20000`
Expected: PASS (5 tests).

- [ ] **Step 6: Typecheck + lint + commit**

```bash
bunx tsc --noEmit && bun run lint
git add src/core/loop-driver.ts tests/unit/loop-driver-signature-recurrence.test.ts
git commit -m "feat(#5): per-signature recurrence escalation (off-ramp grace + threshold clamp)"
```

If `bun run lint` flags formatting, run `bun run format`, re-run `bun run lint` to confirm clean, then commit.

---

## Task 4: off-ramp tip in the pending.md "Required actions"

**Files:**
- Modify: `src/core/report-writer.ts` (`renderMd`, the gate-mode `actions` block ~line 177-190)
- Test: `tests/unit/report-writer-offramp.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/report-writer-offramp.test.ts`:

```ts
// tests/unit/report-writer-offramp.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReportWriter } from "../../src/core/report-writer.ts";
import type { PendingReport } from "../../src/schemas/pending-report.ts";

function report(iter: number): PendingReport {
  return {
    schema: "reviewgate.pending.v1", run_id: "r1", iter, max_iter: 10, verdict: "FAIL",
    counts: { critical: 1, warn: 0, info: 0 },
    reviewers: [{ id: "codex", provider: "codex", model: "m", persona: "security", status: "ok", cost_usd: 0, duration_ms: 1 }],
    findings: [], cost_usd_total: 0, duration_ms_total: 1, generated_at: "2026-06-17T00:00:00Z",
    git: { sha: "abc1234", branch: "main", dirty_files: [] },
  };
}

describe("report-writer off-ramp tip (#5)", () => {
  it("renders the converging tip from iteration 2 onward (gate mode)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-offramp-"));
    await new ReportWriter(dir).write(report(2));
    const md = readFileSync(join(dir, ".reviewgate", "pending.md"), "utf8");
    expect(md).toContain("Converging tip");
    expect(md).toContain("reviewer_was_wrong");
  });

  it("omits the tip on iteration 1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-offramp1-"));
    await new ReportWriter(dir).write(report(1));
    const md = readFileSync(join(dir, ".reviewgate", "pending.md"), "utf8");
    expect(md).not.toContain("Converging tip");
  });

  it("omits the tip in one-shot mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-offramp-os-"));
    await new ReportWriter(dir).write(report(2), { mode: "one-shot" });
    const md = readFileSync(join(dir, ".reviewgate", "plan-review.md"), "utf8");
    expect(md).not.toContain("Converging tip");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/unit/report-writer-offramp.test.ts`
Expected: FAIL — the first test fails (no "Converging tip"); the others pass.

- [ ] **Step 3: Add the tip to the `actions` block**

In `src/core/report-writer.ts` `renderMd`, the `actions` const is built only when `mode !== "one-shot"` (the `: [ ... ]` array). Append the tip to that array, conditional on `r.iter >= 2`. Change the closing of the gate-mode actions array from:

```ts
          "Reviewgate refuses to unblock until every CRITICAL/WARN finding ID has a decision.",
          "",
        ];
```

to:

```ts
          "Reviewgate refuses to unblock until every CRITICAL/WARN finding ID has a decision.",
          "",
          // #5: converging off-ramp — surfaced once the loop is iterating, to break the
          // treadmill where re-editing spawns fresh reviews instead of converging.
          ...(r.iter >= 2
            ? [
                `> ⤷ **Converging tip (iteration ${r.iter}):** prefer fixing a finding definitively or rejecting it (reviewer_was_wrong) over adding new code — each new edit spawns a fresh review and can prolong this loop. A finding you reject as a false positive is suppressed if it recurs.`,
                "",
              ]
            : []),
        ];
```

(`actions` is `[]` in one-shot mode, so the tip never renders there. `r.iter` is on the report.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/unit/report-writer-offramp.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + lint + commit**

```bash
bunx tsc --noEmit && bun run lint
git add src/core/report-writer.ts tests/unit/report-writer-offramp.test.ts
git commit -m "feat(#5): converging off-ramp tip in pending.md from iteration 2"
```

---

## Task 5: Full-suite regression + DoD

**Files:** none (verification only).

- [ ] **Step 1: Full unit suite**

Run: `bun test tests/unit --timeout 20000`
Expected: all green (baseline ~1832 + the new tests). Watch existing `loop-driver*.test.ts` and `report-writer*.test.ts` — the new precondition runs on every gate turn (with default `maxSignatureRecurrence 3`), so confirm no existing escalation test regressed (most seed ≤3 history rows or a stuck/max-iter scenario that escalates first).

- [ ] **Step 2: Typecheck + lint (final)**

Run: `bunx tsc --noEmit && bun run lint`
Expected: both clean.

- [ ] **Step 3: No commit** — verification only. Proceed to the DoD review chain (codex, opus whole-branch) before merge.

---

## Self-review notes (spec coverage)

- `recurringBlockingSignatures` pure helper (last-K rows, empty-row breaks streak, sorted/unique, guards) → Task 1 + tests. ✓
- `EscalationReason "signature-recurrence"` (block-once via NOT-in-ALLOW_STOP) + `loop.maxSignatureRecurrence` (default 3) → Task 2. ✓
- loop-driver precondition: blocking-only via pending.json; off-ramp grace (exclude just-rejected); threshold clamp `> stuckThreshold`; `deferableOnQuota: true` (#10) → Task 3 + tests (escalate / below-K / INFO-only / off-ramp-grace / cap-0). ✓
- Fail-safe: only `escalateAndDecide` (surface to human), never suppress; existing maxIter/hardCap remain → Task 3 placement. ✓
- Off-ramp tip (render-only, iter≥2, gate-mode) → Task 4 + tests. ✓
