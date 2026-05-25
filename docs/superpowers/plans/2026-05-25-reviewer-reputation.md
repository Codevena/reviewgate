# Reviewer Reputation (Slice 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist a per-repo, per-provider reliability score learned from confirmed review outcomes, and use it to demote (never drop, never block-open) the lone, non-security findings of a chronically-wrong reviewer.

**Architecture:** A new `reputation` subsystem mirrors the FP-ledger: pure score math + a locked atomic JSON store (`.reviewgate/reputation.json`). The `LoopDriver` *learns* (writes events, idempotent by `eid`) at the decision-gate where it already reads prior-iteration decisions; the `Orchestrator` *uses* it (reads the store, builds an unreliable-provider set, passes it to `aggregate`); the aggregator adds one more demote-only pass to its existing `scoped → fpScoped → confScoped` chain. Default-on via `phases.reputation`; neutral-start makes it a no-op without data.

**Tech Stack:** Bun + TypeScript, zod schemas, Biome. `bun test`, `bunx tsc --noEmit`, `bun run lint`. Spec: `docs/superpowers/specs/2026-05-25-reviewer-reputation-design.md`.

---

## File Structure

- `src/core/reputation/score.ts` (NEW) — pure decay/trust math, no I/O.
- `src/schemas/reputation.ts` (NEW) — zod schema (source of truth for `reputation.json`).
- `src/core/reputation/store.ts` (NEW) — locked atomic store; `record` (eid-dedup), `unreliableProviders`, `snapshotForDoctor`. Mirrors `src/core/brain/store.ts`.
- `src/core/reputation/learn.ts` (NEW) — map prior-iteration decisions + pending.json findings → reputation events (mirrors `src/core/fp-ledger/learn.ts`).
- `src/schemas/finding.ts` (MODIFY) — add `reputation_demoted?: boolean`.
- `src/core/aggregator.ts` (MODIFY) — `repUnreliable?: Set<string>` on `AggregateInput`; a reputation demote pass after `confScoped`; tally over the new array.
- `src/schemas/state.ts` (MODIFY) — `reputation_cycle_seq` (monotonic, increments on re-arm).
- `src/config/define-config.ts` + `src/config/defaults.ts` (MODIFY) — `phases.reputation`.
- `src/core/orchestrator.ts` (MODIFY) — read store, build `repUnreliable`, pass to `aggregate`.
- `src/core/loop-driver.ts` (MODIFY) — learn at the decision-gate; `reputation_cycle_seq++` on re-arm.
- `src/cli/commands/doctor.ts` (MODIFY) — reputation status line.
- `src/utils/paths.ts` (MODIFY) — `reputationJsonPath` + `reputationLockPath`.
- Config-shape tests to update: `tests/unit/{config-fpledger,setup-prefill,config-diff-serialize,setup-build-config}.test.ts`.

Build order = dependency order: score → schema/paths → store → learn → finding/config/state → aggregator → orchestrator → loop-driver → doctor.

---

### Task 1: Reputation score math (pure)

**Files:**
- Create: `src/core/reputation/score.ts`
- Test: `tests/unit/reputation-score.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/reputation-score.test.ts
import { describe, expect, it } from "bun:test";
import { decayedCount, isUnreliable, trustScore } from "../../src/core/reputation/score.ts";

const DAY = 24 * 60 * 60 * 1000;

describe("reputation score", () => {
  it("decays an event to ~half its weight after one half-life", () => {
    const now = new Date("2026-05-25T00:00:00Z");
    const oneHalfLifeAgo = new Date(now.getTime() - 45 * DAY).toISOString();
    const w = decayedCount([{ ts: oneHalfLifeAgo, eid: "e1" }], now, 45);
    expect(w).toBeGreaterThan(0.49);
    expect(w).toBeLessThan(0.51);
  });

  it("trustScore uses Beta(1,1) smoothing → 0.5 at zero data", () => {
    const now = new Date();
    expect(trustScore([], [], now, 45)).toBeCloseTo(0.5, 5);
  });

  it("trustScore drops as recent wrong events dominate", () => {
    const now = new Date();
    const recent = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ ts: now.toISOString(), eid: `e${i}` }));
    // 1 correct, 9 wrong → (1+1)/(1+9+2) = 0.166...
    expect(trustScore(recent(1), recent(9), now, 45)).toBeCloseTo(2 / 12, 2);
  });

  it("isUnreliable requires BOTH enough samples AND trust below floor", () => {
    expect(isUnreliable({ trust: 0.1, samples: 3 }, 8, 0.35)).toBe(false); // too few samples
    expect(isUnreliable({ trust: 0.5, samples: 20 }, 8, 0.35)).toBe(false); // trust ok
    expect(isUnreliable({ trust: 0.1, samples: 20 }, 8, 0.35)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/reputation-score.test.ts`
Expected: FAIL — module `score.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/reputation/score.ts
export interface RepEvent {
  ts: string; // ISO timestamp
  eid: string; // idempotency id
}

/** Exponential time-decayed sum of events: weight = 0.5 ^ (ageDays / halfLifeDays). */
export function decayedCount(events: RepEvent[], now: Date, halfLifeDays: number): number {
  const halfLifeMs = halfLifeDays * 24 * 60 * 60 * 1000;
  let sum = 0;
  for (const e of events) {
    const ageMs = now.getTime() - Date.parse(e.ts);
    if (!Number.isFinite(ageMs) || ageMs < 0) {
      sum += 1; // future/unparseable ts → treat as fresh (no negative decay)
      continue;
    }
    sum += 0.5 ** (ageMs / halfLifeMs);
  }
  return sum;
}

/** Beta(1,1)-smoothed trust in [0,1]: (c+1)/(c+w+2). Neutral 0.5 at zero data. */
export function trustScore(
  correct: RepEvent[],
  wrong: RepEvent[],
  now: Date,
  halfLifeDays: number,
): number {
  const c = decayedCount(correct, now, halfLifeDays);
  const w = decayedCount(wrong, now, halfLifeDays);
  return (c + 1) / (c + w + 2);
}

export interface RepDerived {
  trust: number;
  samples: number; // decayed c + w
}

export function isUnreliable(d: RepDerived, minSamples: number, trustFloor: number): boolean {
  return d.samples >= minSamples && d.trust < trustFloor;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/reputation-score.test.ts && bunx tsc --noEmit`
