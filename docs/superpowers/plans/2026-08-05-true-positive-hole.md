# True-Positive Hole Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop Reviewgate demoting a real security finding twice over — once by calling a
mis-anchored finding "almost certainly hallucinated", once by letting a lone critic push a WARN
security finding below the blocking boundary.

**Architecture:** Two independent slices. **Slice A** teaches `validateFindingFacts` to
distinguish *mis-anchored* from *fabricated* by consulting the reviewer's own `evidence_line`,
and re-anchors instead of demoting when the quote is a real line of the cited file. Because that
pass runs pre-aggregation, the repaired line feeds clustering, which is what lets two detections
of the same bug merge and gain corroboration. **Slice B** extends the critic's security exemption
from CRITICAL-only to CRITICAL-and-WARN.

**Tech Stack:** TypeScript on Bun. `bun test` (not jest/vitest), `biome` for lint,
`tsc --noEmit` for types. Zod schemas are the source of truth for every persisted artifact.

## Global Constraints

- Spec of record: `docs/superpowers/specs/2026-08-05-true-positive-hole-design.md`.
- Runtime is **Bun**. Use `bun`/`bunx`, never `npm`/`node`/`npx`.
- `bunx tsc --noEmit` and `bun run lint` must both be clean before any task is "done".
- `FindingSchema` changes in Task 1, so the **full** `bun test` runs from Task 1 onward.
- Every new schema field is `.optional()` — older persisted `pending.json` must still parse.
- No new config key, no `reviewgate.config.ts` change: both slices are always-on. Touching the
  config would arm the control plane and demand a TTY approval.
- **Do NOT run `bun run build`.** It deploys to every repo via the `~/.local/bin/reviewgate`
  symlink. The rebuild is step 2 of the pilot-03 sequencing, after all review gates pass.
- Never `git add -A` at the repo root — it tracks `.reviewgate/` runtime state. Add named paths.
- Guard tests that already pass against current code are **vacuous until mutation-checked**.
  Every such test below carries an explicit mutation step: apply the mutation **in a copy of the
  repo**, confirm RED, discard the copy, confirm `git diff` shows the original unchanged.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/core/fact-check.ts` | Deterministic finding fact-check | Add `reanchorByEvidence`; consult it before demoting |
| `src/schemas/finding.ts` | Persisted finding shape | Add `anchor_repaired` to the finding and to `members[]` |
| `src/core/aggregator.ts` | Dedup, merge, suppression passes, verdict | Propagate `anchor_repaired` across a merge; add the critic's WARN-security floor |
| `src/core/report-writer.ts` | Renders `pending.md` | One badge |
| `tests/unit/fact-check-reanchor.test.ts` | Slice A guards | **Create** |
| `tests/unit/aggregator-critic.test.ts` | Critic-pass guards | Append Slice B guards |
| `tests/unit/anchor-repair-cascade.test.ts` | End-to-end acceptance | **Create** |

`src/core/orchestrator.ts` is deliberately **not** touched — the whole change sits inside a pass
it already calls.

---

## Task 1: Slice A — re-anchor a mis-anchored finding instead of demoting it

**Files:**
- Modify: `src/schemas/finding.ts:234` (beside `fact_invalid`)
- Modify: `src/core/fact-check.ts:116-119` (the demote decision) and add a helper above it
- Test: `tests/unit/fact-check-reanchor.test.ts` (create)

**Interfaces:**
- Consumes: `normalizeLine(s: string): string` — already in `fact-check.ts:129`, a hoisted
  function declaration, so it is callable from a function defined above it. It defangs injection
  markers, collapses whitespace runs to one space, and trims.
- Consumes: `lineCount(text: string): number` — already in `fact-check.ts:32`.
- Produces: `Finding.anchor_repaired?: boolean` — Task 2 propagates it, Task 3 renders it.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/fact-check-reanchor.test.ts`:

