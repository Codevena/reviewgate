# Implicit-Outcomes Signal Pipe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture every demoted/dropped reviewer finding as a write-only learning-signal corpus (`.reviewgate/learnings/implicit-outcomes.jsonl`) and surface it in `reviewgate learn status`, with **zero** verdict/behavior change.

**Architecture:** A new zod schema + a flock'd, atomic, prune-at-cap NDJSON store; a pure mapper from aggregate output → outcomes; a best-effort orchestrator side-write after the verdict is computed; a `learn status` render; config-gated (`phases.implicitOutcomes`, default on, cap 5000). The aggregator is extended to return the critic-dropped findings (not just a count) so drops are attributable.

**Tech Stack:** Bun, TypeScript, zod, biome. Plain-JSON files under `.reviewgate/`. Reuses `flock` (`src/utils/flock.ts`) and `writeFileAtomic` (`src/utils/atomic-write.ts`).

Spec: `docs/superpowers/specs/2026-06-02-implicit-outcomes-design.md`. Branch: `feat/implicit-outcomes`.

---

## File Structure

- **Create** `src/schemas/implicit-outcome.ts` — zod schema + type (source of truth for one NDJSON record).
- **Create** `src/core/learnings/implicit-outcomes.ts` — `deriveImplicitOutcomes` (pure mapper) + `ImplicitOutcomeStore` (flock + atomic + prune writer/reader).
- **Modify** `src/utils/paths.ts` — `implicitOutcomesPath`, `implicitOutcomesLockPath`.
- **Modify** `src/core/aggregator.ts` — replace `criticDroppedCount: number` with `criticDropped: Finding[]`.
- **Modify** `src/core/orchestrator.ts` — derive `demoted` from `criticDropped.length`; best-effort side-write after the verdict.
- **Modify** `src/config/define-config.ts` + `src/config/defaults.ts` — `phases.implicitOutcomes`.
- **Modify** `src/cli/commands/learn-status.ts` — render an "Implicit outcomes" section.

---

## Task 1: ImplicitOutcome schema

**Files:**
- Create: `src/schemas/implicit-outcome.ts`
- Test: `tests/unit/implicit-outcome-schema.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/implicit-outcome-schema.test.ts
import { describe, expect, it } from "bun:test";
import { ImplicitOutcomeSchema } from "../../src/schemas/implicit-outcome.ts";

const valid = {
  schema: "reviewgate.implicit_outcome.v1",
  signature: "sig-1",
  reviewer_key: "codex:security",
  category: "correctness",
  demote_reason: "critic_likely_fp",
  run_id: "RUN",
  iter: 3,
  created_at: "2026-06-02T00:00:00Z",
};

describe("ImplicitOutcomeSchema", () => {
  it("accepts a valid record", () => {
    expect(ImplicitOutcomeSchema.parse(valid)).toMatchObject({ demote_reason: "critic_likely_fp" });
  });
  it("rejects an unknown demote_reason", () => {
    expect(() => ImplicitOutcomeSchema.parse({ ...valid, demote_reason: "??" })).toThrow();
  });
  it("rejects a missing required field", () => {
    const { signature, ...rest } = valid;
    expect(() => ImplicitOutcomeSchema.parse(rest)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/implicit-outcome-schema.test.ts`
