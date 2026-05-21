# M5 Phase A — Diff-Scoping + Decisions-Gate Severity Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop false positives on UNCHANGED code from blocking the gate: demote findings outside the changed hunks to INFO (advisory, visible), and stop the decisions-gate from demanding decisions for advisory (INFO) findings.

**Architecture:** A new deterministic aggregator stage `scopeToDiff` demotes findings whose `[line_start,line_end]` range does not overlap any changed hunk to `severity:"INFO"` + `scope_demoted:true` (never drops — cross-impact stays visible). A new hunk parser (`src/diff/hunks.ts`) turns the working-tree diff into per-file changed-line ranges. `LoopDriver.previousFindingIds()` is narrowed to CRITICAL/WARN so demoted findings no longer require a decision. The reviewer preamble is tightened and the report renders demoted findings in a separate advisory section.

**Tech Stack:** Bun + TypeScript, zod schemas, `bun test`, biome. Run `export PATH="$HOME/.bun/bin:$PATH"` first. This plan runs in a git worktree (create via superpowers:using-git-worktrees before starting).

---

## File structure

- **Create** `src/diff/hunks.ts` — `parseChangedRanges(diff)` + `rangeOverlapsChanged(...)`. Pure functions, no I/O.
- **Create** `tests/unit/hunks.test.ts` — parser + overlap unit tests.
- **Modify** `src/schemas/finding.ts` — add optional `scope_demoted`.
- **Modify** `src/core/aggregator.ts` — extend `AggregateInput`; add the `scopeToDiff` stage between critic-demote and the counts/verdict loop.
- **Modify** `tests/unit/aggregator.test.ts` (or a new `tests/unit/aggregator-scope.test.ts`) — scopeToDiff stage tests.
- **Modify** `src/core/loop-driver.ts` — `previousFindingIds()` filters to CRITICAL/WARN.
- **Modify** `tests/unit/loop-driver.test.ts` — gate-severity test.
- **Modify** `src/config/define-config.ts` — `phases.review.scopeToDiff` (default true).
- **Modify** `src/core/orchestrator.ts` — parse diff → pass `changedRanges` + `scopeToDiff` into `aggregate()`; tighten the review preamble.
- **Modify** `src/core/report-writer.ts` — advisory section + decision-instruction wording.

---

## Task 1: `Finding.scope_demoted` schema field

**Files:**
- Modify: `src/schemas/finding.ts`
- Test: `tests/unit/finding-schema.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/finding-schema.test.ts
import { describe, expect, it } from "bun:test";
import { FindingSchema } from "../../src/schemas/finding.ts";

const base = {
  id: "F-001", signature: "s", severity: "INFO", category: "quality",
  rule_id: "r", file: "a.ts", line_start: 1, line_end: 1,
  message: "m", details: "d",
  reviewer: { provider: "codex", model: "x", persona: "security" },
  confidence: 0.5, consensus: "singleton",
};

describe("FindingSchema scope_demoted", () => {
  it("accepts scope_demoted:true and defaults to absent", () => {
    expect(FindingSchema.parse({ ...base, scope_demoted: true }).scope_demoted).toBe(true);
    expect(FindingSchema.parse(base).scope_demoted).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/finding-schema.test.ts`
Expected: FAIL — `scope_demoted` is stripped/undefined when set to true (field not in schema) OR the assertion `toBe(true)` fails.

- [ ] **Step 3: Add the field**

In `src/schemas/finding.ts`, inside `FindingSchema = z.object({ ... })`, add alongside `critic_verdict`:

```typescript
  // M5 Part A: set true when the aggregator demoted this finding to INFO because
  // its range falls outside the changed hunks (advisory, non-blocking).
  scope_demoted: z.boolean().optional(),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/finding-schema.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/schemas/finding.ts tests/unit/finding-schema.test.ts
git commit -m "feat(schema): add Finding.scope_demoted for M5 diff-scoping"
```

---

## Task 2: Hunk-range parser (`src/diff/hunks.ts`)

**Files:**
- Create: `src/diff/hunks.ts`
- Test: `tests/unit/hunks.test.ts`