```ts
// tests/unit/fact-check-reanchor.test.ts
//
// pilot-02 turn 2: the fact-check demoted a 0.90 path-traversal finding as "almost certainly
// hallucinated" because it cited line 67 of a 27-line file — while the reviewer's OWN
// evidence_line matched line 26 of that file verbatim. Mis-anchored, not fabricated. These
// guards pin the distinction, and pin that the fabrication protection the pass was built for
// (a CRITICAL citing a line in an EMPTY file) is untouched.
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateFindingFacts } from "../../src/core/fact-check.ts";
import type { Finding } from "../../src/schemas/finding.ts";

const EVIDENCE = "  return readFileSync(`./templates/${name}`, 'utf8')";

function mkFinding(over: Partial<Finding> = {}): Finding {
  return {
    id: "F-001",
    signature: "sig1",
    severity: "CRITICAL",
    category: "security",
    rule_id: "path-traversal",
    file: "store.ts",
    line_start: 67,
    line_end: 67,
    message: "Path traversal vulnerability in readTemplate.",
    details: "details",
    reviewer: { provider: "openrouter", model: "deepseek/deepseek-v3.2", persona: "security" },
    confidence: 0.9,
    consensus: "singleton",
    ...over,
  };
}

function repo(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-reanchor-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "store.ts"), content);
  writeFileSync(join(dir, "empty.yaml"), "");
  return dir;
}

// 5 lines, the quoted evidence at line 3.
const FIVE_LINES = ["const a = 1", "const b = 2", EVIDENCE, "const d = 4", "const e = 5"].join("\n") + "\n";

describe("validateFindingFacts — mis-anchored vs fabricated", () => {
  // GUARD 1. WITHOUT the mechanism: severity INFO + fact_invalid -> 0 blocking.
  //          WITH it: CRITICAL kept at the quoted line 3 + anchor_repaired -> 1 blocking.
  it("re-anchors an out-of-range finding whose evidence_line matches a real line", () => {
    const dir = repo(FIVE_LINES);
    const out = validateFindingFacts(
      [mkFinding({ line_start: 67, line_end: 67, evidence_line: EVIDENCE })],
      dir,
      new Set(),
    );
    expect(out[0]?.severity).toBe("CRITICAL");
    expect(out[0]?.line_start).toBe(3);
    expect(out[0]?.line_end).toBe(3);
    expect(out[0]?.anchor_repaired).toBe(true);
    expect(out[0]?.fact_invalid).toBeUndefined();
    expect(out[0]?.details).toContain("re-anchored");
  });

  // GUARD 2 (passes on current code — MUTATION-CHECKED in Step 3).
  // WITHOUT the evidence gate (repair unconditionally): fact_invalid absent.
  // WITH it: fact_invalid true. This is the empty-file field-report case.
  it("still demotes an out-of-range finding that carries NO evidence_line", () => {
    const dir = repo(FIVE_LINES);
    const out = validateFindingFacts(
      [mkFinding({ file: "empty.yaml", line_start: 2, line_end: 2 })],
      dir,
      new Set(),
    );
    expect(out[0]?.severity).toBe("INFO");
    expect(out[0]?.fact_invalid).toBe(true);
    expect(out[0]?.anchor_repaired).toBeUndefined();
  });

  // GUARD 3 (passes on current code — MUTATION-CHECKED in Step 3).
  // WITHOUT the match test: fact_invalid absent. WITH it: fact_invalid true.
  it("still demotes when the evidence_line matches NO line of the cited file", () => {
    const dir = repo(FIVE_LINES);
    const out = validateFindingFacts(
      [mkFinding({ line_start: 67, evidence_line: "this line is nowhere in the file" })],
      dir,
      new Set(),
    );
    expect(out[0]?.severity).toBe("INFO");
    expect(out[0]?.fact_invalid).toBe(true);
    expect(out[0]?.anchor_repaired).toBeUndefined();
  });

  // GUARD 4. WITHOUT the nearest-match rule (first match wins): line_start 2.
  //          WITH it: line_start 8. Deterministic either way, but only one is the rule.
  it("resolves a multi-match to the occurrence NEAREST the cited line", () => {
    const dup = ["a", EVIDENCE, "c", "d", "e", "f", "g", EVIDENCE, "i", "j"].join("\n") + "\n";
    const dir = repo(dup);
    const out = validateFindingFacts(
      [mkFinding({ line_start: 20, line_end: 20, evidence_line: EVIDENCE })],
      dir,
      new Set(),
    );
    expect(out[0]?.line_start).toBe(8);
    expect(out[0]?.anchor_repaired).toBe(true);
  });

  // GUARD 5 (passes on current code — MUTATION-CHECKED in Step 3).
  // WITHOUT the range check first (repair before it): line_start moves to 3.
  // WITH the correct order: line_start stays 1. The pass must never move a VALID anchor.
  it("never touches a finding whose cited line is IN range", () => {
    const dir = repo(FIVE_LINES);
    const out = validateFindingFacts(
      [mkFinding({ line_start: 1, line_end: 1, evidence_line: EVIDENCE })],
      dir,
      new Set(),
    );
    expect(out[0]?.line_start).toBe(1);
    expect(out[0]?.anchor_repaired).toBeUndefined();
    expect(out[0]?.fact_invalid).toBeUndefined();
  });

  // Robustness: the match runs under normalizeLine, so indentation/whitespace differences in
  // the reviewer's quote must not defeat it. WITHOUT normalization: no match -> demoted.
  // WITH it: re-anchored to line 3.
  it("matches the quote whitespace-insensitively", () => {
    const dir = repo(FIVE_LINES);
    const out = validateFindingFacts(
      [mkFinding({ line_start: 67, evidence_line: "return readFileSync(`./templates/${name}`,   'utf8')" })],
      dir,
      new Set(),
    );
    expect(out[0]?.line_start).toBe(3);
    expect(out[0]?.anchor_repaired).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/unit/fact-check-reanchor.test.ts`

