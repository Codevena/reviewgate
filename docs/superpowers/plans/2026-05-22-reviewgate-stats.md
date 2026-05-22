# Reviewgate `stats` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record a rich `run.complete` summary per review and add a read-only `reviewgate stats` command that aggregates the audit log (+ FP-ledger/brain snapshots) into verdict/cost/reviewer-performance/learn-state metrics.

**Architecture:** A pure `buildRunSummary` helper turns the orchestrator's existing aggregation output into a `RunSummary`; the orchestrator returns it in `IterationResult`; the LoopDriver emits ONE best-effort `run.complete` audit event carrying it. A read-only `src/stats/` module (load → aggregate → render) behind `reviewgate stats` reads the date-partitioned audit log. Per-provider finding/demote attribution is REPRESENTATIVE-only; escalation rate comes from existing `escalation` events.

**Tech Stack:** Bun + TS, zod, `bun test`, biome. `export PATH="$HOME/.bun/bin:$PATH"`. Worktree from local `master` HEAD. Spec: `docs/superpowers/specs/2026-05-22-reviewgate-stats-design.md`.

---

## File structure
- **Modify** `src/schemas/audit-event.ts` — `ProviderStatSchema`, `RunSummarySchema`, add `run_summary` to `AuditEventSchema`.
- **Create** `src/core/run-summary.ts` — pure `buildRunSummary(input): RunSummary` (the attribution logic, independently testable).
- **Modify** `src/core/orchestrator.ts` — `IterationResult.summary`; catch-wrap reviewer tasks (so `settled` includes thrown adapters as error runs) + critic; call `buildRunSummary` at every return path; accumulate `criticCostUsd`.
- **Modify** `src/core/loop-driver.ts` — emit `run.complete` after `runIteration`, best-effort.
- **Create** `src/stats/load.ts` — `loadAuditWindow`.
- **Create** `src/stats/aggregate.ts` — `aggregate` → `StatsReport`.
- **Create** `src/stats/render.ts` — `renderStats`.
- **Create** `src/cli/commands/stats.ts` + **Modify** `src/cli/index.ts` — the `stats` command.
- **Tests** under `tests/unit/` + an integration test.

Existing types to reuse (do NOT redefine): `Finding` (`src/schemas/finding.ts`, fields incl. `reviewer.provider`, `severity`, `signature`, `scope_demoted?`, `fp_ledger_match?`, `critic_verdict?`), `ReviewResult`/`ReviewStatus`/`ProviderConfig`/`ProviderAdapter` (`src/providers/adapter-base.ts`), `ProviderId` (`src/providers/registry.ts`), `AuditLogger` (`src/audit/logger.ts`), `FpLedgerStore` + `BrainStore` snapshots.

---

## Task 1: `run_summary` schema

**Files:** Modify `src/schemas/audit-event.ts`; Test `tests/unit/run-summary-schema.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/run-summary-schema.test.ts
import { describe, expect, it } from "bun:test";
import { RunSummarySchema } from "../../src/schemas/audit-event.ts";

const valid = {
  verdict: "FAIL",
  source: "panel",
  counts: { critical: 1, warn: 0, info: 2 },
  cost_usd: 0.01,
  duration_ms: 1234,
  demoted: 1,
  signatures: ["sigA", "sigB"],
  providers: [
    { provider: "codex", personas: ["security"], runs: 1, errors: 0, findings: 2, demoted: 1, cost_usd: 0.01, duration_ms: 1200 },
  ],
};

describe("RunSummarySchema", () => {
  it("validates a complete run summary", () => {
    expect(RunSummarySchema.parse(valid).providers[0]?.provider).toBe("codex");
  });
  it("accepts an empty (skipped/cache) summary", () => {
    expect(
      RunSummarySchema.parse({
        verdict: "PASS",
        source: "cache",
        counts: { critical: 0, warn: 0, info: 0 },
        cost_usd: 0,
        duration_ms: 5,
        demoted: 0,
        signatures: [],
        providers: [],
      }).providers,
    ).toEqual([]);
  });
  it("rejects an unknown source / provider", () => {
    expect(() => RunSummarySchema.parse({ ...valid, source: "nope" })).toThrow();
    expect(() =>
      RunSummarySchema.parse({ ...valid, providers: [{ ...valid.providers[0], provider: "x" }] }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run → fail** (`bun test tests/unit/run-summary-schema.test.ts` — `RunSummarySchema` not exported).

- [ ] **Step 3: Implement** — add to `src/schemas/audit-event.ts` (reuse the existing `EventType`; `run.complete` is already a member). Define a `ProviderId` enum locally if one isn't already imported here (mirror `["codex","gemini","claude-code","openrouter","opencode"]`), and a status enum mirroring `ReviewStatus`:

```typescript
const ProviderIdEnum = z.enum(["codex", "gemini", "claude-code", "openrouter", "opencode"]);
const ReviewStatusEnum = z.enum(["ok", "error", "abstain", "timeout", "quota-exhausted"]);