The parser turns `collectDiff()` output (concatenated `git diff HEAD` + per-file `git diff --no-index /dev/null <file>` streams) into a map of **repo-relative file path → array of `[startLine, endLineExclusive)` new-file ranges**. New files get full coverage naturally (their hunk is `@@ -0,0 +1,N @@`). Deletion-only hunks (`+c,0`) and deleted files (`+++ /dev/null`) contribute no ranges.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/hunks.test.ts
import { describe, expect, it } from "bun:test";
import { parseChangedRanges, rangeOverlapsChanged } from "../../src/diff/hunks.ts";

const MODIFY = [
  "diff --git a/src/lib/foo.ts b/src/lib/foo.ts",
  "index 111..222 100644",
  "--- a/src/lib/foo.ts",
  "+++ b/src/lib/foo.ts",
  "@@ -10,3 +10,4 @@ export function foo() {",
  " context",
  "+added line",
  " context",
  "@@ -40,0 +41,2 @@ other",
  "+two",
  "+lines",
].join("\n");

const NEWFILE = [
  "diff --git a/new.ts b/new.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/new.ts",
  "@@ -0,0 +1,3 @@",
  "+a",
  "+b",
  "+c",
].join("\n");

const DELETED = [
  "diff --git a/gone.ts b/gone.ts",
  "deleted file mode 100644",
  "--- a/gone.ts",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-x",
  "-y",
].join("\n");

describe("parseChangedRanges", () => {
  it("collects multi-hunk new-file ranges, repo-relative, stripping b/ prefix", () => {
    const m = parseChangedRanges(MODIFY);
    expect(m.get("src/lib/foo.ts")).toEqual([[10, 14], [41, 43]]);
  });
  it("covers all lines of an added file", () => {
    expect(parseChangedRanges(NEWFILE).get("new.ts")).toEqual([[1, 4]]);
  });
  it("yields no ranges for a deleted file (new-side /dev/null)", () => {
    expect(parseChangedRanges(DELETED).has("gone.ts")).toBe(false);
  });
  it("ignores deletion-only hunks (+c,0)", () => {
    const d = [
      "diff --git a/x.ts b/x.ts", "--- a/x.ts", "+++ b/x.ts",
      "@@ -5,2 +5,0 @@", "-gone1", "-gone2",
    ].join("\n");
    expect(parseChangedRanges(d).get("x.ts") ?? []).toEqual([]);
  });
  it("parses concatenated diff streams (HEAD diff + untracked --no-index)", () => {
    expect(parseChangedRanges(`${MODIFY}\n${NEWFILE}`).size).toBe(2);
  });
});

