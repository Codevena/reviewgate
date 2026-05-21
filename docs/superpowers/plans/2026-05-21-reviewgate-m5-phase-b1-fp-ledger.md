# M5 Phase B1 — FP-Ledger Core (learn + reactive demote) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Learn recurring false positives from `reviewer_was_wrong:true` rejections (signature-keyed, ≥2-distinct-provider quorum) and demote matching findings to INFO on later runs — opt-in via `phases.fpLedger`.

**Architecture:** A committed `.reviewgate/learnings/known_fp.jsonl` store (mirrors BrainStore: flock + atomic write). A learn step at the start of `runIteration` scans the previous iteration's decisions + `pending.json` and, using `Finding.members` provenance (from Phase B0), records a reject per member-signature crediting only the emitting base provider. Lifecycle candidate→active→sticky. A reactive aggregator stage demotes findings whose signature matches an `active`/`sticky` entry to INFO + `fp_ledger_match`. (Proactive few-shot + CLI are Phase B2; brain coupling is B3.)

**Tech Stack:** Bun + TS, zod, `bun test`, biome. `export PATH="$HOME/.bun/bin:$PATH"`. Runs in a git worktree (create via superpowers:using-git-worktrees from current master). Prerequisite: Phase B0 merged (`Finding.members` exists).

---

## File structure
- **Create** `src/schemas/fp-ledger.ts` — `FpLedgerEntry` + `FpLedgerIndex` zod schemas.
- **Create** `src/core/fp-ledger/store.ts` — `FpLedgerStore` (snapshot/mutate/recordReject/pin/unpin/decayPass/activeSnapshot).
- **Create** `src/core/fp-ledger/learn.ts` — `learnFromDecisions(...)` (scan prev decisions+pending → recordReject per member-signature).
- **Create** `tests/unit/fp-ledger-schema.test.ts`, `fp-ledger-store.test.ts`, `fp-ledger-learn.test.ts`, `aggregator-fp.test.ts`.
- **Modify** `src/utils/paths.ts` — `learningsDir`, `knownFpPath`, `fpLedgerLockPath`.
- **Modify** `src/config/define-config.ts` + `defaults.ts` — `phases.fpLedger` (opt-in).
- **Modify** `src/core/aggregator.ts` — reactive fp-demote stage (after scopeToDiff, before counts).
- **Modify** `src/core/orchestrator.ts` — learn at runIteration start; pass active snapshot to aggregate.

---

## Task 1: Schema (`src/schemas/fp-ledger.ts`)

**Files:** Create `src/schemas/fp-ledger.ts`; Test `tests/unit/fp-ledger-schema.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/fp-ledger-schema.test.ts
import { describe, expect, it } from "bun:test";
import { FpLedgerEntrySchema, FpLedgerIndexSchema } from "../../src/schemas/fp-ledger.ts";

const entry = {
  id: "FP-001", signature: "sig", rule_id: "magic-number", category: "quality",
  file: "src/a.ts", symbol: "foo", stage: "candidate",
  rejects: [{ run_id: "r", provider: "codex", ts: "2026-05-21T00:00:00Z", reason: "x" }],
  distinct_providers: ["codex"], first_seen_at: "t", last_seen_at: "t", created_at: "t",
};

describe("FpLedgerEntrySchema", () => {
  it("parses a valid candidate entry", () => {
    expect(FpLedgerEntrySchema.parse(entry).stage).toBe("candidate");
  });
  it("rejects an unknown stage", () => {
    expect(() => FpLedgerEntrySchema.parse({ ...entry, stage: "bogus" })).toThrow();
  });
  it("FpLedgerIndexSchema wraps entries with a schema literal", () => {
    const idx = FpLedgerIndexSchema.parse({ schema: "reviewgate.fpledger.v1", entries: [entry] });
    expect(idx.entries).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `bun test tests/unit/fp-ledger-schema.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