export const ProviderStatSchema = z.object({
  provider: ProviderIdEnum,
  personas: z.array(z.string()),
  runs: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  findings: z.number().int().nonnegative(),
  demoted: z.number().int().nonnegative(),
  cost_usd: z.number(),
  duration_ms: z.number().int().nonnegative(),
});

export const RunSummarySchema = z.object({
  verdict: z.enum(["PASS", "SOFT-PASS", "FAIL", "ERROR"]),
  source: z.enum(["panel", "cache", "skipped"]),
  counts: z.object({
    critical: z.number().int().nonnegative(),
    warn: z.number().int().nonnegative(),
    info: z.number().int().nonnegative(),
  }),
  cost_usd: z.number(),
  duration_ms: z.number().int().nonnegative(),
  demoted: z.number().int().nonnegative(),
  signatures: z.array(z.string()),
  providers: z.array(ProviderStatSchema),
});
export type RunSummary = z.infer<typeof RunSummarySchema>;
export type ProviderStat = z.infer<typeof ProviderStatSchema>;
```

Then add to the existing `AuditEventSchema` object (alongside `gen_ai`, `egress`, etc.): `run_summary: RunSummarySchema.optional(),`.

- [ ] **Step 4: Pass**, then `bun test` (full — schema is shared) + `bunx tsc --noEmit` + `bun run format && bun run lint`.
- [ ] **Step 5: Commit** — `git commit -m "feat(stats): run_summary audit-event schema"`

---

## Task 2: `buildRunSummary` pure helper

**Files:** Create `src/core/run-summary.ts`; Test `tests/unit/run-summary.test.ts`

This isolates the attribution logic (REPRESENTATIVE-only) so it's tested without the whole orchestrator.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/run-summary.test.ts
import { describe, expect, it } from "bun:test";
import { buildRunSummary } from "../../src/core/run-summary.ts";
import type { Finding } from "../../src/schemas/finding.ts";

function finding(over: Partial<Finding>): Finding {
  return {
    id: "F", signature: "s", severity: "CRITICAL", category: "security", rule_id: "r",
    file: "a.ts", line_start: 1, line_end: 1, message: "m", details: "d",
    reviewer: { provider: "codex", model: "m", persona: "security" },
    confidence: 0.9, consensus: "singleton", ...over,
  } as Finding;
}

const run = (provider: string, persona: string, status: string, costUsd: number, durationMs: number) => ({
  res: { reviewerId: `${provider}-${persona}`, status, usage: { costUsd } } as never,
  provider, persona, durationMs,
});

describe("buildRunSummary", () => {
  it("attributes findings/demoted to the REPRESENTATIVE provider only", () => {
    const findings = [
      finding({ signature: "s1", severity: "CRITICAL", reviewer: { provider: "codex", model: "m", persona: "security" } }),
      finding({ signature: "s2", severity: "INFO", scope_demoted: true, reviewer: { provider: "openrouter", model: "m", persona: "security" } }),
    ];
    const s = buildRunSummary({
      verdict: "FAIL", source: "panel", counts: { critical: 1, warn: 0, info: 1 },
      durationMs: 100, criticCostUsd: 0,
      findings,
      runs: [run("codex", "security", "ok", 0.02, 90), run("openrouter", "security", "ok", 0.03, 80)],
    });
    const codex = s.providers.find((p) => p.provider === "codex");
    const or = s.providers.find((p) => p.provider === "openrouter");
    expect(codex?.findings).toBe(1);
    expect(codex?.demoted).toBe(0);
    expect(or?.findings).toBe(1);
    expect(or?.demoted).toBe(1); // s2 is scope_demoted
    expect(s.demoted).toBe(1);            // total demoted clusters
    expect(s.cost_usd).toBeCloseTo(0.05); // panel only (criticCostUsd 0)
    expect(s.signatures.sort()).toEqual(["s1"]); // only blocking (CRITICAL/WARN) signatures
  });

  it("groups multiple personas of one provider into one row with runs/errors", () => {
    const s = buildRunSummary({
      verdict: "PASS", source: "panel", counts: { critical: 0, warn: 0, info: 0 },
      durationMs: 10, criticCostUsd: 0, findings: [],
      runs: [run("codex", "security", "ok", 0.01, 50), run("codex", "architecture", "timeout", 0, 60)],
    });
    const codex = s.providers.find((p) => p.provider === "codex");
    expect(codex?.runs).toBe(2);
    expect(codex?.errors).toBe(1); // timeout is non-ok
    expect(codex?.personas.sort()).toEqual(["architecture", "security"]);
  });

  it("counts demoted from scope_demoted OR fp_ledger_match OR critic likely_fp; caps signatures at 20", () => {
    const findings = [
      finding({ signature: "a", fp_ledger_match: { suppressed: true } as never }),
      finding({ signature: "b", critic_verdict: "likely_fp", severity: "INFO" }),
      ...Array.from({ length: 25 }, (_, i) => finding({ signature: `w${i}`, severity: "WARN" })),
    ];
    const s = buildRunSummary({
      verdict: "FAIL", source: "panel", counts: { critical: 0, warn: 25, info: 2 },
      durationMs: 1, criticCostUsd: 0, findings, runs: [run("codex", "security", "ok", 0, 1)],
    });
    expect(s.demoted).toBe(2);
    expect(s.signatures.length).toBe(20); // capped
  });

  it("builds an empty summary for a skipped/cache source", () => {
    const s = buildRunSummary({
      verdict: "PASS", source: "cache", counts: { critical: 0, warn: 0, info: 0 },
      durationMs: 3, criticCostUsd: 0, findings: [], runs: [],
    });
    expect(s).toEqual({
      verdict: "PASS", source: "cache", counts: { critical: 0, warn: 0, info: 0 },
      cost_usd: 0, duration_ms: 3, demoted: 0, signatures: [], providers: [],
    });
  });
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** `src/core/run-summary.ts`:

```typescript
// src/core/run-summary.ts
import type { Finding } from "../schemas/finding.ts";
import type { ProviderStat, RunSummary } from "../schemas/audit-event.ts";
import type { ProviderId } from "../providers/registry.ts";

