# Advisory Per-Provider Precision Context (#8) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Annotate each finding in `pending.md`/`pending.json` with the historical precision (TP/FP) of the provider(s) that raised it — advisory context for the agent's accept/reject decision, never changing severity or verdict.

**Architecture:** A new pure module `provider-precision.ts` aggregates per-provider precision from the existing `decision.applied` audit events and attaches an optional `reviewer_precision` field to findings. The orchestrator calls it once between `aggregate()` and `writeReport` (gate mode, toggle-gated, best-effort); the report writer renders one metadata line. Purely additive — it cannot suppress a finding.

**Tech Stack:** Bun, TypeScript, zod, `bun test`. Spec: `docs/superpowers/specs/2026-06-16-provider-precision-context-design.md`.

---

## File structure

- `src/core/provider-precision.ts` — new: `perProviderPrecision`, `loadProviderPrecision`, `annotateFindingsWithPrecision`, constants, `ProviderPrecision` type.
- `src/schemas/finding.ts` — new optional `reviewer_precision` field.
- `src/core/report-writer.ts` — render the track-record line in `fmtFinding`.
- `src/config/define-config.ts` + `defaults.ts` — `providerPrecisionContext` toggle.
- `src/core/orchestrator.ts` — annotate `agg.dedupedFindings` before `writeReport`.
- `tests/unit/provider-precision.test.ts`, `tests/unit/report-writer-precision.test.ts`, `tests/unit/orchestrator-precision-context.test.ts` — new tests.

**DRY note:** the spec floated reusing `perProviderPrecision` inside `stats/aggregate.ts`. On inspection that loop bundles `declined` + severity bookkeeping, so extracting only the tp/fp/precision arithmetic would make stats *longer*. Per the spec's explicit fallback, **leave `stats/aggregate.ts` untouched**; `perProviderPrecision` is the single definition for the gate path, and a short code comment notes the deliberate parallel to the stats arithmetic. (Do NOT modify `stats/aggregate.ts` in this plan.)

---

## Task 1: `reviewer_precision` schema field

**Files:**
- Modify: `src/schemas/finding.ts` (after `reputation_demoted` ~line 100)
- Test: `tests/unit/finding-precision-field.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/finding-precision-field.test.ts`:

```ts
// tests/unit/finding-precision-field.test.ts
import { describe, expect, it } from "bun:test";
import { FindingSchema } from "../../src/schemas/finding.ts";

const base = {
  id: "F-001",
  signature: "sig1",
  severity: "CRITICAL" as const,
  category: "security" as const,
  rule_id: "r",
  file: "src/db.ts",
  line_start: 1,
  line_end: 1,
  message: "m",
  details: "d",
  reviewer: { provider: "codex", model: "m", persona: "security" },
  confidence: 0.9,
  consensus: "singleton" as const,
};

describe("FindingSchema reviewer_precision (#8)", () => {
  it("accepts a finding WITH reviewer_precision", () => {
    const parsed = FindingSchema.parse({
      ...base,
      reviewer_precision: [{ provider: "codex", tp: 22, fp: 3, precision: 0.88 }],
    });
    expect(parsed.reviewer_precision?.[0]?.provider).toBe("codex");
  });

  it("accepts a null precision (zero-sample) entry", () => {
    const parsed = FindingSchema.parse({
      ...base,
      reviewer_precision: [{ provider: "gemini", tp: 0, fp: 0, precision: null }],
    });
    expect(parsed.reviewer_precision?.[0]?.precision).toBeNull();
  });

  it("accepts a finding WITHOUT the field (optional)", () => {
    expect(FindingSchema.parse(base).reviewer_precision).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/unit/finding-precision-field.test.ts`
Expected: FAIL — `reviewer_precision` is stripped/rejected (the first two assertions fail; the third passes).

- [ ] **Step 3: Add the schema field**

In `src/schemas/finding.ts`, immediately after the `reputation_demoted: z.boolean().optional(),` line (~100), add:

