# Field-Report Tier-1 Quick-Wins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the three deterministic noise/safety fixes from the flashbuddy field report — (1) drop reviewer findings that are about Reviewgate's own `<REDACTED:…>` placeholder, (2) demote security findings on test/fixture files to advisory, (3) warn early when a diff is large enough to risk a timeout.

**Architecture:** Three disjoint, additive, LLM-free changes. (1) and (2) are demote/drop passes inside `aggregate()` (`src/core/aggregator.ts`); (3) is a pure predicate in `src/cli/commands/gate.ts` plus a `pending.md` banner. No existing verdict logic changes — each slice only suppresses noise or adds a warning. Spec: `docs/superpowers/specs/2026-06-16-field-report-tier1-quickwins-design.md` (codex+opus PASS).

**Tech Stack:** Bun, TypeScript, zod schemas, `bun test`. Use `bun`/`bunx` — never npm/node.

---

## File Structure

- `src/core/aggregator.ts` — Slice 1 redaction drop (pre-cluster filter + `isRedactionArtifact` + `AggregateResult` fields); Slice 2 test-security demote pass.
- `src/schemas/finding.ts` — Slice 2 `test_severity_demoted` flag.
- `src/research/diff-facts.ts` — Slice 2: export `classify()`.
- `src/config/defaults.ts` + `src/config/define-config.ts` — Slice 2 `phases.review.demoteTestSecurity`; Slice 3 `loop.diffWarnBytes` / `loop.diffWarnFiles`.
- `src/schemas/pending-report.ts` — Slice 3 `large_diff` field.
- `src/core/report-writer.ts` — Slice 2 badge in `findingBadges()`; Slice 3 large-diff banner in `renderMd()`.
- `src/core/orchestrator.ts` — Slice 2 wire `demoteTestSecurity` into `AggregateInput`; Slice 3 `OrchestratorInput.largeDiff` + thread into `writeReport`.
- `src/cli/commands/gate.ts` — Slice 3 `computeLargeDiff()` helper + `console.warn` + pass `largeDiff` to `Orchestrator`.
- Tests: `tests/unit/aggregator-redaction-demote.test.ts`, `tests/unit/aggregator-test-severity.test.ts`, `tests/unit/diff-size-warning.test.ts`.

A reusable test Finding factory is shown once in Task 1 Step 1 and reused (copy it into each test file).

---

## Task 1: Slice 1 — Redaction-artifact demote