const SIGNATURE_CAP = 20;

export interface ReviewerOutcome {
  provider: ProviderId;
  persona: string;
  res: { status: string; usage: { costUsd: number } };
  durationMs: number;
}

export interface BuildRunSummaryInput {
  verdict: RunSummary["verdict"];
  source: RunSummary["source"];
  counts: RunSummary["counts"];
  durationMs: number;
  criticCostUsd: number;
  findings: Finding[]; // agg.dedupedFindings (post-aggregation)
  runs: ReviewerOutcome[]; // settled reviewer runs (incl. thrown-as-error)
}

function isDemoted(f: Finding): boolean {
  return f.scope_demoted === true || f.fp_ledger_match?.suppressed === true || f.critic_verdict === "likely_fp";
}

export function buildRunSummary(input: BuildRunSummaryInput): RunSummary {
  const panelCost = input.runs.reduce((sum, r) => sum + r.res.usage.costUsd, 0);

  // Per-provider: group runs (runs/errors/cost/duration) + REPRESENTATIVE-attributed findings/demoted.
  const byProvider = new Map<ProviderId, ProviderStat>();
  const ensure = (provider: ProviderId): ProviderStat => {
    let p = byProvider.get(provider);
    if (!p) {
      p = { provider, personas: [], runs: 0, errors: 0, findings: 0, demoted: 0, cost_usd: 0, duration_ms: 0 };
      byProvider.set(provider, p);
    }
    return p;
  };
  for (const r of input.runs) {
    const p = ensure(r.provider);
    p.runs += 1;
    if (r.res.status !== "ok") p.errors += 1;
    if (!p.personas.includes(r.persona)) p.personas.push(r.persona);
    p.cost_usd += r.res.usage.costUsd;
    p.duration_ms += r.durationMs;
  }
  for (const f of input.findings) {
    const p = ensure(f.reviewer.provider); // representative only
    p.findings += 1;
    if (isDemoted(f)) p.demoted += 1;
  }

  const signatures = input.findings
    .filter((f) => f.severity === "CRITICAL" || f.severity === "WARN")
    .map((f) => f.signature)
    .slice(0, SIGNATURE_CAP);

  return {
    verdict: input.verdict,
    source: input.source,
    counts: input.counts,
    cost_usd: panelCost + input.criticCostUsd,
    duration_ms: input.durationMs,
    demoted: input.findings.filter(isDemoted).length,
    signatures,
    providers: [...byProvider.values()],
  };
}
```

Note: `ensure(f.reviewer.provider)` means a provider that ran but contributed no representative findings still gets a row (from `input.runs`); a provider that only appears as a finding representative but had no settled run (shouldn't happen) would get a row with `runs:0`. Both are acceptable.

- [ ] **Step 4: Pass**, typecheck + lint.
- [ ] **Step 5: Commit** — `git commit -m "feat(stats): buildRunSummary pure helper (representative attribution, provider grouping)"`

---

## Task 3: orchestrator wiring

**Files:** Modify `src/core/orchestrator.ts`; Test: extend `tests/integration/fp-ledger-pipeline.test.ts` is NOT needed — add `tests/integration/run-summary-orchestrator.test.ts`

- [ ] **Step 1: Write the failing test** (drive `runIteration` with a stub adapter; assert `result.summary`)

```typescript
// tests/integration/run-summary-orchestrator.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../src/config/defaults.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";
import type { Finding } from "../../src/schemas/finding.ts";