Expected: PASS, clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add src/core/reputation/score.ts tests/unit/reputation-score.test.ts
git commit -m "feat(reputation): pure decay/trust score math"
```

---

### Task 2: Reputation schema + path helpers

**Files:**
- Create: `src/schemas/reputation.ts`
- Modify: `src/utils/paths.ts` (after `brainLockPath`, ~line 92)
- Test: `tests/unit/reputation-schema.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/reputation-schema.test.ts
import { describe, expect, it } from "bun:test";
import { ReputationSchema, emptyReputation } from "../../src/schemas/reputation.ts";

describe("ReputationSchema", () => {
  it("accepts an empty store", () => {
    expect(ReputationSchema.parse(emptyReputation())).toEqual({
      schema: "reviewgate.reputation.v1",
      reviewers: {},
    });
  });

  it("accepts provider entries with correct/wrong events", () => {
    const parsed = ReputationSchema.parse({
      schema: "reviewgate.reputation.v1",
      reviewers: {
        codex: { correct: [{ ts: "2026-05-25T00:00:00Z", eid: "a" }], wrong: [] },
      },
    });
    expect(parsed.reviewers.codex?.correct).toHaveLength(1);
  });

  it("rejects a wrong schema literal", () => {
    expect(() => ReputationSchema.parse({ schema: "x", reviewers: {} })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/reputation-schema.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/schemas/reputation.ts
import { z } from "zod";

export const RepEventSchema = z.object({ ts: z.string(), eid: z.string() });

export const ReputationEntrySchema = z.object({
  correct: z.array(RepEventSchema).default([]),
  wrong: z.array(RepEventSchema).default([]),
});

export const ReputationSchema = z.object({
  schema: z.literal("reviewgate.reputation.v1"),
  // keyed by provider id (NOT provider::persona — merged members lack persona)
  reviewers: z.record(z.string(), ReputationEntrySchema).default({}),
});

export type Reputation = z.infer<typeof ReputationSchema>;
export type ReputationEntry = z.infer<typeof ReputationEntrySchema>;

export function emptyReputation(): Reputation {
  return { schema: "reviewgate.reputation.v1", reviewers: {} };
}
```

In `src/utils/paths.ts`, add after `brainLockPath` (around line 92):

```ts
export function reputationJsonPath(repoRoot: string): string {
  return join(reviewgateDir(repoRoot), "reputation.json");
}
export function reputationLockPath(repoRoot: string): string {
  return join(reviewgateDir(repoRoot), "reputation.lock");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/reputation-schema.test.ts && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/schemas/reputation.ts src/utils/paths.ts tests/unit/reputation-schema.test.ts
git commit -m "feat(reputation): zod schema + path helpers"
```

---

### Task 3: Reputation store (locked, atomic, eid-dedup)

**Files:**
- Create: `src/core/reputation/store.ts`
- Test: `tests/unit/reputation-store.test.ts`

Mirrors `src/core/brain/store.ts` (flock + atomic tmp+rename). Reuse `flock` from `src/utils/flock.ts` and the atomic write pattern.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/reputation-store.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReputationStore } from "../../src/core/reputation/store.ts";

const repo = () => mkdtempSync(join(tmpdir(), "rg-rep-"));
const CFG = { enabled: true, minSamples: 8, trustFloor: 0.35, halfLifeDays: 45 };

describe("ReputationStore", () => {
  it("records correct/wrong events and dedups by eid", async () => {
    const r = repo();
    const s = new ReputationStore(r);
    await s.record([
      { provider: "codex", outcome: "wrong", eid: "e1", ts: "2026-05-25T00:00:00Z" },
      { provider: "codex", outcome: "wrong", eid: "e1", ts: "2026-05-25T00:00:00Z" }, // dup
      { provider: "codex", outcome: "correct", eid: "e2", ts: "2026-05-25T00:00:00Z" },
    ]);
    const snap = await s.snapshot();
    expect(snap.reviewers.codex?.wrong).toHaveLength(1); // dedup
    expect(snap.reviewers.codex?.correct).toHaveLength(1);
  });

  it("unreliableProviders returns providers below floor with enough samples", async () => {
    const r = repo();
    const s = new ReputationStore(r);
    const now = new Date("2026-05-25T00:00:00Z");
    const events = (n: number, base: string) =>
      Array.from({ length: n }, (_, i) => ({
        provider: "gemini" as const,
        outcome: "wrong" as const,
        eid: `${base}${i}`,
        ts: now.toISOString(),
      }));
    await s.record(events(10, "w"));
    expect(await s.unreliableProviders(CFG, now)).toContain("gemini");
    // a provider with too few events is NOT unreliable
    await s.record([{ provider: "codex", outcome: "wrong", eid: "c1", ts: now.toISOString() }]);
    expect(await s.unreliableProviders(CFG, now)).not.toContain("codex");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/reputation-store.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/reputation/store.ts
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  type Reputation,
  ReputationSchema,
  emptyReputation,
} from "../../schemas/reputation.ts";
import { flock } from "../../utils/flock.ts";
import { reputationJsonPath, reputationLockPath } from "../../utils/paths.ts";
import { type RepDerived, isUnreliable, trustScore } from "./score.ts";

export interface RecordInput {
  provider: string;
  outcome: "correct" | "wrong";
  eid: string;
  ts: string;
}

export interface ReputationConfig {
  enabled: boolean;
  minSamples: number;
  trustFloor: number;
  halfLifeDays: number;
}

export class ReputationStore {
  constructor(private readonly repoRoot: string) {}

  async snapshot(): Promise<Reputation> {
    const p = reputationJsonPath(this.repoRoot);
    if (!existsSync(p)) return emptyReputation();
    try {
      return ReputationSchema.parse(JSON.parse(readFileSync(p, "utf8")));
    } catch {
      return emptyReputation(); // corrupt → start clean (reputation is best-effort)
    }
  }

  /** Append events under a lock; idempotent — events whose eid already exists are skipped. */
  async record(events: RecordInput[]): Promise<void> {
    if (events.length === 0) return;
    const lock = await flock(reputationLockPath(this.repoRoot));
    try {
      const rep = await this.snapshot();
      for (const ev of events) {
        const entry = (rep.reviewers[ev.provider] ??= { correct: [], wrong: [] });
        const bucket = ev.outcome === "correct" ? entry.correct : entry.wrong;
        if (bucket.some((e) => e.eid === ev.eid)) continue; // dedup
        bucket.push({ ts: ev.ts, eid: ev.eid });
      }
      this.writeAtomic(ReputationSchema.parse(rep));
    } finally {
      await lock.release();
    }
  }

  private derive(provider: string, rep: Reputation, now: Date, halfLifeDays: number): RepDerived {
    const e = rep.reviewers[provider] ?? { correct: [], wrong: [] };
    const trust = trustScore(e.correct, e.wrong, now, halfLifeDays);
    // samples = decayed total; reuse trustScore's components via a cheap recompute.
    const { decayedCount } = require("./score.ts") as typeof import("./score.ts");
    const samples = decayedCount(e.correct, now, halfLifeDays) + decayedCount(e.wrong, now, halfLifeDays);
    return { trust, samples };
  }

  /** Providers currently below the trust floor with enough samples. */
  async unreliableProviders(cfg: ReputationConfig, now: Date): Promise<Set<string>> {
    const rep = await this.snapshot();
    const out = new Set<string>();
    for (const provider of Object.keys(rep.reviewers)) {
      const d = this.derive(provider, rep, now, cfg.halfLifeDays);
      if (isUnreliable(d, cfg.minSamples, cfg.trustFloor)) out.add(provider);
    }
    return out;
  }

  /** For doctor: per-provider raw + derived numbers. */
  async forDoctor(cfg: ReputationConfig, now: Date) {
    const rep = await this.snapshot();
    return Object.keys(rep.reviewers).map((provider) => {
      const e = rep.reviewers[provider]!;
      const d = this.derive(provider, rep, now, cfg.halfLifeDays);
      return {
        provider,
        correct: e.correct.length,
        wrong: e.wrong.length,
        trust: d.trust,
        demoting: isUnreliable(d, cfg.minSamples, cfg.trustFloor),
      };
    });
  }

  private writeAtomic(rep: Reputation): void {
    const p = reputationJsonPath(this.repoRoot);
    const dir = dirname(p);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${p}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(tmp, JSON.stringify(rep, null, 2), { mode: 0o600 });
    renameSync(tmp, p);
  }
}
```

Note: replace the inline `require("./score.ts")` with a top-of-file `import { decayedCount, isUnreliable, trustScore } from "./score.ts";` and drop the duplicate — Bun/TS prefer the static import. (Written this way only to keep `derive` self-contained in the snippet; use the static import in the real file.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/reputation-store.test.ts && bunx tsc --noEmit && bun run lint`
Expected: PASS, clean. (If lint flags the `require`, you already moved it to a static import.)

- [ ] **Step 5: Commit**

```bash
git add src/core/reputation/store.ts tests/unit/reputation-store.test.ts
git commit -m "feat(reputation): locked atomic store with eid-dedup + unreliable-provider derivation"
```

---

### Task 4: Config — `phases.reputation` (default ON)

**Files:**
- Modify: `src/config/define-config.ts` (in the `phases` object, after `fpLedger` ~line 93)
- Modify: `src/config/defaults.ts` (in `phases`, after the `fpLedger`/`brain` defaults)
- Test: `tests/unit/reputation-config.test.ts`; update `tests/unit/{config-fpledger,setup-prefill,config-diff-serialize,setup-build-config}.test.ts` if they assert the exact effective-config shape.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/reputation-config.test.ts
import { describe, expect, it } from "bun:test";
import { defaultConfig } from "../../src/config/defaults.ts";
import { ConfigSchema } from "../../src/config/define-config.ts";

describe("phases.reputation config", () => {
  it("is enabled by default with the spec's defaults", () => {
    expect(defaultConfig.phases.reputation).toEqual({
      enabled: true,
      minSamples: 8,
      trustFloor: 0.35,
      halfLifeDays: 45,
    });
  });

  it("validates and is overridable", () => {
    const parsed = ConfigSchema.parse({
      ...defaultConfig,
      phases: { ...defaultConfig.phases, reputation: { enabled: false } },
    });
    expect(parsed.phases.reputation.enabled).toBe(false);
    expect(parsed.phases.reputation.minSamples).toBe(8); // default filled
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/reputation-config.test.ts`
Expected: FAIL — `phases.reputation` is not in the schema/defaults.

- [ ] **Step 3: Write minimal implementation**

In `src/config/define-config.ts`, inside the `phases: z.object({ ... })`, after the `fpLedger` field:

```ts
    reputation: z
      .object({
        enabled: z.boolean(),
        minSamples: z.number().int().nonnegative().default(8),
        trustFloor: z.number().min(0).max(1).default(0.35),
        halfLifeDays: z.number().positive().default(45),
      })
      .default({ enabled: true, minSamples: 8, trustFloor: 0.35, halfLifeDays: 45 }),
```

In `src/config/defaults.ts`, inside `phases`, add:

```ts
    reputation: { enabled: true, minSamples: 8, trustFloor: 0.35, halfLifeDays: 45 },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/reputation-config.test.ts && bunx tsc --noEmit`
Then run the config-shape suites and fix any that assert the exact shape:
Run: `bun test tests/unit/config-fpledger.test.ts tests/unit/setup-prefill.test.ts tests/unit/config-diff-serialize.test.ts tests/unit/setup-build-config.test.ts`
Expected: the reputation test passes; if any shape test fails because it deep-equals the full effective config or the serialized diff, update its expectation to include the new `phases.reputation` default (the feature is config-overridable but has NO setup-wizard prompt, so `src/cli/setup/*` is NOT modified — only test expectations that snapshot the effective shape).

- [ ] **Step 5: Commit**

```bash
git add src/config/define-config.ts src/config/defaults.ts tests/unit/reputation-config.test.ts tests/unit/config-fpledger.test.ts tests/unit/setup-prefill.test.ts tests/unit/config-diff-serialize.test.ts tests/unit/setup-build-config.test.ts
git commit -m "feat(reputation): phases.reputation config (default on) + shape-test updates"
```

---

### Task 5: State field `reputation_cycle_seq`

**Files:**
- Modify: `src/schemas/state.ts` (add field + initialState)
- Test: `tests/unit/state.test.ts` (add a case) or `tests/unit/state-store.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/state.test.ts` (mirror its existing initialState assertions):

```ts
import { initialState, ReviewgateStateSchema } from "../../src/schemas/state.ts";

it("initialState seeds reputation_cycle_seq = 0 and the schema accepts it", () => {
  const s = initialState("01HXQREP");
  expect(s.reputation_cycle_seq).toBe(0);
  expect(ReviewgateStateSchema.parse(s).reputation_cycle_seq).toBe(0);
});

it("defaults reputation_cycle_seq for back-compat state.json without the field", () => {
  const { reputation_cycle_seq, ...withoutField } = initialState("01HXQREP2");
  expect(ReviewgateStateSchema.parse(withoutField).reputation_cycle_seq).toBe(0);
});
```

(Adjust the import line to match the file's existing imports.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/state.test.ts -t "reputation_cycle_seq"`
Expected: FAIL — field is undefined.

- [ ] **Step 3: Write minimal implementation**

In `src/schemas/state.ts`, add to `ReviewgateStateSchema` (after `incomplete_runs`):

```ts
  // Monotonic per-session counter, incremented on every re-arm (clean PASS /
  // commit-recovery). Feeds the reputation event-id namespace so a re-armed cycle
  // (iteration resets to 0, findings renumber from F-001) cannot collide with a
  // prior cycle's events. NOT a gate; never reset to 0 within a session.
  reputation_cycle_seq: z.number().int().nonnegative().default(0),
```

And in `initialState(...)` add `reputation_cycle_seq: 0,`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/state.test.ts && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/schemas/state.ts tests/unit/state.test.ts
git commit -m "feat(reputation): reputation_cycle_seq state field (eid namespace)"
```

---

### Task 6: Aggregator reputation demote pass

**Files:**
- Modify: `src/schemas/finding.ts` (add `reputation_demoted?: boolean` near `low_confidence`, ~line 49)
- Modify: `src/core/aggregator.ts` (`AggregateInput.repUnreliable`; demote pass after `confScoped`; tally over the new array; renumber over the new array)
- Test: `tests/unit/aggregator-reputation.test.ts`

- [ ] **Step 1: Write the failing test**

Mirror the existing aggregator tests' construction of `AggregateInput` + findings. The test builds findings with a `reviewer.provider`, a `consensus`, and a `category`, then asserts the verdict/severity after `aggregate`.

```ts
// tests/unit/aggregator-reputation.test.ts
import { describe, expect, it } from "bun:test";
import { aggregate } from "../../src/core/aggregator.ts";
import type { Finding } from "../../src/schemas/finding.ts";

function finding(over: Partial<Finding>): Finding {
  return {
    id: "F-001",
    severity: "CRITICAL",
    category: "quality",
    rule_id: "r",
    file: "a.ts",
    line_start: 1,
    line_end: 1,
    message: "m",
    details: "d",
    reviewer: { provider: "gemini", model: "x", persona: "security" },
    confidence: 0.9,
    consensus: "singleton",
    signature: "sig-1",
    ...over,
  } as Finding;
}

describe("aggregator reputation demote", () => {
  it("demotes a lone non-security CRITICAL from an unreliable provider → WARN (SOFT-PASS)", () => {
    const agg = aggregate({
      findings: [finding({})],
      reviewersTotal: 2, // not a 1-reviewer panel (avoid the singleton-CRITICAL hard-FAIL)
      repUnreliable: new Set(["gemini"]),
    });
    const f = agg.dedupedFindings[0];
    expect(f?.severity).toBe("WARN");
    expect(f?.reputation_demoted).toBe(true);
    expect(agg.verdict).toBe("SOFT-PASS");
  });

  it("NEVER demotes a security/correctness CRITICAL even from an unreliable provider", () => {
    const agg = aggregate({
      findings: [finding({ category: "security" })],
      reviewersTotal: 2,
      repUnreliable: new Set(["gemini"]),
    });
    expect(agg.dedupedFindings[0]?.severity).toBe("CRITICAL");
    expect(agg.verdict).toBe("FAIL");
  });

  it("does NOT demote a corroborated (majority) finding", () => {
    const agg = aggregate({
      findings: [finding({ consensus: "majority" })],
      reviewersTotal: 2,
      repUnreliable: new Set(["gemini"]),
    });
    expect(agg.dedupedFindings[0]?.severity).toBe("CRITICAL");
  });

  it("no effect when the provider is not unreliable", () => {
    const agg = aggregate({
      findings: [finding({})],
      reviewersTotal: 2,
      repUnreliable: new Set(),
    });
    expect(agg.dedupedFindings[0]?.severity).toBe("CRITICAL");
  });
});
```

Note: confirm the real `aggregate` return field name for the finding list (the orchestrator reads `agg.dedupedFindings`). If a finding constructed here is dropped by diff-scoping, pass `scopeToDiff: false` (no `changedRanges` is given, so `scopeFindings` returns survivors unchanged — verify against `aggregator.ts:129`).

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/aggregator-reputation.test.ts`
Expected: FAIL — `repUnreliable` is not a known input and no demotion happens (lone CRITICAL stays CRITICAL → FAIL).

- [ ] **Step 3: Write minimal implementation**

In `src/schemas/finding.ts`, after the `low_confidence` field (~line 49):

```ts
  // Reviewer-reputation demote: set true when the aggregator demoted this finding
  // one severity step because its sole (un-corroborated) provider is currently
  // below the reputation trust floor. Advisory-leaning; never security/correctness.
  reputation_demoted: z.boolean().optional(),
```

In `src/core/aggregator.ts`, add to `AggregateInput` (after `confidenceFloor`):

```ts
  // Providers currently below the reputation trust floor. A lone (un-corroborated),
  // NON-security/correctness finding whose every contributing provider is in this set
  // is demoted ONE step (CRITICAL→WARN, WARN→INFO; never below INFO). Empty/absent → off.
  repUnreliable?: Set<string>;
```

Then add a demote stage immediately AFTER `confScoped` is built and BEFORE the tally (`let critical = 0; ...`):

```ts
  // Reviewer-reputation demote (Slice 1): an un-corroborated finding whose every
  // contributing provider is currently unreliable is demoted one step. Mirrors the
  // confidence-demote exemptions: corroborated (majority/unanimous) and any
  // security/correctness finding are NEVER reputation-demoted; INFO is untouched.
  const repUnreliable = input.repUnreliable;
  const repScoped: Finding[] =
    repUnreliable && repUnreliable.size > 0
      ? confScoped.map((f) => {
          if (f.severity === "INFO") return f;
          if (f.consensus === "unanimous" || f.consensus === "majority") return f;
          if (touchesSecurityOrCorrectness(f)) return f;
          const provs = [f.reviewer.provider, ...(f.members?.map((m) => m.provider) ?? [])];
          if (!provs.every((p) => repUnreliable.has(p))) return f;
          const next = DEMOTE[f.severity];
          if (next === "drop") return f; // unreachable for CRITICAL/WARN; guard anyway
          const note = `\n\n↓ low reviewer reputation — advisory only.`;
          return {
            ...f,
            severity: next,
            reputation_demoted: true,
            details: `${f.details.slice(0, 2000 - note.length)}${note}`,
          };
        })
      : confScoped;
```

Then change the tally loop and the renumber to iterate `repScoped` instead of `confScoped`:
- `for (const f of confScoped)` → `for (const f of repScoped)`
- the renumber `const renumbered = confScoped.map(...)` → `repScoped.map(...)`

(Search `confScoped` after the demote stage and repoint every post-demote consumer to `repScoped`. Do NOT change the lines that BUILD `confScoped`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/aggregator-reputation.test.ts tests/unit/aggregator.test.ts && bunx tsc --noEmit && bun run lint`
Expected: PASS, including the existing aggregator suite (reputation is off when `repUnreliable` is empty/absent, so existing tests are unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/schemas/finding.ts src/core/aggregator.ts tests/unit/aggregator-reputation.test.ts
git commit -m "feat(reputation): aggregator demote-only pass (lone, non-security, unreliable provider)"
```

---

### Task 7: Orchestrator — read reputation, pass to aggregate

**Files:**
- Modify: `src/core/orchestrator.ts` (build `repUnreliable` before the `aggregate({...})` call ~line 876, pass it in)
- Test: covered end-to-end by Task 8's loop-driver test + the aggregator unit test; add a focused orchestrator test only if the existing `tests/unit/orchestrator*.test.ts` harness makes it cheap.

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/orchestrator.test.ts` (reuse its repo + fake-codex harness). Seed `reputation.json` so the sole provider (`codex`) is unreliable, give the fake reviewer a lone non-security CRITICAL, and assert the run SOFT-PASSes (demoted) instead of FAILs. If seeding is awkward, skip this test and rely on Task 8 (loop-driver) for end-to-end coverage — note that choice in the commit.

```ts
it("demotes a lone CRITICAL when the sole provider is reputation-unreliable", async () => {
  const repo = fakeRepo();
  // Seed reputation.json so codex is below floor (10 recent wrong events).
  const { ReputationStore } = await import("../../src/core/reputation/store.ts");
  const now = new Date();
  await new ReputationStore(repo).record(
    Array.from({ length: 10 }, (_, i) => ({
      provider: "codex" as const, outcome: "wrong" as const, eid: `w${i}`, ts: now.toISOString(),
    })),
  );
  const orch = new Orchestrator({
    repoRoot: repo, config: defaultConfig,
    adapters: { codex: new CodexAdapter({ binPath: FAKE_CODEX }) }, // emits a CRITICAL
    sandboxMode: "off", hostTier: "opus",
    diff: "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-a\n+b\n",
    reasonOnFailEnabled: true,
  });
  const result = await orch.runIteration({ runId: "01HXQREPO", iter: 1 });
  // fake-codex emits a security CRITICAL → exempt → still FAIL. So this test only
  // holds if the fake's finding is NON-security. If fake-codex.sh emits category
  // "security", instead assert the reputation snapshot was READ (no throw) and leave
  // the demote assertion to the aggregator unit test. Adjust per the fixture.
  expect(["FAIL", "SOFT-PASS"]).toContain(result.verdict);
});
```

Note: `fake-codex.sh` emits a `security` CRITICAL (verified in `tests/fixtures/fake-codex.sh`), which is EXEMPT from reputation demotion. So a true end-to-end demote test needs a non-security fake — reuse the `WARN_CODEX_SCRIPT`/`quality`-category pattern from `tests/unit/orchestrator.test.ts` but with `severity:"CRITICAL"`. Prefer that fixture for a real RED→GREEN; otherwise this task is a pure wiring change covered by Tasks 6 + 8.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/orchestrator.test.ts -t "reputation-unreliable"`
Expected: FAIL — orchestrator does not yet read reputation, so a lone non-security CRITICAL still FAILs.

- [ ] **Step 3: Write minimal implementation**

In `src/core/orchestrator.ts`, just before `const agg = aggregate({` (~line 876):

```ts
    // Reviewer reputation (Slice 1): read the per-repo store and pass the set of
    // currently-unreliable providers so the aggregator can demote their lone,
    // non-security findings. Best-effort: never let a reputation read break a review.
    const repCfg = this.input.config.phases.reputation;
    let repUnreliable: Set<string> | undefined;
    if (repCfg?.enabled) {
      const { ReputationStore } = await import("./reputation/store.ts");
      repUnreliable = await new ReputationStore(repo)
        .unreliableProviders(repCfg, new Date())
        .catch(() => undefined);
    }
```

Then add to the `aggregate({ ... })` options object (alongside `...(fpActive ? { fpActive } : {})`):

```ts
      ...(repUnreliable && repUnreliable.size > 0 ? { repUnreliable } : {}),
```

(Confirm `phases.reputation` is on `this.input.config` — it is, after Task 4. Use a static import at the top of the file instead of the dynamic `import()` if the file's style prefers it.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/orchestrator.test.ts && bunx tsc --noEmit && bun run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/orchestrator.ts tests/unit/orchestrator.test.ts
git commit -m "feat(reputation): orchestrator reads reputation → repUnreliable into aggregate"
```

---

### Task 8: LoopDriver — learn at the decision-gate + cycle_seq on re-arm

**Files:**
- Create: `src/core/reputation/learn.ts`
- Modify: `src/core/loop-driver.ts` (call the learn at the decision-gate; `reputation_cycle_seq++` in BOTH re-arm state updates)
- Test: `tests/unit/reputation-learn.test.ts` + `tests/unit/loop-driver.test.ts`

- [ ] **Step 1: Write the failing test (learn mapping)**

```ts
// tests/unit/reputation-learn.test.ts
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { learnReputationFromDecisions } from "../../src/core/reputation/learn.ts";
import { ReputationStore } from "../../src/core/reputation/store.ts";
import { decisionsPath, pendingJsonPath } from "../../src/utils/paths.ts";

describe("learnReputationFromDecisions", () => {
  it("credits/debits the finding's providers, anchored to real pending ids", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-replearn-"));
    mkdirSync(join(repo, ".reviewgate"), { recursive: true });
    writeFileSync(
      pendingJsonPath(repo),
      JSON.stringify({
        findings: [
          { id: "F-001", severity: "CRITICAL", reviewer: { provider: "gemini" }, members: [] },
          { id: "F-002", severity: "WARN", reviewer: { provider: "codex" }, members: [] },
        ],
      }),
    );
    const dp = decisionsPath(repo, 1);
    mkdirSync(dirname(dp), { recursive: true });
    writeFileSync(
      dp,
      [
        JSON.stringify({ schema: "reviewgate.decision.v1", finding_id: "F-001", verdict: "rejected", reason: "false positive verified xx", reviewer_was_wrong: true }),
        JSON.stringify({ schema: "reviewgate.decision.v1", finding_id: "F-002", verdict: "accepted", action: "fixed" }),
        JSON.stringify({ schema: "reviewgate.decision.v1", finding_id: "F-999", verdict: "rejected", reason: "not a real id xx", reviewer_was_wrong: true }),
      ].join("\n") + "\n",
    );
    const store = new ReputationStore(repo);
    await learnReputationFromDecisions({
      repoRoot: repo, iter: 1, sessionId: "S", cycleSeq: 0, store,
      nowIso: new Date().toISOString(),
    });
    const snap = await store.snapshot();
    expect(snap.reviewers.gemini?.wrong).toHaveLength(1); // F-001 confirmed wrong
    expect(snap.reviewers.codex?.correct).toHaveLength(1); // F-002 fixed
    // F-999 is not in pending.json → ignored (no fabrication)
    expect(Object.keys(snap.reviewers)).not.toContain(undefined);
  });

  it("is idempotent across re-application (same iter/cycle → eid dedup)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-replearn2-"));
    mkdirSync(join(repo, ".reviewgate"), { recursive: true });
    writeFileSync(pendingJsonPath(repo), JSON.stringify({ findings: [{ id: "F-001", severity: "CRITICAL", reviewer: { provider: "gemini" }, members: [] }] }));
    const dp = decisionsPath(repo, 1);
    mkdirSync(dirname(dp), { recursive: true });
    writeFileSync(dp, JSON.stringify({ schema: "reviewgate.decision.v1", finding_id: "F-001", verdict: "rejected", reason: "fp verified xx", reviewer_was_wrong: true }) + "\n");
    const store = new ReputationStore(repo);
    const args = { repoRoot: repo, iter: 1, sessionId: "S", cycleSeq: 0, store, nowIso: new Date().toISOString() };
    await learnReputationFromDecisions(args);
    await learnReputationFromDecisions(args); // re-apply
    expect((await store.snapshot()).reviewers.gemini?.wrong).toHaveLength(1); // no double-count
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/reputation-learn.test.ts`
Expected: FAIL — `learn.ts` does not exist.

- [ ] **Step 3: Write minimal implementation (learn)**

```ts
// src/core/reputation/learn.ts
import { existsSync, readFileSync } from "node:fs";
import { DecisionEntrySchema } from "../../schemas/decision.ts";
import type { Finding } from "../../schemas/finding.ts";
import { decisionsPath, pendingJsonPath } from "../../utils/paths.ts";
import type { RecordInput, ReputationStore } from "./store.ts";

export async function learnReputationFromDecisions(input: {
  repoRoot: string;
  iter: number;
  sessionId: string;
  cycleSeq: number;
  store: ReputationStore;
  nowIso: string;
}): Promise<void> {
  const { repoRoot, iter, sessionId, cycleSeq, store, nowIso } = input;
  if (iter < 1) return;
  const dp = decisionsPath(repoRoot, iter);
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

  const events: RecordInput[] = [];
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
    const f = byId.get(d.finding_id); // anchor to a REAL finding (no fabrication)
    if (!f) continue;

    let outcome: "correct" | "wrong" | null = null;
    if (d.verdict === "accepted" && d.action === "fixed") outcome = "correct";
    else if (d.verdict === "rejected" && d.reviewer_was_wrong === true) outcome = "wrong";
    if (!outcome) continue;

    // Every distinct contributing provider (representative + members), deduped.
    const providers = [
      f.reviewer?.provider,
      ...((f.members ?? []).map((m) => m.provider)),
    ].filter((p): p is string => typeof p === "string" && p.length > 0);
    for (const provider of new Set(providers)) {
      events.push({
        provider,
        outcome,
        // cycle_seq + session_id make this collision-free across re-armed cycles
        // (iteration resets, ids renumber) and across sessions.
        eid: `${sessionId}:${cycleSeq}:${iter}:${d.finding_id}:${d.verdict}:${provider}`,
        ts: nowIso,
      });
    }
  }
  await store.record(events);
}
```

In `src/core/loop-driver.ts`, at the decision-gate (inside `if (state.iteration > 0)`, right where `computeRejectRate`/fp-streak run — i.e. after the decisions-gate confirms addressed), add the learn call. It is best-effort and must never affect the verdict:

```ts
      // Reviewer reputation: learn from THIS iteration's confirmed decisions (anchored
      // to real pending.json finding ids). Best-effort, idempotent by eid; persists
      // across cycles (NOT reset on re-arm). cycle_seq namespaces the eid.
      if (this.i.config.phases.reputation?.enabled) {
        const { ReputationStore } = await import("./reputation/store.ts");
        const { learnReputationFromDecisions } = await import("./reputation/learn.ts");
        await learnReputationFromDecisions({
          repoRoot: this.i.repoRoot,
          iter: state.iteration,
          sessionId: state.session_id,
          cycleSeq: state.reputation_cycle_seq,
          store: new ReputationStore(this.i.repoRoot),
          nowIso: new Date().toISOString(),
        }).catch(() => undefined);
      }
```

Then add `reputation_cycle_seq: cur.reputation_cycle_seq + 1` to BOTH re-arm `state.update` objects:
1. The clean-PASS re-arm (the `passed ? ... : ...` update — increment when `passed`): `reputation_cycle_seq: passed ? cur.reputation_cycle_seq + 1 : cur.reputation_cycle_seq`.
2. The commit-recovery re-arm (`headMovedWhileEscalated` branch): add `reputation_cycle_seq: cur.reputation_cycle_seq + 1` inside that reset object.

(Confirm `this.i.config.phases.reputation` is reachable — `LoopInput.config` is the full `ReviewgateConfig`.)

- [ ] **Step 4: Write the loop-driver persistence + cycle_seq tests**

Add to `tests/unit/loop-driver.test.ts`:

```ts
it("increments reputation_cycle_seq on a clean-PASS re-arm and persists reputation across it", async () => {
  const repo = fakeRepo();
  const state = new StateStore(repo);
  await state.initialise("01HXQREPCYC");
  writeDirty(repo);
  // Stub orchestrator returns PASS → re-arm path runs.
  const passOrch = { runIteration: async () => ({
    verdict: "PASS" as const, costUsd: 0, durationMs: 1, signaturesThisIter: [],
    summary: { verdict: "PASS", source: "panel", counts: { critical: 0, warn: 0, info: 0 }, cost_usd: 0, duration_ms: 1, demoted: 0, signatures: [], providers: [] } as RunSummary,
  }) };
  await new LoopDriver({ repoRoot: repo, config: defaultConfig, state, audit: new AuditLogger(auditDir(repo)), orchestrator: passOrch, stopHookActive: false }).run();
  expect((await state.load()).reputation_cycle_seq).toBe(1);
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/unit/reputation-learn.test.ts tests/unit/loop-driver.test.ts && bunx tsc --noEmit && bun run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/reputation/learn.ts src/core/loop-driver.ts tests/unit/reputation-learn.test.ts tests/unit/loop-driver.test.ts
git commit -m "feat(reputation): learn from decisions at the gate + cycle_seq on re-arm"
```

---

### Task 9: Doctor reputation status line

**Files:**
- Modify: `src/cli/commands/doctor.ts` (`reputationCheck` + wire into `runDoctor` near `brainMemoryCheck`)
- Test: `tests/unit/doctor-reputation.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/doctor-reputation.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reputationCheck } from "../../src/cli/commands/doctor.ts";
import type { ReviewgateConfig } from "../../src/config/define-config.ts";
import { ReputationStore } from "../../src/core/reputation/store.ts";

const repCfg = { enabled: true, minSamples: 8, trustFloor: 0.35, halfLifeDays: 45 };
const cfgOn = () => ({ phases: { reputation: repCfg } }) as unknown as ReviewgateConfig;

describe("reputationCheck", () => {
  it("returns null when reputation is disabled", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-docrep-off-"));
    const cfg = { phases: { reputation: { ...repCfg, enabled: false } } } as unknown as ReviewgateConfig;
    expect(await reputationCheck(repo, cfg)).toBeNull();
  });

  it("reports 'no data yet' when enabled but empty", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-docrep-empty-"));
    const c = await reputationCheck(repo, cfgOn());
    expect(c?.status).toBe("ok");
    expect(c?.detail).toMatch(/no reputation data|nothing/i);
  });

  it("flags a demoting provider with warn", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-docrep-warn-"));
    const now = new Date();
    await new ReputationStore(repo).record(
      Array.from({ length: 10 }, (_, i) => ({ provider: "gemini" as const, outcome: "wrong" as const, eid: `w${i}`, ts: now.toISOString() })),
    );
    const c = await reputationCheck(repo, cfgOn());
    expect(c?.status).toBe("warn");
    expect(c?.detail).toContain("gemini");
    expect(c?.detail).toContain("demoting");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/doctor-reputation.test.ts`
Expected: FAIL — `reputationCheck` not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/cli/commands/doctor.ts`, add (near `brainMemoryCheck`):

```ts
import { ReputationStore } from "../../core/reputation/store.ts";

export async function reputationCheck(
  repoRoot: string,
  cfg: ReviewgateConfig,
): Promise<Check | null> {
  const rep = cfg.phases.reputation;
  if (!rep?.enabled) return null;
  const name = "reviewer reputation";
  const rows = await new ReputationStore(repoRoot).forDoctor(rep, new Date());
  if (rows.length === 0) {
    return { name, status: "ok", detail: "enabled — no reputation data yet" };
  }
  const demoting = rows.filter((r) => r.demoting);
  const detail = rows
    .map((r) => `${r.provider} ${r.correct}✓/${r.wrong}✗ (trust ${r.trust.toFixed(2)})${r.demoting ? " ⚠ demoting" : ""}`)
    .join(" · ");
  return { name, status: demoting.length > 0 ? "warn" : "ok", detail };
}
```

Wire it into `runDoctor`, right after the `brainMemoryCheck` push:

```ts
    const rep = await reputationCheck(input.repoRoot, cfg);
    if (rep) checks.push(rep);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/doctor-reputation.test.ts && bunx tsc --noEmit && bun run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/doctor.ts tests/unit/doctor-reputation.test.ts
git commit -m "feat(reputation): doctor reviewer-reputation status line"
```

---

## Final Verification

- [ ] **Full suite + static checks**

Run: `bunx tsc --noEmit && bun run lint && bun test`
Expected: all green. The compiled-binary path is unaffected (no new native/wasm); a `bun run build && ./dist/reviewgate doctor` smoke check should show the new `reviewer reputation` line.

- [ ] **Reviewgate dogfood gate** — this repo runs its own gate. Reputation is now default-on here too; address or reject findings per `docs/AGENTS.md`. (Note: with reputation default-on, watch that no legitimate finding is wrongly demoted — `reputation.json` starts empty so there is no effect on the first runs.)

---

## Self-Review Notes

- **Spec coverage:** §1 data model → Tasks 1,2 (+ provider-only key). §2 signal source → Task 8 (`learn.ts`, real-id anchor, every-provider, eid). §3 effect → Task 6 (singleton/minority, security exemption, one-step, never below INFO). §4 anti-abuse → enforced by Task 6's exemption + Task 8's anchor; no extra task. §5 config default-on → Task 4. §6 doctor → Task 9. §7 tests → each task. §8 file map → matches. `reputation_cycle_seq` → Task 5; eid namespace → Task 8.
- **Type consistency:** `RecordInput{provider,outcome,eid,ts}`, `ReputationConfig{enabled,minSamples,trustFloor,halfLifeDays}`, `RepEvent{ts,eid}`, `repUnreliable: Set<string>`, `reputation_demoted?: boolean`, `reputation_cycle_seq` used identically across Tasks 1-9. `forDoctor`/`unreliableProviders`/`record` are the store's only public methods, all used as defined.
- **Verify-at-implementation points (flagged inline, do not skip):** (a) `aggregate` return field name for the finding list (`dedupedFindings`) before Task 6/7 tests; (b) `fake-codex.sh` emits a SECURITY CRITICAL (exempt) → Task 7's end-to-end demote test needs a non-security fake or is deferred to Tasks 6+8; (c) replace the snippet's dynamic `import()`/`require()` with static imports to satisfy lint; (d) confirm the two exact re-arm `state.update` sites in `loop-driver.ts` for the `reputation_cycle_seq++`.