```typescript
// src/schemas/fp-ledger.ts
import { z } from "zod";
import { FindingCategory } from "./finding.ts";

export const FpRejectSchema = z.object({
  run_id: z.string(),
  provider: z.string(), // base provider (Finding.reviewer.provider)
  ts: z.string(),
  reason: z.string(),
});

export const FpLedgerStage = z.enum(["candidate", "active", "sticky"]);
export type FpLedgerStage = z.infer<typeof FpLedgerStage>;

export const FpLedgerEntrySchema = z.object({
  id: z.string(),
  signature: z.string(), // the computeSignature match key
  rule_id: z.string(),
  category: FindingCategory,
  file: z.string(),
  symbol: z.string(),
  stage: FpLedgerStage,
  rejects: z.array(FpRejectSchema),
  distinct_providers: z.array(z.string()),
  first_seen_at: z.string(),
  last_seen_at: z.string(),
  pinned_by: z.string().optional(),
  linked_brain_id: z.string().optional(), // Phase B3
  created_at: z.string(),
});
export type FpLedgerEntry = z.infer<typeof FpLedgerEntrySchema>;

export const FpLedgerIndexSchema = z.object({
  schema: z.literal("reviewgate.fpledger.v1"),
  entries: z.array(FpLedgerEntrySchema),
});
export type FpLedgerIndex = z.infer<typeof FpLedgerIndexSchema>;
```

- [ ] **Step 4: Run to verify it passes** — `bun test tests/unit/fp-ledger-schema.test.ts` → PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(schema): add FP-ledger schema"`

---

## Task 2: Paths (`src/utils/paths.ts`)

**Files:** Modify `src/utils/paths.ts`; Test `tests/unit/fp-ledger-store.test.ts` (covers indirectly).

- [ ] **Step 1: Add path helpers** — after `decisionsPath`:

```typescript
export function learningsDir(repoRoot: string): string {
  return join(reviewgateDir(repoRoot), "learnings");
}
export function knownFpPath(repoRoot: string): string {
  return join(learningsDir(repoRoot), "known_fp.jsonl");
}
export function fpLedgerLockPath(repoRoot: string): string {
  return join(learningsDir(repoRoot), ".lock");
}
```

(Storage is a single JSON document despite the `.jsonl` name — keep the name from the design spec; the file holds one `FpLedgerIndex` object. If you prefer true JSONL, change both the store and this comment together; for v1 a single JSON doc mirrors BrainStore and is simplest.)

- [ ] **Step 2: typecheck** — `bun run typecheck` → clean. (Commit with Task 3.)

---

## Task 3: Store (`src/core/fp-ledger/store.ts`) + lifecycle

**Files:** Create `src/core/fp-ledger/store.ts`; Test `tests/unit/fp-ledger-store.test.ts`

Lifecycle thresholds (from spec §Part B): `active` = ≥3 rejects within 60 days across ≥2 distinct providers; `sticky` = ≥5 rejects within 90 days OR pinned. `recordReject` finds-or-creates by signature, appends the reject, recomputes the stage. `decayPass`: candidate removed after 90d with no new match; active→candidate after 180d; sticky never expires.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/fp-ledger-store.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FpLedgerStore } from "../../src/core/fp-ledger/store.ts";

const sig = "sig-1";
const meta = { rule_id: "magic-number", category: "quality" as const, file: "a.ts", symbol: "foo" };
const repo = () => mkdtempSync(join(tmpdir(), "rg-fp-"));

