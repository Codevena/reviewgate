# Agent Lessons v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture the agent's accepted+fixed findings, detect recurring mistake patterns deterministically, and inject them back to Claude at SessionStart as advisory (never verdict-affecting) context.

**Architecture:** A new isolated module `src/core/agent-lessons/` mirrors `src/core/fp-ledger/`: a flock-guarded single-JSON store (`store.ts`), an accepted+fixed decision fold (`learn.ts`), a deterministic recurrence distiller (`distill.ts`), and a fail-safe SessionStart injection builder (`inject.ts`). Collection is wired into `LoopDriver.absorbPriorDecisions`; injection into the reset branch of `runGate`. Opt-in via `phases.agentLessons` (null = off).

**Tech Stack:** Bun + TypeScript, zod schemas, `node:crypto` sha256, `node:fs` atomic writes, the repo's `flock` util, `bun:test`.

## Global Constraints

- Runtime is **Bun**. Use `bun`/`bunx`, `bun test` — never npm/node/jest.
- **House principle (non-negotiable):** this feature is **render-only / advisory, NEVER verdict-affecting, and fail-safe**. No code path may block a review, change a verdict, or break session startup. Collection is `.catch()`-guarded; injection is wrapped in one `try/catch` that returns `""` on any error.
- **Default OFF / opt-in:** `phases.agentLessons` is a nullable-object subsystem, `null = off`, mirroring `phases.fpLedger` exactly.
- **Recurrence key = `(category, normalizeRuleId(rule_id))`** (cross-file). **`minRecurrence` default = 3.** Injection text is **English**.
- **Findings with an empty `rule_id` are skipped** in v1.
- Reviewer-authored text (`exemplar_message`) is sanitized with `neutralizeInjectionMarkers` + `neutralizeFences` (`src/diff/sanitizer.ts`) **on write AND at injection**, and clamped to ≤200 chars.
- Store persistence mirrors `FpLedgerStore`: flock, atomic tmp+rename, mode `0o600`, corrupt-file backup, and a transient-I/O read error is **rethrown** (never misread as empty → never wipes real data). **No per-entry occurrence cap** (would break `(run_id, signature)` dedup); TTL-prune only.
- Before any task is "done": `bunx tsc --noEmit` **and** `bun run lint` must be clean; run the affected tests. Run the full `bun test` after the config/schema tasks.
- Commits: **no `Co-Authored-By`/"powered by" line**. **Never `git add -A`** (it tracks `.reviewgate/` state) — add the exact files each step lists.

## Reference: reused APIs (verified against the current tree)

- `flock(path: string): Promise<{ release(): Promise<void> }>` — `src/utils/flock.ts`.
- `foldLastDecisions(content: string): Map<string, DecisionEntry>` — `src/core/fp-ledger/decision-fold.ts` (last-valid-line-per-`finding_id` wins).
- `decisionsPath(repoRoot, iter)`, `pendingJsonPath(repoRoot)`, `learningsDir(repoRoot)` — `src/utils/paths.ts`.
- `neutralizeInjectionMarkers(text): string`, `neutralizeFences(s): string` — `src/diff/sanitizer.ts`.
- `parseHookStdin(raw: string): unknown` — `src/hooks/handlers.ts` (exported; returns parsed JSON or `null`).
- `Finding` fields used: `id`, `signature`, `category` (`FindingCategory` enum), `rule_id`, `file`, `message` (≤200). — `src/schemas/finding.ts`.
- `DecisionEntry` accepted branch: `verdict:"accepted"`, `action:"fixed" | …` — `src/schemas/decision.ts`.
- Loop call-site context: `absorbPriorDecisions(state)` at `src/core/loop-driver.ts:2095`; uses `state.iteration`, `state.session_id`, `state.reputation_cycle_seq`; gated blocks `.catch(() => undefined)`.
- Gate reset branch: `src/cli/commands/gate.ts:310-341` returns `{ exitCode: 0, stdout: "", stderr }`; `cfg` (loaded config) is in scope; `src/cli/index.ts:102` already does `if (res.stdout) process.stdout.write(res.stdout)`.

---

### Task 1: Foundations — schema, paths, `normalizeRuleId` export, config

**Files:**
- Create: `src/schemas/agent-lessons.ts`
- Modify: `src/utils/paths.ts` (append after line 95, near the other `learnings/` paths)
- Modify: `src/diff/signature.ts:62` (add `export` to `normalizeRuleId`)
- Modify: `src/config/define-config.ts` (after the `fpLedger` line, `:242`)
- Test: `tests/unit/agent-lessons-schema.test.ts`

**Interfaces:**
- Produces: `AgentLessonsIndexSchema`, `LessonEntrySchema`, `LessonOccurrenceSchema`, types `AgentLessonsIndex`, `LessonEntry`, `LessonOccurrence`; `agentLessonsPath(repoRoot)`, `agentLessonsLockPath(repoRoot)`; `export function normalizeRuleId`; config `phases.agentLessons`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/agent-lessons-schema.test.ts
import { expect, test } from "bun:test";
import { AgentLessonsIndexSchema } from "../../src/schemas/agent-lessons.ts";
import { defineConfig } from "../../src/config/define-config.ts";
import { agentLessonsPath, agentLessonsLockPath } from "../../src/utils/paths.ts";
import { normalizeRuleId } from "../../src/diff/signature.ts";

test("agent-lessons index round-trips", () => {
  const idx = {
    schema: "reviewgate.agentlessons.v1",
    seq: 1,
    entries: [
      {
        id: "AL-001",
        key: "abc",
        category: "correctness",
        rule_id: "missing-additionalproperties",
        occurrences: [
          { run_id: "s:0:1", session_id: "s", signature: "sig1", file: "a.ts", ts: "2026-07-03T00:00:00.000Z" },
        ],
        exemplar_message: "add additionalProperties:false",
        first_seen_at: "2026-07-03T00:00:00.000Z",
        last_seen_at: "2026-07-03T00:00:00.000Z",
      },
    ],
  };
  expect(AgentLessonsIndexSchema.parse(idx)).toEqual(idx);
});

test("paths live under learnings/", () => {
  expect(agentLessonsPath("/repo")).toBe("/repo/.reviewgate/learnings/agent-lessons.json");
  expect(agentLessonsLockPath("/repo")).toBe("/repo/.reviewgate/learnings/.agent-lessons.lock");
});

test("normalizeRuleId is exported and canonicalizes", () => {
  expect(normalizeRuleId("Missing AdditionalProperties")).toBe(normalizeRuleId("missing-additionalproperties"));
});

test("phases.agentLessons defaults to null (off)", () => {
  const cfg = defineConfig({});
  expect(cfg.phases.agentLessons ?? null).toBeNull();
});

