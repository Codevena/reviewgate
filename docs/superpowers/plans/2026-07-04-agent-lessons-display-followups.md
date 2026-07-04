# Agent Lessons — Display Fast-Follows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Agent Lessons show a human-readable `rule_id`, and warn — during an active review — when a finding matches a recurring accepted+fixed lesson.

**Architecture:** F1 adds an optional `display_rule_id` (the raw reviewer rule_id) to the lesson store and renders it instead of the token-sorted normalized form. F2 adds a pure, fail-safe `recurrenceNotesForFindings` that the orchestrator computes at report time and hands to `report-writer` as pending-report data, rendered as a `> ⚠` banner. Both ride the existing `phases.agentLessons` opt-in.

**Tech Stack:** Bun + TypeScript, zod schemas, `bun:test`.

## Global Constraints

- Runtime is **Bun**. `bun`/`bunx`, `bun test`. `bunx tsc --noEmit` **and** `bun run lint` clean, plus the affected tests, before any task is done.
- **House principle:** render-only / NEVER verdict-affecting / fail-safe. No path may block a review or change a verdict/counts.
- Both features ride the EXISTING `phases.agentLessons` opt-in — **no new config flag**.
- `display_rule_id` and `agent_lesson_recurrences` are **optional** schema additions (back-compat: existing persisted stores + pending reports parse unchanged; renderers fall back).
- Reviewer-authored embeds (`exemplar_message`, raw `rule_id`) are sanitized with `neutralizeInjectionMarkers` (+ `neutralizeFences` for prose) before rendering — matching the existing `fragmentationBanner` pattern (sanitize the embeds, not the trusted markup).
- Commits: **no `Co-Authored-By` line**. **Never `git add -A`** — add the exact files each step lists.

## Reference: current code (verified)

- `LessonEntrySchema` (`src/schemas/agent-lessons.ts:13-23`): `id, key, category, rule_id, occurrences, exemplar_message, first_seen_at, last_seen_at`.
- `AgentLessonsStore.recordOccurrence` (`src/core/agent-lessons/store.ts:106-150`): create branch sets `rule_id: normalizeRuleId(meta.rule_id)`; non-dup branch sets `e.exemplar_message = meta.message`. `meta.rule_id` is the RAW reviewer rule_id (learn.ts passes `f.rule_id`). `lessonKey(category, ruleId)` and `snapshot(opts?)` exported from store.ts.
- `renderLesson` (`src/core/agent-lessons/distill.ts:31-42`) uses `entry.rule_id`. `surfacedLessons(idx, minRecurrence)` returns `{entry, count, sessions, files}[]` sorted count-desc. `SurfacedLesson` exported.
- `learn-status` surfaced map (`src/cli/commands/learn-status.ts:298-303`) uses `l.entry.rule_id`.
- `AgentLessonsCfg` exported from `src/core/agent-lessons/inject.ts` (`{enabled, minRecurrence, topK, maxInjectChars, ttlDays}`).
- `PendingReportSchema` (`src/schemas/pending-report.ts:12-103`) — optional advisory fields e.g. `workspace_unsettled` (55), `fp_fragmentation` (70).
- `Orchestrator.writeReport` (`src/core/orchestrator.ts:2629-2717`): builds the pending object and calls `writer.write(...)`. `this.input.repoRoot`, `this.input.config`, and `findings` are in scope. Called from many sites — ERROR/PASS pass `findings: []`.
- `report-writer.renderMd` (`src/core/report-writer.ts:267+`) builds banner arrays (`unsettledBanner` :326, `fragmentationBanner` :345) and spreads them into the output at `:406-411`.

---

### Task 1: F1 — human-readable `display_rule_id`