Expected: guards 1, 4 and the whitespace test FAIL (the finding comes back `INFO` +
`fact_invalid`, `line_start` still 67). Guards 2, 3, 5 PASS — they pin behaviour that already
exists, and Step 3 proves they are not vacuous.

- [ ] **Step 3: Mutation-check the three tests that already pass**

Do this in a **copy**, never in the working repo:

```bash
cp -R /Users/markus/Developer/reviewgate /private/tmp/claude-501/-Users-markus-Developer-reviewgate/4d33f15e-1cc6-4490-b511-a3a6d3b10443/scratchpad/mut1
```

In the copy's `src/core/fact-check.ts`, apply each mutation and record the result:

| Mutation | Expected RED |
|---|---|
| Delete the `if (f.line_start <= lines) return f;` early return (repair before the range check) | GUARD 5 red — `line_start` 3, expected 1 |
| Make `reanchorByEvidence` return a repaired finding even when `evidence_line` is absent (anchor to line 1) | GUARD 2 red — `fact_invalid` undefined, expected true |
| Make `reanchorByEvidence` skip the `normalizeLine` equality test and take line 1 | GUARD 3 red — `fact_invalid` undefined, expected true |

Then: `rm -rf <copy>` and `git -C /Users/markus/Developer/reviewgate diff --stat` → must show the
original untouched.

(Steps 1–3 are written against the finished implementation; if a mutation cannot be applied
because the code does not exist yet, do Step 4 first and then Step 3.)

- [ ] **Step 4: Add the schema field**

In `src/schemas/finding.ts`, immediately after `fact_invalid: z.boolean().optional(),` (`:234`):

```ts
  // Slice A (pilot-02 turn 2): set true when the fact-check found the cited line OUT OF RANGE
  // but the reviewer's own evidence_line matched a real line of that file — the finding was
  // MIS-ANCHORED, not fabricated, so it is re-anchored to the quoted line instead of demoted.
  // Severity is untouched; this is a provenance/render marker. Mutually exclusive with
  // fact_invalid by construction (the repair returns before the demote).
  anchor_repaired: z.boolean().optional(),
```

- [ ] **Step 5: Add the helper to `src/core/fact-check.ts`**

Insert directly above `export function validateFindingFacts` (`:58`):