test("phases.agentLessons fills inner defaults when enabled", () => {
  const cfg = defineConfig({ phases: { agentLessons: { enabled: true } } as never });
  expect(cfg.phases.agentLessons).toMatchObject({ enabled: true, minRecurrence: 3, topK: 5, maxInjectChars: 1500, ttlDays: 90 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/agent-lessons-schema.test.ts`
Expected: FAIL — `Cannot find module '../../src/schemas/agent-lessons.ts'` and `normalizeRuleId` not exported.

- [ ] **Step 3: Create the schema**

```ts
// src/schemas/agent-lessons.ts
import { z } from "zod";
import { FindingCategory } from "./finding.ts";

export const LessonOccurrenceSchema = z.object({
  run_id: z.string(),
  session_id: z.string(),
  signature: z.string(),
  file: z.string(),
  ts: z.string(),
});
export type LessonOccurrence = z.infer<typeof LessonOccurrenceSchema>;

export const LessonEntrySchema = z.object({
  id: z.string(), // "AL-NNN"
  key: z.string(), // sha256(category + "|" + normalizeRuleId(rule_id))
  category: FindingCategory,
  rule_id: z.string(),
  occurrences: z.array(LessonOccurrenceSchema),
  exemplar_message: z.string(),
  first_seen_at: z.string(),
  last_seen_at: z.string(),
});
export type LessonEntry = z.infer<typeof LessonEntrySchema>;

export const AgentLessonsIndexSchema = z.object({
  schema: z.literal("reviewgate.agentlessons.v1"),
  entries: z.array(LessonEntrySchema),
  // Monotonic high-water for AL-NNN allocation (never reuse a pruned id). Optional
  // for back-compat with a store written before `seq` existed.
  seq: z.number().int().nonnegative().optional(),
});
export type AgentLessonsIndex = z.infer<typeof AgentLessonsIndexSchema>;
```

- [ ] **Step 4: Add path helpers**

Append to `src/utils/paths.ts` right after `implicitOutcomesLockPath` (line 95):

```ts
// Agent Lessons v1 — repo-memory of the agent's accepted+fixed mistakes. Single
// JSON document (one AgentLessonsIndex) alongside the FP-ledger; same learnings/ dir.
export function agentLessonsPath(repoRoot: string): string {
  return join(learningsDir(repoRoot), "agent-lessons.json");
}
export function agentLessonsLockPath(repoRoot: string): string {
  return join(learningsDir(repoRoot), ".agent-lessons.lock");
}
```

- [ ] **Step 5: Export `normalizeRuleId`**

`src/diff/signature.ts:62` — change `function normalizeRuleId(raw: string): string {` to:

```ts
export function normalizeRuleId(raw: string): string {
```

- [ ] **Step 6: Add the config phase**

`src/config/define-config.ts` — insert immediately after the `fpLedger` line (`:242`):

```ts
    // Agent Lessons v1: collect accepted+fixed findings → deterministic recurrence →
    // SessionStart advisory injection. Render-only, never verdict-affecting. Opt-in
    // (null = off), mirroring fpLedger's nullable-object shape.
    agentLessons: z
      .object({
        enabled: z.boolean(),
        minRecurrence: z.number().int().min(1).default(3),
        topK: z.number().int().min(1).default(5),
        maxInjectChars: z.number().int().min(200).default(1500),
        ttlDays: z.number().int().min(1).default(90),
      })
      .nullable()
      .default(null)
      .optional(),
```

- [ ] **Step 7: Run test to verify it passes**

Run: `bun test tests/unit/agent-lessons-schema.test.ts`
Expected: PASS (5 tests).

If `defineConfig` is not the exported name, use the actual export from `src/config/define-config.ts` (grep `export function defineConfig` / `export const ConfigSchema`); the test only needs to parse `{}` and `{ phases: { agentLessons: { enabled: true } } }` through the effective-config schema.

- [ ] **Step 8: Typecheck, lint, commit**

```bash
bunx tsc --noEmit && bun run lint
git add src/schemas/agent-lessons.ts src/utils/paths.ts src/diff/signature.ts src/config/define-config.ts tests/unit/agent-lessons-schema.test.ts
git commit -m "feat(agent-lessons): schema, paths, config phase, export normalizeRuleId"
```

---

### Task 2: `AgentLessonsStore`

**Files:**
- Create: `src/core/agent-lessons/store.ts`
- Test: `tests/unit/agent-lessons-store.test.ts`

**Interfaces:**
- Consumes: `AgentLessonsIndexSchema`, `agentLessonsPath`, `agentLessonsLockPath`, `learningsDir`, `flock`, `normalizeRuleId`.
- Produces:
  - `lessonKey(category: string, ruleId: string): string`
  - `class AgentLessonsStore(repoRoot: string)` with:
    - `snapshot(): Promise<AgentLessonsIndex>`
    - `recordOccurrence(meta: OccurrenceMeta, occ: { run_id, session_id, signature }, nowIso: string): Promise<void>`
    - `decayPass(nowIso: string, ttlDays: number): Promise<void>`
  - `interface OccurrenceMeta { category: FindingCategory; rule_id: string; message: string; file: string }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/agent-lessons-store.test.ts
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentLessonsStore } from "../../src/core/agent-lessons/store.ts";
import { agentLessonsPath, learningsDir } from "../../src/utils/paths.ts";

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "rg-al-store-"));
}
const meta = { category: "correctness" as const, rule_id: "missing-additionalproperties", message: "add it", file: "a.ts" };

test("records an occurrence and creates AL-001", async () => {
  const repo = tmpRepo();
  const store = new AgentLessonsStore(repo);
  await store.recordOccurrence(meta, { run_id: "s:0:1", session_id: "s", signature: "sig1" }, "2026-07-03T00:00:00.000Z");
  const idx = await store.snapshot();
  expect(idx.entries).toHaveLength(1);
  expect(idx.entries[0]!.id).toBe("AL-001");
  expect(idx.entries[0]!.occurrences).toHaveLength(1);
});

test("is idempotent on (run_id, signature)", async () => {
  const repo = tmpRepo();
  const store = new AgentLessonsStore(repo);
  await store.recordOccurrence(meta, { run_id: "s:0:1", session_id: "s", signature: "sig1" }, "2026-07-03T00:00:00.000Z");
  await store.recordOccurrence(meta, { run_id: "s:0:1", session_id: "s", signature: "sig1" }, "2026-07-03T00:01:00.000Z");
  const idx = await store.snapshot();
  expect(idx.entries[0]!.occurrences).toHaveLength(1); // no double-count
});

test("distinct signatures under the same key accumulate", async () => {
  const repo = tmpRepo();
  const store = new AgentLessonsStore(repo);
  await store.recordOccurrence(meta, { run_id: "s:0:1", session_id: "s", signature: "sig1" }, "2026-07-03T00:00:00.000Z");
  await store.recordOccurrence(meta, { run_id: "s:0:2", session_id: "s", signature: "sig2" }, "2026-07-03T00:00:00.000Z");
  const idx = await store.snapshot();
  expect(idx.entries).toHaveLength(1);
  expect(idx.entries[0]!.occurrences).toHaveLength(2);
});

test("decayPass drops stale occurrences and empty entries", async () => {
  const repo = tmpRepo();
  const store = new AgentLessonsStore(repo);
  await store.recordOccurrence(meta, { run_id: "s:0:1", session_id: "s", signature: "sig1" }, "2026-01-01T00:00:00.000Z");
  await store.decayPass("2026-07-03T00:00:00.000Z", 90);
  const idx = await store.snapshot();
  expect(idx.entries).toHaveLength(0);
});

test("a corrupt store is backed up and recovers empty", async () => {
  const repo = tmpRepo();
  mkdirSync(learningsDir(repo), { recursive: true });
  writeFileSync(agentLessonsPath(repo), "{ not json");
  const store = new AgentLessonsStore(repo);
  const idx = await store.snapshot();
  expect(idx.entries).toHaveLength(0);
  expect(existsSync(agentLessonsPath(repo))).toBe(false); // renamed to .corrupt.*
});

test("a read-only snapshot does NOT back up a corrupt store", async () => {
  const repo = tmpRepo();
  mkdirSync(learningsDir(repo), { recursive: true });
  writeFileSync(agentLessonsPath(repo), "{ not json");
  const idx = await new AgentLessonsStore(repo).snapshot({ backupCorrupt: false });
  expect(idx.entries).toHaveLength(0);
  expect(existsSync(agentLessonsPath(repo))).toBe(true); // untouched — no rename (pure read)
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/agent-lessons-store.test.ts`
Expected: FAIL — `Cannot find module '.../agent-lessons/store.ts'`.

- [ ] **Step 3: Implement the store**

```ts
// src/core/agent-lessons/store.ts
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { normalizeRuleId } from "../../diff/signature.ts";
import type { FindingCategory } from "../../schemas/finding.ts";
import {
  type AgentLessonsIndex,
  AgentLessonsIndexSchema,
  type LessonEntry,
} from "../../schemas/agent-lessons.ts";
import { flock } from "../../utils/flock.ts";
import { agentLessonsLockPath, agentLessonsPath, learningsDir } from "../../utils/paths.ts";

const DAY_MS = 86_400_000;
const EMPTY: AgentLessonsIndex = { schema: "reviewgate.agentlessons.v1", entries: [] };

export interface OccurrenceMeta {
  category: FindingCategory;
  rule_id: string;
  message: string; // caller sanitizes + clamps before passing
  file: string;
}

// Recurrence key: category + drift-tolerant rule_id. Same-mistake-different-line
// (distinct signatures) collapses into ONE lesson; the signature stays per-occurrence
// for idempotency only.
export function lessonKey(category: string, ruleId: string): string {
  return createHash("sha256").update(`${category}|${normalizeRuleId(ruleId)}`).digest("hex");
}

// Preserve a corrupt file for forensics before recovering empty (mirrors FpLedgerStore).
function backupCorrupt(p: string): void {
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    renameSync(p, `${p}.corrupt.${ts}`);
  } catch {
    // best-effort only
  }
}

function maxEntryId(entries: LessonEntry[]): number {
  let max = 0;
  for (const e of entries) {
    const n = Number.parseInt(e.id.replace(/^AL-/, ""), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

export class AgentLessonsStore {
  constructor(private readonly repoRoot: string) {}

  // opts.backupCorrupt === false makes this a PURE read: a corrupt file is NOT renamed
  // (no fs mutation at all). The SessionStart injection + learn-status pass this so those
  // read-only paths never mutate .reviewgate/learnings/ (plan-gate WARN). The write path
  // (mutate) uses the default true so a corrupt store self-heals on the next write.
  async snapshot(opts?: { backupCorrupt?: boolean }): Promise<AgentLessonsIndex> {
    const p = agentLessonsPath(this.repoRoot);
    if (!existsSync(p)) return EMPTY;
    let raw: string;
    try {
      raw = readFileSync(p, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return EMPTY;
      // A transient I/O error on an EXISTING store must NOT be misread as "empty" —
      // inside mutate() that empty snapshot would be atomically persisted, wiping every
      // accumulated lesson. Rethrow so the mutate fails loudly (the learn path .catch()es
      // → "no learning this round", not data loss). Mirrors FpLedgerStore.snapshot.
      throw err;
    }
    try {
      return AgentLessonsIndexSchema.parse(JSON.parse(raw));
    } catch {
      if (opts?.backupCorrupt !== false) backupCorrupt(p);
      return EMPTY;
    }
  }

  private persist(idx: AgentLessonsIndex): void {
    const p = agentLessonsPath(this.repoRoot);
    if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(idx, null, 2), { mode: 0o600 });
    renameSync(tmp, p);
  }

  async mutate<T>(
    fn: (idx: AgentLessonsIndex) => { next: AgentLessonsIndex; result: T },
  ): Promise<T> {
    if (!existsSync(learningsDir(this.repoRoot)))
      mkdirSync(learningsDir(this.repoRoot), { recursive: true });
    const lock = await flock(agentLessonsLockPath(this.repoRoot));
    try {
      const cur = await this.snapshot();
      const { next, result } = fn(structuredClone(cur));
      AgentLessonsIndexSchema.parse(next);
      this.persist(next);
      return result;
    } finally {
      await lock.release();
    }
  }

  async recordOccurrence(
    meta: OccurrenceMeta,
    occ: { run_id: string; session_id: string; signature: string },
    nowIso: string,
  ): Promise<void> {
    const key = lessonKey(meta.category, meta.rule_id);
    await this.mutate((idx) => {
      let e = idx.entries.find((x) => x.key === key);
      if (!e) {
        const nextNum = Math.max(idx.seq ?? 0, maxEntryId(idx.entries)) + 1;
        idx.seq = nextNum;
        e = {
          id: `AL-${String(nextNum).padStart(3, "0")}`,
          key,
          category: meta.category,
          rule_id: normalizeRuleId(meta.rule_id),
          occurrences: [],
          exemplar_message: meta.message,
          first_seen_at: nowIso,
          last_seen_at: nowIso,
        };
        idx.entries.push(e);
      }
      // Idempotent on (run_id, signature): re-absorbing the same iteration's decisions
      // (e.g. an escalated gate re-firing its stop-hook before commit-recovery) must not
      // double-count. Mirrors the FP-ledger's (run_id, provider) dedup — and is why we
      // never cap occurrences (a dropped occurrence could no longer be seen as a dup).
      const dup = e.occurrences.some(
        (o) => o.run_id === occ.run_id && o.signature === occ.signature,
      );
      // True no-op on re-absorb. Unlike the FP-ledger (whose candidate decay keys on
      // entry.last_seen_at, so it bumps it here), our TTL decay keys on each
      // occurrence.ts — so a duplicate must touch NOTHING, or it would nudge the
      // ranking recency tiebreak without a real new occurrence (plan-gate WARN).
      if (dup) return { next: idx, result: undefined };
      e.occurrences.push({
        run_id: occ.run_id,
        session_id: occ.session_id,
        signature: occ.signature,
        file: meta.file,
        ts: nowIso,
      });
      e.exemplar_message = meta.message; // most-recent sanitized message wins
      e.last_seen_at = nowIso;
      return { next: idx, result: undefined };
    });
  }

  // TTL decay: drop occurrences older than ttlDays; an entry left with none is removed.
  async decayPass(nowIso: string, ttlDays: number): Promise<void> {
    const nowMs = Date.parse(nowIso);
    await this.mutate((idx) => {
      const entries: LessonEntry[] = [];
      for (const e of idx.entries) {
        const kept = e.occurrences.filter((o) => (nowMs - Date.parse(o.ts)) / DAY_MS <= ttlDays);
        if (kept.length === 0) continue;
        // Re-derive the seen-at bounds from the SURVIVING occurrences so ranking/display
        // metadata never references a pruned event (plan-gate INFO).
        const times = kept.map((o) => Date.parse(o.ts)).sort((a, b) => a - b);
        entries.push({
          ...e,
          occurrences: kept,
          first_seen_at: new Date(times[0]!).toISOString(),
          last_seen_at: new Date(times[times.length - 1]!).toISOString(),
        });
      }
      return { next: { ...idx, entries }, result: undefined };
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/agent-lessons-store.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck, lint, commit**

```bash
bunx tsc --noEmit && bun run lint
git add src/core/agent-lessons/store.ts tests/unit/agent-lessons-store.test.ts
git commit -m "feat(agent-lessons): flock-guarded store with idempotent record + TTL decay"
```

---

### Task 3: Collect — `learnLessonsFromDecisions`

**Files:**
- Create: `src/core/agent-lessons/learn.ts`
- Test: `tests/unit/agent-lessons-learn.test.ts`

**Interfaces:**
- Consumes: `AgentLessonsStore`, `foldLastDecisions`, `decisionsPath`, `pendingJsonPath`, `neutralizeInjectionMarkers`, `neutralizeFences`, `Finding`.
- Produces: `learnLessonsFromDecisions(input: { repoRoot, prevIter, sessionId, cycleSeq, store: AgentLessonsStore, nowIso }): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/agent-lessons-learn.test.ts
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentLessonsStore } from "../../src/core/agent-lessons/store.ts";
import { learnLessonsFromDecisions } from "../../src/core/agent-lessons/learn.ts";
import { decisionsPath, pendingJsonPath, decisionsDir, reviewgateDir } from "../../src/utils/paths.ts";

function finding(over: Record<string, unknown> = {}) {
  return {
    id: "F-001", signature: "sig1", severity: "WARN", category: "correctness", rule_id: "missing-additionalproperties",
    file: "a.ts", line_start: 1, line_end: 1, message: "add additionalProperties:false", details: "",
    reviewer: { provider: "codex", model: "m", persona: "p" }, confidence: 0.9, consensus: "singleton", ...over,
  };
}
function seed(repo: string, findings: unknown[], decisions: string) {
  mkdirSync(reviewgateDir(repo), { recursive: true });
  mkdirSync(decisionsDir(repo), { recursive: true });
  writeFileSync(pendingJsonPath(repo), JSON.stringify({ findings }));
  writeFileSync(decisionsPath(repo, 1), decisions);
}
function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "rg-al-learn-"));
}
const D = (o: Record<string, unknown>) => JSON.stringify({ schema: "reviewgate.decision.v1", ...o });

test("folds an accepted+fixed finding", async () => {
  const repo = tmpRepo();
  seed(repo, [finding()], D({ finding_id: "F-001", verdict: "accepted", action: "fixed" }));
  const store = new AgentLessonsStore(repo);
  await learnLessonsFromDecisions({ repoRoot: repo, prevIter: 1, sessionId: "s", cycleSeq: 0, store, nowIso: "2026-07-03T00:00:00.000Z" });
  const idx = await store.snapshot();
  expect(idx.entries).toHaveLength(1);
  expect(idx.entries[0]!.exemplar_message).toBe("add additionalProperties:false");
});

test("ignores rejected and accepted-but-not-fixed", async () => {
  const repo = tmpRepo();
  seed(
    repo,
    [finding({ id: "F-001" }), finding({ id: "F-002" })],
    [
      D({ finding_id: "F-001", verdict: "rejected", reason: "reviewer hallucinated the missing key here" }),
      D({ finding_id: "F-002", verdict: "accepted", action: "deferred-with-followup" }),
    ].join("\n"),
  );
  const store = new AgentLessonsStore(repo);
  await learnLessonsFromDecisions({ repoRoot: repo, prevIter: 1, sessionId: "s", cycleSeq: 0, store, nowIso: "2026-07-03T00:00:00.000Z" });
  expect((await store.snapshot()).entries).toHaveLength(0);
});

test("skips findings with an empty rule_id", async () => {
  const repo = tmpRepo();
  seed(repo, [finding({ rule_id: "" })], D({ finding_id: "F-001", verdict: "accepted", action: "fixed" }));
  const store = new AgentLessonsStore(repo);
  await learnLessonsFromDecisions({ repoRoot: repo, prevIter: 1, sessionId: "s", cycleSeq: 0, store, nowIso: "2026-07-03T00:00:00.000Z" });
  expect((await store.snapshot()).entries).toHaveLength(0);
});

test("sanitizes the exemplar message", async () => {
  const repo = tmpRepo();
  seed(repo, [finding({ message: "```` fenced [INST] payload" })], D({ finding_id: "F-001", verdict: "accepted", action: "fixed" }));
  const store = new AgentLessonsStore(repo);
  await learnLessonsFromDecisions({ repoRoot: repo, prevIter: 1, sessionId: "s", cycleSeq: 0, store, nowIso: "2026-07-03T00:00:00.000Z" });
  const msg = (await store.snapshot()).entries[0]!.exemplar_message;
  expect(msg).not.toContain("```` ");
  expect(msg).not.toContain("[INST]");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/agent-lessons-learn.test.ts`
Expected: FAIL — `Cannot find module '.../agent-lessons/learn.ts'`.

- [ ] **Step 3: Implement the fold**

```ts
// src/core/agent-lessons/learn.ts
import { existsSync, readFileSync } from "node:fs";
import { neutralizeFences, neutralizeInjectionMarkers } from "../../diff/sanitizer.ts";
import { normalizeRuleId } from "../../diff/signature.ts";
import type { Finding } from "../../schemas/finding.ts";
import { decisionsPath, pendingJsonPath } from "../../utils/paths.ts";
import { foldLastDecisions } from "../fp-ledger/decision-fold.ts";
import type { AgentLessonsStore } from "./store.ts";

// The accepted+fixed twin of learnFromDecisions (which folds reviewer FALSE-positives).
// The high-value signal here is the opposite: a finding the agent ACCEPTED and FIXED —
// a verified, categorized, located, REAL mistake. Non-blocking; the caller .catch()es.
export async function learnLessonsFromDecisions(input: {
  repoRoot: string;
  prevIter: number;
  sessionId: string;
  cycleSeq: number;
  store: AgentLessonsStore;
  nowIso: string;
}): Promise<void> {
  const { repoRoot, prevIter, sessionId, cycleSeq, store, nowIso } = input;
  if (prevIter < 1) return;

  const dp = decisionsPath(repoRoot, prevIter);
  const pp = pendingJsonPath(repoRoot);
  if (!existsSync(dp) || !existsSync(pp)) return;

  let findings: Finding[] = [];
  try {
    const r = JSON.parse(readFileSync(pp, "utf8")) as { findings?: Finding[] };
    findings = Array.isArray(r.findings) ? r.findings : [];
  } catch {
    return;
  }
  const byId = new Map(findings.map((f) => [f.id, f]));

  // Fold to the LAST valid decision per finding_id (same contract as the FP-ledger
  // learn path): a rejected→later-accepted retraction must reflect the agent's FINAL intent.
  for (const d of foldLastDecisions(readFileSync(dp, "utf8")).values()) {
    if (d.verdict !== "accepted" || d.action !== "fixed") continue;
    const f = byId.get(d.finding_id);
    if (!f) continue;
    // Skip rule-less findings — raw-empty/whitespace OR anything whose NORMALIZED rule_id
    // is empty (spec wording). Either would collapse into a coarse category-only bucket
    // (`category|`) instead of a specific, actionable lesson. The store keys on
    // normalizeRuleId(rule_id), so this guard matches the actual bucket key.
    if (f.rule_id.trim() === "" || normalizeRuleId(f.rule_id) === "") continue;
    // Sanitize reviewer-authored text into trusted context (same pattern as report-writer/
    // research-writer), and clamp — Finding.message is already ≤200 but be defensive.
    const message = neutralizeFences(neutralizeInjectionMarkers(f.message)).slice(0, 200);
    // run_id keys the (run_id, signature) idempotency; unique per (session, cycle, iter),
    // stable on re-absorb of the same one. Mirrors reputation/fp-ledger eid construction.
    await store.recordOccurrence(
      { category: f.category, rule_id: f.rule_id, message, file: f.file },
      { run_id: `${sessionId}:${cycleSeq}:${prevIter}`, session_id: sessionId, signature: f.signature },
      nowIso,
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/agent-lessons-learn.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck, lint, commit**

```bash
bunx tsc --noEmit && bun run lint
git add src/core/agent-lessons/learn.ts tests/unit/agent-lessons-learn.test.ts
git commit -m "feat(agent-lessons): collect accepted+fixed findings from decisions"
```

---

### Task 4: Distill — `surfacedLessons` + `renderLesson`

**Files:**
- Create: `src/core/agent-lessons/distill.ts`
- Test: `tests/unit/agent-lessons-distill.test.ts`

**Interfaces:**
- Consumes: `AgentLessonsIndex`, `LessonEntry`.
- Produces:
  - `interface SurfacedLesson { entry: LessonEntry; count: number; sessions: number; files: number }`
  - `surfacedLessons(idx: AgentLessonsIndex, minRecurrence: number): SurfacedLesson[]` (filtered `count >= minRecurrence`, ranked count desc then last_seen_at desc)
  - `renderLesson(l: SurfacedLesson): string`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/agent-lessons-distill.test.ts
import { expect, test } from "bun:test";
import { renderLesson, surfacedLessons } from "../../src/core/agent-lessons/distill.ts";
import type { AgentLessonsIndex } from "../../src/schemas/agent-lessons.ts";

function entry(id: string, rule: string, occ: Array<{ s: string; f: string; ts: string }>) {
  return {
    id, key: id, category: "correctness" as const, rule_id: rule,
    occurrences: occ.map((o, i) => ({ run_id: `${o.s}:0:${i}`, session_id: o.s, signature: `${id}-${i}`, file: o.f, ts: o.ts })),
    exemplar_message: `msg-${rule}`,
    first_seen_at: occ[0]!.ts, last_seen_at: occ[occ.length - 1]!.ts,
  };
}
const idx: AgentLessonsIndex = {
  schema: "reviewgate.agentlessons.v1",
  entries: [
    entry("AL-001", "rule-a", [ { s: "s1", f: "a.ts", ts: "2026-07-01T00:00:00.000Z" }, { s: "s2", f: "b.ts", ts: "2026-07-02T00:00:00.000Z" }, { s: "s2", f: "a.ts", ts: "2026-07-03T00:00:00.000Z" } ]),
    entry("AL-002", "rule-b", [ { s: "s1", f: "c.ts", ts: "2026-07-01T00:00:00.000Z" } ]),
  ],
};

test("surfaces only entries at or above minRecurrence, ranked by count", () => {
  const s = surfacedLessons(idx, 3);
  expect(s).toHaveLength(1);
  expect(s[0]!.entry.id).toBe("AL-001");
  expect(s[0]!.count).toBe(3);
  expect(s[0]!.sessions).toBe(2);
  expect(s[0]!.files).toBe(2);
});

test("renderLesson is a deterministic imperative one-liner", () => {
  const s = surfacedLessons(idx, 3)[0]!;
  expect(renderLesson(s)).toBe(
    '- [correctness] rule "rule-a" - caught 3x in this repo (2 files, 2 sessions). Last: "msg-rule-a". Check for this before ending your turn.',
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/agent-lessons-distill.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the distiller**

```ts
// src/core/agent-lessons/distill.ts
import type { AgentLessonsIndex, LessonEntry } from "../../schemas/agent-lessons.ts";

export interface SurfacedLesson {
  entry: LessonEntry;
  count: number; // derived: occurrences.length
  sessions: number; // derived: distinct session_ids
  files: number; // derived: distinct files
}

// count / distinct_* are DERIVED here, never stored (mirrors FP-ledger deriving
// distinct_providers). A lesson surfaces when count >= minRecurrence.
export function surfacedLessons(idx: AgentLessonsIndex, minRecurrence: number): SurfacedLesson[] {
  const out: SurfacedLesson[] = [];
  for (const e of idx.entries) {
    const count = e.occurrences.length;
    if (count < minRecurrence) continue;
    out.push({
      entry: e,
      count,
      sessions: new Set(e.occurrences.map((o) => o.session_id)).size,
      files: new Set(e.occurrences.map((o) => o.file)).size,
    });
  }
  out.sort(
    (a, b) =>
      b.count - a.count ||
      Date.parse(b.entry.last_seen_at) - Date.parse(a.entry.last_seen_at),
  );
  return out;
}

export function renderLesson(l: SurfacedLesson): string {
  const { entry, count, sessions, files } = l;
  const fw = files === 1 ? "file" : "files";
  const sw = sessions === 1 ? "session" : "sessions";
  // ASCII only (no em dash / multiplication sign) — keeps the source and the injected
  // text plain, consistent with the learn-status renderer (plan-gate INFO).
  return (
    `- [${entry.category}] rule "${entry.rule_id}" - caught ${count}x in this repo ` +
    `(${files} ${fw}, ${sessions} ${sw}). ` +
    `Last: "${entry.exemplar_message}". Check for this before ending your turn.`
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/agent-lessons-distill.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck, lint, commit**

```bash
bunx tsc --noEmit && bun run lint
git add src/core/agent-lessons/distill.ts tests/unit/agent-lessons-distill.test.ts
git commit -m "feat(agent-lessons): deterministic recurrence distiller"
```

---

### Task 5: Inject — `buildSessionStartInjection`

**Files:**
- Create: `src/core/agent-lessons/inject.ts`
- Test: `tests/unit/agent-lessons-inject.test.ts`

**Interfaces:**
- Consumes: `AgentLessonsStore`, `surfacedLessons`, `renderLesson`, `neutralizeInjectionMarkers`, `neutralizeFences`.
- Produces:
  - `interface AgentLessonsCfg { enabled: boolean; minRecurrence: number; topK: number; maxInjectChars: number; ttlDays: number }`
  - `buildSessionStartInjection(input: { repoRoot: string; cfg: AgentLessonsCfg | null | undefined; source: string | null }): Promise<string>` — returns the SessionStart hook stdout (the `hookSpecificOutput` JSON, or `""`). **Never throws.**

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/agent-lessons-inject.test.ts
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentLessonsStore } from "../../src/core/agent-lessons/store.ts";
import { buildSessionStartInjection } from "../../src/core/agent-lessons/inject.ts";
import { agentLessonsPath, learningsDir } from "../../src/utils/paths.ts";

const CFG = { enabled: true, minRecurrence: 3, topK: 5, maxInjectChars: 1500, ttlDays: 90 };
function tmpRepo(): string { return mkdtempSync(join(tmpdir(), "rg-al-inject-")); }

async function seedThrice(repo: string): Promise<void> {
  const store = new AgentLessonsStore(repo);
  const meta = { category: "correctness" as const, rule_id: "rule-a", message: "add it", file: "a.ts" };
  for (let i = 0; i < 3; i++)
    await store.recordOccurrence({ ...meta, file: `f${i}.ts` }, { run_id: `s:0:${i}`, session_id: "s", signature: `sig${i}` }, "2026-07-03T00:00:00.000Z");
}

test("emits hookSpecificOutput JSON on startup", async () => {
  const repo = tmpRepo();
  await seedThrice(repo);
  const out = await buildSessionStartInjection({ repoRoot: repo, cfg: CFG, source: "startup" });
  const parsed = JSON.parse(out);
  expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
  expect(parsed.hookSpecificOutput.additionalContext).toContain('rule "rule-a"');
});

test("emits nothing on clear/compact, when disabled, or below threshold", async () => {
  const repo = tmpRepo();
  await seedThrice(repo);
  expect(await buildSessionStartInjection({ repoRoot: repo, cfg: CFG, source: "clear" })).toBe("");
  expect(await buildSessionStartInjection({ repoRoot: repo, cfg: CFG, source: "compact" })).toBe("");
  expect(await buildSessionStartInjection({ repoRoot: repo, cfg: null, source: "startup" })).toBe("");
  expect(await buildSessionStartInjection({ repoRoot: repo, cfg: { ...CFG, minRecurrence: 99 }, source: "startup" })).toBe("");
});

test("fails safe to '' on a corrupt store, and does not mutate it", async () => {
  const repo = tmpRepo();
  mkdirSync(learningsDir(repo), { recursive: true });
  writeFileSync(agentLessonsPath(repo), "{ not json");
  expect(await buildSessionStartInjection({ repoRoot: repo, cfg: CFG, source: "startup" })).toBe("");
  expect(existsSync(agentLessonsPath(repo))).toBe(true); // pure read — corrupt file untouched
});

test("respects maxInjectChars (never exceeds the cap)", async () => {
  const repo = tmpRepo();
  await seedThrice(repo);
  const out = await buildSessionStartInjection({ repoRoot: repo, cfg: { ...CFG, maxInjectChars: 200 }, source: "startup" });
  if (out !== "") {
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext as string;
    expect(ctx.length).toBeLessThanOrEqual(200);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/agent-lessons-inject.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the injector**

```ts
// src/core/agent-lessons/inject.ts
import { neutralizeFences, neutralizeInjectionMarkers } from "../../diff/sanitizer.ts";
import { renderLesson, surfacedLessons } from "./distill.ts";
import { AgentLessonsStore } from "./store.ts";

export interface AgentLessonsCfg {
  enabled: boolean;
  minRecurrence: number;
  topK: number;
  maxInjectChars: number;
  ttlDays: number;
}

const HEADER =
  "Reviewgate — recurring mistakes it has caught in this repo (advisory, not blocking):";

// Build the SessionStart hook stdout: the hookSpecificOutput JSON, or "" (a guaranteed
// no-op). NEVER throws — any error, missing/corrupt store, or empty result → "" so
// SessionStart can never break (verified: exit 0 + empty stdout = silent no-op).
export async function buildSessionStartInjection(input: {
  repoRoot: string;
  cfg: AgentLessonsCfg | null | undefined;
  source: string | null;
}): Promise<string> {
  try {
    const cfg = input.cfg;
    if (!cfg?.enabled) return "";
    // Only prime a fresh/resumed session — never re-inject mid-session on clear/compact.
    if (input.source !== "startup" && input.source !== "resume") return "";

    // Pure read (backupCorrupt:false): SessionStart must NEVER mutate the store, even to
    // back up a corrupt file. A corrupt store → EMPTY → "" (fail-safe, no fs write).
    const idx = await new AgentLessonsStore(input.repoRoot).snapshot({ backupCorrupt: false });
    const surfaced = surfacedLessons(idx, cfg.minRecurrence).slice(0, cfg.topK);
    if (surfaced.length === 0) return "";

    // Defense in depth: sanitize each rendered line even though the exemplar was
    // sanitized on write.
    const lines = surfaced.map((l) =>
      neutralizeFences(neutralizeInjectionMarkers(renderLesson(l))),
    );

    // Size cap: drop lowest-ranked lines until the block fits (keep the header).
    const kept = [...lines];
    while (kept.length > 0 && [HEADER, ...kept].join("\n").length > cfg.maxInjectChars) {
      kept.pop();
    }
    if (kept.length === 0) return "";
    const block = [HEADER, ...kept].join("\n");

    return JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: block },
    });
  } catch {
    return "";
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/agent-lessons-inject.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck, lint, commit**

```bash
bunx tsc --noEmit && bun run lint
git add src/core/agent-lessons/inject.ts tests/unit/agent-lessons-inject.test.ts
git commit -m "feat(agent-lessons): fail-safe SessionStart injection builder"
```

---

### Task 6: Wire collection into `LoopDriver.absorbPriorDecisions`

**Files:**
- Modify: `src/core/loop-driver.ts` (imports near the other `fp-ledger` imports; body at `absorbPriorDecisions`, `:2098-2113`)
- Test: `tests/unit/agent-lessons-loop-collect.test.ts`

**Interfaces:**
- Consumes: `AgentLessonsStore`, `learnLessonsFromDecisions`, `this.i.config.phases.agentLessons`, `state.iteration`, `state.session_id`, `state.reputation_cycle_seq`.

- [ ] **Step 1: Add the imports**

Near the existing `import { learnFromDecisions } from "./fp-ledger/learn.ts";` / `import { FpLedgerStore } from "./fp-ledger/store.ts";` lines in `src/core/loop-driver.ts`, add:

```ts
import { AgentLessonsStore } from "./agent-lessons/store.ts";
import { learnLessonsFromDecisions } from "./agent-lessons/learn.ts";
```

- [ ] **Step 2: Wire the collect block**

In `absorbPriorDecisions` (`src/core/loop-driver.ts`), immediately AFTER the `if (this.i.config.phases.reputation?.enabled) { … }` block and before the method's closing `}` (`:2124`), add:

```ts
    const alCfg = this.i.config.phases.agentLessons;
    if (alCfg?.enabled) {
      const alStore = new AgentLessonsStore(this.i.repoRoot);
      await learnLessonsFromDecisions({
        repoRoot: this.i.repoRoot,
        prevIter: state.iteration,
        sessionId: state.session_id,
        cycleSeq: state.reputation_cycle_seq,
        store: alStore,
        nowIso,
      })
        // Decay AFTER learning so freshly-touched entries are never reaped this pass.
        .then(() => alStore.decayPass(nowIso, alCfg.ttlDays))
        .catch(() => undefined); // render-only: a collect failure never blocks the loop
    }
```

- [ ] **Step 3: Write the test**

This test drives the REAL `LoopDriver.run()` → `absorbPriorDecisions` path (not just `learnLessonsFromDecisions`), so a broken or ungated wiring fails the test. It mirrors the harness in `tests/unit/loop-driver.test.ts` (stub `Orchestrator` over `fake-codex`, doc-only diff so triage skips the panel, `stopHookActive=true` + `iteration=1` + a dirty flag so absorb fires). One test asserts collection when `phases.agentLessons` is enabled; a twin asserts a no-op under the default (off) config.

```ts
// tests/unit/agent-lessons-loop-collect.test.ts
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { AuditLogger } from "../../src/audit/logger.ts";
import { defineConfig } from "../../src/config/define-config.ts";
import { LoopDriver } from "../../src/core/loop-driver.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import { StateStore } from "../../src/core/state-store.ts";
import { AgentLessonsStore } from "../../src/core/agent-lessons/store.ts";
import { CodexAdapter } from "../../src/providers/codex.ts";
import { auditDir, decisionsPath, dirtyFlagPath, pendingJsonPath } from "../../src/utils/paths.ts";

const FAKE_CODEX = join(process.cwd(), "tests/fixtures/fake-codex.sh");
const DOC_DIFF =
  "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-a\n+b\n";

function seedAcceptedFixed(repo: string): void {
  writeFileSync(join(repo, "foo.ts"), "x");
  writeFileSync(dirtyFlagPath(repo), JSON.stringify({ diff_hash: "h", ts: new Date().toISOString() }));
  writeFileSync(
    pendingJsonPath(repo),
    JSON.stringify({
      findings: [
        {
          id: "F-001", signature: "sig-al", severity: "WARN", category: "correctness", rule_id: "rule-al",
          file: "a.ts", line_start: 1, line_end: 1, message: "fix it", details: "d",
          reviewer: { provider: "codex", model: "x", persona: "security" }, confidence: 0.5, consensus: "singleton",
        },
      ],
    }),
  );
  const dp = decisionsPath(repo, 1);
  mkdirSync(dirname(dp), { recursive: true });
  writeFileSync(dp, `${JSON.stringify({ schema: "reviewgate.decision.v1", finding_id: "F-001", verdict: "accepted", action: "fixed" })}\n`);
}

function makeDriver(repo: string, config: ReturnType<typeof defineConfig>, state: StateStore, audit: AuditLogger) {
  return new LoopDriver({
    repoRoot: repo, config, state, audit,
    orchestrator: new Orchestrator({
      repoRoot: repo, config, adapters: { codex: new CodexAdapter({ binPath: FAKE_CODEX }) },
      sandboxMode: "off", hostTier: "opus", diff: DOC_DIFF, reasonOnFailEnabled: true,
    }),
    stopHookActive: true,
    freshHeadSha: async () => null,
  });
}

test("run() collects an accepted+fixed lesson when phases.agentLessons is enabled", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rg-al-loop-on-"));
  const state = new StateStore(repo);
  await state.initialise("01HXQAL1");
  await state.update((cur) => ({ ...cur, iteration: 1 }));
  seedAcceptedFixed(repo);
  const config = defineConfig({ phases: { agentLessons: { enabled: true } } });
  await makeDriver(repo, config, state, new AuditLogger(auditDir(repo))).run();
  const idx = await new AgentLessonsStore(repo).snapshot();
  expect(idx.entries).toHaveLength(1);
  expect(idx.entries[0]!.rule_id).toBe("rule-al");
});

test("run() collects NOTHING when phases.agentLessons is off (default config)", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rg-al-loop-off-"));
  const state = new StateStore(repo);
  await state.initialise("01HXQAL2");
  await state.update((cur) => ({ ...cur, iteration: 1 }));
  seedAcceptedFixed(repo);
  await makeDriver(repo, defineConfig({}), state, new AuditLogger(auditDir(repo))).run();
  const idx = await new AgentLessonsStore(repo).snapshot();
  expect(idx.entries).toHaveLength(0);
});
```

If any peripheral field the stub Orchestrator/LoopDriver needs is missing (compare against a passing block in `tests/unit/loop-driver.test.ts:94-134` — the closest existing scenario), copy it verbatim from there; do not invent config shape.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/agent-lessons-loop-collect.test.ts`
Expected: PASS (2 tests). Then confirm no regression in the loop suite:
Run: `bun test tests/unit/loop-driver.test.ts`
Expected: PASS (unchanged).

- [ ] **Step 5: Typecheck, lint, commit**

```bash
bunx tsc --noEmit && bun run lint
git add src/core/loop-driver.ts tests/unit/agent-lessons-loop-collect.test.ts
git commit -m "feat(agent-lessons): collect on absorbPriorDecisions (opt-in, non-blocking)"
```

---

### Task 7: Wire injection into the gate reset branch

**Files:**
- Modify: `src/cli/commands/gate.ts` (imports; reset branch `:333-340`)
- Test: `tests/unit/agent-lessons-gate-inject.test.ts`

**Interfaces:**
- Consumes: `parseHookStdin` (from `src/hooks/handlers.ts`), `buildSessionStartInjection`, `cfg.phases.agentLessons`, `input.hookStdinRaw`.

- [ ] **Step 1: Add the imports**

In `src/cli/commands/gate.ts`, add `parseHookStdin` to the existing import from `../../hooks/handlers.ts` (which already brings in `handleReset`, `handleTrigger`), and add:

```ts
import { buildSessionStartInjection } from "../../core/agent-lessons/inject.ts";
```

- [ ] **Step 2: Emit the injection from the reset branch**

Replace the reset branch's `return { exitCode: 0, stdout: "", stderr };` (`src/cli/commands/gate.ts:340`) with:

```ts
    // Agent Lessons: after reset (read-only + additive; handleReset already seeded the
    // reviewed-through markers), emit recurring-mistake lessons as SessionStart
    // additionalContext. buildSessionStartInjection NEVER throws and returns "" (a
    // guaranteed no-op) when disabled, not startup/resume, empty, or on ANY error — so
    // reset can never break session startup.
    const source =
      (parseHookStdin(input.hookStdinRaw) as { source?: string } | null)?.source ?? null;
    const stdout = await buildSessionStartInjection({
      repoRoot: input.repoRoot,
      cfg: cfg.phases.agentLessons,
      source,
    });
    return { exitCode: 0, stdout, stderr };
```

- [ ] **Step 3: Write the test**

```ts
// tests/unit/agent-lessons-gate-inject.test.ts
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "../../src/config/define-config.ts";
import { runGate } from "../../src/cli/commands/gate.ts";
import { AgentLessonsStore } from "../../src/core/agent-lessons/store.ts";

async function seedThrice(repo: string): Promise<void> {
  const store = new AgentLessonsStore(repo);
  const meta = { category: "correctness" as const, rule_id: "rule-a", message: "add it", file: "a.ts" };
  for (let i = 0; i < 3; i++)
    await store.recordOccurrence({ ...meta, file: `f${i}.ts` }, { run_id: `s:0:${i}`, session_id: "s", signature: `sig${i}` }, "2026-07-03T00:00:00.000Z");
}

// Real, fully-resolved configs (no partial cast) so cfg.audit.retentionDays and every
// other field the reset branch touches are present — the enabled one via defineConfig,
// the off one via the default (agentLessons === null).
const enabledCfg = async () => defineConfig({ phases: { agentLessons: { enabled: true } } });
const offCfg = async () => defineConfig({}); // fully resolved, agentLessons === null (off)

test("reset hook injects lessons on startup when enabled", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rg-al-gate-"));
  await seedThrice(repo);
  const res = await runGate({ repoRoot: repo, hook: "reset", hookStdinRaw: JSON.stringify({ source: "startup", session_id: "s" }), loadConfigFn: enabledCfg });
  expect(res.exitCode).toBe(0);
  expect(JSON.parse(res.stdout).hookSpecificOutput.hookEventName).toBe("SessionStart");
});

test("reset hook stays silent on clear/compact even when enabled", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rg-al-gate-clear-"));
  await seedThrice(repo);
  for (const source of ["clear", "compact"]) {
    const res = await runGate({ repoRoot: repo, hook: "reset", hookStdinRaw: JSON.stringify({ source, session_id: "s" }), loadConfigFn: enabledCfg });
    expect(res.stdout).toBe("");
  }
});

test("reset hook stays silent when agentLessons is off (default)", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rg-al-gate-off-"));
  await seedThrice(repo);
  const res = await runGate({ repoRoot: repo, hook: "reset", hookStdinRaw: JSON.stringify({ source: "startup", session_id: "s" }), loadConfigFn: offCfg });
  expect(res.stdout).toBe("");
});
```

Note: `runGate` accepts `loadConfigFn` (`src/cli/commands/gate.ts:114,293`); its return type is `typeof loadEffectiveConfig` (a `Promise<ReviewgateConfig>`), which `async () => defineConfig(...)` / `async () => defaultConfig` satisfy (the extra `{cwd,env,home}` arg is ignored). Because the config is fully resolved, `cfg.audit.retentionDays` and `handleReset` never throw.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/agent-lessons-gate-inject.test.ts`
Expected: PASS (3 tests). Then confirm no regression:
Run: `bun test tests/unit/gate.test.ts` (or the gate test file present)
Expected: PASS (unchanged — the reset branch still returns `stdout: ""` when disabled/no lessons).

- [ ] **Step 5: Typecheck, lint, commit**

```bash
bunx tsc --noEmit && bun run lint
git add src/cli/commands/gate.ts tests/unit/agent-lessons-gate-inject.test.ts
git commit -m "feat(agent-lessons): inject SessionStart additionalContext from reset hook"
```

---

### Task 8: `learn-status` — Agent Lessons section

**Files:**
- Modify: `src/cli/commands/learn-status.ts` (imports; `LearnStatusReport` type; `buildReport`; `renderText`)
- Test: `tests/unit/learn-status-agent-lessons.test.ts`

**Interfaces:**
- Consumes: `AgentLessonsStore`, `surfacedLessons`.
- Produces: `LearnStatusReport.agent_lessons`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/learn-status-agent-lessons.test.ts
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __test } from "../../src/cli/commands/learn-status.ts";
import { AgentLessonsStore } from "../../src/core/agent-lessons/store.ts";

test("learn-status report includes surfaced agent lessons", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rg-al-ls-"));
  const store = new AgentLessonsStore(repo);
  const meta = { category: "correctness" as const, rule_id: "rule-a", message: "m", file: "a.ts" };
  for (let i = 0; i < 3; i++)
    await store.recordOccurrence({ ...meta, file: `f${i}.ts` }, { run_id: `s:0:${i}`, session_id: "s", signature: `sig${i}` }, "2026-07-03T00:00:00.000Z");
  const r = await __test.buildReport({ repoRoot: repo, now: "2026-07-03T12:00:00.000Z" });
  expect(r.agent_lessons.total_entries).toBe(1);
  expect(r.agent_lessons.surfaced[0]!.count).toBe(3);
  expect(__test.renderText(r)).toContain("Agent lessons");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/learn-status-agent-lessons.test.ts`
Expected: FAIL — `r.agent_lessons` is undefined.

- [ ] **Step 3: Add the imports**

In `src/cli/commands/learn-status.ts`, near the other `core/…` imports:

```ts
import { AgentLessonsStore } from "../../core/agent-lessons/store.ts";
import { surfacedLessons } from "../../core/agent-lessons/distill.ts";
```

- [ ] **Step 4: Extend the report type**

In the `LearnStatusReport` interface, after `implicit_outcomes: { … };`, add:

```ts
  agent_lessons: {
    total_entries: number;
    surfaced: Array<{
      id: string;
      category: string;
      rule_id: string;
      count: number;
      sessions: number;
      files: number;
    }>;
  };
```

- [ ] **Step 5: Compute it in `buildReport`**

First, add an optional recurrence override to `LearnStatusInput` (near `halfLifeDays?`), so a caller can align this view with the gate's configured threshold instead of the hardcoded default:

```ts
  /** Recurrence threshold for the agent-lessons view. Defaults to 3 (the
   *  phases.agentLessons.minRecurrence default). No config loader here by design. */
  agentLessonsMinRecurrence?: number;
```

Then, just before the `return { … }` in `buildReport`, add (fail-safe: a transient read
error on the lessons store must not crash this diagnostic; pure read, no mutation):

```ts
  // --- Agent lessons (accepted+fixed recurrence) ---
  let alSnap: Awaited<ReturnType<AgentLessonsStore["snapshot"]>>;
  try {
    alSnap = await new AgentLessonsStore(input.repoRoot).snapshot({ backupCorrupt: false });
  } catch {
    alSnap = { schema: "reviewgate.agentlessons.v1", entries: [] };
  }
  const alSurfaced = surfacedLessons(alSnap, input.agentLessonsMinRecurrence ?? 3)
    .slice(0, 5)
    .map((l) => ({
      id: l.entry.id,
      category: l.entry.category,
      rule_id: l.entry.rule_id,
      count: l.count,
      sessions: l.sessions,
      files: l.files,
    }));
```

and add to the returned object, after `implicit_outcomes: …,`:

```ts
    agent_lessons: { total_entries: alSnap.entries.length, surfaced: alSurfaced },
```

- [ ] **Step 6: Render it in `renderText`**

Immediately before `return \`${lines.join("\n")}\n\`;`, add:

```ts
  // Agent lessons
  lines.push("");
  lines.push(
    `Agent lessons        ${r.agent_lessons.total_entries} entries · ${r.agent_lessons.surfaced.length} surfaced`,
  );
  for (const l of r.agent_lessons.surfaced) {
    lines.push(
      `    ${l.id}  ${l.count}x [${l.category}] ${l.rule_id}  (${l.files}f/${l.sessions}s)`,
    );
  }
```

- [ ] **Step 7: Run test to verify it passes**

Run: `bun test tests/unit/learn-status-agent-lessons.test.ts`
Expected: PASS.

- [ ] **Step 8: Full suite, typecheck, lint, commit**

```bash
bunx tsc --noEmit && bun run lint && bun test
git add src/cli/commands/learn-status.ts tests/unit/learn-status-agent-lessons.test.ts
git commit -m "feat(agent-lessons): learn-status surfaces recurring agent lessons"
```

---

## Self-Review

**1. Spec coverage:**
- Problem / thesis → Tasks 3 (collect) + 4 (distill) + 5/7 (inject). ✓
- A · Data model → Task 1 (schema) + Task 2 (store). Derived count/distinct, no cap, TTL prune → Task 2 `decayPass` + Task 4 derivation. ✓
- B · Collect (accepted+fixed, absorbPriorDecisions, gated, non-blocking) → Task 3 + Task 6. ✓
- C · Distill (deterministic, minRecurrence 3, English template) → Task 4. ✓
- D · Inject (SessionStart, startup/resume only, fail-safe) → Task 5 + Task 7. ✓
- E · Safety (neutralizeInjectionMarkers + neutralizeFences on write AND inject) → Task 3 (write) + Task 5 (inject). ✓
- F · Config (`phases.agentLessons` nullable-object, null=off) → Task 1 Step 6. ✓
- G · CLI (learn-status section) → Task 8. ✓
- H · Testing (fold, idempotency, threshold, template, inject shape, fail-safe, sanitize, config-off) → covered across Tasks 1–8. ✓

**2. Placeholder scan:** No "TBD"/"implement later"/"add error handling". Two tasks (7 config-stub, 8 minRecurrence-in-view) carry explicit notes about a real, bounded decision, not a placeholder — each names the concrete fallback.

**3. Type consistency:** `recordOccurrence(meta, occ, nowIso)` signature identical in store (Task 2), learn (Task 3), inject-seed helper (Task 5), gate test (Task 7), learn-status test (Task 8). `surfacedLessons(idx, minRecurrence)` / `renderLesson(l)` identical in Tasks 4/5/8. `buildSessionStartInjection({repoRoot, cfg, source})` identical in Tasks 5/7. `AgentLessonsCfg` fields match the zod object in Task 1 Step 6 (`enabled/minRecurrence/topK/maxInjectChars/ttlDays`). `lessonKey(category, ruleId)` and the AL-NNN id format consistent. ✓

## Verification gate (before "done")

Per the repo DoD: `bunx tsc --noEmit` clean, `bun run lint` clean, full `bun test` green (expect prior 2537 + the new tests, 0 fail). Then dogfood: set `phases.agentLessons: { enabled: true }` in `reviewgate.config.ts`, run `reviewgate reset` with a `{"source":"startup"}` stdin, and confirm the injection JSON (or `""` when the store is empty) — the real end-to-end SessionStart path.