describe("rangeOverlapsChanged", () => {
  const ranges = [[10, 14], [41, 43]] as Array<[number, number]>;
  it("true when the finding range intersects a changed range", () => {
    expect(rangeOverlapsChanged(11, 11, ranges)).toBe(true); // inside
    expect(rangeOverlapsChanged(8, 12, ranges)).toBe(true);  // declaration above, body overlaps
    expect(rangeOverlapsChanged(42, 42, ranges)).toBe(true); // second hunk
  });
  it("false when entirely outside every changed range", () => {
    expect(rangeOverlapsChanged(20, 25, ranges)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/unit/hunks.test.ts`
Expected: FAIL — module `src/diff/hunks.ts` not found.

- [ ] **Step 3: Implement the parser**

```typescript
// src/diff/hunks.ts
// Parse a unified diff (collectDiff output: git diff HEAD + per-file
// `git diff --no-index /dev/null <file>` streams) into per-file changed
// NEW-file line ranges. Pure, no I/O. Used by the M5 scopeToDiff aggregator stage.

export type Range = [start: number, endExclusive: number];

// Strip a leading a// b/ prefix from a diff path; "/dev/null" stays as-is.
function stripPrefix(path: string): string {
  if (path === "/dev/null") return path;
  return path.replace(/^[ab]\//, "");
}

// Parse the `+++ ` header path, tolerating quotes and the b/ prefix.
function plusPath(line: string): string {
  let p = line.slice(4).trim(); // after "+++ "
  if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
  return stripPrefix(p);
}

export function parseChangedRanges(diff: string): Map<string, Range[]> {
  const out = new Map<string, Range[]>();
  let currentFile: string | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const p = plusPath(line);
      currentFile = p === "/dev/null" ? null : p; // deleted file → no new-side
      if (currentFile && !out.has(currentFile)) out.set(currentFile, []);
      continue;
    }
    if (line.startsWith("@@") && currentFile) {
      // @@ -a,b +c,d @@   (d omitted → 1). New-file changed lines = [c, c+d).
      const m = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (!m) continue;
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      if (count > 0) (out.get(currentFile) as Range[]).push([start, start + count]);
    }
  }
  return out;
}

// True if [lineStart, lineEnd] intersects any changed range.
export function rangeOverlapsChanged(
  lineStart: number,
  lineEnd: number,
  ranges: Range[],
): boolean {
  const lo = Math.min(lineStart, lineEnd);
  const hi = Math.max(lineStart, lineEnd);
  return ranges.some(([s, e]) => lo < e && hi >= s);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/unit/hunks.test.ts`
Expected: PASS (all 7 tests).

- [ ] **Step 5: typecheck + lint + commit**

```bash
bun run typecheck && bun run lint
git add src/diff/hunks.ts tests/unit/hunks.test.ts
git commit -m "feat(diff): add hunk-range parser for M5 diff-scoping"
```

---

## Task 3: `scopeToDiff` aggregator stage

**Files:**
- Modify: `src/core/aggregator.ts`
- Test: `tests/unit/aggregator-scope.test.ts` (create)

Insert the stage in `aggregate()` between the critic-demote loop (which builds `survivors`) and the counts/verdict loop. It only runs when `input.scopeToDiff !== false` AND `input.changedRanges` is provided.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/aggregator-scope.test.ts
import { describe, expect, it } from "bun:test";
import { aggregate } from "../../src/core/aggregator.ts";
import type { Finding } from "../../src/schemas/finding.ts";

function f(over: Partial<Finding>): Finding {
  return {
    id: "F", signature: `${over.file}:${over.line_start}`, severity: "CRITICAL",
    category: "security", rule_id: "r", file: "a.ts", line_start: 5, line_end: 5,
    message: "m", details: "d",
    reviewer: { provider: "codex", model: "x", persona: "security" },
    confidence: 0.9, consensus: "unanimous",
    ...over,
  } as Finding;
}

describe("aggregate scopeToDiff", () => {
  const changedRanges = new Map([["a.ts", [[10, 14]] as Array<[number, number]>]]);

  it("keeps a finding whose range overlaps a changed hunk", () => {
    const r = aggregate({
      findings: [f({ line_start: 11, line_end: 11 })],
      reviewersTotal: 1, changedRanges, scopeToDiff: true,
    });
    expect(r.dedupedFindings[0]?.severity).toBe("CRITICAL");
    expect(r.dedupedFindings[0]?.scope_demoted).toBeUndefined();
    expect(r.verdict).toBe("FAIL");
  });

  it("demotes an out-of-diff finding to INFO (advisory) and does not FAIL", () => {
    const r = aggregate({
      findings: [f({ line_start: 50, line_end: 50 })],
      reviewersTotal: 1, changedRanges, scopeToDiff: true,
    });
    expect(r.dedupedFindings[0]?.severity).toBe("INFO");
    expect(r.dedupedFindings[0]?.scope_demoted).toBe(true);
    expect(r.verdict).not.toBe("FAIL");
  });

  it("keeps findings when scopeToDiff is false", () => {
    const r = aggregate({
      findings: [f({ line_start: 50, line_end: 50 })],
      reviewersTotal: 1, changedRanges, scopeToDiff: false,
    });
    expect(r.dedupedFindings[0]?.severity).toBe("CRITICAL");
  });

  it("keeps a finding on a file not present in changedRanges (conservative)", () => {
    const r = aggregate({
      findings: [f({ file: "other.ts", line_start: 99 })],
      reviewersTotal: 1, changedRanges, scopeToDiff: true,
    });
    expect(r.dedupedFindings[0]?.severity).toBe("CRITICAL");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/unit/aggregator-scope.test.ts`
Expected: FAIL — `aggregate` does not accept `changedRanges`/`scopeToDiff` and does not demote.

- [ ] **Step 3: Extend `AggregateInput` + add the stage**

In `src/core/aggregator.ts`, add the import and extend the input type:

```typescript
import { type Range, rangeOverlapsChanged } from "../diff/hunks.ts";
```

```typescript
export interface AggregateInput {
  findings: Finding[];
  reviewersTotal: number;
  critic?: Map<string, CriticVerdict>;
  // M5 Part A: per-file changed new-file line ranges. When provided and
  // scopeToDiff !== false, findings outside the changed hunks are demoted to INFO.
  changedRanges?: Map<string, Range[]>;
  scopeToDiff?: boolean;
}
```

Then, immediately AFTER the `survivors` array is fully built (the critic-demote `for (const f of deduped)` loop) and BEFORE the `let critical = 0; ...` counts/verdict loop, insert:

```typescript
  // M5 Part A — diff-scoping: demote findings outside the changed hunks to INFO
  // (advisory, never dropped). Cross-impact stays visible; only the BLOCKING
  // weight is removed. Range intersection (not line_start alone) so a finding
  // anchored to a declaration above the edit but overlapping it is kept.
  const scoped =
    input.scopeToDiff !== false && input.changedRanges
      ? survivors.map((f) => {
          if (!f.line_start) return f; // no usable line → keep (conservative)
          const ranges = input.changedRanges?.get(f.file);
          if (!ranges) return f; // file not in diff → keep (conservative)
          if (rangeOverlapsChanged(f.line_start, f.line_end ?? f.line_start, ranges)) return f;
          if (f.severity === "INFO") return { ...f, scope_demoted: true };
          return {
            ...f,
            severity: "INFO" as const,
            scope_demoted: true,
            details: `${f.details}\n\n↓ outside the changed lines — advisory only.`,
          };
        })
      : survivors;
```

Then change the counts/verdict loop and the final `renumbered` to read from `scoped` instead of `survivors` (replace `for (const f of survivors)` → `for (const f of scoped)`, and `survivors.map(...)` in the renumber → `scoped.map(...)`).

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/unit/aggregator-scope.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the full aggregator suite (no regressions)**

Run: `bun test tests/unit/aggregator.test.ts && bun run typecheck && bun run lint`
Expected: PASS / clean.

- [ ] **Step 6: Commit**

```bash
git add src/core/aggregator.ts tests/unit/aggregator-scope.test.ts
git commit -m "feat(aggregator): scopeToDiff stage demotes out-of-diff findings to INFO"
```

---

## Task 4: Wire diff-scoping into the orchestrator

**Files:**
- Modify: `src/core/orchestrator.ts:425` (the `aggregate({...})` call)
- Test: covered by Task 6 (config default) + the existing orchestrator integration tests; add a focused assertion below.

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/aggregator-scope.test.ts` a test that the orchestrator passes ranges. Simplest: an integration check in `tests/integration/` is heavy; instead assert via a thin helper. If an orchestrator test fixture exists (`tests/integration/pipeline*.test.ts`), add: a code diff touching only line N, a reviewer stub flagging line N+100 → finding ends up INFO + `scope_demoted` in the written `pending.json`. If no such harness exists, SKIP this test step and rely on Task 3 unit coverage + the real e2e in the spec; note that in the commit.

- [ ] **Step 2: Modify the aggregate call**

In `src/core/orchestrator.ts`, before the `aggregate({...})` call at ~line 425, add:

```typescript
    const changedRanges = parseChangedRanges(this.input.diff);
```

and import at the top:

```typescript
import { parseChangedRanges } from "../diff/hunks.ts";
```

Then extend the call:

```typescript
    const agg = aggregate({
      findings: allFindings,
      reviewersTotal: okRuns.length,
      changedRanges,
      scopeToDiff: this.input.config.phases.review.scopeToDiff,
      ...(criticMap ? { critic: criticMap } : {}),
    });
```

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: clean (after Task 6 adds `scopeToDiff` to the config type; if running before Task 6, expect a type error on `phases.review.scopeToDiff` — do Task 6 first or together).

- [ ] **Step 4: Commit (with Task 6)**

Commit together with Task 6 so the type resolves.

---

## Task 5: Config — `phases.review.scopeToDiff` (default true)

**Files:**
- Modify: `src/config/define-config.ts:36` (inside `phases.review`)
- Test: `tests/unit/config*.test.ts` (add a case) or `tests/unit/config-scope.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/config-scope.test.ts
import { describe, expect, it } from "bun:test";
import { ConfigSchema } from "../../src/config/define-config.ts";

describe("config scopeToDiff", () => {
  it("defaults scopeToDiff to true when absent", () => {
    const c = ConfigSchema.parse({
      providers: {}, phases: { review: { reviewers: [{ provider: "codex", persona: "security" }] } },
    });
    expect(c.phases.review.scopeToDiff).toBe(true);
  });
  it("honors an explicit false", () => {
    const c = ConfigSchema.parse({
      providers: {},
      phases: { review: { reviewers: [{ provider: "codex", persona: "security" }], scopeToDiff: false } },
    });
    expect(c.phases.review.scopeToDiff).toBe(false);
  });
});
```

(If `ConfigSchema.parse` requires more required fields, copy the minimal valid object from the existing `tests/unit/config*.test.ts`.)

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/unit/config-scope.test.ts`
Expected: FAIL — `scopeToDiff` is `undefined` (not in schema).

- [ ] **Step 3: Add the field**

In `src/config/define-config.ts`, inside `review: z.object({ ... })`, after `fileContextBudgetBytes`:

```typescript
      // M5 Part A: demote findings outside the changed hunks to INFO (advisory).
      // Default ON — the gate primarily reviews the change.
      scopeToDiff: z.boolean().default(true),
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/unit/config-scope.test.ts && bun run typecheck`
Expected: PASS / clean (and Task 4's orchestrator reference now type-checks).

- [ ] **Step 5: Commit (Task 4 + Task 5 together)**

```bash
git add src/config/define-config.ts src/core/orchestrator.ts tests/unit/config-scope.test.ts
git commit -m "feat(config): phases.review.scopeToDiff (default on) + wire into orchestrator"
```

---

## Task 6: Decisions-gate — require decisions only for CRITICAL/WARN

**Files:**
- Modify: `src/core/loop-driver.ts` (`previousFindingIds`)
- Test: `tests/unit/loop-driver.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/loop-driver.test.ts` (uses the existing `fakeRepo`, `writeDirty`, `pendingJsonPath`, imports already present):

```typescript
  it("decisions-gate ignores INFO/scope_demoted findings (only CRITICAL/WARN need decisions)", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQGATEINFO");
    await state.update((cur) => ({ ...cur, iteration: 1 }));
    writeDirty(repo);
    // Prior report: one blocking WARN (needs a decision) + one demoted INFO (must NOT).
    writeFileSync(
      pendingJsonPath(repo),
      JSON.stringify({
        findings: [
          { id: "F-001", severity: "WARN" },
          { id: "F-002", severity: "INFO", scope_demoted: true },
        ],
      }),
    );
    const dpath = decisionsPath(repo, 1);
    mkdirSync(dirname(dpath), { recursive: true });
    // Only F-001 (the WARN) is addressed; F-002 (INFO) is not.
    writeFileSync(
      dpath,
      `${JSON.stringify({ schema: "reviewgate.decision.v1", finding_id: "F-001", verdict: "accepted", action: "fixed" })}\n`,
    );
    const audit = new AuditLogger(auditDir(repo));
    const driver = new LoopDriver({
      repoRoot: repo, config: defaultConfig, state, audit,
      orchestrator: new Orchestrator({
        repoRoot: repo, config: defaultConfig,
        adapters: { codex: new CodexAdapter({ binPath: FAKE_CODEX }) },
        sandboxMode: "off", hostTier: "opus", diff: DOC_DIFF, reasonOnFailEnabled: true,
      }),
      stopHookActive: false,
    });
    const decision = await driver.run();
    // F-001 addressed + F-002 (INFO) not required → gate proceeds to re-review (allow_stop on DOC_DIFF PASS).
    expect(decision.kind).toBe("allow_stop");
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/unit/loop-driver.test.ts -t "ignores INFO"`
Expected: FAIL — current `previousFindingIds` returns both ids; F-002 has no decision → gate blocks ("not yet addressed") → `decision.kind === "block"`.

- [ ] **Step 3: Filter to blocking severities**

In `src/core/loop-driver.ts`, change `previousFindingIds`:

```typescript
function previousFindingIds(repoRoot: string): string[] {
  const p = pendingJsonPath(repoRoot);
  if (!existsSync(p)) return [];
  try {
    const report = JSON.parse(readFileSync(p, "utf8")) as {
      findings?: Array<{ id?: string; severity?: string }>;
    };
    if (!Array.isArray(report.findings)) return [];
    // Only CRITICAL/WARN findings are blocking and therefore require a decision.
    // INFO (incl. scope_demoted / fp_ledger_match.suppressed advisories) never
    // blocks the verdict, so demanding a decision for it would defeat M5's
    // demote-to-INFO mechanism.
    return report.findings
      .filter((f) => f.severity === "CRITICAL" || f.severity === "WARN")
      .map((f) => f.id)
      .filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run to verify it passes + no regressions**

Run: `bun test tests/unit/loop-driver.test.ts && bun run typecheck`
Expected: PASS (15+ existing loop-driver tests still pass — they use CRITICAL/WARN findings).

- [ ] **Step 5: Commit**

```bash
git add src/core/loop-driver.ts tests/unit/loop-driver.test.ts
git commit -m "fix(loop-driver): require decisions only for blocking (CRITICAL/WARN) findings"
```

---

## Task 7: Tighten the reviewer preamble

**Files:**
- Modify: `src/core/orchestrator.ts` (`REVIEW_PROMPT_PREAMBLE`, ~line 64)
- Test: `tests/unit/review-output-schema.test.ts` style is structural; add a small assertion on the preamble constant if a prompt test exists, else verify by reading.

- [ ] **Step 1: Add the scope sentence**

In `REVIEW_PROMPT_PREAMBLE` (the joined string array in `src/core/orchestrator.ts`), after the existing "Full content of every changed file is provided…" / "Before reporting any symbol as undefined…" lines, add:

```typescript
  "Report issues INTRODUCED OR AFFECTED BY THIS diff. Pre-existing issues in",
  "unchanged code (outside the changed lines) are out of scope — do not report them.",
```

- [ ] **Step 2: Typecheck + commit**

Run: `bun run typecheck && bun run lint`

```bash
git add src/core/orchestrator.ts
git commit -m "feat(orchestrator): tighten reviewer preamble to scope findings to the diff"
```

---

## Task 8: Report-writer — advisory section + decision wording

**Files:**
- Modify: `src/core/report-writer.ts` (`renderMd`, lines ~37-85)
- Test: `tests/unit/report-writer*.test.ts` (add a case) or `tests/unit/report-writer-advisory.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/report-writer-advisory.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReportWriter } from "../../src/core/report-writer.ts";
import { pendingMdPath } from "../../src/utils/paths.ts";

function finding(over: Record<string, unknown>) {
  return {
    id: "F-001", signature: "s", severity: "INFO", category: "quality", rule_id: "r",
    file: "a.ts", line_start: 1, line_end: 1, message: "m", details: "d",
    reviewer: { provider: "codex", model: "x", persona: "security" },
    confidence: 0.5, consensus: "singleton", ...over,
  };
}

describe("renderMd advisory section", () => {
  it("renders scope_demoted findings under an Advisory heading, not the decision flow", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-rw-"));
    const w = new ReportWriter(repo);
    await w.write({
      schema: "reviewgate.pending.v1", run_id: "r", iter: 1, max_iter: 3,
      verdict: "FAIL", counts: { critical: 1, warn: 0, info: 1 },
      reviewers: [], critic: null, cost_usd_total: 0, duration_ms_total: 0,
      generated_at: "t", git: { sha: "0", branch: "main", dirty_files: [] },
      findings: [
        finding({ id: "F-001", severity: "CRITICAL", scope_demoted: undefined }),
        finding({ id: "F-002", severity: "INFO", scope_demoted: true }),
      ],
    } as never, "gate");
    const md = readFileSync(pendingMdPath(repo), "utf8");
    expect(md).toContain("Advisory");           // advisory section present
    expect(md).toMatch(/F-002/);                // demoted finding listed there
    // The decision instruction must scope to blocking findings only.
    expect(md).toMatch(/CRITICAL.{0,40}WARN|blocking/i);
  });
});
```

(Adjust the `write(...)` payload to the exact `PendingReport`/`writeReport` API in `report-writer.ts` — read the file to match the method name and required fields before finalizing this test.)

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/unit/report-writer-advisory.test.ts`
Expected: FAIL — no "Advisory" section; demoted INFO rendered in the normal INFO flow.

- [ ] **Step 3: Update `renderMd`**

In `src/core/report-writer.ts` `renderMd`:
- change the decision instruction (line ~60) from "For each finding below" to: ``For each CRITICAL/WARN finding below, append ONE line to `.reviewgate/decisions/${r.iter}.jsonl` (INFO/advisory findings need no decision):``
- split the findings rendering (lines ~81-85): partition into `blocking` (CRITICAL/WARN, not `scope_demoted`, not `fp_ledger_match?.suppressed`) and `advisory` (everything else). Render blocking under the existing CRITICAL/WARN/INFO headings, then render advisory under a new heading:

```typescript
  const isAdvisory = (f: Finding) =>
    f.severity === "INFO" || f.scope_demoted === true || f.fp_ledger_match?.suppressed === true;
  const blocking = r.findings.filter((f) => !isAdvisory(f));
  const advisory = r.findings.filter(isAdvisory);
  // ... render blocking by severity as before (using `blocking` instead of `r.findings`) ...
  if (advisory.length > 0) {
    sections.push(
      "## Advisory (out of scope / known FP — no decision needed) ·\n",
      ...advisory.map(fmtFinding),
    );
  }
```

- [ ] **Step 4: Run to verify it passes + no regressions**

Run: `bun test tests/unit/report-writer-advisory.test.ts && bun test tests/unit/report-writer*.test.ts && bun run typecheck && bun run lint`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/report-writer.ts tests/unit/report-writer-advisory.test.ts
git commit -m "feat(report-writer): advisory section + scope decision instruction to blocking findings"
```

---

## Task 9: Full-suite gate + real verification

- [ ] **Step 1: Full suite**

Run: `bun test && bun run typecheck && bun run lint`
Expected: all pass / clean.

- [ ] **Step 2: Compiled-binary smoke (per the real-verification rule)**

Build + confirm a real diff-scoped scenario in flashbuddy (after merge + rebuild): a change touching one function where a reviewer flags an unrelated function → that finding appears as INFO + `scope_demoted` in `pending.json`, in the pending.md Advisory section, and does NOT block. (This is the live e2e; do it after the worktree merges to master and the binary is rebuilt.)

- [ ] **Step 3: DoD review + merge**

Per CLAUDE.md Definition of Done: Codex + Claude review subagents (PASS = 0 CRITICAL/WARN), fix findings, re-review, `rm -rf .review/`, then FF-merge to master, rebuild the binary, delete the worktree.

---

## Self-review notes (spec coverage)
- Decisions-gate severity fix → Task 6. ✓
- Hunk parser (multi-hunk, /dev/null new/deleted, +c,0, header variants, path normalization) → Task 2. ✓
- `scopeToDiff` range-intersection demote + `scope_demoted` → Tasks 1, 3. ✓
- Config default-on → Task 5. ✓
- Orchestrator wiring → Task 4. ✓
- Prompt tightening → Task 7. ✓
- Report-writer advisory section + wording → Task 8. ✓
- Testing incl. real e2e → Task 9. ✓

Not in Phase A (later phases): FP-ledger schema/store/learn/apply, `Finding.members` provenance, few-shot, CLI, cache hash, brain coupling.