```ts
/**
 * A cited line that does not exist is NOT automatically a fabrication. When the reviewer quoted
 * its own evidence and that quote is a real line of the cited file, the reviewer read real code
 * and mis-numbered it — mis-anchored, not hallucinated. Demoting that as a hallucination is a
 * false accusation against a finding we can PROVE is grounded (pilot-02 turn 2: a 0.90 path
 * traversal, quote verbatim at line 26, cited at 67, demoted with "almost certainly
 * hallucinated").
 *
 * Returns the finding re-anchored to the quoted line, or null when nothing can be proven — in
 * which case the caller demotes exactly as before. This can only ever be reached for an
 * out-of-range anchor, so it can never move a valid one.
 *
 * Multiple matches resolve to the occurrence NEAREST the cited line, ties to the LOWER line
 * number. Both are real occurrences of the reviewer's own quote, so this chooses among facts
 * rather than inventing one — and it must be deterministic, because the aggregator's clustering
 * is deliberately order-independent and keys on line_start.
 */
function reanchorByEvidence(f: Finding, text: string): Finding | null {
  const ev = typeof f.evidence_line === "string" ? f.evidence_line : null;
  if (ev === null || ev.length === 0) return null;
  const evN = normalizeLine(ev);
  if (evN.length === 0) return null; // quote was only whitespace/markers → no signal
  const lines = text.split("\n");
  const cited = f.line_start - 1;
  let best = -1;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw === undefined) continue;
    if (normalizeLine(raw) !== evN) continue;
    // Strict `<` with an ascending scan makes ties keep the LOWER line number.
    if (best === -1 || Math.abs(i - cited) < Math.abs(best - cited)) best = i;
  }
  if (best === -1) return null; // quote matches no line → the fabrication signal stands
  const line = best + 1;
  const total = lineCount(text);
  const note = `\n\n[reviewgate fact-check] the reviewer cited ${f.file}:${f.line_start}, which does not exist (the file has ${total} line${total === 1 ? "" : "s"}), but the evidence it quoted matches line ${line} verbatim — MIS-ANCHORED, not fabricated, so it has been re-anchored there. Treat the defect as real and check line ${line}.`;
  return {
    ...f,
    line_start: line,
    line_end: line,
    anchor_repaired: true,
    details: `${f.details.slice(0, 2000 - note.length)}${note}`,
  };
}
```

- [ ] **Step 6: Consult the helper before demoting**

In `validateFindingFacts`, replace lines `116-119`:

```ts
    const lines = lineCount(text);
    if (f.line_start <= lines) return f; // cited line exists → real finding, untouched
    const note = `\n\n[reviewgate fact-check] cited location ${file}:${f.line_start} does not exist in the working tree (file has ${lines} line${lines === 1 ? "" : "s"}) — almost certainly hallucinated; demoted to advisory. Verify before treating as real.`;
    return demote(f, note);
```

with:

```ts
    const lines = lineCount(text);
    if (f.line_start <= lines) return f; // cited line exists → real finding, untouched
    // Out of range. Before calling it a fabrication, consult the reviewer's OWN quoted evidence:
    // a quote that matches a real line of THIS file proves the reviewer read the code and
    // mis-numbered it, which is not what this pass exists to catch.
    const repaired = reanchorByEvidence(f, text);
    if (repaired !== null) return repaired;
    const note = `\n\n[reviewgate fact-check] cited location ${file}:${f.line_start} does not exist in the working tree (file has ${lines} line${lines === 1 ? "" : "s"}) — almost certainly hallucinated; demoted to advisory. Verify before treating as real.`;
    return demote(f, note);
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bun test tests/unit/fact-check-reanchor.test.ts tests/unit/fact-check.test.ts tests/unit/evidence-attestation.test.ts`
Expected: PASS, including the pre-existing fact-check and evidence suites.

- [ ] **Step 8: Full gates**

```bash
bunx tsc --noEmit
bun run lint
bun test
```
Expected: all clean. `FindingSchema` changed, so the whole suite matters here.

- [ ] **Step 9: Commit**

```bash
git add src/schemas/finding.ts src/core/fact-check.ts tests/unit/fact-check-reanchor.test.ts
git commit -m "fix(fact-check): re-anchor a mis-anchored finding instead of calling it fabricated"
```

---

## Task 2: Carry `anchor_repaired` through a dedup merge

**Why this task exists:** Slice A's whole point is that the repaired line lets two detections
merge. But `memberOf` (`aggregator.ts:295`) projects a member down to six fields and drops
everything else, and the representative is chosen by severity with **ties keeping the first**. In
the turn-2 shape both findings are WARN and the repaired one sorts second, so it becomes a
*member* — and the marker, the badge and pilot-03's count all vanish in exactly the case the
slice was built for. `demoted_from_critical` already solved this problem in the same code
(`:524-531`); this mirrors it.

**Files:**
- Modify: `src/schemas/finding.ts:254` (inside the `members[]` object)
- Modify: `src/core/aggregator.ts:295-307` (`memberOf`) and `:529-538` (the dedupe push)
- Test: `tests/unit/anchor-repair-cascade.test.ts` (create; Task 5 adds the second test to it)