Expected: FAIL — `Cannot find module '.../implicit-outcome.ts'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/schemas/implicit-outcome.ts
import { z } from "zod";

export const DEMOTE_REASONS = [
  "scope_demoted",
  "fp_ledger_match",
  "low_confidence",
  "reputation_demoted",
  "critic_likely_fp",
  "critic_dropped",
] as const;

export const ImplicitOutcomeSchema = z.object({
  schema: z.literal("reviewgate.implicit_outcome.v1"),
  signature: z.string(),
  reviewer_key: z.string(),
  category: z.string(),
  demote_reason: z.enum(DEMOTE_REASONS),
  run_id: z.string(),
  iter: z.number().int().nonnegative(),
  created_at: z.string(),
});

export type ImplicitOutcome = z.infer<typeof ImplicitOutcomeSchema>;
export type DemoteReason = (typeof DEMOTE_REASONS)[number];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/implicit-outcome-schema.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Static + commit**

```bash
bunx tsc --noEmit && bun run lint
git add src/schemas/implicit-outcome.ts tests/unit/implicit-outcome-schema.test.ts
git commit -m "feat(schema): implicit-outcome record (v1)"
```

---

## Task 2: paths helpers

**Files:**
- Modify: `src/utils/paths.ts` (after the `learningsDir`/`knownFpPath` block, ~line 65)

- [ ] **Step 1: Add the helpers** (no separate test — exercised by Task 3's store test)

```ts
export function implicitOutcomesPath(repoRoot: string): string {
  return join(learningsDir(repoRoot), "implicit-outcomes.jsonl");
}
export function implicitOutcomesLockPath(repoRoot: string): string {
  return join(learningsDir(repoRoot), ".implicit-outcomes.lock");
}
```

- [ ] **Step 2: Verify it compiles**

Run: `bunx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/utils/paths.ts
git commit -m "feat(paths): implicit-outcomes path + lock helpers"
```

---

## Task 3: ImplicitOutcomeStore (writer + reader, flock + atomic + prune)

**Files:**
- Create: `src/core/learnings/implicit-outcomes.ts`
- Test: `tests/unit/implicit-outcomes-store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/implicit-outcomes-store.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImplicitOutcomeStore } from "../../src/core/learnings/implicit-outcomes.ts";
import type { ImplicitOutcome } from "../../src/schemas/implicit-outcome.ts";

const oc = (signature: string, iter = 1): ImplicitOutcome => ({
  schema: "reviewgate.implicit_outcome.v1",
  signature,
  reviewer_key: "codex:security",
  category: "correctness",
  demote_reason: "critic_likely_fp",
  run_id: "RUN",
  iter,
  created_at: "2026-06-02T00:00:00Z",
});