describe("FpLedgerStore lifecycle", () => {
  it("first reject creates a candidate (not applied)", async () => {
    const s = new FpLedgerStore(repo());
    await s.recordReject(sig, meta, { run_id: "r1", provider: "codex", reason: "x" }, "2026-05-21T00:00:00Z");
    const snap = await s.snapshot();
    expect(snap.entries).toHaveLength(1);
    expect(snap.entries[0]?.stage).toBe("candidate");
  });

  it("promotes to active at 3 rejects across ≥2 providers within 60d", async () => {
    const r = repo();
    const s = new FpLedgerStore(r);
    const t = "2026-05-21T00:00:00Z";
    await s.recordReject(sig, meta, { run_id: "r1", provider: "codex", reason: "x" }, t);
    await s.recordReject(sig, meta, { run_id: "r2", provider: "gemini", reason: "x" }, t);
    await s.recordReject(sig, meta, { run_id: "r3", provider: "codex", reason: "x" }, t);
    expect((await s.snapshot()).entries[0]?.stage).toBe("active");
  });

  it("does NOT promote with 3 rejects from a SINGLE provider (anti-poisoning)", async () => {
    const s = new FpLedgerStore(repo());
    const t = "2026-05-21T00:00:00Z";
    for (const run_id of ["r1", "r2", "r3"])
      await s.recordReject(sig, meta, { run_id, provider: "codex", reason: "x" }, t);
    expect((await s.snapshot()).entries[0]?.stage).toBe("candidate");
  });

  it("pin makes an entry sticky; unpin reverts toward its earned stage", async () => {
    const s = new FpLedgerStore(repo());
    await s.recordReject(sig, meta, { run_id: "r1", provider: "codex", reason: "x" }, "2026-05-21T00:00:00Z");
    const id = (await s.snapshot()).entries[0]?.id as string;
    await s.pin(id, "markus");
    expect((await s.snapshot()).entries[0]?.stage).toBe("sticky");
    await s.unpin(id);
    expect((await s.snapshot()).entries[0]?.stage).toBe("candidate");
  });

  it("activeSnapshot returns only active + sticky entries keyed by signature", async () => {
    const s = new FpLedgerStore(repo());
    const t = "2026-05-21T00:00:00Z";
    await s.recordReject(sig, meta, { run_id: "r1", provider: "codex", reason: "x" }, t);
    await s.recordReject(sig, meta, { run_id: "r2", provider: "gemini", reason: "x" }, t);
    await s.recordReject(sig, meta, { run_id: "r3", provider: "claude-code", reason: "x" }, t);
    const active = await s.activeSnapshot();
    expect(active.has(sig)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — module not found.

- [ ] **Step 3: Implement** (mirror BrainStore's flock+atomic pattern)

```typescript
// src/core/fp-ledger/store.ts
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { flock } from "../../utils/flock.ts";
import {
  type FpLedgerEntry,
  FpLedgerIndexSchema,
  type FpLedgerIndex,
} from "../../schemas/fp-ledger.ts";
import { fpLedgerLockPath, knownFpPath, learningsDir } from "../../utils/paths.ts";
import type { FindingCategory } from "../../schemas/finding.ts";

const ACTIVE_REJECTS = 3;
const ACTIVE_DAYS = 60;
const STICKY_REJECTS = 5;
const STICKY_DAYS = 90;
const DAY_MS = 86_400_000;

export interface RejectMeta {
  rule_id: string;
  category: FindingCategory;
  file: string;
  symbol: string;
}

const EMPTY: FpLedgerIndex = { schema: "reviewgate.fpledger.v1", entries: [] };

function recompute(e: FpLedgerEntry, nowMs: number): FpLedgerEntry {
  if (e.pinned_by) return { ...e, stage: "sticky" };
  const within = (days: number) =>
    e.rejects.filter((r) => nowMs - Date.parse(r.ts) <= days * DAY_MS);
  const distinct = (rs: typeof e.rejects) => new Set(rs.map((r) => r.provider)).size;
  const win90 = within(STICKY_DAYS);
  const win60 = within(ACTIVE_DAYS);
  let stage: FpLedgerEntry["stage"] = "candidate";
  if (win90.length >= STICKY_REJECTS && distinct(win90) >= 2) stage = "sticky";
  else if (win60.length >= ACTIVE_REJECTS && distinct(win60) >= 2) stage = "active";
  return { ...e, stage, distinct_providers: [...new Set(e.rejects.map((r) => r.provider))] };
}

export class FpLedgerStore {
  constructor(private readonly repoRoot: string) {}

  async snapshot(): Promise<FpLedgerIndex> {
    const p = knownFpPath(this.repoRoot);
    if (!existsSync(p)) return EMPTY;
    try {
      return FpLedgerIndexSchema.parse(JSON.parse(readFileSync(p, "utf8")));
    } catch {
      return EMPTY;
    }
  }

  private persist(idx: FpLedgerIndex): void {
    const p = knownFpPath(this.repoRoot);
    if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(idx, null, 2), { mode: 0o600 });
    renameSync(tmp, p);
  }

  async mutate<T>(fn: (idx: FpLedgerIndex) => { next: FpLedgerIndex; result: T }): Promise<T> {
    if (!existsSync(learningsDir(this.repoRoot)))
      mkdirSync(learningsDir(this.repoRoot), { recursive: true });
    const lock = await flock(fpLedgerLockPath(this.repoRoot));
    try {
      const cur = await this.snapshot();
      const { next, result } = fn(structuredClone(cur));
      FpLedgerIndexSchema.parse(next);
      this.persist(next);
      return result;
    } finally {
      await lock.release();
    }
  }

  async recordReject(
    signature: string,
    meta: RejectMeta,
    reject: { run_id: string; provider: string; reason: string },
    nowIso: string,
  ): Promise<void> {
    const nowMs = Date.parse(nowIso);
    await this.mutate((idx) => {
      let e = idx.entries.find((x) => x.signature === signature);
      if (!e) {
        e = {
          id: `FP-${String(idx.entries.length + 1).padStart(3, "0")}`,
          signature,
          rule_id: meta.rule_id,
          category: meta.category,
          file: meta.file,
          symbol: meta.symbol,
          stage: "candidate",
          rejects: [],
          distinct_providers: [],
          first_seen_at: nowIso,
          last_seen_at: nowIso,
          created_at: nowIso,
        };
        idx.entries.push(e);
      }
      e.rejects.push({ ...reject, ts: nowIso });
      e.last_seen_at = nowIso;
      const updated = recompute(e, nowMs);
      Object.assign(e, updated);
      return { next: idx, result: undefined };
    });
  }

  async pin(id: string, by: string): Promise<boolean> {
    return this.mutate((idx) => {
      const e = idx.entries.find((x) => x.id === id);
      if (e) {
        e.pinned_by = by;
        e.stage = "sticky";
      }
      return { next: idx, result: Boolean(e) };
    });
  }

  async unpin(id: string): Promise<boolean> {
    return this.mutate((idx) => {
      const e = idx.entries.find((x) => x.id === id);
      if (e) {
        e.pinned_by = undefined;
        Object.assign(e, recompute(e, Date.now()));
      }
      return { next: idx, result: Boolean(e) };
    });
  }

  // candidate removed after 90d no new match; active→candidate after 180d; sticky kept.
  async decayPass(nowIso: string): Promise<void> {
    const nowMs = Date.parse(nowIso);
    await this.mutate((idx) => {
      const kept = idx.entries.filter((e) => {
        if (e.stage === "sticky") return true;
        const ageDays = (nowMs - Date.parse(e.last_seen_at)) / DAY_MS;
        if (e.stage === "candidate") return ageDays <= 90;
        return true; // active: demote (not drop) below
      });
      for (const e of kept) {
        if (e.stage === "active" && (nowMs - Date.parse(e.last_seen_at)) / DAY_MS > 180) {
          e.stage = "candidate";
        }
      }
      return { next: { ...idx, entries: kept }, result: undefined };
    });
  }

  // active + sticky entries, keyed by signature, for prompt + aggregator use.
  async activeSnapshot(): Promise<Map<string, FpLedgerEntry>> {
    const snap = await this.snapshot();
    const m = new Map<string, FpLedgerEntry>();
    for (const e of snap.entries) if (e.stage !== "candidate") m.set(e.signature, e);
    return m;
  }
}
```

- [ ] **Step 4: Run to verify it passes** — `bun test tests/unit/fp-ledger-store.test.ts` → PASS (5 tests).
- [ ] **Step 5: typecheck + lint + commit** — `git add -A && git commit -m "feat(fp-ledger): store + candidate→active→sticky lifecycle with ≥2-provider quorum"`

---

## Task 4: Learn path (`src/core/fp-ledger/learn.ts`)

**Files:** Create `src/core/fp-ledger/learn.ts`; Test `tests/unit/fp-ledger-learn.test.ts`

Reads `decisions/<prevIter>.jsonl` (rejected + reviewer_was_wrong:true) + `pending.json`; for each rejected finding id, looks up the finding and records a reject **per member-signature** crediting only the member's `provider`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/fp-ledger-learn.test.ts
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FpLedgerStore } from "../../src/core/fp-ledger/store.ts";
import { learnFromDecisions } from "../../src/core/fp-ledger/learn.ts";
import { decisionsPath, pendingJsonPath } from "../../src/utils/paths.ts";

describe("learnFromDecisions", () => {
  it("records a reject per member-signature for a rejected reviewer_was_wrong finding", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-fpl-"));
    writeFileSync(
      pendingJsonPath(repo),
      JSON.stringify({
        findings: [
          {
            id: "F-001", signature: "rep-sig", rule_id: "r", category: "quality",
            file: "a.ts", line_start: 1, line_end: 1, message: "m", details: "d",
            reviewer: { provider: "codex", model: "x", persona: "security" },
            confidence: 0.5, consensus: "majority",
            members: [
              { signature: "sigA", provider: "codex", rule_id: "r", category: "quality" },
              { signature: "sigB", provider: "gemini", rule_id: "r", category: "quality" },
            ],
          },
        ],
      }),
    );
    const dp = decisionsPath(repo, 1);
    mkdirSync(dirname(dp), { recursive: true });
    writeFileSync(
      dp,
      `${JSON.stringify({ schema: "reviewgate.decision.v1", finding_id: "F-001", verdict: "rejected", reason: "false positive on unchanged code", reviewer_was_wrong: true })}\n`,
    );
    const store = new FpLedgerStore(repo);
    await learnFromDecisions({ repoRoot: repo, prevIter: 1, store, nowIso: "2026-05-21T00:00:00Z" });
    const snap = await store.snapshot();
    const sigs = snap.entries.map((e) => e.signature).sort();
    expect(sigs).toEqual(["sigA", "sigB"]);
    expect(snap.entries.find((e) => e.signature === "sigA")?.distinct_providers).toEqual(["codex"]);
  });

  it("ignores accepted decisions and rejections without reviewer_was_wrong", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-fpl2-"));
    writeFileSync(pendingJsonPath(repo), JSON.stringify({ findings: [] }));
    const dp = decisionsPath(repo, 1);
    mkdirSync(dirname(dp), { recursive: true });
    writeFileSync(
      dp,
      `${JSON.stringify({ schema: "reviewgate.decision.v1", finding_id: "F-001", verdict: "accepted", action: "fixed" })}\n`,
    );
    const store = new FpLedgerStore(repo);
    await learnFromDecisions({ repoRoot: repo, prevIter: 1, store, nowIso: "t" });
    expect((await store.snapshot()).entries).toHaveLength(0);
  });

  it("is a no-op for prevIter < 1", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-fpl3-"));
    const store = new FpLedgerStore(repo);
    await learnFromDecisions({ repoRoot: repo, prevIter: 0, store, nowIso: "t" });
    expect((await store.snapshot()).entries).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — module not found.

- [ ] **Step 3: Implement**

```typescript
// src/core/fp-ledger/learn.ts
import { existsSync, readFileSync } from "node:fs";
import { DecisionEntrySchema } from "../../schemas/decision.ts";
import type { Finding } from "../../schemas/finding.ts";
import { decisionsPath, pendingJsonPath } from "../../utils/paths.ts";
import type { FpLedgerStore } from "./store.ts";

export async function learnFromDecisions(input: {
  repoRoot: string;
  prevIter: number;
  store: FpLedgerStore;
  nowIso: string;
}): Promise<void> {
  const { repoRoot, prevIter, store, nowIso } = input;
  if (prevIter < 1) return;

  const dp = decisionsPath(repoRoot, prevIter);
  const pp = pendingJsonPath(repoRoot);
  if (!existsSync(dp) || !existsSync(pp)) return;

  // Map finding id → Finding from the (previous) pending report.
  let findings: Finding[] = [];
  try {
    const r = JSON.parse(readFileSync(pp, "utf8")) as { findings?: Finding[] };
    findings = Array.isArray(r.findings) ? r.findings : [];
  } catch {
    return;
  }
  const byId = new Map(findings.map((f) => [f.id, f]));

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
    if (d.verdict !== "rejected" || d.reviewer_was_wrong !== true) continue;
    const f = byId.get(d.finding_id);
    if (!f) continue;

    // Record per member-signature, crediting only that member's base provider.
    // Fall back to the finding's own signature/provider if members is absent.
    const members =
      f.members && f.members.length > 0
        ? f.members
        : [
            {
              signature: f.signature,
              provider: f.reviewer.provider,
              rule_id: f.rule_id,
              category: f.category,
            },
          ];
    for (const m of members) {
      await store.recordReject(
        m.signature,
        { rule_id: m.rule_id, category: m.category, file: f.file, symbol: "" },
        { run_id: d.finding_id, provider: m.provider, reason: d.reason ?? "" },
        nowIso,
      );
    }
  }
}
```

- [ ] **Step 4: Run to verify it passes** — `bun test tests/unit/fp-ledger-learn.test.ts` → PASS (3 tests).
- [ ] **Step 5: commit** — `git add -A && git commit -m "feat(fp-ledger): learn from reviewer_was_wrong rejections per member-signature"`

---

## Task 5: Config — `phases.fpLedger` (opt-in)

**Files:** Modify `src/config/define-config.ts` (after `brain`), `src/config/defaults.ts`; Test `tests/unit/config-fpledger.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/config-fpledger.test.ts
import { describe, expect, it } from "bun:test";
import { defineConfig } from "../../src/config/define-config.ts";

describe("config fpLedger", () => {
  it("defaults to off (null)", () => {
    expect(defineConfig({}).phases.fpLedger ?? null).toBeNull();
  });
  it("accepts enabled:true", () => {
    const c = defineConfig({ phases: { fpLedger: { enabled: true } } } as Parameters<typeof defineConfig>[0]);
    expect(c.phases.fpLedger?.enabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `phases.fpLedger` not in type.

- [ ] **Step 3: Add to the schema** — in `src/config/define-config.ts`, inside `phases: z.object({ ... })`, after the `brain` field:

```typescript
    fpLedger: z
      .object({ enabled: z.boolean() })
      .nullable()
      .default(null)
      .optional(),
```

- [ ] **Step 4: Run to verify it passes** — `bun test tests/unit/config-fpledger.test.ts && bun run typecheck` → PASS/clean.
- [ ] **Step 5: commit** — `git add -A && git commit -m "feat(config): phases.fpLedger (opt-in)"`

---

## Task 6: Reactive aggregator stage — demote FP matches

**Files:** Modify `src/core/aggregator.ts`; Test `tests/unit/aggregator-fp.test.ts`

Add `fpActive?: Map<string, { id: string }>` to `AggregateInput`. After the `scoped` stage, demote any finding whose `signature` (or any member signature) is in `fpActive` to INFO + `fp_ledger_match`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/aggregator-fp.test.ts
import { describe, expect, it } from "bun:test";
import { aggregate } from "../../src/core/aggregator.ts";
import type { Finding } from "../../src/schemas/finding.ts";

function f(over: Partial<Finding>): Finding {
  return {
    id: "F", signature: "sigX", severity: "CRITICAL", category: "quality", rule_id: "r",
    file: "a.ts", line_start: 1, line_end: 1, message: "m", details: "d",
    reviewer: { provider: "codex", model: "x", persona: "security" },
    confidence: 0.9, consensus: "unanimous", ...over,
  } as Finding;
}

describe("aggregate fp-ledger demote", () => {
  it("demotes a finding whose signature matches an active FP entry", () => {
    const r = aggregate({
      findings: [f({ signature: "sigX" })],
      reviewersTotal: 1,
      fpActive: new Map([["sigX", { id: "FP-001" }]]),
    });
    expect(r.dedupedFindings[0]?.severity).toBe("INFO");
    expect(r.dedupedFindings[0]?.fp_ledger_match?.suppressed).toBe(true);
    expect(r.dedupedFindings[0]?.fp_ledger_match?.pattern_id).toBe("FP-001");
    expect(r.verdict).not.toBe("FAIL");
  });
  it("leaves non-matching findings blocking", () => {
    const r = aggregate({
      findings: [f({ signature: "other" })],
      reviewersTotal: 1,
      fpActive: new Map([["sigX", { id: "FP-001" }]]),
    });
    expect(r.dedupedFindings[0]?.severity).toBe("CRITICAL");
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `aggregate` ignores `fpActive`.

- [ ] **Step 3: Implement** — extend `AggregateInput`:

```typescript
  fpActive?: Map<string, { id: string }>;
```

After the `const scoped = ...` block and before the counts loop, add an `fpScoped` stage:

```typescript
  // M5 Part B1 — reactive FP-ledger demote: a finding whose representative
  // signature (or any merged member signature) matches an active/sticky FP entry
  // is demoted to INFO + tagged. Never dropped — stays visible in the advisory
  // section, and the decisions-gate already ignores INFO.
  const fpScoped: Finding[] = input.fpActive
    ? scoped.map((f) => {
        const sigs = [f.signature, ...(f.members?.map((m) => m.signature) ?? [])];
        const hit = sigs.map((s) => input.fpActive?.get(s)).find((x) => x);
        if (!hit) return f;
        const base = f.severity === "INFO" ? f : { ...f, severity: "INFO" as const };
        return {
          ...base,
          fp_ledger_match: { pattern_id: hit.id, matched_count: 1, suppressed: true },
        };
      })
    : scoped;
```

Then change the counts/verdict loop and renumber to iterate `fpScoped` instead of `scoped`.

- [ ] **Step 4: Run to verify it passes** — `bun test tests/unit/aggregator-fp.test.ts tests/unit/aggregator-scope.test.ts tests/unit/aggregator.test.ts` → PASS.
- [ ] **Step 5: commit** — `git add -A && git commit -m "feat(aggregator): reactive FP-ledger demote stage"`

---

## Task 7: Wire learn + apply into the orchestrator

**Files:** Modify `src/core/orchestrator.ts`; Test `tests/integration/fp-ledger-pipeline.test.ts` (or extend an existing integration test)

- [ ] **Step 1: Add the learn step at the START of `runIteration`** (before triage/cache/panel), gated on `phases.fpLedger?.enabled`:

```typescript
    const fpCfg = this.input.config.phases.fpLedger;
    const fpStore = fpCfg?.enabled ? new FpLedgerStore(repo) : null;
    if (fpStore) {
      await learnFromDecisions({
        repoRoot: repo,
        prevIter: opts.iter - 1,
        store: fpStore,
        nowIso: new Date().toISOString(),
      }).catch(() => undefined); // non-blocking
    }
```

Imports:

```typescript
import { FpLedgerStore } from "./fp-ledger/store.ts";
import { learnFromDecisions } from "./fp-ledger/learn.ts";
```

- [ ] **Step 2: Pass the active snapshot to `aggregate()`** — before the `aggregate({...})` call:

```typescript
    const fpActive = fpStore
      ? new Map([...(await fpStore.activeSnapshot())].map(([sig, e]) => [sig, { id: e.id }]))
      : undefined;
```

and add to the `aggregate({...})` call:

```typescript
      ...(fpActive ? { fpActive } : {}),
```

- [ ] **Step 3: Run to verify** — `bun run typecheck && bun test` → clean / all pass.
- [ ] **Step 4: commit** — `git add -A && git commit -m "feat(orchestrator): wire FP-ledger learn + reactive demote (opt-in)"`

---

## Task 8: Full-suite gate + DoD + merge

- [ ] **Step 1:** `bun test && bun run typecheck && bun run lint` → all pass / clean.
- [ ] **Step 2: DoD** (B1 is a substantial subsystem): Codex + Claude review subagents (PASS = 0 CRITICAL/WARN), fix findings, re-review, `rm -rf .review/`.
- [ ] **Step 3:** FF-merge to master, rebuild binary, remove worktree, delete branch.
- [ ] **Step 4: Real e2e** (later, in flashbuddy): enable `phases.fpLedger`, reject the same FP across ≥2 providers over runs → entry reaches `active` → demoted on the next run + appears in the advisory section, not blocking.

---

## Self-review (spec coverage)
- Storage `.reviewgate/learnings/known_fp.jsonl` → Task 2. ✓
- Schema (signature key, stage, rejects, distinct_providers, pinned_by, linked_brain_id) → Task 1. ✓
- Store + lifecycle (candidate→active@3/60d/≥2prov→sticky@5/90d|pin) + decay → Task 3. ✓
- Anti-poisoning ≥2 distinct base providers (from members.provider) → Tasks 3 (single-provider test), 4 (per-member attribution). ✓
- Learn path (prev decisions + pending, per member-signature, prevIter-1, no-op iter1) → Task 4. ✓
- Reactive apply (demote to INFO + fp_ledger_match, never drop) → Task 6. ✓
- Config opt-in → Task 5. ✓
- Orchestrator wiring (learn at start, active snapshot to aggregate) → Task 7. ✓
- NOT in B1 (later): proactive few-shot + cache hash (B2a), CLI/decay-cron/reject-rate (B2b), brain coupling (B3).