const DIFF = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n";
const finding: Finding = {
  id: "F-1", signature: "sigX", severity: "CRITICAL", category: "security", rule_id: "r",
  file: "a.ts", line_start: 1, line_end: 1, message: "m", details: "d",
  reviewer: { provider: "codex", model: "m", persona: "security" }, confidence: 0.9, consensus: "singleton",
};
function stub(findings: Finding[]): ProviderAdapter {
  return {
    id: "codex",
    async preflight() { return { available: true, version: "x", authMode: "oauth", error: null }; },
    async review(inp) {
      return { reviewerId: inp.reviewerId, verdict: findings.length ? "FAIL" : "PASS", findings,
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.02, quotaUsedPct: null },
        durationMs: 1, exitCode: 0, rawEventsPath: "", rawText: "", status: "ok" } satisfies ReviewResult;
    },
  };
}
const config = {
  ...defaultConfig,
  cache: { enabled: false, reviewTtlDays: 7 },
  phases: { review: { reviewers: [{ provider: "codex" as const, persona: "security" }], scopeToDiff: true }, critic: null, triage: null },
};

describe("orchestrator IterationResult.summary", () => {
  it("returns a run summary with the verdict, source=panel, and per-provider findings", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-summ-"));
    const orch = new Orchestrator({
      repoRoot: repo, config, adapters: { codex: stub([finding]) },
      sandboxMode: "off", hostTier: "opus", diff: DIFF, reasonOnFailEnabled: true,
    });
    const result = await orch.runIteration({ runId: "RUN", iter: 1 });
    expect(result.summary.verdict).toBe(result.verdict);
    expect(result.summary.source).toBe("panel");
    expect(result.summary.providers.find((p) => p.provider === "codex")?.findings).toBe(1);
    expect(result.summary.cost_usd).toBeCloseTo(0.02);
  });

  it("a triage-skip (doc-only diff) returns source=skipped, empty providers", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-summ2-"));
    const orch = new Orchestrator({
      repoRoot: repo, config, adapters: { codex: stub([]) },
      sandboxMode: "off", hostTier: "opus",
      diff: "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-x\n+y\n",
      reasonOnFailEnabled: true,
    });
    const result = await orch.runIteration({ runId: "RUN", iter: 1 });
    expect(result.summary.source).toBe("skipped");
    expect(result.summary.providers).toEqual([]);
  });
});
```

- [ ] **Step 2: Run → fail** (`result.summary` undefined / type error).

- [ ] **Step 3: Implement** — in `src/core/orchestrator.ts`:
  1. Extend `IterationResult` (the interface near the top) with `summary: import("./run-summary.ts").RunSummary;` — or import `RunSummary` and add `summary: RunSummary;`.
  2. Import `buildRunSummary` + `RunSummary` from `./run-summary.ts`.
  3. **Catch-wrap the reviewer task** so a thrown adapter becomes an error run (so `settled` includes it). Change the task body's `const res = await adapter.review({...}); return { res, provider: r.provider, persona, model };` to wrap the `adapter.review` call:

```typescript
      let res: ReviewResult;
      const t0 = Date.now();
      try {
        res = await adapter.review({ cfg: { ...providerCfg, model }, reviewerId: `${r.provider}-${persona}`, promptFile, workingDir: repo, findingsPath, persona, diffPath });
      } catch (err) {
        res = {
          reviewerId: `${r.provider}-${persona}`, verdict: "ERROR", findings: [],
          usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, quotaUsedPct: null },
          durationMs: Date.now() - t0, exitCode: -1, rawEventsPath: "", status: "error",
          statusDetail: `threw: ${(err as Error).message}`.slice(0, 200),
        };
      }
      return { res, provider: r.provider, persona, model };