**Files:**
- Modify: `src/schemas/agent-lessons.ts:17` (add field after `rule_id`)
- Modify: `src/core/agent-lessons/store.ts` (recordOccurrence create + non-dup branches)
- Modify: `src/core/agent-lessons/distill.ts:38` (renderLesson)
- Modify: `src/cli/commands/learn-status.ts:303` (surfaced map)
- Test: `tests/unit/agent-lessons-store.test.ts`, `tests/unit/agent-lessons-distill.test.ts`

**Interfaces:**
- Produces: `LessonEntry.display_rule_id?: string` — the raw reviewer rule_id (most-recent-wins). Renderers use `entry.display_rule_id ?? entry.rule_id`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/agent-lessons-store.test.ts`:

```ts
test("stores the raw rule_id as display_rule_id (most-recent-wins), keeps rule_id normalized", async () => {
  const repo = tmpRepo();
  const store = new AgentLessonsStore(repo);
  const meta = { category: "correctness" as const, rule_id: "Missing AdditionalProperties", message: "m", file: "a.ts" };
  await store.recordOccurrence(meta, { run_id: "s:0:1", session_id: "s", signature: "sig1" }, "2026-07-04T00:00:00.000Z");
  let e = (await store.snapshot()).entries[0]!;
  expect(e.display_rule_id).toBe("Missing AdditionalProperties"); // raw
  expect(e.rule_id).not.toBe("Missing AdditionalProperties"); // normalized bucket token
  // A later occurrence (same normalized key, different raw casing) updates the display form.
  await store.recordOccurrence({ ...meta, rule_id: "missing-additionalProperties" }, { run_id: "s:0:2", session_id: "s", signature: "sig2" }, "2026-07-04T00:01:00.000Z");
  e = (await store.snapshot()).entries[0]!;
  expect(e.display_rule_id).toBe("missing-additionalProperties");
});