describe("ImplicitOutcomeStore", () => {
  it("appends and reloads outcomes", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-io-"));
    const store = new ImplicitOutcomeStore(repo);
    await store.append([oc("a"), oc("b")], 5000);
    const all = await store.load();
    expect(all.map((o) => o.signature)).toEqual(["a", "b"]);
  });

  it("is a no-op on empty input", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-io2-"));
    const store = new ImplicitOutcomeStore(repo);
    await store.append([], 5000);
    expect(await store.load()).toEqual([]);
  });

  it("prunes to cap, dropping the OLDEST", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-io3-"));
    const store = new ImplicitOutcomeStore(repo);
    await store.append([oc("old1"), oc("old2"), oc("old3")], 5000);
    await store.append([oc("new1"), oc("new2")], 3); // total 5 > cap 3
    const all = await store.load();
    expect(all.length).toBe(3);
    expect(all.map((o) => o.signature)).toEqual(["old3", "new1", "new2"]); // oldest dropped
  });

  it("skips malformed lines on load (tolerant reader)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-io4-"));
    const store = new ImplicitOutcomeStore(repo);
    await store.append([oc("a")], 5000);
    const { appendFileSync } = await import("node:fs");
    const { implicitOutcomesPath } = await import("../../src/utils/paths.ts");
    appendFileSync(implicitOutcomesPath(repo), "not json\n");
    const all = await store.load();
    expect(all.map((o) => o.signature)).toEqual(["a"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/implicit-outcomes-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/learnings/implicit-outcomes.ts
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { type ImplicitOutcome, ImplicitOutcomeSchema } from "../../schemas/implicit-outcome.ts";
import { writeFileAtomic } from "../../utils/atomic-write.ts";
import { flock } from "../../utils/flock.ts";
import {
  implicitOutcomesLockPath,
  implicitOutcomesPath,
  learningsDir,
} from "../../utils/paths.ts";

/** Write-only learning-signal corpus of demoted/dropped findings. flock'd,
 *  atomic, prune-at-write (oldest-drop). Never throws into the caller. */
export class ImplicitOutcomeStore {
  constructor(private readonly repoRoot: string) {}

  async load(): Promise<ImplicitOutcome[]> {
    const p = implicitOutcomesPath(this.repoRoot);
    if (!existsSync(p)) return [];
    const out: ImplicitOutcome[] = [];
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(ImplicitOutcomeSchema.parse(JSON.parse(t)));
      } catch {
        /* skip partial/old-schema line */
      }
    }
    return out;
  }

  /** Append `outcomes`, then prune to the newest `cap` lines (oldest dropped). */
  async append(outcomes: ImplicitOutcome[], cap: number): Promise<void> {
    if (outcomes.length === 0) return;
    const dir = learningsDir(this.repoRoot);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const lock = await flock(implicitOutcomesLockPath(this.repoRoot));
    try {
      const merged = [...(await this.load()), ...outcomes];
      const kept = merged.length > cap ? merged.slice(merged.length - cap) : merged;
      writeFileAtomic(
        implicitOutcomesPath(this.repoRoot),
        `${kept.map((o) => JSON.stringify(o)).join("\n")}\n`,
        { mode: 0o600 },
      );
    } finally {
      await lock.release();
    }
  }
}
```

> Verify the `flock` return shape: open `src/utils/flock.ts` and confirm the
> release call (the codebase uses `const lock = await flock(path); … lock.release()`
> — match the exact method name; adjust if it is `lock()` / `unlock()` / a returned
> function). The CandidateStore in `src/core/brain/candidate-store.ts` is the
> reference usage.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/implicit-outcomes-store.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Static + commit**

```bash
bunx tsc --noEmit && bun run lint
git add src/core/learnings/implicit-outcomes.ts tests/unit/implicit-outcomes-store.test.ts
git commit -m "feat(learn): implicit-outcomes store (flock + atomic + prune-at-cap)"
```

---

## Task 4: Aggregator returns `criticDropped: Finding[]`

**Files:**
- Modify: `src/core/aggregator.ts` (interface ~line 51-58; loop ~line 300/318; return ~line 538)
- Modify: `src/core/orchestrator.ts` (the `demoted` computation, ~line 1150)
- Test: `tests/unit/aggregator-critic.test.ts` (extend)

- [ ] **Step 1: Write the failing test** (append inside the existing `describe("aggregate with critic", …)`)

```ts
  it("exposes dropped INFO likely_fp findings in criticDropped (attributable)", () => {
    const f = fin({ signature: "sigDropX", severity: "INFO", category: "quality" });
    const r = aggregate({
      findings: [f],
      reviewersTotal: 1,
      critic: new Map([["sigDropX", { verdict: "likely_fp" }]]),
    });
    expect(r.dedupedFindings).toHaveLength(0);
    expect(r.criticDropped.map((d) => d.signature)).toEqual(["sigDropX"]);
    expect(r.criticDroppedCount).toBe(r.criticDropped.length);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/aggregator-critic.test.ts -t "criticDropped"`
Expected: FAIL — `r.criticDropped` is undefined.

- [ ] **Step 3: Implement** — three edits in `src/core/aggregator.ts`:

(a) Interface (replace the existing `criticDroppedCount: number;`):
```ts
  /** Findings the critic DROPPED entirely (INFO likely_fp → drop). Exposed so a
   *  side-consumer (implicit-outcomes) can attribute them; the count is derived. */
  criticDropped: Finding[];
  /** Convenience count (== criticDropped.length); kept for existing callers. */
  criticDroppedCount: number;
```

(b) Loop (replace the `let criticDroppedCount = 0;` declaration and the drop branch):
```ts
  const criticDropped: Finding[] = [];
```
```ts
        const next = DEMOTE[f.severity];
        if (next === "drop") {
          criticDropped.push(f); // INFO likely_fp dropped entirely — keep it attributable
          continue;
        }
```

(c) Return (add both fields):
```ts
  return {
    verdict,
    dedupedFindings: renumbered,
    counts: { critical, warn, info },
    criticDropped,
    criticDroppedCount: criticDropped.length,
  };
```

- [ ] **Step 4: Update the orchestrator `demoted` source** (`src/core/orchestrator.ts`, ~line 1150) — no behavior change, just read the new field:

```ts
    const demoted =
      agg.dedupedFindings.filter((f) => f.critic_verdict === "likely_fp").length +
      agg.criticDropped.length;
```

- [ ] **Step 5: Run tests**

Run: `bun test tests/unit/aggregator-critic.test.ts && bun test tests/unit/aggregator.test.ts`
Expected: PASS (all aggregator tests green).

- [ ] **Step 6: Static + commit**

```bash
bunx tsc --noEmit && bun run lint
git add src/core/aggregator.ts src/core/orchestrator.ts tests/unit/aggregator-critic.test.ts
git commit -m "feat(aggregator): expose criticDropped findings (attributable drops)"
```

---

## Task 5: Config `phases.implicitOutcomes`

**Files:**
- Modify: `src/config/define-config.ts` (phases block, after `fpLedger`)
- Modify: `src/config/defaults.ts` (phases object)
- Test: `tests/unit/config-implicit-outcomes.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/config-implicit-outcomes.test.ts
import { describe, expect, it } from "bun:test";
import { defaultConfig } from "../../src/config/defaults.ts";
import { ConfigSchema } from "../../src/config/define-config.ts";

describe("phases.implicitOutcomes config", () => {
  it("defaults to enabled with cap 5000", () => {
    expect(defaultConfig.phases.implicitOutcomes).toEqual({ enabled: true, cap: 5000 });
  });
  it("accepts an override", () => {
    const parsed = ConfigSchema.parse({
      phases: { implicitOutcomes: { enabled: false, cap: 100 } },
    });
    expect(parsed.phases.implicitOutcomes).toEqual({ enabled: false, cap: 100 });
  });
});
```

> Confirm the exported schema name (`ConfigSchema`) and how a partial config is
> parsed in `src/config/define-config.ts`; if the export differs, match it. The
> first assertion only needs `defaultConfig`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/config-implicit-outcomes.test.ts`
Expected: FAIL — `implicitOutcomes` undefined on defaults.

- [ ] **Step 3: Implement** — in `src/config/define-config.ts`, inside the `phases` object after the `fpLedger` line:

```ts
    // P0 self-improving: write-only capture of demoted/dropped finding outcomes.
    // Default ON; cap bounds the NDJSON (oldest-drop). No verdict/behavior effect.
    implicitOutcomes: z
      .object({ enabled: z.boolean(), cap: z.number().int().positive().default(5000) })
      .nullable()
      .default({ enabled: true, cap: 5000 })
      .optional(),
```

In `src/config/defaults.ts`, inside `phases`, add:
```ts
    implicitOutcomes: { enabled: true, cap: 5000 },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/config-implicit-outcomes.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Static + commit**

```bash
bunx tsc --noEmit && bun run lint && bun test tests/unit/config-defaults.test.ts
git add src/config/define-config.ts src/config/defaults.ts tests/unit/config-implicit-outcomes.test.ts
git commit -m "feat(config): phases.implicitOutcomes (default on, cap 5000)"
```

---

## Task 6: Pure mapper `deriveImplicitOutcomes`

**Files:**
- Modify: `src/core/learnings/implicit-outcomes.ts` (add the mapper)
- Test: `tests/unit/implicit-outcomes-derive.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/implicit-outcomes-derive.test.ts
import { describe, expect, it } from "bun:test";
import { deriveImplicitOutcomes } from "../../src/core/learnings/implicit-outcomes.ts";
import type { Finding } from "../../src/schemas/finding.ts";

const base = (over: Partial<Finding>): Finding =>
  ({
    id: "F",
    signature: "s",
    severity: "INFO",
    category: "correctness",
    rule_id: "r",
    file: "a.ts",
    line_start: 1,
    line_end: 1,
    message: "m",
    details: "d",
    reviewer: { provider: "codex", model: "m", persona: "security" },
    confidence: 0.5,
    consensus: "singleton",
    ...over,
  }) as Finding;

describe("deriveImplicitOutcomes", () => {
  const ctx = { runId: "RUN", iter: 2, nowIso: "2026-06-02T00:00:00Z" };

  it("maps a critic-dropped finding to critic_dropped with the reviewer key", () => {
    const out = deriveImplicitOutcomes([], [base({ signature: "drp" })], ctx);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      signature: "drp",
      reviewer_key: "codex:security",
      demote_reason: "critic_dropped",
      run_id: "RUN",
      iter: 2,
    });
  });

  it("maps each demote tag with the documented priority", () => {
    const demoted = [
      base({ signature: "c", critic_verdict: "likely_fp" }),
      base({ signature: "s", scope_demoted: true }),
      base({ signature: "r", reputation_demoted: true }),
      base({ signature: "l", low_confidence: true }),
    ];
    const out = deriveImplicitOutcomes(demoted, [], ctx);
    const byReason = Object.fromEntries(out.map((o) => [o.signature, o.demote_reason]));
    expect(byReason).toEqual({
      c: "critic_likely_fp",
      s: "scope_demoted",
      r: "reputation_demoted",
      l: "low_confidence",
    });
  });

  it("ignores findings with no demote tag", () => {
    expect(deriveImplicitOutcomes([base({ severity: "WARN" })], [], ctx)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/implicit-outcomes-derive.test.ts`
Expected: FAIL — `deriveImplicitOutcomes` not exported.

- [ ] **Step 3: Implement** — add to `src/core/learnings/implicit-outcomes.ts`:

```ts
import type { Finding } from "../../schemas/finding.ts";
import type { DemoteReason } from "../../schemas/implicit-outcome.ts";

// Highest-priority demote tag for a finding present in dedupedFindings, or null
// if it carries no demote tag (so it is not an "outcome" worth recording).
function reasonOf(f: Finding): DemoteReason | null {
  if (f.critic_verdict === "likely_fp") return "critic_likely_fp";
  if (f.scope_demoted) return "scope_demoted";
  if (f.fp_ledger_match) return "fp_ledger_match";
  if (f.reputation_demoted) return "reputation_demoted";
  if (f.low_confidence) return "low_confidence";
  return null;
}

/** Map an aggregate's demoted survivors + critic-dropped findings to outcomes.
 *  Pure (no I/O, no clock): `nowIso`/`runId`/`iter` are passed in. */
export function deriveImplicitOutcomes(
  dedupedFindings: Finding[],
  criticDropped: Finding[],
  ctx: { runId: string; iter: number; nowIso: string },
): ImplicitOutcome[] {
  const make = (f: Finding, reason: DemoteReason): ImplicitOutcome => ({
    schema: "reviewgate.implicit_outcome.v1",
    signature: f.signature,
    reviewer_key: `${f.reviewer.provider}:${f.reviewer.persona}`,
    category: f.category,
    demote_reason: reason,
    run_id: ctx.runId,
    iter: ctx.iter,
    created_at: ctx.nowIso,
  });
  const out: ImplicitOutcome[] = [];
  for (const f of dedupedFindings) {
    const reason = reasonOf(f);
    if (reason) out.push(make(f, reason));
  }
  for (const f of criticDropped) out.push(make(f, "critic_dropped"));
  return out;
}
```

> Add `ImplicitOutcome` to the existing type import at the top of the file if it
> is currently imported `import type`-only; `deriveImplicitOutcomes` returns it.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/implicit-outcomes-derive.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Static + commit**

```bash
bunx tsc --noEmit && bun run lint
git add src/core/learnings/implicit-outcomes.ts tests/unit/implicit-outcomes-derive.test.ts
git commit -m "feat(learn): deriveImplicitOutcomes pure mapper (demote tags → outcomes)"
```

---

## Task 7: Orchestrator wire-in (best-effort side-write, no behavior change)

**Files:**
- Modify: `src/core/orchestrator.ts` (after `aggregate()` + `demoted`, ~line 1150)
- Test: `tests/unit/orchestrator-implicit-outcomes.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/orchestrator-implicit-outcomes.test.ts
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../src/config/defaults.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";
import type { Finding } from "../../src/schemas/finding.ts";
import { implicitOutcomesPath } from "../../src/utils/paths.ts";

// A reviewer that flags a finding OUTSIDE the changed hunks → scope_demoted to INFO.
function stub(id: ProviderAdapter["id"], findings: Finding[]): ProviderAdapter {
  return {
    id,
    async preflight() {
      return { available: true, version: "x", authMode: "oauth", error: null };
    },
    async review(inp) {
      return {
        reviewerId: inp.reviewerId,
        verdict: findings.length ? "FAIL" : "PASS",
        findings,
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
        durationMs: 1,
        exitCode: 0,
        rawEventsPath: "",
        status: "ok",
      } satisfies ReviewResult;
    },
  };
}

const outOfDiffFinding: Finding = {
  id: "F-1",
  signature: "ood-sig",
  severity: "WARN",
  category: "quality",
  rule_id: "r",
  file: "untouched.ts", // not in the diff → scope_demoted
  line_start: 500,
  line_end: 500,
  message: "m",
  details: "d",
  reviewer: { provider: "codex", model: "m", persona: "security" },
  confidence: 0.9,
  consensus: "singleton",
};

function makeConfig(implicitEnabled: boolean) {
  return {
    ...defaultConfig,
    phases: {
      ...defaultConfig.phases,
      review: { reviewers: [{ provider: "codex" as const, persona: "security" }] },
      critic: null,
      triage: null,
      implicitOutcomes: { enabled: implicitEnabled, cap: 5000 },
    },
  };
}

const DIFF = "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-a\n+b\n";

describe("orchestrator implicit-outcomes side-write", () => {
  it("writes a scope_demoted outcome when enabled", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-io-orch-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    const orch = new Orchestrator({
      repoRoot: repo,
      config: makeConfig(true),
      adapters: { codex: stub("codex", [outOfDiffFinding]) },
      sandboxMode: "off",
      hostTier: "opus",
      diff: DIFF,
      reasonOnFailEnabled: true,
    });
    await orch.runIteration({ runId: "RUN", iter: 1 });
    const lines = readFileSync(implicitOutcomesPath(repo), "utf8").trim().split("\n");
    const recs = lines.map((l) => JSON.parse(l));
    expect(recs.some((r) => r.signature === "ood-sig" && r.demote_reason === "scope_demoted")).toBe(
      true,
    );
    expect(recs[0].reviewer_key).toBe("codex:security");
  });

  it("writes NOTHING and leaves the verdict identical when disabled", async () => {
    const run = async (enabled: boolean) => {
      const repo = mkdtempSync(join(tmpdir(), `rg-io-orch-${enabled}-`));
      writeFileSync(join(repo, "foo.ts"), "x");
      const orch = new Orchestrator({
        repoRoot: repo,
        config: makeConfig(enabled),
        adapters: { codex: stub("codex", [outOfDiffFinding]) },
        sandboxMode: "off",
        hostTier: "opus",
        diff: DIFF,
        reasonOnFailEnabled: true,
      });
      const res = await orch.runIteration({ runId: "RUN", iter: 1 });
      return { repo, verdict: res.verdict };
    };
    const off = await run(false);
    const on = await run(true);
    expect(existsSync(implicitOutcomesPath(off.repo))).toBe(false); // no file when disabled
    expect(on.verdict).toBe(off.verdict); // identical verdict either way
  });
});
```

> The exact `scope_demoted` trigger depends on diff-scoping defaults (a finding on
> a file NOT in the diff is demoted to INFO). If the harness here does not produce
> `scope_demoted`, switch the stub to return a finding the critic drops, or assert
> on whichever demote tag the run actually produces — the contract under test is
> "an outcome line is written for a demoted finding, and the verdict is unchanged
> vs disabled". Read `scopeFindings` in `src/core/aggregator.ts` to confirm the
> trigger before finalizing the fixture.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/orchestrator-implicit-outcomes.test.ts`
Expected: FAIL — no `implicit-outcomes.jsonl` written (wire-in absent).

- [ ] **Step 3: Implement** — in `src/core/orchestrator.ts`, immediately AFTER the `const demoted = …` computation and BEFORE `await this.writeReport(...)`:

```ts
    // P0 self-improving (write-only, non-blocking): record demoted/dropped finding
    // outcomes so downstream learners have signal. NEVER changes the verdict or
    // report — a failure here is swallowed.
    const ioCfg = this.input.config.phases.implicitOutcomes;
    if (ioCfg?.enabled) {
      try {
        const outcomes = deriveImplicitOutcomes(agg.dedupedFindings, agg.criticDropped, {
          runId: opts.runId,
          iter: opts.iter,
          nowIso: new Date().toISOString(),
        });
        await new ImplicitOutcomeStore(repo).append(outcomes, ioCfg.cap);
      } catch (err) {
        console.warn(`[reviewgate] implicit-outcomes write failed (non-fatal): ${String(err)}`);
      }
    }
```

Add the import at the top of `src/core/orchestrator.ts`:
```ts
import { ImplicitOutcomeStore, deriveImplicitOutcomes } from "./learnings/implicit-outcomes.ts";
```

> Confirm `repo`, `opts.runId`, and `opts.iter` are in scope at the insertion
> point (they are used by the surrounding `writeReport`/RunSummary code). If `repo`
> is named differently there, use `this.input.repoRoot`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/orchestrator-implicit-outcomes.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Regression + static + commit**

```bash
bun test tests/unit/orchestrator-panel.test.ts && bunx tsc --noEmit && bun run lint
git add src/core/orchestrator.ts tests/unit/orchestrator-implicit-outcomes.test.ts
git commit -m "feat(orchestrator): write implicit-outcomes after verdict (best-effort, no behavior change)"
```

---

## Task 8: `learn status` render

**Files:**
- Modify: `src/cli/commands/learn-status.ts` (`LearnStatusReport` type, `buildReport`, and the render/print)
- Test: `tests/unit/learn-status.test.ts` (extend if present, else create `tests/unit/learn-status-implicit.test.ts`)

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/learn-status-implicit.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLearnStatusReport } from "../../src/cli/commands/learn-status.ts";
import { ImplicitOutcomeStore } from "../../src/core/learnings/implicit-outcomes.ts";
import type { ImplicitOutcome } from "../../src/schemas/implicit-outcome.ts";

const oc = (reason: ImplicitOutcome["demote_reason"]): ImplicitOutcome => ({
  schema: "reviewgate.implicit_outcome.v1",
  signature: "s",
  reviewer_key: "codex:security",
  category: "correctness",
  demote_reason: reason,
  run_id: "RUN",
  iter: 1,
  created_at: "2026-06-02T00:00:00Z",
});

describe("learn status — implicit outcomes section", () => {
  it("reports total + by-reason breakdown", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-ls-io-"));
    await new ImplicitOutcomeStore(repo).append([oc("scope_demoted"), oc("critic_likely_fp")], 5000);
    const report = await buildLearnStatusReport({ repoRoot: repo });
    expect(report.implicit_outcomes.total).toBe(2);
    expect(report.implicit_outcomes.by_reason.scope_demoted).toBe(1);
  });

  it("reports zero when the file is absent", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-ls-io2-"));
    const report = await buildLearnStatusReport({ repoRoot: repo });
    expect(report.implicit_outcomes.total).toBe(0);
  });
});
```

> Match the EXISTING exported report-builder name + input shape in
> `learn-status.ts` (the file already has `buildReport`/`LearnStatusInput`/
> `LearnStatusReport`). If `buildReport` is not exported, export it (rename to
> `buildLearnStatusReport` only if that is cleaner) and pass the input shape it
> already uses (`{ repoRoot, halfLifeDays? }`). Adjust the test to the real names.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/learn-status-implicit.test.ts`
Expected: FAIL — `implicit_outcomes` missing on the report.

- [ ] **Step 3: Implement** — in `src/cli/commands/learn-status.ts`:

(a) Add to `LearnStatusReport`:
```ts
  implicit_outcomes: {
    total: number;
    by_reason: Record<string, number>;
    by_reviewer: Record<string, number>;
  };
```

(b) In `buildReport`, before the `return`:
```ts
  const implicit = await new ImplicitOutcomeStore(input.repoRoot).load();
  const byReason: Record<string, number> = {};
  const byReviewer: Record<string, number> = {};
  for (const o of implicit) {
    byReason[o.demote_reason] = (byReason[o.demote_reason] ?? 0) + 1;
    byReviewer[o.reviewer_key] = (byReviewer[o.reviewer_key] ?? 0) + 1;
  }
```
and add to the returned object:
```ts
    implicit_outcomes: { total: implicit.length, by_reason: byReason, by_reviewer: byReviewer },
```

(c) Add the import:
```ts
import { ImplicitOutcomeStore } from "../../core/learnings/implicit-outcomes.ts";
```

(d) In the human-readable print section, add a block:
```ts
  console.log("\nImplicit outcomes (write-only signal corpus):");
  if (report.implicit_outcomes.total === 0) {
    console.log("  none yet");
  } else {
    console.log(`  total: ${report.implicit_outcomes.total}`);
    console.log(`  by reason: ${JSON.stringify(report.implicit_outcomes.by_reason)}`);
    console.log(`  by reviewer: ${JSON.stringify(report.implicit_outcomes.by_reviewer)}`);
  }
```

> If `buildReport` is not currently exported, add `export` to it (and to a thin
> `buildLearnStatusReport` alias if the test uses that name). Do NOT change the
> existing brain/reputation/fp sections.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/learn-status-implicit.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Static + commit**

```bash
bunx tsc --noEmit && bun run lint
git add src/cli/commands/learn-status.ts tests/unit/learn-status-implicit.test.ts
git commit -m "feat(learn-status): render implicit-outcomes section"
```

---

## Task 9: Full verification + build

- [ ] **Step 1: Full suite (split to avoid load-timeout flakes)**

```bash
bun test tests/unit && bun test tests/integration
```
Expected: 0 fail in both.

- [ ] **Step 2: Static + build**

```bash
bunx tsc --noEmit && bun run lint && bun run build
```
Expected: all exit 0; `dist/reviewgate` rebuilt.

- [ ] **Step 3: Real smoke** — drive the compiled gate once to confirm the wire-in writes the corpus end-to-end:

```bash
bun run dev learn status
```
Expected: prints the "Implicit outcomes" section ("none yet" on a fresh repo) without error.

- [ ] **Step 4: DoD review pipeline** (per CLAUDE.md): Codex Agent A + Claude Agent A on the uncommitted/branch diff → both `VERDICT: PASS`; fix findings and re-run until clean. Then stop and ask before pushing.

---

## Self-Review (completed by plan author)

- **Spec coverage:** schema (T1) · paths (T2) · store flock+atomic+prune (T3) · aggregator criticDropped (T4) · config default-on+cap (T5) · pure mapper + demote priority (T6) · orchestrator best-effort wire-in + no-behavior-change proof (T7) · learn status render (T8). All spec sections mapped.
- **Placeholder scan:** no TBD/TODO; every code step shows full code. The three `>` notes are *verification reminders* (confirm an existing symbol name), not deferred work — each has a concrete fallback.
- **Type consistency:** `ImplicitOutcome`/`DemoteReason` (T1) used in T3/T6/T8; `deriveImplicitOutcomes(dedupedFindings, criticDropped, ctx)` signature (T6) matches the T7 call; `ImplicitOutcomeStore.append(outcomes, cap)` / `.load()` (T3) match T7/T8 usage; `agg.criticDropped` (T4) matches T7. `phases.implicitOutcomes.{enabled,cap}` consistent across T5/T7.