```
   (`okRuns` still filters `status === "ok"`, so the fail-closed guard is unchanged; `settled` now includes thrown adapters as error runs — used for provider error-rate.)
  4. **Accumulate `criticCostUsd`** + catch-wrap the critic call. In the critic block, wrap `const cRes = await criticAdapter.review({...})` in try/catch (on throw → `criticInfo = {provider, status:"error", verdicts:0}`, leave `criticMap` undefined), and after a successful/non-ok `cRes` add `criticCostUsd += cRes.usage.costUsd;`. Declare `let criticCostUsd = 0;` before the critic block.
  5. Build a `ReviewerOutcome[]` from `settled`: `const reviewerOutcomes = settled.map((s) => ({ provider: s.provider, persona: s.persona, res: { status: s.res.status, usage: { costUsd: s.res.usage.costUsd } }, durationMs: s.res.durationMs }));`
  6. **Each return path** gets `summary: buildRunSummary({...})`:
     - **normal** (final return): `summary: buildRunSummary({ verdict: agg.verdict, source: "panel", counts: agg.counts, durationMs: Date.now() - start, criticCostUsd, findings: agg.dedupedFindings, runs: reviewerOutcomes })`.
     - **okRuns===0 ERROR**: `source: "panel"`, `counts: {critical:0,warn:0,info:0}`, `findings: []`, `runs: reviewerOutcomes` (the error runs), `criticCostUsd: 0`.
     - **cache-hit** return: `source: "cache"`, `counts: cached.counts`, `findings: []`, `runs: []`, cost 0.
     - **triage-skip** PASS return: `source: "skipped"`, `counts: {0,0,0}`, `findings: []`, `runs: []`.
     - **sandbox-refuse** ERROR return: `source: "skipped"`, `counts: {0,0,0}`, `findings: []`, `runs: []`.
  (Use the literal verdict each path already returns. `buildRunSummary` ignores `cost_usd` from runs for cache/skip because `runs: []`.)

- [ ] **Step 4: Pass** the new test + the FULL suite (`bun test` — existing orchestrator/fp/full-loop tests must stay green; the catch-wrap changes `settled` to include thrown adapters — verify `tests/unit/orchestrator-fail-closed.test.ts` still passes), typecheck + lint.
- [ ] **Step 5: Commit** — `git commit -m "feat(stats): orchestrator returns a RunSummary on every path (+ capture thrown adapters, critic cost)"`

---

## Task 4: LoopDriver emits `run.complete`

**Files:** Modify `src/core/loop-driver.ts`; Test `tests/integration/run-complete-emit.test.ts`

- [ ] **Step 1: Write the failing test** — drive the gate so `runIteration` runs once, then assert a `run.complete` event with a `run_summary` was appended. Mirror the LoopDriver construction from `tests/integration/full-loop.test.ts` (read it for the exact `LoopDriver`/`Orchestrator`/`AuditLogger` wiring) and assert the audit dir contains a `run.complete` line whose `run_summary.verdict` matches.

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** — in `src/core/loop-driver.ts`, immediately AFTER `const result = await this.i.orchestrator.runIteration({ runId: state.session_id, iter: nextIter });` and BEFORE the subsequent state-mutation/`gate.decision` block, add:

```typescript
    await this.i.audit
      .append({ event: "run.complete", run_id: state.session_id, iter: nextIter, trigger: "stop-hook", run_summary: result.summary })
      .catch(() => {});