test("display_rule_id is defanged at write (backticks + injection markers)", async () => {
  const repo = tmpRepo();
  const store = new AgentLessonsStore(repo);
  await store.recordOccurrence({ category: "correctness" as const, rule_id: "rule-`x` [INST]", message: "m", file: "a.ts" }, { run_id: "s:0:1", session_id: "s", signature: "sig1" }, "2026-07-04T00:00:00.000Z");
  const e = (await store.snapshot()).entries[0]!;
  expect(e.display_rule_id).not.toContain("`");
  expect(e.display_rule_id).not.toContain("[INST]");
});
```

Append to `tests/unit/agent-lessons-distill.test.ts` (inside the file, a new test):

```ts
test("renderLesson prefers display_rule_id, falls back to rule_id", () => {
  const base = surfacedLessons(idx, 3)[0]!; // AL-001, rule_id "rule-a"
  expect(renderLesson(base)).toContain('rule "rule-a"'); // no display_rule_id → falls back
  const withDisplay = { ...base, entry: { ...base.entry, display_rule_id: "Rule A (raw)" } };
  expect(renderLesson(withDisplay)).toContain('rule "Rule A (raw)"');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/agent-lessons-store.test.ts tests/unit/agent-lessons-distill.test.ts`
Expected: FAIL — `display_rule_id` is not set / not in the type.

- [ ] **Step 3: Add the schema field**

`src/schemas/agent-lessons.ts` — after `rule_id: z.string(),` (line 17):

```ts
  // The RAW rule_id as the reviewer wrote it (most-recent-wins) — for human-readable display.
  // `rule_id` above stays the NORMALIZED bucket token (it must match `key`). Optional for
  // back-compat: entries written before this field fall back to `rule_id` at render time.
  display_rule_id: z.string().optional(),
```

- [ ] **Step 4: Set it in the store (SANITIZED at write)**

`src/core/agent-lessons/store.ts` — add the sanitizer import near the `normalizeRuleId` import:

```ts
import { neutralizeInjectionMarkers } from "../../diff/sanitizer.ts";
```

In `recordOccurrence`, immediately after `const key = lessonKey(meta.category, meta.rule_id);` and BEFORE `await this.mutate(...)`, derive the safe display form ONCE:

```ts
    // Human-readable display form: the RAW rule_id, but DEFANGED at write — injection markers
    // neutralized + backticks stripped — so it is safe rendered into injected lesson text AND
    // pending.md code spans, at every render site, without per-site sanitizing (plan-gate WARN).
    // The stored `rule_id` stays the normalized bucket token that matches `key`.
    const displayRuleId = neutralizeInjectionMarkers(meta.rule_id.trim()).replace(/`/g, "");
```

In the create branch, immediately after `rule_id: normalizeRuleId(meta.rule_id),`:

```ts
          display_rule_id: displayRuleId,
```

And in the non-dup branch, immediately after `e.exemplar_message = meta.message;`:

```ts
      e.display_rule_id = displayRuleId; // most-recent raw (sanitized) rule_id wins, like exemplar_message
```

- [ ] **Step 5: Render it (distill + learn-status)**

`src/core/agent-lessons/distill.ts:38` — change `rule "${entry.rule_id}"` to:

```ts
    `- [${entry.category}] rule "${entry.display_rule_id ?? entry.rule_id}" - caught ${count}x in this repo ` +
```

`src/cli/commands/learn-status.ts:303` — change `rule_id: l.entry.rule_id,` to:

```ts
      rule_id: l.entry.display_rule_id ?? l.entry.rule_id,
```

- [ ] **Step 6: Run tests + gates**

Run: `bun test tests/unit/agent-lessons-store.test.ts tests/unit/agent-lessons-distill.test.ts tests/unit/learn-status-agent-lessons.test.ts`
Expected: PASS. Then `bunx tsc --noEmit` && `bun run lint` clean.

- [ ] **Step 7: Commit**

```bash
git add src/schemas/agent-lessons.ts src/core/agent-lessons/store.ts src/core/agent-lessons/distill.ts src/cli/commands/learn-status.ts tests/unit/agent-lessons-store.test.ts tests/unit/agent-lessons-distill.test.ts
git commit -m "feat(agent-lessons): human-readable display_rule_id in lessons"
```

---

### Task 2: F2a — `recurrenceNotesForFindings` + pending-report field

**Files:**
- Create: `src/core/agent-lessons/recurrence.ts`
- Modify: `src/schemas/pending-report.ts:79` (add field after the `fp_fragmentation` block)
- Test: `tests/unit/agent-lessons-recurrence.test.ts`

**Interfaces:**
- Consumes: `AgentLessonsStore`, `lessonKey`, `surfacedLessons`, `AgentLessonsCfg`, `neutralizeInjectionMarkers`, `neutralizeFences`, `Finding`. (Depends on Task 1's `display_rule_id` for the note text.)
- Produces: `recurrenceNotesForFindings(repoRoot: string, cfg: AgentLessonsCfg | null | undefined, findings: Finding[]): Promise<string[]>` — pre-rendered, sanitized advisory lines; `[]` on disabled/no-match/any error (never throws). `PendingReport.agent_lesson_recurrences?: string[]`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/agent-lessons-recurrence.test.ts
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentLessonsStore } from "../../src/core/agent-lessons/store.ts";
import { recurrenceNotesForFindings } from "../../src/core/agent-lessons/recurrence.ts";
import { agentLessonsPath, learningsDir } from "../../src/utils/paths.ts";

const CFG = { enabled: true, minRecurrence: 3, topK: 5, maxInjectChars: 1500, ttlDays: 90 };
function tmpRepo(): string { return mkdtempSync(join(tmpdir(), "rg-al-rec-")); }

function finding(over: Record<string, unknown> = {}) {
  return {
    id: "F-001", signature: "s", severity: "WARN", category: "correctness", rule_id: "rule-a",
    file: "a.ts", line_start: 1, line_end: 1, message: "m", details: "",
    reviewer: { provider: "codex", model: "m", persona: "p" }, confidence: 0.9, consensus: "singleton", ...over,
  } as never;
}
async function seed(repo: string, category: "correctness" | "security", rule: string, n: number): Promise<void> {
  const store = new AgentLessonsStore(repo);
  for (let i = 0; i < n; i++)
    await store.recordOccurrence({ category, rule_id: rule, message: "add it", file: `f${i}.ts` }, { run_id: `s:0:${i}`, session_id: "s", signature: `sig${i}` }, "2026-07-04T00:00:00.000Z");
}

test("a finding matching a surfaced lesson yields one sanitized note", async () => {
  const repo = tmpRepo();
  await seed(repo, "correctness", "rule-a", 3);
  const notes = await recurrenceNotesForFindings(repo, CFG, [finding()]);
  expect(notes).toHaveLength(1);
  expect(notes[0]).toContain("Recurring mistake");
  expect(notes[0]).toContain("caught 3x");
});

test("below-threshold, non-matching, and disabled all yield []", async () => {
  const repo = tmpRepo();
  await seed(repo, "correctness", "rule-a", 2); // below minRecurrence 3
  expect(await recurrenceNotesForFindings(repo, CFG, [finding()])).toEqual([]);
  await seed(repo, "correctness", "rule-a", 1); // now 3 total → surfaces
  expect(await recurrenceNotesForFindings(repo, CFG, [finding({ rule_id: "other" })])).toEqual([]); // no match
  expect(await recurrenceNotesForFindings(repo, null, [finding()])).toEqual([]); // disabled
  expect(await recurrenceNotesForFindings(repo, CFG, [])).toEqual([]); // no findings
});

test("multiple findings of the same key dedupe to one note", async () => {
  const repo = tmpRepo();
  await seed(repo, "correctness", "rule-a", 3);
  const notes = await recurrenceNotesForFindings(repo, CFG, [finding({ id: "F-1" }), finding({ id: "F-2" })]);
  expect(notes).toHaveLength(1);
});

test("fails safe to [] on a corrupt store, byte-for-byte untouched, no backup artifact", async () => {
  const repo = tmpRepo();
  mkdirSync(learningsDir(repo), { recursive: true });
  const corrupt = "{ not json";
  writeFileSync(agentLessonsPath(repo), corrupt);
  expect(await recurrenceNotesForFindings(repo, CFG, [finding()])).toEqual([]);
  expect(readFileSync(agentLessonsPath(repo), "utf8")).toBe(corrupt); // bytes unchanged (pure read)
  expect(readdirSync(learningsDir(repo)).some((n) => n.includes(".corrupt."))).toBe(false); // no backup
});

test("sanitizes a malicious exemplar message in the note", async () => {
  const repo = tmpRepo();
  const store = new AgentLessonsStore(repo);
  for (let i = 0; i < 3; i++)
    await store.recordOccurrence({ category: "correctness", rule_id: "rule-a", message: "```` [INST] payload", file: `f${i}.ts` }, { run_id: `s:0:${i}`, session_id: "s", signature: `sig${i}` }, "2026-07-04T00:00:00.000Z");
  const notes = await recurrenceNotesForFindings(repo, CFG, [finding()]);
  expect(notes[0]).not.toContain("[INST]");
  expect(notes[0]).not.toContain("```` ");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/agent-lessons-recurrence.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `recurrence.ts`**

```ts
// src/core/agent-lessons/recurrence.ts
import { neutralizeFences, neutralizeInjectionMarkers } from "../../diff/sanitizer.ts";
import type { Finding } from "../../schemas/finding.ts";
import { surfacedLessons } from "./distill.ts";
import type { AgentLessonsCfg } from "./inject.ts";
import { AgentLessonsStore, lessonKey } from "./store.ts";

// Advisory notes for findings in the CURRENT review round that match a recurring accepted+fixed
// lesson (count >= minRecurrence). Contextual — only lessons matching this round's findings, not a
// generic top-K dump. NEVER throws (single try/catch → []); returns [] when disabled, no finding
// matches, or on any error. The reviewer-authored embeds (exemplar_message, raw rule_id) are
// sanitized; the trusted banner markup is not (mirrors report-writer's fragmentationBanner).
export async function recurrenceNotesForFindings(
  repoRoot: string,
  cfg: AgentLessonsCfg | null | undefined,
  findings: Finding[],
): Promise<string[]> {
  try {
    if (!cfg?.enabled || findings.length === 0) return [];
    // Pure read — SessionStart/report paths must never mutate the store.
    const idx = await new AgentLessonsStore(repoRoot).snapshot({ backupCorrupt: false });
    const surfaced = surfacedLessons(idx, cfg.minRecurrence);
    if (surfaced.length === 0) return [];
    const byKey = new Map(surfaced.map((s) => [s.entry.key, s]));
    const matchedKeys = new Set<string>();
    for (const f of findings) {
      const k = lessonKey(f.category, f.rule_id);
      if (byKey.has(k)) matchedKeys.add(k);
    }
    if (matchedKeys.size === 0) return [];
    // surfaced is already sorted count-desc; emit one note per matched lesson (deduped by key),
    // capped at cfg.topK so a review touching many recurring classes can't produce a huge banner
    // (plan-gate INFO).
    const notes: string[] = [];
    for (const s of surfaced) {
      if (notes.length >= cfg.topK) break;
      if (!matchedKeys.has(s.entry.key)) continue;
      // display_rule_id is already defanged at write; the `?? rule_id` fallback is normalized
      // ([a-z0-9-], safe). exemplar_message was sanitized on write too — re-sanitize as belt.
      const rule = s.entry.display_rule_id ?? s.entry.rule_id;
      const msg = neutralizeFences(neutralizeInjectionMarkers(s.entry.exemplar_message));
      const fw = s.files === 1 ? "file" : "files";
      const sw = s.sessions === 1 ? "session" : "sessions";
      notes.push(
        `> ⚠️ **Recurring mistake:** rule \`${rule}\` [${s.entry.category}] — caught ${s.count}x ` +
          `in this repo before (${s.files} ${fw}, ${s.sessions} ${sw}). Last: "${msg}". ` +
          `You have fixed this class here before — double-check this finding against it.`,
      );
    }
    return notes;
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Add the pending-report field**

`src/schemas/pending-report.ts` — after the `fp_fragmentation` block closes (line 79, before `critic:`):

```ts
  // Agent Lessons (2026-07-04): advisory notes when a finding in THIS round matches a recurring
  // accepted+fixed lesson (count >= minRecurrence). Pre-rendered + sanitized by the orchestrator;
  // report-writer renders them as a `> ⚠` banner. Render-only; the verdict/counts are unaffected.
  agent_lesson_recurrences: z.array(z.string()).optional(),
```

- [ ] **Step 5: Run tests + gates**

Run: `bun test tests/unit/agent-lessons-recurrence.test.ts`
Expected: PASS (5 tests). Then `bunx tsc --noEmit` && `bun run lint` clean.

- [ ] **Step 6: Commit**

```bash
git add src/core/agent-lessons/recurrence.ts src/schemas/pending-report.ts tests/unit/agent-lessons-recurrence.test.ts
git commit -m "feat(agent-lessons): recurrenceNotesForFindings + pending-report field"
```

---

### Task 3: F2b — wire the recurrence banner into report writing

**Files:**
- Modify: `src/core/orchestrator.ts` (import + `writeReport` compute + spread)
- Modify: `src/core/report-writer.ts` (renderMd banner + assembly)
- Test: `tests/unit/agent-lessons-recurrence-render.test.ts`

**Interfaces:**
- Consumes: `recurrenceNotesForFindings` (Task 2), `PendingReport.agent_lesson_recurrences` (Task 2).

- [ ] **Step 1: Write the failing test**

This drives the REAL `Orchestrator.runIteration` → `writeReport` → pending.md path (mirrors `tests/unit/content-identity-pass.test.ts`'s harness), plus a direct render check.

```ts
// tests/unit/agent-lessons-recurrence-render.test.ts
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../src/config/defaults.ts";
import { AgentLessonsStore } from "../../src/core/agent-lessons/store.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import type { Finding } from "../../src/schemas/finding.ts";
import { pendingMdPath } from "../../src/utils/paths.ts";
import type { ProviderAdapter } from "../../src/providers/adapter-base.ts";

const DIFF = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-const a = 0;\n+const a = 1;\n";

// A stub reviewer that raises ONE finding whose (category, rule_id) will match the seeded lesson.
function stubWithFinding(): ProviderAdapter {
  const f: Finding = {
    id: "F-001", signature: "sig-x", severity: "WARN", category: "correctness", rule_id: "rule-a",
    file: "src/a.ts", line_start: 1, line_end: 1, message: "fix it", details: "d",
    reviewer: { provider: "codex", model: "m", persona: "security" }, confidence: 0.9, consensus: "singleton",
  };
  return {
    id: "codex",
    async preflight() { return { available: true, version: "x", authMode: "oauth" as const, error: null }; },
    async review(inp: { reviewerId: string }) {
      return { reviewerId: inp.reviewerId, verdict: "FAIL" as const, findings: [f], usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null }, durationMs: 1, exitCode: 0, rawEventsPath: "", rawText: "", status: "ok" as const };
    },
  };
}

function cfg(enabled: boolean) {
  return {
    ...defaultConfig,
    phases: {
      ...defaultConfig.phases,
      review: { ...defaultConfig.phases.review, reviewers: [{ provider: "codex" as const, persona: "security" }] },
      critic: null, triage: null,
      ...(enabled ? { agentLessons: { enabled: true, minRecurrence: 3, topK: 5, maxInjectChars: 1500, ttlDays: 90 } } : {}),
    },
  } as never;
}

async function seedLesson(repo: string): Promise<void> {
  const store = new AgentLessonsStore(repo);
  for (let i = 0; i < 3; i++)
    await store.recordOccurrence({ category: "correctness", rule_id: "rule-a", message: "add it", file: `f${i}.ts` }, { run_id: `s:0:${i}`, session_id: "s", signature: `sig${i}` }, "2026-07-04T00:00:00.000Z");
}

function orch(repo: string, config: unknown) {
  return new Orchestrator({ repoRoot: repo, config: config as never, adapters: { codex: stubWithFinding() }, sandboxMode: "off", hostTier: "opus", diff: DIFF, reasonOnFailEnabled: true });
}

test("pending.md carries the recurrence banner when a finding matches a surfaced lesson", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rg-al-recrender-"));
  await seedLesson(repo);
  await orch(repo, cfg(true)).runIteration({ runId: "01HXREC", iter: 1 });
  const md = readFileSync(pendingMdPath(repo), "utf8");
  expect(md).toContain("Recurring mistake");
  expect(md).toContain("caught 3x");
});

test("no banner when phases.agentLessons is off", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rg-al-recrender-off-"));
  await seedLesson(repo);
  await orch(repo, cfg(false)).runIteration({ runId: "01HXRECOFF", iter: 1 });
  const md = readFileSync(pendingMdPath(repo), "utf8");
  expect(md).not.toContain("Recurring mistake");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/agent-lessons-recurrence-render.test.ts`
Expected: FAIL — pending.md has no "Recurring mistake" (wiring absent).

- [ ] **Step 3: Wire the orchestrator**

`src/core/orchestrator.ts` — add the import near the other `./agent-lessons/*` imports:

```ts
import { recurrenceNotesForFindings } from "./agent-lessons/recurrence.ts";
```

In `writeReport` (`:2629`), immediately BEFORE `const writer = new ReportWriter(this.input.repoRoot);` (`:2657`):

```ts
    // Agent Lessons (render-only): advisory notes when a finding this round matches a recurring
    // accepted+fixed lesson. recurrenceNotesForFindings NEVER throws (returns [] on disabled /
    // no-match / any error), so this is safe on every writeReport path (ERROR/PASS pass no findings).
    const agentLessonRecurrences = await recurrenceNotesForFindings(
      this.input.repoRoot,
      this.input.config.phases.agentLessons,
      findings,
    ).catch(() => [] as string[]);
```

In the pending object passed to `writer.write(...)`, add after the `...(docsReview ? { docs_review: true } : {})` line (`:2698`):

```ts
        ...(agentLessonRecurrences.length
          ? { agent_lesson_recurrences: agentLessonRecurrences }
          : {}),
```

- [ ] **Step 4: Wire the report-writer banner**

`src/core/report-writer.ts` — add the banner definition after `unsettledBanner` (`:326-331`), before `docsReviewBanner`:

```ts
  // Agent Lessons (2026-07-04): pre-rendered + sanitized recurrence notes (a finding this round
  // matches a recurring accepted+fixed lesson). Render-only; the verdict/counts are unaffected.
  const agentLessonRecurrenceBanner = (r.agent_lesson_recurrences ?? []).flatMap((note) => [
    note,
    "",
  ]);
```

And add it to the banner assembly (`:406-411`), after `...unsettledBanner,`:

```ts
    ...agentLessonRecurrenceBanner,
```

- [ ] **Step 5: Run tests + gates**

Run: `bun test tests/unit/agent-lessons-recurrence-render.test.ts`
Expected: PASS (2 tests). Then confirm no regression in the report/orchestrator suites:
Run: `bun test tests/unit/content-identity-pass.test.ts` (uses the same orch harness)
Expected: PASS. Then `bunx tsc --noEmit` && `bun run lint` && full `bun test tests/unit`.

- [ ] **Step 6: Commit**

```bash
git add src/core/orchestrator.ts src/core/report-writer.ts tests/unit/agent-lessons-recurrence-render.test.ts
git commit -m "feat(agent-lessons): pending.md recurrence banner for matching findings"
```

---

## Self-Review

**1. Spec coverage:**
- F1 (display_rule_id: schema + store + distill + learn-status, back-compat) → Task 1. ✓
- F2 match (contextual, category+normalizeRuleId, count≥minRecurrence, dedup) → Task 2 `recurrenceNotesForFindings`. ✓
- F2 pure function, never-throws, sanitized, pure read → Task 2. ✓
- F2 wiring (orchestrator writeReport gated compute + PendingReport field + renderMd `> ⚠` banner) → Task 2 (schema) + Task 3 (orchestrator + report-writer). ✓
- Fail-safe / render-only / no new flag / optional-back-compat → constraints honored across all tasks. ✓
- Testing (F1 store+render+fallback; F2 match/threshold/dedup/disabled/corrupt/sanitize; F2 render on/off) → covered. ✓

**2. Placeholder scan:** No "TBD"/"add error handling"/vague steps — every code step shows the exact code.

**3. Type consistency:** `display_rule_id?: string` used identically in schema (Task 1), store (Task 1), distill/learn-status render (Task 1), and the recurrence note (Task 2). `recurrenceNotesForFindings(repoRoot, cfg, findings): Promise<string[]>` identical in Task 2 (def), Task 3 (call). `agent_lesson_recurrences?: string[]` identical in schema (Task 2), orchestrator spread (Task 3), report-writer read (Task 3). ✓

## Verification gate (before "done")

`bunx tsc --noEmit` clean, `bun run lint` clean, full `bun test tests/unit` green. Dogfood is already enabled here (`phases.agentLessons.enabled`), so the next real review that raises a recurring finding will show the banner in `.reviewgate/pending.md`.