> **Implemented as DEMOTE-to-INFO, not DROP** (changed during the iteration-1 dogfood gate
> review — see the spec's Slice 1 UPDATE note). The pre-cluster step `map`s a matching finding to
> `severity:"INFO"` + `redaction_demoted:true` (instead of filtering it out), so a mis-worded real
> secret leak stays visible (fail-visible). No `redactionDropped` field on `AggregateResult`; a
> `redaction_demoted?: boolean` flag on `FindingSchema` + a `findingBadges()` entry instead. The
> steps below show the original drop wording for history; the committed code reflects the demote.

**Files:**
- Modify: `src/core/aggregator.ts` (AggregateResult interface ~65-74; top of `aggregate()` ~262-264; return ~669-675)
- Test: `tests/unit/aggregator-redaction-demote.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/aggregator-redaction-demote.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { aggregate } from "../../src/core/aggregator.ts";
import type { Finding } from "../../src/schemas/finding.ts";

// Minimal valid Finding factory — override per case.
function mkFinding(over: Partial<Finding> = {}): Finding {
  return {
    id: "F-001",
    signature: "sig-1",
    severity: "CRITICAL",
    category: "correctness",
    rule_id: "rule.x",
    file: "src/foo.ts",
    line_start: 10,
    line_end: 10,
    message: "a problem",
    details: "some details",
    reviewer: { provider: "codex", model: "m", persona: "security" },
    confidence: 0.9,
    consensus: "singleton",
    ...over,
  } as Finding;
}

describe("Slice 1: redaction-artifact drop", () => {
  test("drops a non-security finding whose message is the REDACTED placeholder", () => {
    const f = mkFinding({ message: "undefined variable <REDACTED:HIGH_ENTROPY>" });
    const r = aggregate({ findings: [f], reviewersTotal: 1 });
    expect(r.dedupedFindings).toHaveLength(0);
    expect(r.redactionDropped).toHaveLength(1);
    expect(r.redactionDroppedCount).toBe(1);
  });

  test("drops when REDACTED is only in suggested_fix (non-security, no lead word)", () => {
    const f = mkFinding({ message: "fix this", suggested_fix: "remove <REDACTED:HIGH_ENTROPY>" });
    const r = aggregate({ findings: [f], reviewersTotal: 1 });
    expect(r.dedupedFindings).toHaveLength(0);
    expect(r.redactionDroppedCount).toBe(1);
  });

  test("KEEPS a security finding mentioning REDACTED (gate 2: possible real leak)", () => {
    const f = mkFinding({ category: "security", message: "exposed value <REDACTED:HIGH_ENTROPY>" });
    const r = aggregate({ findings: [f], reviewersTotal: 1 });
    expect(r.dedupedFindings).toHaveLength(1);
    expect(r.redactionDroppedCount).toBe(0);
  });

  test("KEEPS a non-security finding whose message names a secret (gate 3 backstop)", () => {
    const f = mkFinding({ message: "Hardcoded api_key <REDACTED:HIGH_ENTROPY> committed" });
    const r = aggregate({ findings: [f], reviewersTotal: 1 });
    expect(r.dedupedFindings).toHaveLength(1);
    expect(r.redactionDroppedCount).toBe(0);
  });

  test("KEEPS when the secret lead word is only in suggested_fix (gate 3 scans both fields)", () => {
    const f = mkFinding({
      message: "remove this committed value <REDACTED:HIGH_ENTROPY>",
      suggested_fix: "delete the hardcoded api_key",
    });
    const r = aggregate({ findings: [f], reviewersTotal: 1 });
    expect(r.dedupedFindings).toHaveLength(1);
    expect(r.redactionDroppedCount).toBe(0);
  });

  test("KEEPS when REDACTED appears only in details (context, not subject)", () => {
    const f = mkFinding({ message: "a real bug", details: "near <REDACTED:HIGH_ENTROPY> here" });
    const r = aggregate({ findings: [f], reviewersTotal: 1 });
    expect(r.dedupedFindings).toHaveLength(1);
    expect(r.redactionDroppedCount).toBe(0);
  });

  test("a clean co-located finding is unaffected by a dropped one", () => {
    const dropped = mkFinding({ id: "F-001", message: "undefined <REDACTED:HIGH_ENTROPY>" });
    const clean = mkFinding({ id: "F-002", signature: "sig-2", message: "real bug", line_start: 11 });
    const r = aggregate({ findings: [dropped, clean], reviewersTotal: 1 });
    expect(r.dedupedFindings).toHaveLength(1);
    expect(r.dedupedFindings[0]?.message).toBe("real bug");
    expect(r.redactionDroppedCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/aggregator-redaction-demote.test.ts`
Expected: FAIL — `r.redactionDropped` is `undefined` (property does not exist yet) and findings are not dropped.

- [ ] **Step 3: Add the `redactionDropped` fields to `AggregateResult`**

In `src/core/aggregator.ts`, in the `AggregateResult` interface (after `criticDroppedCount: number;`, ~line 73), add:

```ts
  /** Slice 1: findings dropped pre-cluster as redaction artifacts (FP-by-construction —
   *  the reviewer mistook the sanitizer's <REDACTED:…> placeholder for code). Exposed for
   *  parity with criticDropped; pre-cluster, so they never reach pending.json/metrics. */
  redactionDropped: Finding[];
  redactionDroppedCount: number;
```

- [ ] **Step 4: Add the detector and the pre-cluster filter**

In `src/core/aggregator.ts`, add this module-level helper just above `export function aggregate(` (~line 256):

```ts
// Slice 1 (field report #1): a finding whose SUBJECT (message/suggested_fix) is
// Reviewgate's own <REDACTED:…> placeholder is a false positive by construction —
// the reviewer mistook the sanitizer's redaction for broken code. But the SAME
// placeholder also masks a genuinely committed secret (sanitizer HEX_SECRET_WITH_CONTEXT),
// so dropping blindly would fail-open a real leak. Two independent gates protect that:
// (2) keep anything categorized security; (3) keep anything whose subject names a secret
// (lead-word backstop — a superset of the sanitizer's own HEX_SECRET_WITH_CONTEXT lead
// words). Gate (3) scans the SAME fields gate (1) triggers on, so the backstop can never
// be narrower than the drop trigger. `category` alone is untrusted (reviewer-supplied);
// gate (3) is the trusted content backstop.
const SECRET_LEAD_WORD =
  /api[_-]?key|secret|token|passwo?r?d|pwd|auth|bearer|access[_-]?key|private[_-]?key|client[_-]?secret|credential|hardcoded/i;

function isRedactionArtifact(f: Finding): boolean {
  const fields = [f.message, f.suggested_fix ?? ""];
  if (!fields.some((s) => s.includes("<REDACTED:"))) return false; // gate 1: subject only
  if (f.category === "security") return false; // gate 2: possible real leak
  if (fields.some((s) => SECRET_LEAD_WORD.test(s))) return false; // gate 3: trusted backstop
  return true;
}
```

Then, at the very top of `aggregate()`, REPLACE the existing first statement:

```ts
  const findings = input.findings.map((f) =>
    f.file ? { ...f, file: normalizeRepoPath(f.file) } : f,
  );
```

with:

```ts
  // Slice 1: drop redaction-artifact findings BEFORE clustering so they never pollute
  // consensus / FP-ledger / reputation accounting. Pre-cluster + never surfaced =
  // invisible to pending.json and every metric.
  const redactionDropped: Finding[] = [];
  const kept = input.findings.filter((f) => {
    if (isRedactionArtifact(f)) {
      redactionDropped.push(f);
      return false;
    }
    return true;
  });
  const findings = kept.map((f) => (f.file ? { ...f, file: normalizeRepoPath(f.file) } : f));
```

- [ ] **Step 5: Add the fields to the returned object**

In `src/core/aggregator.ts`, in the final `return { ... }` of `aggregate()` (~669-675), after `criticDroppedCount: criticDropped.length,` add:

```ts
    redactionDropped,
    redactionDroppedCount: redactionDropped.length,
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test tests/unit/aggregator-redaction-demote.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 7: Typecheck + lint**

Run: `bunx tsc --noEmit && bun run lint`
Expected: clean (no errors).

- [ ] **Step 8: Commit**

```bash
git add src/core/aggregator.ts tests/unit/aggregator-redaction-demote.test.ts
git commit -m "feat(aggregator): drop redaction-artifact findings (field report #1)

Two-gate fail-safe: drop a finding whose message/suggested_fix is the
<REDACTED:...> placeholder ONLY when non-security AND no secret-leak lead
word in either field — so a real redacted-secret leak is never dropped."
```

---

## Task 2: Slice 2 — Test-file security-severity demote

**Files:**
- Modify: `src/research/diff-facts.ts:92` (export `classify`)
- Modify: `src/schemas/finding.ts` (after `scope_demoted`, ~81)
- Modify: `src/core/aggregator.ts` (import classify; AggregateInput; demote pass after repScoped ~606; count loop ~613; renumber ~664)
- Modify: `src/config/defaults.ts` (`phases.review`, after `scopeToDiff` ~70)
- Modify: `src/config/define-config.ts` (`review` object, after `scopeToDiff` ~72)
- Modify: `src/core/orchestrator.ts` (AggregateInput build ~1593)
- Modify: `src/core/report-writer.ts` (`findingBadges` ~44)
- Test: `tests/unit/aggregator-test-severity.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/aggregator-test-severity.test.ts` (reuse the `mkFinding` factory from Task 1 — copy it in):

```ts
import { describe, expect, test } from "bun:test";
import { aggregate } from "../../src/core/aggregator.ts";
import type { Finding } from "../../src/schemas/finding.ts";

function mkFinding(over: Partial<Finding> = {}): Finding {
  return {
    id: "F-001",
    signature: "sig-1",
    severity: "CRITICAL",
    category: "security",
    rule_id: "rule.x",
    file: "src/foo.test.ts",
    line_start: 10,
    line_end: 10,
    message: "weak password TempPass123!",
    details: "mocked return value",
    reviewer: { provider: "codex", model: "m", persona: "security" },
    confidence: 0.9,
    consensus: "singleton",
    ...over,
  } as Finding;
}

describe("Slice 2: test-file security demote", () => {
  test("demotes a security CRITICAL on a *.test.ts file to INFO", () => {
    const r = aggregate({ findings: [mkFinding()], reviewersTotal: 1, demoteTestSecurity: true });
    const f = r.dedupedFindings[0];
    expect(f?.severity).toBe("INFO");
    expect(f?.test_severity_demoted).toBe(true);
    expect(r.verdict).not.toBe("FAIL");
  });

  test("demotes a security finding under a tests/ directory", () => {
    const r = aggregate({
      findings: [mkFinding({ file: "tests/fixtures/auth.ts" })],
      reviewersTotal: 1,
      demoteTestSecurity: true,
    });
    expect(r.dedupedFindings[0]?.severity).toBe("INFO");
  });

  test("does NOT demote a correctness finding on a test file", () => {
    const r = aggregate({
      findings: [mkFinding({ category: "correctness" })],
      reviewersTotal: 1,
      demoteTestSecurity: true,
    });
    expect(r.dedupedFindings[0]?.severity).toBe("CRITICAL");
    expect(r.dedupedFindings[0]?.test_severity_demoted).toBeUndefined();
  });

  test("does NOT demote a security finding on a non-test file", () => {
    const r = aggregate({
      findings: [mkFinding({ file: "src/auth.ts" })],
      reviewersTotal: 1,
      demoteTestSecurity: true,
    });
    expect(r.dedupedFindings[0]?.severity).toBe("CRITICAL");
  });

  test("is a no-op when demoteTestSecurity is absent/false", () => {
    const r = aggregate({ findings: [mkFinding()], reviewersTotal: 1 });
    expect(r.dedupedFindings[0]?.severity).toBe("CRITICAL");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/aggregator-test-severity.test.ts`
Expected: FAIL — `demoteTestSecurity` is not a known input and no demote happens; security CRITICAL stays CRITICAL.

- [ ] **Step 3: Export `classify()`**

In `src/research/diff-facts.ts:92`, change:

```ts
function classify(path: string): FileKind {
```

to:

```ts
export function classify(path: string): FileKind {
```

- [ ] **Step 4: Add the `test_severity_demoted` schema flag**

In `src/schemas/finding.ts`, after the `scope_demoted: z.boolean().optional(),` line (~81), add:

```ts
  // Slice 2 (field report #9): set true when the aggregator demoted a SECURITY finding
  // to INFO because its file is a test/fixture (classify()==="tests") — a mocked secret /
  // weak password in a fixture is not a production vulnerability. Only category "security"
  // is demoted; correctness/other on a test file stay blocking. Advisory, non-blocking.
  test_severity_demoted: z.boolean().optional(),
```

- [ ] **Step 5: Wire `demoteTestSecurity` into `AggregateInput` + add the demote pass**

In `src/core/aggregator.ts`, add the import near the top (after the existing `import { ruleIdToken0 } ...` line ~9):

```ts
import { classify } from "../research/diff-facts.ts";
```

In the `AggregateInput` interface, after `demoteCorrectness?: boolean;` (~55), add:

```ts
  // Slice 2 (field report #9): when true, a SECURITY finding whose file classify()s as
  // "tests" is demoted to INFO (advisory). Only security; correctness/other stay. Absent/
  // false → no-op (production passes the config value, default true). Representative-keyed.
  demoteTestSecurity?: boolean;
```

Then insert the demote pass immediately AFTER the `repScoped` block ends (after its closing `: confScoped;` ~line 606) and BEFORE `let critical = 0;` (~608):

```ts
  // Slice 2 (field report #9): demote a SECURITY finding on a test/fixture file to INFO
  // (advisory). Representative-keyed — clustering is per-file (anchorFile), so members
  // share the file; a security member wording-merged under a non-security representative
  // simply stays at full severity (safe under-demote, never over-demote). Only category
  // "security"; correctness/other test-file findings stay blocking (a real test bug is a bug).
  const testScoped: Finding[] =
    input.demoteTestSecurity === true
      ? repScoped.map((f) => {
          if (f.category !== "security" || classify(f.file) !== "tests") return f;
          if (f.severity === "INFO") return { ...f, test_severity_demoted: true };
          const note =
            "\n\n↓ security finding on a test/fixture file — not production code; advisory only.";
          return {
            ...f,
            severity: "INFO" as const,
            test_severity_demoted: true,
            details: `${f.details.slice(0, 2000 - note.length)}${note}`,
          };
        })
      : repScoped;
```

- [ ] **Step 6: Point the verdict count + renumber at `testScoped`**

In `src/core/aggregator.ts`, change the count loop header (~613) from:

```ts
  for (const f of repScoped) {
```

to:

```ts
  for (const f of testScoped) {
```

And change the renumber (~664) from:

```ts
  const renumbered = repScoped.map((f, i) => ({
```

to:

```ts
  const renumbered = testScoped.map((f, i) => ({
```

- [ ] **Step 7: Add the config key (schema + default)**

In `src/config/define-config.ts`, in the `review: z.object({ ... })` block, after the `scopeToDiff: z.boolean().optional(),` line (~72), add:

```ts
      // Slice 2 (field report #9): demote security findings on test/fixture files to
      // INFO (advisory) — a mocked secret in a fixture isn't a prod vuln. Default ON via
      // defaults.ts. Set false for repos that ship production code under a tests/ path.
      demoteTestSecurity: z.boolean().optional(),
```

In `src/config/defaults.ts`, in `phases.review`, after the `scopeToDiff: true,` line (~70), add:

```ts
      demoteTestSecurity: true,
```

- [ ] **Step 8: Pass the config value into the aggregate() call**

In `src/core/orchestrator.ts`, in the `aggregate({ ... })` call (~1578), after the `demoteCorrectness: repCfg?.demoteCorrectness ?? true,` line (~1593), add:

```ts
      demoteTestSecurity: this.input.config.phases.review.demoteTestSecurity ?? true,
```

- [ ] **Step 9: Add the report badge**

In `src/core/report-writer.ts`, in `findingBadges()`, after the `if (f.scope_demoted) badges.push("📍 outside changed lines");` line (~44), add:

```ts
  if (f.test_severity_demoted)
    badges.push("📁 security finding on a test/fixture file — advisory");
```

- [ ] **Step 10: Run test to verify it passes**

Run: `bun test tests/unit/aggregator-test-severity.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 11: Typecheck + lint**

Run: `bunx tsc --noEmit && bun run lint`
Expected: clean.

- [ ] **Step 12: Commit**

```bash
git add src/core/aggregator.ts src/schemas/finding.ts src/research/diff-facts.ts src/config/defaults.ts src/config/define-config.ts src/core/orchestrator.ts src/core/report-writer.ts tests/unit/aggregator-test-severity.test.ts
git commit -m "feat(aggregator): demote security findings on test files (field report #9)

Only category=security on classify()=='tests' files → INFO advisory;
correctness/other stay blocking. Config phases.review.demoteTestSecurity
(default true). Badge in findingBadges()."
```

---

## Task 3: Slice 3 — Diff-size early warning

**Files:**
- Modify: `src/config/defaults.ts` (`loop`, after `runTimeoutMs` ~175)
- Modify: `src/config/define-config.ts` (`loop` object, after `runTimeoutMs` ~264)
- Modify: `src/schemas/pending-report.ts` (after `panel_note` ~38)
- Modify: `src/core/orchestrator.ts` (`OrchestratorInput` ~140; `writeReport` PendingReport build ~2053)
- Modify: `src/core/report-writer.ts` (`renderMd` head ~171)
- Modify: `src/cli/commands/gate.ts` (export `computeLargeDiff`; call after diff destructure ~562; pass to Orchestrator ~566)
- Test: `tests/unit/diff-size-warning.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/diff-size-warning.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { computeLargeDiff } from "../../src/cli/commands/gate.ts";

function diffWithFiles(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) {
    s += `diff --git a/f${i}.ts b/f${i}.ts\n@@ -1 +1 @@\n+x\n`;
  }
  return s;
}

describe("Slice 3: computeLargeDiff", () => {
  test("over byte threshold → returns counts", () => {
    const diff = `diff --git a/x.ts b/x.ts\n@@ -1 +1 @@\n+${"y".repeat(2000)}\n`;
    const r = computeLargeDiff(diff, 1000, 0);
    expect(r).not.toBeUndefined();
    expect(r?.bytes).toBeGreaterThan(1000);
    expect(r?.files).toBe(1);
  });

  test("over file threshold (under bytes) → returns counts via raw diff --git headers", () => {
    const diff = diffWithFiles(5);
    const r = computeLargeDiff(diff, 0, 3);
    expect(r?.files).toBe(5);
  });

  test("under both thresholds → undefined", () => {
    const r = computeLargeDiff(diffWithFiles(2), 1_000_000, 80);
    expect(r).toBeUndefined();
  });

  test("threshold 0 disables that check", () => {
    // 5 files but file-check disabled (0) and bytes huge → undefined
    const r = computeLargeDiff(diffWithFiles(5), 1_000_000, 0);
    expect(r).toBeUndefined();
  });

  test("rename/binary entries still counted by raw header (not hunk-filtered)", () => {
    const diff =
      "diff --git a/old.ts b/new.ts\nrename from old.ts\nrename to new.ts\n" +
      "diff --git a/bin b/bin\nBinary files a/bin and b/bin differ\n";
    const r = computeLargeDiff(diff, 0, 1);
    expect(r?.files).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/diff-size-warning.test.ts`
Expected: FAIL — `computeLargeDiff` is not exported from `gate.ts`.

- [ ] **Step 3: Add the config keys (schema + defaults)**

In `src/config/define-config.ts`, in `loop: z.object({ ... })`, after the `runTimeoutMs: z.number().int().nonnegative().default(720_000),` line (~264), add:

```ts
    // Slice 3 (field report #6): warn (stderr + pending.md banner) when the reviewed diff
    // is large enough to risk a self-deadline timeout. WARN-ONLY — never auto-raises
    // runTimeoutMs (that could exceed the OS Stop-hook timeout → fail-open). 0 disables a check.
    diffWarnBytes: z.number().int().nonnegative().default(600_000),
    diffWarnFiles: z.number().int().nonnegative().default(80),
```

In `src/config/defaults.ts`, in `loop`, after the `runTimeoutMs: 720_000,` line (~175), add:

```ts
    // Slice 3 (field report #6): warn when the diff is this large (bytes / file count).
    // WARN-only — see schema. 0 disables a check.
    diffWarnBytes: 600_000,
    diffWarnFiles: 80,
```

- [ ] **Step 4: Add the `large_diff` field to the pending-report schema**

In `src/schemas/pending-report.ts`, after the `panel_note: z.string().optional(),` line (~38), add:

```ts
  // Slice 3 (field report #6): counts for the large-diff warning banner. Present only when
  // the reviewed diff exceeded loop.diffWarnBytes/diffWarnFiles. Render-only; mirrors panel_note.
  large_diff: z
    .object({ files: z.number().int().nonnegative(), bytes: z.number().int().nonnegative() })
    .optional(),
```

- [ ] **Step 5: Add `largeDiff` to `OrchestratorInput` and thread it into `writeReport`**

In `src/core/orchestrator.ts`, in the `OrchestratorInput` interface, after the `diffIncomplete?: boolean;` line (~140), add:

```ts
  // Slice 3 (field report #6): set by the gate when the reviewed diff exceeded the
  // size-warning thresholds. Surfaced as a banner in pending.md (the stderr warning is
  // emitted in gate.ts, outside the loop self-deadline). Absent → no banner.
  largeDiff?: { files: number; bytes: number };
```

In `writeReport()`, in the object passed to `writer.write(` , after the `...(panelNote ? { panel_note: panelNote } : {}),` line (~2053), add:

```ts
        ...(this.input.largeDiff ? { large_diff: this.input.largeDiff } : {}),
```

- [ ] **Step 6: Render the banner in `report-writer.ts`**

In `src/core/report-writer.ts`, in `renderMd()`, after the `singleReviewerBanner` const block ends (~148) and before `const actions =` (~149), add:

```ts
  // Slice 3 (field report #6): large-diff warning. The matching stderr warning is emitted
  // in gate.ts (outside the loop self-deadline, so it survives a timeout-abort that writes
  // no report); this banner is the in-report copy with the remediation.
  const largeDiffBanner = r.large_diff
    ? [
        `> ⚠ **Large diff:** ${r.large_diff.files} files / ${Math.round(
          r.large_diff.bytes / 1000,
        )} KB. If the review times out, raise \`loop.runTimeoutMs\` in \`reviewgate.config.ts\` AND the Stop-hook \`timeout\` in \`.claude/settings.json\` — both, or the OS kills the hook before Reviewgate's deadline and the turn ends un-reviewed (fail-open).`,
        "",
      ]
    : [];
```

Then in the `head` array, after the `...singleReviewerBanner,` line (~171), add:

```ts
    ...largeDiffBanner,
```

- [ ] **Step 7: Add `computeLargeDiff` + the warning to `gate.ts`**

In `src/cli/commands/gate.ts`, add this exported helper near the top-level helpers (e.g. just after the imports / near `diffMarkedIncomplete`):

```ts
// Slice 3 (field report #6): pure predicate for the large-diff warning. Counts FILES via
// raw `diff --git ` headers — NOT computeDiffFacts (which filters renames/binary/mode-only
// and would undercount operational diff size). Bytes via UTF-8 length. A threshold of 0
// disables that check. Returns the counts when over either limit, else undefined.
export function computeLargeDiff(
  diff: string,
  diffWarnBytes: number,
  diffWarnFiles: number,
): { files: number; bytes: number } | undefined {
  const bytes = Buffer.byteLength(diff, "utf8");
  const files = (diff.match(/^diff --git /gm) ?? []).length;
  const over =
    (diffWarnBytes > 0 && bytes > diffWarnBytes) || (diffWarnFiles > 0 && files > diffWarnFiles);
  return over ? { files, bytes } : undefined;
}
```

Then, after `const { gitInfo, diff, reviewBase } = ctx;` (~562) and before `const diffIncomplete = ...` (~565), add:

```ts
  // Slice 3: warn EARLY (stderr survives a self-deadline abort that writes no pending.md)
  // when the diff is large enough to risk a timeout. This runs in the gate, OUTSIDE the
  // loop self-deadline (which wraps only LoopDriver→runIteration). WARN-only — never
  // auto-scales the timeout (could exceed the OS Stop-hook timeout → fail-open).
  const largeDiff = computeLargeDiff(diff, cfg.loop.diffWarnBytes, cfg.loop.diffWarnFiles);
  if (largeDiff) {
    console.warn(
      `🟡 Reviewgate · Large diff: ${largeDiff.files} files / ${Math.round(
        largeDiff.bytes / 1000,
      )} KB — if the review times out, raise loop.runTimeoutMs AND the Stop-hook timeout (both).`,
    );
  }
```

Then in the `new Orchestrator({ ... })` constructor input (~566-583), after the `diffIncomplete,` line (~582), add:

```ts
    largeDiff,
```

- [ ] **Step 8: Run test to verify it passes**

Run: `bun test tests/unit/diff-size-warning.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 9: Add a banner-rendering assertion (report-writer integration)**

Append to `tests/unit/diff-size-warning.test.ts`:

```ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReportWriter } from "../../src/core/report-writer.ts";

test("renders the large-diff banner in pending.md when large_diff is present", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rg-large-diff-"));
  const writer = new ReportWriter(dir);
  await writer.write(
    {
      schema: "reviewgate.pending.v1",
      run_id: "r1",
      iter: 1,
      max_iter: 3,
      verdict: "PASS",
      counts: { critical: 0, warn: 0, info: 0 },
      reviewers: [
        { id: "codex", provider: "codex", model: "m", persona: "security", status: "ok", cost_usd: 0, duration_ms: 1 },
      ],
      findings: [],
      large_diff: { files: 170, bytes: 800_000 },
      cost_usd_total: 0,
      duration_ms_total: 1,
      generated_at: new Date().toISOString(),
      git: { sha: "0".repeat(40), branch: "main", dirty_files: [] },
    },
    { mode: "gate" },
  );
  const md = readFileSync(join(dir, ".reviewgate", "pending.md"), "utf8");
  expect(md).toContain("Large diff:");
  expect(md).toContain("170 files");
  expect(md).toContain("loop.runTimeoutMs");
});
```

Note: confirmed output path is `<repoRoot>/.reviewgate/pending.md` (via `pendingMdPath` → `reviewgateDir` in `src/utils/paths.ts`), so `join(dir, ".reviewgate", "pending.md")` is correct.

- [ ] **Step 10: Run the full new test file**

Run: `bun test tests/unit/diff-size-warning.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 11: Typecheck + lint**

Run: `bunx tsc --noEmit && bun run lint`
Expected: clean.

- [ ] **Step 12: Commit**

```bash
git add src/config/defaults.ts src/config/define-config.ts src/schemas/pending-report.ts src/core/orchestrator.ts src/core/report-writer.ts src/cli/commands/gate.ts tests/unit/diff-size-warning.test.ts
git commit -m "feat(gate): warn early on large diffs (field report #6)

console.warn in gate.ts (outside the loop self-deadline) + pending.md banner
when the diff exceeds loop.diffWarnBytes/diffWarnFiles. File count via raw
diff --git headers. WARN-only — no timeout auto-scaling (fail-open risk)."
```

---

## Task 4: Definition of Done — full suite + dogfood gate

**Files:** none (verification only)

- [ ] **Step 1: Full typecheck + lint + test suite**

Run: `bunx tsc --noEmit && bun run lint && bun test`
Expected: tsc clean, lint clean, ALL tests green (no regressions in the existing suite). If any existing test asserts the exact shape of `AggregateResult` and now fails on the two new fields, update that assertion to include `redactionDropped`/`redactionDroppedCount` — do not remove the new fields.

- [ ] **Step 2: Rebuild the dist binary (deploys to all repos via the symlink)**

Run: `bun run build`
Expected: builds `dist/reviewgate` without error.

- [ ] **Step 3: Reviewgate self-gate (dogfood)**

End the turn so the Stop hook runs Reviewgate on this branch's own diff. Address every finding (fix or reject-with-reason ≥20 chars) per the decisions protocol until the gate PASSes. The redaction-demote and test-severity slices should themselves reduce noise on this very diff.

- [ ] **Step 4: Report completion**

Summarize: tests green (count), tsc+lint clean, dist rebuilt, gate PASS. Do NOT push — ask the user first (per project git policy).

---

## Self-Review (completed by plan author)

- **Spec coverage:** Slice 1 → Task 1; Slice 2 (export classify, schema flag, demote pass, config, orchestrator wiring, badge) → Task 2; Slice 3 (config, pending schema, OrchestratorInput, writeReport, banner, gate.ts warn) → Task 3; DoD → Task 4. All spec test cases mapped (REDACTED subject-vs-context + both gate-2/gate-3 keep cases; security-vs-correctness-vs-non-test demote + config-off; byte/file/disabled/rename predicate + banner render + stderr independence via the pure `computeLargeDiff`).
- **Type consistency:** `redactionDropped`/`redactionDroppedCount` (AggregateResult), `demoteTestSecurity` (AggregateInput + config + orchestrator), `test_severity_demoted` (finding schema + aggregator + badge), `large_diff` (pending schema + writeReport + renderMd), `largeDiff` (OrchestratorInput + gate.ts), `computeLargeDiff` (gate.ts export + test import) — names consistent across tasks.
- **Placeholders:** none — every code step shows complete code.