```
(Best-effort `.catch` so a logging failure never affects the verdict — the existing `gate.decision` append is awaited without a catch, so add the catch here explicitly.)

- [ ] **Step 4: Pass** + full suite + typecheck + lint.
- [ ] **Step 5: Commit** — `git commit -m "feat(stats): LoopDriver emits run.complete with run_summary (best-effort)"`

---

## Task 5: `src/stats/load.ts`

**Files:** Create `src/stats/load.ts`; Test `tests/unit/stats-load.test.ts`

- [ ] **Step 1: Write the failing test** — seed a temp `.reviewgate/audit/2026/05/20/x.jsonl` with a couple of `run.complete` lines (carrying `run_summary`), one `escalation` line, and one malformed line; assert `loadAuditWindow(repo, {})` returns the runs (malformed skipped, escalation excluded from runs) + `escalationCount: 1`; assert `{ last: 1 }` keeps the most recent run; assert `{ since: "<future date>" }` returns none.

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** — walk `.reviewgate/audit` recursively (`Bun.Glob("**/*.jsonl")` rooted at the audit dir, or `readdirSync` recursion), parse each JSONL line (skip malformed), collect `event === "run.complete"` with a `run_summary` into `runs` and count `event === "escalation"`. Sort runs by `ts`. Apply `since` (compare `ts >= since`) then `last` (slice the tail). Return `{ runs: { ts, run_id, iter, summary }[]; escalationCount: number }`. The audit dir path: reuse the same dir the `AuditLogger` writes to (`auditDir(repoRoot)` from `src/utils/paths.ts` — confirm the helper name).

- [ ] **Step 4: Pass**, typecheck + lint.
- [ ] **Step 5: Commit** — `git commit -m "feat(stats): loadAuditWindow (run.complete runs + escalation count, since/last)"`

---

## Task 6: `src/stats/aggregate.ts`

**Files:** Create `src/stats/aggregate.ts`; Test `tests/unit/stats-aggregate.test.ts`

- [ ] **Step 1: Write the failing test** — feed a handful of `RunSummary` runs (mix of `source: panel/cache/skipped`, mixed verdicts, two providers with findings/demoted/cost/errors), an `escalationCount`, a stub `fpSnapshot` (entries with `rejects[].provider` + `stage`), and a stub `brainSnapshot` (entries with `status`/`type`); assert: verdict distribution (counts + %) over ALL runs; escalation rate = escalationCount/runs; cost total/per-provider over PANEL runs only; per-provider demote rate (`Σdemoted/Σfindings`) + error rate (`Σerrors/Σruns`); top recurring signatures (most frequent across panel runs); FP-ledger per-provider confirmed-FP counts; brain entries-by-status.

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** `aggregate(runs, escalationCount, fpSnapshot, brainSnapshot): StatsReport`. Define `StatsReport` (a plain typed object — verdict distribution, source breakdown, escalation rate, cost {total, perProvider, perDay}, providers[] {provider, runs, findings, demoteRate, errorRate, avgDurationMs, cost}, topSignatures [{signature, count}], fpLedger {active, sticky, candidate, perProviderConfirmed: Record<provider,count>}, brain {byStatus, byType}, window {firstTs, lastTs, runCount}). PANEL-only filter for cost/provider/signature aggregation (`runs.filter(r => r.summary.source === "panel")`); verdict distribution + escalation over all runs. Pure function, no IO.

- [ ] **Step 4: Pass**, typecheck + lint.
- [ ] **Step 5: Commit** — `git commit -m "feat(stats): aggregate run summaries + fp/brain snapshots into StatsReport"`

---

## Task 7: `src/stats/render.ts` + CLI

**Files:** Create `src/stats/render.ts`, `src/cli/commands/stats.ts`; Modify `src/cli/index.ts`; Test `tests/unit/stats-render.test.ts`

- [ ] **Step 1: Write the failing test** — `renderStats(report)` returns a string containing section headers (e.g. "Verdicts", "Cost", "Reviewers", "Findings", "Brain") and key numbers; an empty report (0 runs) renders a "no review history yet" line. (Mirror the output style of `src/cli/commands/doctor.ts` / the `fp audit` renderer.)

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** `renderStats(report): string` (sectioned human text). Then `src/cli/commands/stats.ts` exporting `runStats({ repoRoot, since?, last?, json? })`: loads config (for paths), `loadAuditWindow` + `FpLedgerStore(repoRoot).snapshot()` + `BrainStore(repoRoot).snapshot()`, `aggregate`, then prints `JSON.stringify(report, null, 2)` if `json` else `renderStats(report)`. Wire into `src/cli/index.ts` as a `stats` command with citty args `--since` (string), `--last` (number), `--json` (boolean), following the existing `doctor`/`fp` command pattern.

- [ ] **Step 4: Pass** + full suite + typecheck + lint.
- [ ] **Step 5: Commit** — `git commit -m "feat(stats): renderStats + reviewgate stats CLI (--since/--last/--json)"`

---

## Task 8: integration (cassette) + binary smoke + DoD

- [ ] **Step 1: Integration test** `tests/integration/stats-pipeline.test.ts` — drive one review through the LoopDriver via a **ReplayAdapter cassette** (deterministic; reuse the cassette feature, `REVIEWGATE_CASSETTE` or direct injection) so a `run.complete` with a known `run_summary` is written; then run `loadAuditWindow` + `aggregate` and assert the report reflects that run (verdict, the provider's findings, cost). Confirms the whole record→read path end-to-end without an LLM.
- [ ] **Step 2:** `bun test && bunx tsc --noEmit && bun run lint` → all clean.
- [ ] **Step 3: Compiled-binary smoke** — `bun run build`; in a scratch repo seed `.reviewgate/audit/2026/05/20/x.jsonl` with two `run.complete` lines, run `dist/reviewgate stats` (human render shows the numbers) and `dist/reviewgate stats --json` (parses); confirms `loadAuditWindow` + the CLI work in the compiled binary.
- [ ] **Step 4: DoD** — Codex Agent A (or OpenCode fallback) reviewing `git diff master...HEAD`, runs typecheck+lint+test itself → PASS = 0 CRITICAL/WARN; fix + re-run; then Claude Agent A → PASS. `rm -rf .review/`.
- [ ] **Step 5:** FF-merge to master, rebuild binary, remove worktree, delete branch. Ask before pushing.

---

## Self-review (spec coverage)
- `run_summary` schema (verdict/source/counts/cost/duration/demoted/signatures/providers) → Task 1. ✓
- Representative-only per-provider attribution; demoted from scope/fp/critic; signatures capped; thrown adapters captured; critic cost in total not a provider row → Tasks 2, 3. ✓
- `run.complete` emitted once per actual iteration, best-effort, before state mutation; only on the runIteration path → Task 4. ✓
- Escalation rate from existing `escalation` events (not run_summary) → Tasks 5, 6. ✓
- Source-scoped denominators (panel-only cost/reviewer/signatures; all-runs verdict/escalation) → Task 6. ✓
- All four metric groups (verdict/activity, cost, reviewer-performance, findings+learn-state incl. FP-ledger per-provider counts + brain by status/type) → Task 6. ✓
- Human render default + `--json`; `--since`/`--last` → Tasks 5, 7. ✓
- Cassette-driven integration + compiled-binary smoke → Task 8. ✓
- Out of scope: weekly reports, per-file analytics, cross-repo, backfill. ✓