**Interfaces:**
- Consumes: `Finding.anchor_repaired` from Task 1.
- Produces: a deduped finding whose `anchor_repaired` is `OR(representative, all members)`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/anchor-repair-cascade.test.ts`:

```ts
// tests/unit/anchor-repair-cascade.test.ts
import { describe, expect, it } from "bun:test";
import { aggregate } from "../../src/core/aggregator.ts";
import type { Finding } from "../../src/schemas/finding.ts";

function fin(over: Partial<Finding>): Finding {
  return {
    id: "F-x",
    signature: "s",
    severity: "WARN",
    category: "security",
    rule_id: "r",
    file: "src/store.ts",
    line_start: 25,
    line_end: 25,
    message: "m",
    details: "d",
    reviewer: { provider: "ollama", model: "glm-5.2:cloud", persona: "correctness" },
    confidence: 0.55,
    consensus: "singleton",
    ...over,
  };
}

describe("anchor_repaired survives a dedup merge", () => {
  // WITHOUT the OR-propagation: anchor_repaired is undefined on the merged finding (it lived on
  // the member, and ties-keep-first made the UNrepaired finding the representative) -> the badge
  // and pilot-03's count both disappear in exactly the cascade case.
  // WITH it: anchor_repaired is true on the single merged finding.
  it("OR-propagates anchor_repaired from a merged member to the representative", () => {
    const r = aggregate({
      findings: [
        fin({ signature: "sigA", line_start: 25, line_end: 25, rule_id: "path-traversal-readtemplate" }),
        fin({
          signature: "sigB",
          line_start: 26,
          line_end: 26,
          rule_id: "path-traversal",
          anchor_repaired: true,
          reviewer: { provider: "openrouter", model: "deepseek/deepseek-v3.2", persona: "security" },
          confidence: 0.9,
        }),
      ],
      reviewersTotal: 2,
    });
    expect(r.dedupedFindings.length).toBe(1);
    expect(r.dedupedFindings[0]?.anchor_repaired).toBe(true);
    expect(r.dedupedFindings[0]?.consensus).toBe("majority");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/unit/anchor-repair-cascade.test.ts`
Expected: FAIL — `anchor_repaired` is `undefined`, expected `true`. (`consensus` already passes;
the merge itself is existing behaviour.)

- [ ] **Step 3: Add the field to the member schema**

In `src/schemas/finding.ts`, inside the `members[]` object right after
`demoted_from_critical: z.boolean().optional(),` (`:254`):

```ts
        // Slice A: per-member mis-anchor provenance, so a repaired member merged under an
        // unrepaired equal-severity representative (ties-keep-first) does not silently lose
        // the marker — the badge and the pilot count both key on it.
        anchor_repaired: z.boolean().optional(),
```

- [ ] **Step 4: Carry it in `memberOf`**

In `src/core/aggregator.ts`, inside `memberOf` after the `demoted_from_critical` spread (`:305`):

```ts
    ...(f.anchor_repaired === true ? { anchor_repaired: true } : {}),
```

- [ ] **Step 5: OR it into the representative**

In `src/core/aggregator.ts`, after the `demotedFromCritical` computation (`:529-531`):

```ts
    // Slice A mirror of the G0 OR above: the repaired finding is often NOT the representative
    // (equal severity + ties-keep-first), and losing the marker would hide the mis-anchor in
    // exactly the merge the repair made possible.
    const anchorRepaired =
      sample.anchor_repaired === true || members.some((m) => m.anchor_repaired === true);
```

and add to the `deduped.push({...})` object after the `demoted_from_critical` spread (`:538`):

```ts
      ...(anchorRepaired ? { anchor_repaired: true } : {}),
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test tests/unit/anchor-repair-cascade.test.ts tests/unit/aggregator-dedup-category.test.ts`
Expected: PASS.

- [ ] **Step 7: Gates and commit**

```bash
bunx tsc --noEmit && bun run lint && bun test
git add src/schemas/finding.ts src/core/aggregator.ts tests/unit/anchor-repair-cascade.test.ts
git commit -m "fix(aggregator): carry anchor_repaired across a dedup merge"
```

---

## Task 3: Render the mis-anchor badge

**Files:**
- Modify: `src/core/report-writer.ts:43` (beside the `fact_invalid` badge)
- Test: `tests/unit/anchor-repair-cascade.test.ts` (append)

**Interfaces:**
- Consumes: `Finding.anchor_repaired` (Task 1), `findingBadges(f: Finding): string | null`
  (`report-writer.ts:39`, already exported).

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/anchor-repair-cascade.test.ts` (and add
`import { findingBadges } from "../../src/core/report-writer.ts";` to the imports):

```ts
describe("anchor_repaired badge", () => {
  // WITHOUT the badge: findingBadges returns null for a repaired finding -> the agent sees a
  // silently corrected line number and no signal that a reviewer mis-anchored.
  // WITH it: the badge text is present.
  it("renders a badge naming the repair", () => {
    const out = findingBadges(fin({ anchor_repaired: true }));
    expect(out).toContain("re-anchored");
  });

  it("renders no such badge for an ordinary finding", () => {
    expect(findingBadges(fin({}))).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/unit/anchor-repair-cascade.test.ts`
Expected: FAIL — `findingBadges` returns `null`, expected a string containing "re-anchored".

- [ ] **Step 3: Add the badge**

In `src/core/report-writer.ts`, directly after the `fact_invalid` badge (`:43`):

```ts
  // Slice A: the counterpart to the badge above — the cited line was wrong, but the reviewer's
  // quoted evidence proved the finding is grounded, so it was moved rather than demoted.
  if (f.anchor_repaired)
    badges.push("⚑ reviewer cited a line that does not exist — re-anchored to the source line it quoted");
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/anchor-repair-cascade.test.ts tests/unit/report-writer.test.ts`
Expected: PASS — the new badge tests plus the existing report-writer suite.

- [ ] **Step 5: Gates and commit**

```bash
bunx tsc --noEmit && bun run lint && bun test
git add src/core/report-writer.ts tests/unit/anchor-repair-cascade.test.ts
git commit -m "feat(report): badge a finding whose anchor was repaired from its quoted evidence"
```

---

## Task 4: Slice B — the critic's WARN-security floor

**Files:**
- Modify: `src/core/aggregator.ts:604` (add the floor), `:615` and `:619` (use it)
- Test: `tests/unit/aggregator-critic.test.ts` (append)

**Interfaces:**
- Consumes: `touchesSecurityOrCorrectness(f: Finding): boolean` (`aggregator.ts:255`).
- Produces: nothing new — a protected finding takes the existing
  `survivors.push({ ...f, critic_verdict: "keep" })` path at `:635`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/aggregator-critic.test.ts`:

```ts
describe("critic — security/correctness floor (pilot-02 turn 2)", () => {
  // GUARD 7. WITHOUT the floor: INFO + critic_verdict "likely_fp" -> 0 blocking.
  //          WITH it: WARN + critic_verdict "keep" -> 1 blocking.
  it("does not demote a WARN security finding below the blocking boundary", () => {
    const f = fin({ signature: "sigSecWarn", severity: "WARN", category: "security" });
    const r = aggregate({
      findings: [f],
      reviewersTotal: 2,
      critic: new Map([["sigSecWarn", { verdict: "likely_fp" }]]),
    });
    expect(r.dedupedFindings[0]?.severity).toBe("WARN");
    expect(r.dedupedFindings[0]?.critic_verdict).toBe("keep");
  });

  it("does not demote a WARN correctness finding below the blocking boundary", () => {
    const f = fin({ signature: "sigCorrWarn", severity: "WARN", category: "correctness" });
    const r = aggregate({
      findings: [f],
      reviewersTotal: 2,
      critic: new Map([["sigCorrWarn", { verdict: "likely_fp" }]]),
    });
    expect(r.dedupedFindings[0]?.severity).toBe("WARN");
    expect(r.dedupedFindings[0]?.critic_verdict).toBe("keep");
  });

  // GUARD 8 (passes on current code — MUTATION-CHECKED in Step 3).
  // WITH an "exempt at every severity" floor: criticDroppedCount 0.
  // WITH the correct WARN floor: criticDroppedCount 1. The critic keeps its FP-filtering
  // power exactly where reviewers are noisiest (low-confidence INFO security chatter).
  it("still drops an already-INFO security likely_fp", () => {
    const f = fin({ signature: "sigSecInfo", severity: "INFO", category: "security" });
    const r = aggregate({
      findings: [f],
      reviewersTotal: 2,
      critic: new Map([["sigSecInfo", { verdict: "likely_fp" }]]),
    });
    expect(r.criticDroppedCount).toBe(1);
    expect(r.dedupedFindings.length).toBe(0);
  });

  // GUARD 9 (passes on current code — MUTATION-CHECKED in Step 3).
  // WITH a severity-only floor (all WARN exempt): the finding stays WARN -> 1 blocking.
  // WITH the correct category-keyed floor: INFO -> 0 blocking.
  it("still demotes a WARN quality finding", () => {
    const f = fin({ signature: "sigQualWarn", severity: "WARN", category: "quality" });
    const r = aggregate({
      findings: [f],
      reviewersTotal: 2,
      critic: new Map([["sigQualWarn", { verdict: "likely_fp" }]]),
    });
    expect(r.dedupedFindings[0]?.severity).toBe("INFO");
    expect(r.dedupedFindings[0]?.critic_verdict).toBe("likely_fp");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/unit/aggregator-critic.test.ts`
Expected: the two "does not demote a WARN …" tests FAIL (severity comes back `INFO`,
`critic_verdict` `likely_fp`). Guards 8 and 9 PASS — Step 3 proves they are not vacuous.

- [ ] **Step 3: Mutation-check guards 8 and 9**

In a **copy** of the repo:

| Mutation in `aggregator.ts` | Expected RED |
|---|---|
| `const isBlockingSecurity = touchesSecurityOrCorrectness(f);` (drop the severity test → exempt at every severity) | GUARD 8 red — `criticDroppedCount` 0, expected 1 |
| `const isBlockingSecurity = f.severity === "WARN";` (drop the category test) | GUARD 9 red — severity `WARN`, expected `INFO` |

Then `rm -rf <copy>` and confirm `git diff --stat` shows the original untouched.

- [ ] **Step 4: Implement the floor**

In `src/core/aggregator.ts`, replace line `604`:

```ts
      const isCriticalSecurity = f.severity === "CRITICAL" && touchesSecurityOrCorrectness(f);
```

with:

```ts
      const isCriticalSecurity = f.severity === "CRITICAL" && touchesSecurityOrCorrectness(f);
      // pilot-02 turn 2: the exemption above is keyed to CRITICAL, so a WARN-severity security
      // finding was demotable by a single adversarial critic — and WARN→INFO is the one demote
      // that crosses the blocking boundary (isBlocking = CRITICAL || WARN). The sibling
      // delta-scope pass already exempts security/correctness at ANY severity; mirror that floor
      // here. An already-INFO security finding stays droppable, so the critic keeps its
      // FP-filtering power where reviewers are noisiest.
      const isBlockingSecurity = f.severity === "WARN" && touchesSecurityOrCorrectness(f);
      const isSecurityProtected = isCriticalSecurity || isBlockingSecurity;
```

Then replace `!isCriticalSecurity` with `!isSecurityProtected` in **both** conditions — `:615`
(`if (!isCriticalSecurity && !isCorroborated && isProtected(f))`) and `:619`
(`if (!isCriticalSecurity && !isCorroborated)`).

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/unit/aggregator-critic.test.ts`
Expected: PASS.

- [ ] **Step 6: Gates and commit**

```bash
bunx tsc --noEmit && bun run lint && bun test
git add src/core/aggregator.ts tests/unit/aggregator-critic.test.ts
git commit -m "fix(aggregator): the critic may not demote a security finding below WARN"
```

---

## Task 5: End-to-end acceptance — the turn-2 cascade

**Files:**
- Test: `tests/unit/anchor-repair-cascade.test.ts` (append)

No production code changes. If this test does not pass on the strength of Tasks 1–4, one of them
is wrong.

**Interfaces:**
- Consumes: `validateFindingFacts` (Task 1), `aggregate` (Tasks 2 and 4).

**What it reconstructs:** turn 2's two findings with their real lines, categories, providers,
confidences and the actual `evidence_line`, over a temp-dir copy of the 27-line `src/store.ts`
taken from `rig/results/pilot-02/turns/2/diff.patch`. This is a **reconstruction, not a replay** —
the archived findings are post-aggregation, so the pre-aggregation severities are inferred from
the demotion markers, exactly as `ablate.ts` does.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/anchor-repair-cascade.test.ts` (add `mkdirSync`, `mkdtempSync`,
`writeFileSync`, `tmpdir`, `join` and `validateFindingFacts` to the imports):

```ts
// The 27-line src/store.ts exactly as turn 2's diff created it. Line 26 is the quoted evidence.
const STORE_TS = [
  "import { readFileSync } from 'node:fs'",
  "",
  "export interface KVStore<K, V> {",
  "  get(key: K): V | undefined",
  "  set(key: K, value: V): void",
  "  has(key: K): boolean",
  "}",
  "",
  "export function createStore<K, V>(): KVStore<K, V> {",
  "  const entries = new Map<K, V>()",
  "",
  "  return {",
  "    get(key) {",
  "      return entries.get(key)",
  "    },",
  "    set(key, value) {",
  "      entries.set(key, value)",
  "    },",
  "    has(key) {",
  "      return entries.has(key)",
  "    },",
  "  }",
  "}",
  "",
  "export function readTemplate(name: string): string {",
  "  return readFileSync(`./templates/${name}`, 'utf8')",
  "}",
].join("\n") + "\n";

describe("pilot-02 turn 2 — the full cascade", () => {
  // WITHOUT the fix: F-002 is demoted as fabricated (INFO + fact_invalid) and stays 42 lines
  // from F-001, so nothing merges, both stay `singleton`, and the critic demotes F-001 to INFO
  // -> 2 findings, 0 blocking. This is what pilot-02 recorded.
  // WITH the fix: F-002 re-anchors 67 -> 26, merges with F-001 at 25, consensus becomes
  // `majority`, the critic is barred -> 1 finding, blocking WARN.
  it("repairs the anchor, merges, corroborates, and stays blocking", () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-turn2-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "store.ts"), STORE_TS);

    const evidence = "  return readFileSync(`./templates/${name}`, 'utf8')";
    const raw: Finding[] = [
      fin({
        signature: "sigF001",
        rule_id: "path-traversal-readtemplate",
        line_start: 25,
        line_end: 27,
        confidence: 0.55,
        evidence_line: evidence,
        message: "readTemplate interpolates 'name' directly into a filesystem path",
      }),
      fin({
        signature: "sigF002",
        rule_id: "path-traversal",
        line_start: 67,
        line_end: 67,
        confidence: 0.9,
        evidence_line: evidence,
        message: "Path traversal vulnerability in readTemplate.",
        reviewer: { provider: "openrouter", model: "deepseek/deepseek-v3.2", persona: "security" },
      }),
    ];

    const checked = validateFindingFacts(raw, dir, new Set());
    expect(checked.find((f) => f.signature === "sigF002")?.line_start).toBe(26);

    const r = aggregate({
      findings: checked,
      reviewersTotal: 2,
      changedRanges: new Map([["src/store.ts", [[1, 27]] as Array<[number, number]>]]),
      scopeToDiff: true,
      // The critic called the weaker detection a likely FP, exactly as it did in the pilot.
      critic: new Map([["sigF001", { verdict: "likely_fp" }]]),
    });

    expect(r.dedupedFindings.length).toBe(1);
    expect(r.dedupedFindings[0]?.consensus).toBe("majority");
    expect(r.dedupedFindings[0]?.severity).toBe("WARN");
    expect(r.dedupedFindings[0]?.critic_verdict).toBe("keep");
    expect(r.dedupedFindings[0]?.anchor_repaired).toBe(true);
    expect(r.dedupedFindings[0]?.scope_demoted).toBeUndefined();
    expect(r.dedupedFindings[0]?.fact_invalid).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it**

Run: `bun test tests/unit/anchor-repair-cascade.test.ts`
Expected: PASS on the strength of Tasks 1–4. If it fails, do **not** patch the test — find which
task's behaviour is wrong.

- [ ] **Step 3: Gates and commit**

```bash
bunx tsc --noEmit && bun run lint && bun test
git add tests/unit/anchor-repair-cascade.test.ts
git commit -m "test: pilot-02 turn-2 cascade — repair, merge, corroborate, stay blocking"
```

---

## After the tasks

1. **Review pipeline** — the post-implementation gate, two independent slots, both must return
   `VERDICT: PASS`. Codex is quota-blocked until **2026-08-08T11:07Z**, so Slot A (the executing
   reviewer) is `agy`/Gemini or a Claude reviewer subagent, and Slot B is a second, different
   voice. Tell the reviewer explicitly to mutation-check the new guard tests in a copy.
2. **`rm -rf .review/`** before the final commit.
3. **Stop and ask before pushing.** Do not push to `origin`.
4. **Do not `bun run build` yet** — that is step 2 of the pilot-03 sequencing in the spec, and it
   re-pins the binary for every repo on the machine.