```ts
  // #8: historical precision of the base provider(s) that raised this finding,
  // attached at report-write time as ADVISORY context (never affects severity/
  // verdict). Only providers with >= PROVIDER_PRECISION_MIN_DECISIONS of decision
  // history are listed. precision is tp/(tp+fp), or null at zero samples.
  reviewer_precision: z
    .array(
      z.object({
        provider: z.string(),
        tp: z.number().int().nonnegative(),
        fp: z.number().int().nonnegative(),
        precision: z.number().min(0).max(1).nullable(),
      }),
    )
    .optional(),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/unit/finding-precision-field.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
bunx tsc --noEmit
git add src/schemas/finding.ts tests/unit/finding-precision-field.test.ts
git commit -m "feat(#8): add optional reviewer_precision finding field"
```

---

## Task 2: `provider-precision.ts` core helpers

**Files:**
- Create: `src/core/provider-precision.ts`
- Test: `tests/unit/provider-precision.test.ts`

### Context

- `DecisionOutcome` (`src/schemas/audit-event.ts`): `{ finding_id, severity: "CRITICAL"|"WARN"|"INFO", bucket: "tp"|"fp"|"declined", providers: string[] }`.
- `normalizeProviders(f)` (`src/core/decision-outcome.ts`, already exported): returns the finding's base provider ids (`reviewer.provider` + `members[].provider`, persona suffix stripped, deduped, **sorted**).
- `loadAuditWindow(repoRoot, { since, until })` (`src/stats/load.ts`): returns `{ decisions: DecisionOutcome[] }` among other fields. **Both** `since` and `until` must be passed for the bounded day-dir scan (with only `since` it scans the whole audit tree).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/provider-precision.test.ts`:

```ts
// tests/unit/provider-precision.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  annotateFindingsWithPrecision,
  loadProviderPrecision,
  perProviderPrecision,
} from "../../src/core/provider-precision.ts";
import type { DecisionOutcome } from "../../src/schemas/audit-event.ts";
import type { Finding } from "../../src/schemas/finding.ts";

function dec(bucket: DecisionOutcome["bucket"], providers: string[], severity: DecisionOutcome["severity"] = "CRITICAL"): DecisionOutcome {
  return { finding_id: "F", severity, bucket, providers };
}

function finding(provider: string): Finding {
  return {
    id: "F-001",
    signature: "s",
    severity: "CRITICAL",
    category: "security",
    rule_id: "r",
    file: "a.ts",
    line_start: 1,
    line_end: 1,
    message: "m",
    details: "d",
    reviewer: { provider, model: "m", persona: "security" },
    confidence: 0.9,
    consensus: "singleton",
  };
}

describe("perProviderPrecision", () => {
  it("computes tp/(tp+fp) per provider, excludes INFO and declined", () => {
    const m = perProviderPrecision([
      dec("tp", ["codex"]),
      dec("tp", ["codex"]),
      dec("fp", ["codex"]),
      dec("declined", ["codex"]), // ignored
      dec("fp", ["codex"], "INFO"), // INFO excluded
      dec("tp", ["gemini"]),
    ]);
    expect(m.get("codex")).toEqual({ tp: 2, fp: 1, precision: 2 / 3 });
    expect(m.get("gemini")).toEqual({ tp: 1, fp: 0, precision: 1 });
  });

  it("counts a multi-provider decision toward EACH provider", () => {
    const m = perProviderPrecision([dec("fp", ["codex", "openrouter"])]);
    expect(m.get("codex")).toEqual({ tp: 0, fp: 1, precision: 0 });
    expect(m.get("openrouter")).toEqual({ tp: 0, fp: 1, precision: 0 });
  });

  it("returns an empty map for no qualifying decisions", () => {
    expect(perProviderPrecision([dec("declined", ["codex"])]).get("codex")).toBeUndefined();
  });
});

describe("annotateFindingsWithPrecision", () => {
  const precision = new Map([
    ["codex", { tp: 22, fp: 3, precision: 22 / 25 }],
    ["openrouter", { tp: 2, fp: 1, precision: 2 / 3 }], // only 3 samples
  ]);

  it("attaches reviewer_precision only for providers with >= minDecisions samples", () => {
    const out = annotateFindingsWithPrecision([finding("codex")], precision, { minDecisions: 5 });
    expect(out[0]?.reviewer_precision).toEqual([{ provider: "codex", tp: 22, fp: 3, precision: 22 / 25 }]);
  });

  it("omits a provider below minDecisions (no annotation when none qualify)", () => {
    const out = annotateFindingsWithPrecision([finding("openrouter")], precision, { minDecisions: 5 });
    expect(out[0]?.reviewer_precision).toBeUndefined();
  });

  it("does not mutate the input finding", () => {
    const input = [finding("codex")];
    annotateFindingsWithPrecision(input, precision, { minDecisions: 5 });
    expect(input[0]?.reviewer_precision).toBeUndefined();
  });
});

describe("loadProviderPrecision (best-effort)", () => {
  it("returns an empty map when there is no audit dir", () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-pp-"));
    const m = loadProviderPrecision(repo, { windowDays: 90, now: new Date() });
    expect(m.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/unit/provider-precision.test.ts`
Expected: FAIL — module `src/core/provider-precision.ts` does not exist.

- [ ] **Step 3: Create the module**

Create `src/core/provider-precision.ts`:

```ts
// src/core/provider-precision.ts
// #8: advisory per-provider precision context. Aggregates historical precision
// (tp/(tp+fp)) from decision.applied audit events and attaches it to findings as
// pure metadata. NEVER affects severity/verdict — see the design spec.
//
// The tp/(tp+fp) arithmetic deliberately parallels src/stats/aggregate.ts's
// byProvider precision cell (same DecisionOutcome source); it is NOT factored into
// a shared helper because the stats loop bundles declined/severity bookkeeping that
// the gate path does not need.
import type { DecisionOutcome } from "../schemas/audit-event.ts";
import type { Finding } from "../schemas/finding.ts";
import { loadAuditWindow } from "../stats/load.ts";
import { normalizeProviders } from "./decision-outcome.ts";

export const PROVIDER_PRECISION_WINDOW_DAYS = 90;
export const PROVIDER_PRECISION_MIN_DECISIONS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ProviderPrecision {
  tp: number;
  fp: number;
  precision: number | null; // tp/(tp+fp); null when tp+fp === 0
}

// Pure: count tp/fp per base provider. INFO is excluded (non-blocking, needs no
// decision); `declined` is ignored (neither a true nor a false positive).
export function perProviderPrecision(
  decisions: DecisionOutcome[],
): Map<string, ProviderPrecision> {
  const acc = new Map<string, { tp: number; fp: number }>();
  for (const d of decisions) {
    if (d.severity === "INFO") continue;
    if (d.bucket !== "tp" && d.bucket !== "fp") continue;
    for (const p of d.providers) {
      const cur = acc.get(p) ?? { tp: 0, fp: 0 };
      if (d.bucket === "tp") cur.tp += 1;
      else cur.fp += 1;
      acc.set(p, cur);
    }
  }
  const out = new Map<string, ProviderPrecision>();
  for (const [p, { tp, fp }] of acc) {
    out.set(p, { tp, fp, precision: tp + fp === 0 ? null : tp / (tp + fp) });
  }
  return out;
}

// Best-effort gate-time load over [now − windowDays, now]. BOTH since and until
// are passed so loadAuditWindow uses the bounded day-dir scan. Empty map on ANY
// error (advisory only — never throws).
export function loadProviderPrecision(
  repoRoot: string,
  opts: { windowDays: number; now: Date },
): Map<string, ProviderPrecision> {
  try {
    const since = new Date(opts.now.getTime() - opts.windowDays * DAY_MS).toISOString();
    const until = opts.now.toISOString();
    const { decisions } = loadAuditWindow(repoRoot, { since, until });
    return perProviderPrecision(decisions);
  } catch {
    return new Map();
  }
}

// Attach reviewer_precision to each finding for its contributing base providers
// (normalizeProviders) that have >= minDecisions samples (tp+fp). Immutable: a
// finding with no qualifying provider is returned unchanged.
export function annotateFindingsWithPrecision(
  findings: Finding[],
  precision: Map<string, ProviderPrecision>,
  opts: { minDecisions: number },
): Finding[] {
  if (precision.size === 0) return findings;
  return findings.map((f) => {
    const cells: NonNullable<Finding["reviewer_precision"]> = [];
    for (const p of normalizeProviders(f)) {
      const pr = precision.get(p);
      if (pr && pr.tp + pr.fp >= opts.minDecisions) {
        cells.push({ provider: p, tp: pr.tp, fp: pr.fp, precision: pr.precision });
      }
    }
    return cells.length > 0 ? { ...f, reviewer_precision: cells } : f;
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/unit/provider-precision.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
bunx tsc --noEmit
git add src/core/provider-precision.ts tests/unit/provider-precision.test.ts
git commit -m "feat(#8): provider-precision aggregation + finding annotation helpers"
```

---

## Task 3: Render the track-record line in `fmtFinding`

**Files:**
- Modify: `src/core/report-writer.ts` (`fmtFinding`, ~line 69-105)
- Test: `tests/unit/report-writer-precision.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/report-writer-precision.test.ts`:

```ts
// tests/unit/report-writer-precision.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReportWriter } from "../../src/core/report-writer.ts";
import type { PendingReport } from "../../src/schemas/pending-report.ts";

const report: PendingReport = {
  schema: "reviewgate.pending.v1",
  run_id: "r1",
  iter: 1,
  max_iter: 3,
  verdict: "FAIL",
  counts: { critical: 1, warn: 0, info: 0 },
  reviewers: [
    { id: "codex", provider: "codex", model: "m", persona: "security", status: "ok", cost_usd: 0, duration_ms: 1 },
  ],
  findings: [
    {
      id: "F-001",
      signature: "s",
      severity: "CRITICAL",
      category: "security",
      rule_id: "r",
      file: "a.ts",
      line_start: 1,
      line_end: 1,
      message: "m",
      details: "d",
      reviewer: { provider: "codex", model: "m", persona: "security" },
      confidence: 0.9,
      consensus: "singleton",
      reviewer_precision: [
        { provider: "codex", tp: 22, fp: 3, precision: 22 / 25 },
        { provider: "openrouter", tp: 7, fp: 10, precision: 7 / 17 },
      ],
    },
  ],
  cost_usd_total: 0,
  duration_ms_total: 1,
  generated_at: "2026-06-16T00:00:00Z",
  git: { sha: "abc1234", branch: "main", dirty_files: ["a.ts"] },
};

describe("report-writer renders reviewer_precision (#8)", () => {
  it("renders a Reviewer track record line with each provider's precision", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-pp-rep-"));
    await new ReportWriter(dir).write(report);
    const md = readFileSync(join(dir, ".reviewgate", "pending.md"), "utf8");
    expect(md).toContain("Reviewer track record:");
    expect(md).toContain("codex 88% (22 TP / 3 FP)");
    expect(md).toContain("openrouter 41% (7 TP / 10 FP)");
  });

  it("omits the line when no finding carries reviewer_precision", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-pp-rep2-"));
    const f0 = report.findings[0];
    if (!f0) throw new Error("fixture");
    const { reviewer_precision: _omit, ...noPrec } = f0;
    await new ReportWriter(dir).write({ ...report, findings: [noPrec] });
    const md = readFileSync(join(dir, ".reviewgate", "pending.md"), "utf8");
    expect(md).not.toContain("Reviewer track record:");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/unit/report-writer-precision.test.ts`
Expected: FAIL — the first test fails (no "Reviewer track record:" line); the second passes.

- [ ] **Step 3: Render the line in `fmtFinding`**

In `src/core/report-writer.ts`, inside `fmtFinding`, just before the `return [` (after `const consNote = ...` / the `suggestedFix` block ~line 93), add:

```ts
  // #8: advisory per-provider precision (pure metadata; never affects the verdict).
  // Rendered as a metadata line, NOT a badge — a badge would imply a demote happened.
  const precisionLine =
    f.reviewer_precision && f.reviewer_precision.length > 0
      ? `**Reviewer track record:** ${f.reviewer_precision
          .map(
            (p) =>
              `${p.provider} ${p.precision === null ? "n/a" : `${Math.round(p.precision * 100)}%`} (${p.tp} TP / ${p.fp} FP)`,
          )
          .join(" · ")}`
      : null;
```

Then insert `precisionLine` into the returned array, immediately after the `**Category:** …` line and before the badges:

```ts
  return [
    `### ${f.id}  ${sym} ${f.severity} ${consEmoji}  ·  ${f.file}:${loc}  ·  ${f.rule_id}`,
    `**Category:** ${f.category}  ·  **Consensus:** ${f.consensus}  ·  **Confidence:** ${f.confidence.toFixed(2)}${consNote}${confirmed}`,
    ...(precisionLine ? [precisionLine] : []),
    ...(badges ? [badges] : []),
    "",
    message,
    "",
    details,
    suggestedFix ? `\n**Suggested fix:**\n\`\`\`\n${suggestedFix}\n\`\`\`` : "",
    "",
  ].join("\n");
```

(Note: `Math.round((22/25)*100) = 88`, `Math.round((7/17)*100) = 41` — matches the test.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/unit/report-writer-precision.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
bunx tsc --noEmit
git add src/core/report-writer.ts tests/unit/report-writer-precision.test.ts
git commit -m "feat(#8): render the reviewer track-record line in pending.md"
```

---

## Task 4: `providerPrecisionContext` config toggle

**Files:**
- Modify: `src/config/define-config.ts` (in the `phases.review` object schema)
- Modify: `src/config/defaults.ts` (in `phases.review`)
- Test: `tests/unit/provider-precision-config.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/provider-precision-config.test.ts`:

```ts
// tests/unit/provider-precision-config.test.ts
import { describe, expect, it } from "bun:test";
import { defaultConfig } from "../../src/config/defaults.ts";
import { ConfigSchema } from "../../src/config/define-config.ts";

describe("#8 providerPrecisionContext config", () => {
  it("defaults to true in defaultConfig", () => {
    expect(defaultConfig.phases.review.providerPrecisionContext).toBe(true);
  });

  it("re-defaults to true when omitted from a parsed config", () => {
    const { providerPrecisionContext: _omit, ...reviewWithout } = defaultConfig.phases.review;
    const parsed = ConfigSchema.parse({
      ...defaultConfig,
      phases: { ...defaultConfig.phases, review: reviewWithout },
    });
    expect(parsed.phases.review.providerPrecisionContext).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/unit/provider-precision-config.test.ts`
Expected: FAIL — `providerPrecisionContext` is `undefined`.

- [ ] **Step 3: Add the config field + default**

In `src/config/define-config.ts`, inside the `phases.review` object schema (near the other flat review toggles like `confidenceFloor` / `demoteTestSecurity` / `scopeToDiff`), add:

```ts
    // #8: annotate each finding in pending.md/json with the historical precision
    // (tp/fp) of the provider(s) that raised it — ADVISORY context for the agent's
    // accept/reject decision; never changes severity/verdict. Default on.
    providerPrecisionContext: z.boolean().default(true),
```

In `src/config/defaults.ts`, inside `phases.review` (near `confidenceFloor` / `demoteTestSecurity`), add:

```ts
      providerPrecisionContext: true,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/unit/provider-precision-config.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
bunx tsc --noEmit
git add src/config/define-config.ts src/config/defaults.ts tests/unit/provider-precision-config.test.ts
git commit -m "feat(#8): add phases.review.providerPrecisionContext toggle (default true)"
```

---

## Task 5: Orchestrator wiring

**Files:**
- Modify: `src/core/orchestrator.ts` (between `aggregate()` ~1639 and `writeReport` ~1691)
- Test: `tests/unit/orchestrator-precision-context.test.ts`

### Context

- The injection point is inside `runIteration` (defined ~line 447). `repo` (`this.input.repoRoot`), `now` (`this.input.now?.() ?? new Date()`), `this.input.reportMode`, and `this.input.config` are all in scope there.
- `agg.dedupedFindings` is also used by the `demoted` count and `deriveImplicitOutcomes` — leave those on the original; only the report gets the annotated copy.
- The annotation must NOT run in one-shot mode and must be best-effort.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/orchestrator-precision-context.test.ts`:

```ts
// tests/unit/orchestrator-precision-context.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLogger } from "../../src/audit/logger.ts";
import { defaultConfig } from "../../src/config/defaults.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";
import type { Finding } from "../../src/schemas/finding.ts";
import { auditDir } from "../../src/utils/paths.ts";

const DIFF = "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-a\n+b\n";

function critFinding(): Finding {
  return {
    id: "F", signature: "real-sig", severity: "CRITICAL", category: "security", rule_id: "r",
    file: "foo.ts", line_start: 1, line_end: 1, message: "m", details: "d",
    reviewer: { provider: "codex", model: "m", persona: "security" }, confidence: 0.9, consensus: "singleton",
  };
}

function stub(): ProviderAdapter {
  return {
    id: "codex",
    async preflight() { return { available: true, version: "x", authMode: "oauth", error: null }; },
    async review(inp) {
      return {
        reviewerId: inp.reviewerId, verdict: "FAIL", findings: [critFinding()],
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
        durationMs: 1, exitCode: 0, rawEventsPath: "", status: "ok",
      } satisfies ReviewResult;
    },
  };
}

// Seed `tp` true positives and `fp` false positives for `provider` into the audit log.
async function seedDecisions(repo: string, provider: string, tp: number, fp: number) {
  const audit = new AuditLogger(auditDir(repo));
  for (let i = 0; i < tp; i++)
    await audit.append({ event: "decision.applied", run_id: "seed", iter: 1, trigger: "stop-hook",
      decision_outcome: { finding_id: `T${i}`, severity: "CRITICAL", bucket: "tp", providers: [provider] } });
  for (let i = 0; i < fp; i++)
    await audit.append({ event: "decision.applied", run_id: "seed", iter: 1, trigger: "stop-hook",
      decision_outcome: { finding_id: `P${i}`, severity: "CRITICAL", bucket: "fp", providers: [provider] } });
}

function makeConfig(providerPrecisionContext: boolean) {
  return {
    ...defaultConfig,
    phases: {
      ...defaultConfig.phases,
      review: { reviewers: [{ provider: "codex" as const, persona: "security" }], providerPrecisionContext },
      critic: null,
      triage: null,
    },
  };
}

describe("orchestrator annotates findings with provider precision (#8)", () => {
  it("renders the track-record line when the toggle is on and history exists", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-pp-orch-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    await seedDecisions(repo, "codex", 5, 2); // 5 TP / 2 FP → 71%, 7 samples ≥ 5
    const orch = new Orchestrator({
      repoRoot: repo, config: makeConfig(true), adapters: { codex: stub() },
      sandboxMode: "off", hostTier: "opus", diff: DIFF, reasonOnFailEnabled: true,
    });
    await orch.runIteration({ runId: "RUN", iter: 1 });
    const md = readFileSync(join(repo, ".reviewgate", "pending.md"), "utf8");
    expect(md).toContain("Reviewer track record:");
    expect(md).toContain("codex 71% (5 TP / 2 FP)");
  });

  it("does NOT annotate when the toggle is off", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-pp-orch-off-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    await seedDecisions(repo, "codex", 5, 2);
    const orch = new Orchestrator({
      repoRoot: repo, config: makeConfig(false), adapters: { codex: stub() },
      sandboxMode: "off", hostTier: "opus", diff: DIFF, reasonOnFailEnabled: true,
    });
    await orch.runIteration({ runId: "RUN", iter: 1 });
    const md = readFileSync(join(repo, ".reviewgate", "pending.md"), "utf8");
    expect(md).not.toContain("Reviewer track record:");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/unit/orchestrator-precision-context.test.ts --timeout 20000`
Expected: FAIL — the first test fails (no track-record line; the wiring doesn't exist yet). The toggle-off test passes.

- [ ] **Step 3: Add the imports**

In `src/core/orchestrator.ts`, add to the imports near the other `./` core imports:

```ts
import {
  PROVIDER_PRECISION_MIN_DECISIONS,
  PROVIDER_PRECISION_WINDOW_DAYS,
  annotateFindingsWithPrecision,
  loadProviderPrecision,
} from "./provider-precision.ts";
```

- [ ] **Step 4: Wire the annotation before `writeReport`**

In `runIteration`, locate the `await this.writeReport(opts, start, settled, agg.dedupedFindings, agg.verdict, agg.counts, ...)` call (~line 1691). Immediately BEFORE it, add:

```ts
    // #8: advisory per-provider precision context (gate mode only, toggle-gated,
    // best-effort). Pure metadata on the REPORT findings only — the verdict/counts
    // (from aggregate, above) and the cached {verdict,counts} are untouched.
    let reportFindings = agg.dedupedFindings;
    if (
      this.input.reportMode !== "one-shot" &&
      this.input.config.phases.review.providerPrecisionContext
    ) {
      try {
        const precision = loadProviderPrecision(repo, {
          windowDays: PROVIDER_PRECISION_WINDOW_DAYS,
          now,
        });
        reportFindings = annotateFindingsWithPrecision(reportFindings, precision, {
          minDecisions: PROVIDER_PRECISION_MIN_DECISIONS,
        });
      } catch (err) {
        console.warn(`[reviewgate] provider-precision annotation failed (non-fatal): ${String(err)}`);
      }
    }
```

Then change the `writeReport` call's 4th argument from `agg.dedupedFindings` to `reportFindings`:

```ts
    await this.writeReport(
      opts,
      start,
      settled,
      reportFindings,
      agg.verdict,
      agg.counts,
      criticInfo ? { ...criticInfo, demoted } : undefined,
      panelNote,
    );
```

Leave the `demoted` count and `deriveImplicitOutcomes` call (above) on `agg.dedupedFindings` — unchanged.

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test tests/unit/orchestrator-precision-context.test.ts --timeout 20000`
Expected: PASS (2 tests).

- [ ] **Step 6: Typecheck + lint + commit**

```bash
bunx tsc --noEmit && bun run lint
git add src/core/orchestrator.ts tests/unit/orchestrator-precision-context.test.ts
git commit -m "feat(#8): annotate findings with provider precision before writeReport"
```

---

## Task 6: Full-suite regression + DoD

**Files:** none (verification only).

- [ ] **Step 1: Run the full unit suite**

Run: `bun test tests/unit --timeout 20000`
Expected: all green (baseline ~1801 + the new tests). Watch the existing `report-writer*.test.ts` and `stats-aggregate.test.ts` — the new metadata line must not break any existing `toContain`/snapshot assertion, and stats was left untouched.

- [ ] **Step 2: Typecheck + lint (final)**

Run: `bunx tsc --noEmit && bun run lint`
Expected: both clean.

- [ ] **Step 3: No commit**

Verification only. Proceed to the DoD review chain (codex, opus whole-branch) before merge.

---

## Self-review notes (spec coverage)

- Advisory `reviewer_precision` finding field → Task 1. ✓
- `perProviderPrecision` (tp/(tp+fp), INFO excluded, declined ignored, null at 0) → Task 2 + tests. ✓
- `loadProviderPrecision` both-bounds + best-effort → Task 2 (impl passes `since`+`until`; empty-on-error test). ✓
- `annotateFindingsWithPrecision` minDecisions gate, multi-provider, immutable → Task 2 + tests. ✓
- Render track-record line (no badge) → Task 3 + tests. ✓
- `providerPrecisionContext` toggle default true → Task 4 + tests. ✓
- Orchestrator wiring (gate mode, toggle, best-effort, report-only) → Task 5 + integration tests (toggle on/off). ✓
- Non-suppressing: annotation is post-aggregate, report-only, verdict/cache untouched → Task 5 placement + the orchestrator tests assert only rendering, never verdict change. ✓
- DRY: stats left untouched per the spec's allowed fallback (documented). ✓
