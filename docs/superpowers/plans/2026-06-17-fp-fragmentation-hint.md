# Advisory FP-Fragmentation Surfacing (#4) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a false-positive class is fragmenting on a file (many distinct FP-ledger entries with recent rejects) but not being auto-suppressed, surface an advisory banner in pending.md recommending a house rule (the documented durable fix). Non-suppressing, render-only, fail-safe.

**Architecture:** A pure `fragmentingFpClasses` detector over the FP-ledger snapshot, called from the orchestrator after `fpActiveClusters` (gate-mode, toggle-gated, best-effort). Suppression-exclusion uses the WINDOWED views (`fpActiveSnapshot` + active/sticky `FpCluster.file`), never the stored entry stage. The result threads to `writeReport` as a new param → an optional `fp_fragmentation` `PendingReport` field → a banner.

**Tech Stack:** Bun, TypeScript, zod, `bun test`. Spec: `docs/superpowers/specs/2026-06-17-fp-fragmentation-hint-design.md`.

---

## File structure

- `src/core/fp-ledger/fragmentation.ts` — new: pure `fragmentingFpClasses` + constants.
- `src/schemas/pending-report.ts` — optional `fp_fragmentation` field.
- `src/core/report-writer.ts` — the advisory banner in `renderMd`.
- `src/config/define-config.ts` + `defaults.ts` — `phases.review.fpFragmentationHint` toggle.
- `src/core/orchestrator.ts` — compute the hint after `fpActiveClusters`; thread via a new `writeReport` param.
- `tests/unit/` — new tests per task.

---

## Task 1: `fragmentingFpClasses` pure detector

**Files:**
- Create: `src/core/fp-ledger/fragmentation.ts`
- Test: `tests/unit/fp-fragmentation.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/fp-fragmentation.test.ts`:

```ts
// tests/unit/fp-fragmentation.test.ts
import { describe, expect, it } from "bun:test";
import { fragmentingFpClasses } from "../../src/core/fp-ledger/fragmentation.ts";
import type { FpLedgerEntry } from "../../src/schemas/fp-ledger.ts";

const NOW = "2026-06-17T12:00:00.000Z";
function ago(days: number): string {
  return new Date(Date.parse(NOW) - days * 86_400_000).toISOString();
}
// Minimal valid FpLedgerEntry; the detector reads only file/signature/rule_id/rejects[].ts.
function entry(file: string, signature: string, rule_id: string, rejectTs: string[]): FpLedgerEntry {
  return {
    id: signature,
    signature,
    rule_id,
    category: "security",
    file,
    symbol: "",
    stage: "candidate",
    rejects: rejectTs.map((ts) => ({ run_id: "r", provider: "codex", ts, reason: "fp" })),
    distinct_providers: ["codex"],
    first_seen_at: rejectTs[0] ?? NOW,
    last_seen_at: rejectTs.at(-1) ?? NOW,
    created_at: rejectTs[0] ?? NOW,
  };
}
const OPTS = { minDistinctSignatures: 3, minRejects: 3, windowDays: 60, suppressedFiles: new Set<string>() };

describe("fragmentingFpClasses", () => {
  it("flags a file with >= 3 distinct in-window signatures and >= 3 in-window rejects", () => {
    const out = fragmentingFpClasses(
      [
        entry("a.ts", "s1", "color-hsl", [ago(1)]),
        entry("a.ts", "s2", "css-var", [ago(2)]),
        entry("a.ts", "s3", "hsl-usage", [ago(3)]),
      ],
      NOW,
      OPTS,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.file).toBe("a.ts");
    expect(out[0]?.distinct_signatures).toBe(3);
    expect(out[0]?.total_rejects).toBe(3);
    expect(out[0]?.sample_rule_ids).toEqual(["color-hsl", "css-var", "hsl-usage"]);
  });

  it("does NOT flag below minDistinctSignatures (only 2 distinct sigs)", () => {
    const out = fragmentingFpClasses(
      [entry("a.ts", "s1", "r1", [ago(1), ago(2)]), entry("a.ts", "s2", "r2", [ago(1)])],
      NOW,
      OPTS,
    );
    expect(out).toEqual([]);
  });

  it("excludes a file in suppressedFiles entirely", () => {
    const out = fragmentingFpClasses(
      [
        entry("a.ts", "s1", "r1", [ago(1)]),
        entry("a.ts", "s2", "r2", [ago(2)]),
        entry("a.ts", "s3", "r3", [ago(3)]),
      ],
      NOW,
      { ...OPTS, suppressedFiles: new Set(["a.ts"]) },
    );
    expect(out).toEqual([]);
  });

  it("ignores stale (out-of-window) rejects — a signature with no in-window reject does not count", () => {
    const out = fragmentingFpClasses(
      [
        entry("a.ts", "s1", "r1", [ago(1)]),
        entry("a.ts", "s2", "r2", [ago(2)]),
        entry("a.ts", "s3", "r3", [ago(90)]), // stale → s3 not counted, only 2 distinct in-window
      ],
      NOW,
      OPTS,
    );
    expect(out).toEqual([]);
  });

  it("sorts multiple flagged files by total_rejects desc", () => {
    const out = fragmentingFpClasses(
      [
        entry("a.ts", "a1", "r", [ago(1)]),
        entry("a.ts", "a2", "r", [ago(1)]),
        entry("a.ts", "a3", "r", [ago(1)]),
        entry("b.ts", "b1", "r", [ago(1), ago(2)]),
        entry("b.ts", "b2", "r", [ago(1)]),
        entry("b.ts", "b3", "r", [ago(1)]),
      ],
      NOW,
      OPTS,
    );
    expect(out.map((f) => f.file)).toEqual(["b.ts", "a.ts"]); // b has 4 rejects, a has 3
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/unit/fp-fragmentation.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create the module**

Create `src/core/fp-ledger/fragmentation.ts`:

```ts
// src/core/fp-ledger/fragmentation.ts
// #4: advisory detector for a FRAGMENTING false-positive class — a file with many
// distinct FP-ledger entries that recur (recent rejects) but can't promote to
// auto-suppression (fragmented rule_ids / single-reviewer ≥2-provider floor). Pure.
// NON-suppressing: the caller renders a banner recommending a house rule (the durable
// fix); this never demotes/suppresses a finding.
import type { FpLedgerEntry } from "../../schemas/fp-ledger.ts";

export const FP_FRAG_MIN_SIGNATURES = 3;
export const FP_FRAG_MIN_REJECTS = 3;
export const FP_FRAG_WINDOW_DAYS = 60;
export const FP_FRAG_MAX_REPORTED = 3;
const DAY_MS = 86_400_000;

export interface FpFragmentation {
  file: string;
  distinct_signatures: number;
  total_rejects: number;
  sample_rule_ids: string[];
}

// `suppressedFiles` = files where suppression is EFFECTIVELY ACTIVE at `now` (the
// caller builds it from the windowed views — fpActiveSnapshot + active/sticky clusters
// — NOT the stored, promote-only entry.stage). The detector relies entirely on it for
// the "already suppressed" exclusion and never reads entry.stage.
export function fragmentingFpClasses(
  entries: FpLedgerEntry[],
  nowIso: string,
  opts: {
    minDistinctSignatures: number;
    minRejects: number;
    windowDays: number;
    suppressedFiles: Set<string>;
  },
): FpFragmentation[] {
  const nowMs = Date.parse(nowIso);
  const windowMs = opts.windowDays * DAY_MS;
  const byFile = new Map<string, FpLedgerEntry[]>();
  for (const e of entries) {
    if (opts.suppressedFiles.has(e.file)) continue;
    const arr = byFile.get(e.file);
    if (arr) arr.push(e);
    else byFile.set(e.file, [e]);
  }
  const out: FpFragmentation[] = [];
  for (const [file, fileEntries] of byFile) {
    const sigs = new Set<string>();
    const ruleIds = new Set<string>();
    let rejects = 0;
    for (const e of fileEntries) {
      const inWindow = e.rejects.filter((r) => nowMs - Date.parse(r.ts) <= windowMs);
      if (inWindow.length === 0) continue; // stale signature — no recent activity
      sigs.add(e.signature);
      ruleIds.add(e.rule_id);
      rejects += inWindow.length;
    }
    if (sigs.size >= opts.minDistinctSignatures && rejects >= opts.minRejects) {
      out.push({
        file,
        distinct_signatures: sigs.size,
        total_rejects: rejects,
        sample_rule_ids: [...ruleIds].sort().slice(0, 4),
      });
    }
  }
  out.sort((a, b) => b.total_rejects - a.total_rejects || a.file.localeCompare(b.file));
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/unit/fp-fragmentation.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck + lint + commit**

```bash
bunx tsc --noEmit && bun run lint
git add src/core/fp-ledger/fragmentation.ts tests/unit/fp-fragmentation.test.ts
git commit -m "feat(#4): fragmentingFpClasses pure detector"
```

(If `bun run lint` flags formatting, run `bun run format`, re-check, then commit.)

---

## Task 2: `fp_fragmentation` schema field + report banner

**Files:**
- Modify: `src/schemas/pending-report.ts` (after `large_diff`)
- Modify: `src/core/report-writer.ts` (`renderMd`, near `largeDiffBanner` / the head banners)
- Test: `tests/unit/report-writer-fragmentation.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/report-writer-fragmentation.test.ts`:

```ts
// tests/unit/report-writer-fragmentation.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReportWriter } from "../../src/core/report-writer.ts";
import type { PendingReport } from "../../src/schemas/pending-report.ts";

const base: PendingReport = {
  schema: "reviewgate.pending.v1",
  run_id: "r1",
  iter: 1,
  max_iter: 3,
  verdict: "FAIL",
  counts: { critical: 1, warn: 0, info: 0 },
  reviewers: [
    { id: "codex", provider: "codex", model: "m", persona: "security", status: "ok", cost_usd: 0, duration_ms: 1 },
  ],
  findings: [],
  cost_usd_total: 0,
  duration_ms_total: 1,
  generated_at: "2026-06-17T00:00:00Z",
  git: { sha: "abc1234", branch: "main", dirty_files: [] },
};

describe("report-writer fp_fragmentation banner (#4)", () => {
  it("renders the fragmenting-class banner with file, rule_ids, and the house-rule recommendation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-frag-"));
    await new ReportWriter(dir).write({
      ...base,
      fp_fragmentation: [
        { file: "src/theme.ts", distinct_signatures: 4, total_rejects: 6, sample_rule_ids: ["color-hsl", "css-var"] },
      ],
    });
    const md = readFileSync(join(dir, ".reviewgate", "pending.md"), "utf8");
    expect(md).toContain("Fragmenting false-positive class");
    expect(md).toContain("src/theme.ts");
    expect(md).toContain("color-hsl");
    expect(md).toContain("houseRules");
  });

  it("omits the banner when fp_fragmentation is absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-frag2-"));
    await new ReportWriter(dir).write(base);
    const md = readFileSync(join(dir, ".reviewgate", "pending.md"), "utf8");
    expect(md).not.toContain("Fragmenting false-positive class");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/unit/report-writer-fragmentation.test.ts`
Expected: FAIL — the schema rejects `fp_fragmentation` and the banner is not rendered.

- [ ] **Step 3: Add the schema field**

In `src/schemas/pending-report.ts`, immediately after the `large_diff` field (the one ending `.optional(),`), add:

```ts
  // #4: advisory — files where a false-positive class is fragmenting across many
  // FP-ledger entries but not promoting to auto-suppression (fragmented rule_ids /
  // single-reviewer ≥2-provider floor). Render-only; recommends a house rule. The
  // verdict is unaffected.
  fp_fragmentation: z
    .array(
      z.object({
        file: z.string(),
        distinct_signatures: z.number().int().nonnegative(),
        total_rejects: z.number().int().nonnegative(),
        sample_rule_ids: z.array(z.string()),
      }),
    )
    .optional(),
```

- [ ] **Step 4: Render the banner**

In `src/core/report-writer.ts` `renderMd`, immediately after the `unsettledBanner` const block (the #7 banner), add:

```ts
  // #4: advisory hint when a false-positive class is fragmenting on a file but not
  // auto-suppressing — recommend a house rule (the durable fix). rule_ids are
  // gate-derived ledger fields (known strings), so no injection neutralization needed.
  const fragmentationBanner = (r.fp_fragmentation ?? []).flatMap((f) => [
    `> ⚠ **Fragmenting false-positive class:** \`${f.file}\` has ${f.distinct_signatures} distinct rejected-FP findings (e.g. ${f.sample_rule_ids.map((id) => `\`${id}\``).join(", ")}; ${f.total_rejects} rejects) that aren't promoting to auto-suppression (fragmented rule_ids / single reviewer). The durable fix is a **house rule** in \`phases.review.houseRules\` (reviewgate.config.ts) asserting the repo's ground truth — it suppresses the class at the source and invalidates cached verdicts.`,
    "",
  ]);
```

Then add `...fragmentationBanner,` to the `head` array immediately after `...unsettledBanner,`:

```ts
    ...largeDiffBanner,
    ...unsettledBanner,
    ...fragmentationBanner,
    ...(r.panel_note ? [`> ⛔ **Panel:** ${r.panel_note}`, ""] : []),
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test tests/unit/report-writer-fragmentation.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Typecheck + lint + commit**

```bash
bunx tsc --noEmit && bun run lint
git add src/schemas/pending-report.ts src/core/report-writer.ts tests/unit/report-writer-fragmentation.test.ts
git commit -m "feat(#4): fp_fragmentation report field + fragmenting-class banner"
```

---

## Task 3: `fpFragmentationHint` config toggle

**Files:**
- Modify: `src/config/define-config.ts` (phases.review) + `src/config/defaults.ts` (phases.review)
- Test: `tests/unit/fp-fragmentation-config.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/fp-fragmentation-config.test.ts`:

```ts
// tests/unit/fp-fragmentation-config.test.ts
import { describe, expect, it } from "bun:test";
import { defaultConfig } from "../../src/config/defaults.ts";
import { defineConfig } from "../../src/config/define-config.ts";

describe("#4 fpFragmentationHint config", () => {
  it("defaults to true in defaultConfig", () => {
    expect(defaultConfig.phases.review.fpFragmentationHint).toBe(true);
  });

  it("re-defaults to true when omitted from a user config (deepMerge)", () => {
    const parsed = defineConfig({
      phases: { review: { reviewers: [{ provider: "codex", persona: "security" }] } },
    });
    expect(parsed.phases.review.fpFragmentationHint).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/unit/fp-fragmentation-config.test.ts`
Expected: FAIL — `fpFragmentationHint` is `undefined`.

- [ ] **Step 3: Add the config field + default**

In `src/config/define-config.ts`, inside the `phases.review` object schema (near `providerPrecisionContext` / `settleBeforeReview`), add:

```ts
    // #4: surface an advisory hint in pending.md when a false-positive class is
    // fragmenting across many FP-ledger entries on a file but not promoting to
    // auto-suppression — recommending a house rule (the durable fix). Render-only;
    // never suppresses a finding. Default on. (No-op unless the FP-ledger is enabled.)
    fpFragmentationHint: z.boolean().optional(),
```

In `src/config/defaults.ts`, inside `phases.review` (near `settleBeforeReview: true`), add:

```ts
      fpFragmentationHint: true,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/unit/fp-fragmentation-config.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck + lint + commit**

```bash
bunx tsc --noEmit && bun run lint
git add src/config/define-config.ts src/config/defaults.ts tests/unit/fp-fragmentation-config.test.ts
git commit -m "feat(#4): add phases.review.fpFragmentationHint toggle (default true)"
```

---

## Task 4: Orchestrator wiring (compute hint + thread via writeReport param)

**Files:**
- Modify: `src/core/orchestrator.ts` — collect active-cluster files in the cluster loop (~1626); compute `fpFragmentation` after it; add a `fpFragmentation?` param to `writeReport` (~2091) + inject into the report object (next to `large_diff` ~2148); pass it on the main panel `writeReport` call (~1723)
- Test: `tests/unit/orchestrator-fp-fragmentation.test.ts`

### Context
- The orchestrator loads `fpFullSnapshot = await fpStore.snapshot()` (~651) and `fpActiveSnapshot = await fpStore.activeSnapshot(now)` (~654, `Map<signature, FpLedgerEntry>` effectively-active at now). It computes `fpActiveClusters` from `computeFpClusters(...)` in a loop (~1624-1631) where each `c` is an `FpCluster` with `.file`, `.stage`.
- `now` is `this.input.now?.() ?? new Date()` (in scope).
- `writeReport(opts, start, runs, findings, verdict, counts, critic?, panelNote?)` builds the `PendingReport` (the `large_diff` injection is `...(this.input.largeDiff ? { large_diff: this.input.largeDiff } : {})`).
- The main panel `writeReport` call is at ~1723.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/orchestrator-fp-fragmentation.test.ts`:

```ts
// tests/unit/orchestrator-fp-fragmentation.test.ts
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultConfig } from "../../src/config/defaults.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";
import type { Finding } from "../../src/schemas/finding.ts";
import type { FpLedgerEntry } from "../../src/schemas/fp-ledger.ts";
import { knownFpPath } from "../../src/utils/paths.ts";

const DIFF = "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-a\n+b\n";

function stub(): ProviderAdapter {
  const f: Finding = {
    id: "F", signature: "real", severity: "CRITICAL", category: "security", rule_id: "r",
    file: "foo.ts", line_start: 1, line_end: 1, message: "m", details: "d",
    reviewer: { provider: "codex", model: "m", persona: "security" }, confidence: 0.9, consensus: "singleton",
  };
  return {
    id: "codex",
    async preflight() { return { available: true, version: "x", authMode: "oauth", error: null }; },
    async review(inp) {
      return {
        reviewerId: inp.reviewerId, verdict: "FAIL", findings: [f],
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
        durationMs: 1, exitCode: 0, rawEventsPath: "", status: "ok",
      } satisfies ReviewResult;
    },
  };
}

function fpEntry(signature: string, rule_id: string, ts: string): FpLedgerEntry {
  return {
    id: signature, signature, rule_id, category: "security", file: "bar.ts", symbol: "", stage: "candidate",
    rejects: [{ run_id: "r", provider: "codex", ts, reason: "fp" }],
    distinct_providers: ["codex"], first_seen_at: ts, last_seen_at: ts, created_at: ts,
  };
}

// A fragmenting class on bar.ts: 3 distinct candidate signatures, 1 recent reject each,
// single provider → can't promote (per-signature OR cluster) → flagged.
function seedFragmentingLedger(repo: string): void {
  const ts = new Date().toISOString();
  const index = {
    schema: "reviewgate.fpledger.v1",
    entries: [fpEntry("s1", "color-hsl", ts), fpEntry("s2", "css-var", ts), fpEntry("s3", "hsl-usage", ts)],
  };
  const p = knownFpPath(repo);
  mkdirSync(dirname(p), { recursive: true }); // fresh temp repo → .reviewgate/ may not exist yet
  writeFileSync(p, JSON.stringify(index));
}

describe("orchestrator surfaces FP fragmentation (#4)", () => {
  it("renders the fragmenting-class banner for a fragmenting ledger when the hint is on", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-orch-frag-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    seedFragmentingLedger(repo);
    const config = {
      ...defaultConfig,
      phases: {
        ...defaultConfig.phases,
        review: { reviewers: [{ provider: "codex" as const, persona: "security" }], fpFragmentationHint: true },
        fpLedger: { enabled: true },
        critic: null,
        triage: null,
      },
    };
    const orch = new Orchestrator({
      repoRoot: repo, config, adapters: { codex: stub() },
      sandboxMode: "off", hostTier: "opus", diff: DIFF, reasonOnFailEnabled: true,
    });
    await orch.runIteration({ runId: "RUN", iter: 1 });
    const md = readFileSync(join(repo, ".reviewgate", "pending.md"), "utf8");
    expect(md).toContain("Fragmenting false-positive class");
    expect(md).toContain("bar.ts");
  });

  it("does NOT render the banner when the hint is off", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-orch-frag-off-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    seedFragmentingLedger(repo);
    const config = {
      ...defaultConfig,
      phases: {
        ...defaultConfig.phases,
        review: { reviewers: [{ provider: "codex" as const, persona: "security" }], fpFragmentationHint: false },
        fpLedger: { enabled: true },
        critic: null,
        triage: null,
      },
    };
    const orch = new Orchestrator({
      repoRoot: repo, config, adapters: { codex: stub() },
      sandboxMode: "off", hostTier: "opus", diff: DIFF, reasonOnFailEnabled: true,
    });
    await orch.runIteration({ runId: "RUN", iter: 1 });
    const md = readFileSync(join(repo, ".reviewgate", "pending.md"), "utf8");
    expect(md).not.toContain("Fragmenting false-positive class");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/unit/orchestrator-fp-fragmentation.test.ts --timeout 20000`
Expected: FAIL — no banner (wiring absent). The toggle-off test may already pass.

- [ ] **Step 3: Import the detector**

In `src/core/orchestrator.ts`, add to the imports (near `computeFpClusters` from `./fp-ledger/clusters.ts`):

```ts
import {
  FP_FRAG_MAX_REPORTED,
  FP_FRAG_MIN_REJECTS,
  FP_FRAG_MIN_SIGNATURES,
  FP_FRAG_WINDOW_DAYS,
  type FpFragmentation,
  fragmentingFpClasses,
} from "./fp-ledger/fragmentation.ts";
```

- [ ] **Step 4: Collect active-cluster files in the cluster loop**

In the `fpActiveClusters` computation (~1622-1634), add an `activeClusterFiles` set populated from `c.file`. Change the loop:

```ts
    let fpActiveClusters: Map<string, { key: string; member_ids: string[] }> | undefined;
    const activeClusterFiles = new Set<string>();
    if (fpFullSnapshot) {
      try {
        const clusters = computeFpClusters(fpFullSnapshot.entries, now.toISOString());
        const map = new Map<string, { key: string; member_ids: string[] }>();
        for (const c of clusters) {
          if (c.stage === "active" || c.stage === "sticky") {
            map.set(c.key, { key: c.key, member_ids: c.member_ids });
            activeClusterFiles.add(c.file);
          }
        }
        if (map.size > 0) fpActiveClusters = map;
      } catch {
        /* best-effort */
      }
    }
```

- [ ] **Step 5: Compute the fragmentation hint (after the cluster block)**

Immediately after that block, add:

```ts
    // #4: advisory FP-fragmentation hint (gate-mode, toggle-gated, best-effort). Pure
    // render-only metadata — never suppresses a finding. Exclude files where suppression
    // is EFFECTIVELY ACTIVE at `now` (the windowed fpActiveSnapshot + active/sticky
    // clusters), never the stored entry.stage.
    let fpFragmentation: FpFragmentation[] | undefined;
    if (
      this.input.reportMode !== "one-shot" &&
      this.input.config.phases.review.fpFragmentationHint &&
      fpFullSnapshot
    ) {
      try {
        const suppressedFiles = new Set<string>(activeClusterFiles);
        if (fpActiveSnapshot) for (const e of fpActiveSnapshot.values()) suppressedFiles.add(e.file);
        const frag = fragmentingFpClasses(fpFullSnapshot.entries, now.toISOString(), {
          minDistinctSignatures: FP_FRAG_MIN_SIGNATURES,
          minRejects: FP_FRAG_MIN_REJECTS,
          windowDays: FP_FRAG_WINDOW_DAYS,
          suppressedFiles,
        });
        if (frag.length > 0) fpFragmentation = frag.slice(0, FP_FRAG_MAX_REPORTED);
      } catch (err) {
        console.warn(`[reviewgate] fp-fragmentation hint failed (non-fatal): ${String(err)}`);
      }
    }
```

- [ ] **Step 6: Add the `writeReport` param + inject into the report**

Change the `writeReport` signature (~2091) to add a trailing param after `panelNote?`:

```ts
    panelNote?: string,
    fpFragmentation?: FpFragmentation[],
  ): Promise<void> {
```

In the `PendingReport` object writeReport builds, immediately after the `...(this.input.largeDiff ? { large_diff: this.input.largeDiff } : {})` line, add:

```ts
        ...(fpFragmentation ? { fp_fragmentation: fpFragmentation } : {}),
```

- [ ] **Step 7: Pass it on the main panel call**

At the main panel `writeReport` call (~1723), add `fpFragmentation` as the final argument:

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
      fpFragmentation,
    );
```

(The other `writeReport` call sites don't pass it → `undefined` → no banner, correct — those paths have no panel/ledger context.)

- [ ] **Step 8: Run the test to verify it passes**

Run: `bun test tests/unit/orchestrator-fp-fragmentation.test.ts --timeout 20000`
Expected: PASS (2 tests).

- [ ] **Step 9: Typecheck + lint + commit**

```bash
bunx tsc --noEmit && bun run lint
git add src/core/orchestrator.ts tests/unit/orchestrator-fp-fragmentation.test.ts
git commit -m "feat(#4): compute + surface the FP-fragmentation hint in the orchestrator"
```

If `bun run lint` flags formatting, run `bun run format`, re-run `bun run lint` to confirm clean, then commit.

---

## Task 5: Full-suite regression + DoD

**Files:** none (verification only).

- [ ] **Step 1: Full unit suite**

Run: `bun test tests/unit --timeout 20000`
Expected: all green (baseline ~1848 + the new tests). The hint runs on every gate turn with an enabled FP-ledger; confirm no existing orchestrator/report-writer test regressed (the banner only renders when `fp_fragmentation` is present, which requires a fragmenting ledger — existing tests have empty/clean ledgers).

- [ ] **Step 2: Typecheck + lint (final)**

Run: `bunx tsc --noEmit && bun run lint`
Expected: both clean.

- [ ] **Step 3: No commit** — verification only. Proceed to the DoD review chain (codex, opus whole-branch) before merge.

---

## Self-review notes (spec coverage)

- `fragmentingFpClasses` pure detector (in-window counting, suppressedFiles exclusion, no entry.stage, sorted/capped) → Task 1 + tests. ✓
- `fp_fragmentation` schema field + house-rule-recommending banner → Task 2. ✓
- `fpFragmentationHint` toggle (default true) → Task 3. ✓
- Orchestrator: windowed `suppressedFiles` (fpActiveSnapshot + active-cluster `c.file`, no key-parse/stale-stage); compute (gate-mode, toggle-gated, best-effort); thread via the new `writeReport` PARAM (not `this.input`) → Task 4. ✓
- Fail-safe: render-only, never suppresses; best-effort try/catch; verdict/counts from `aggregate` untouched → Task 4 placement + the report-only field. ✓
- No-op unless FP-ledger enabled (`fpFullSnapshot` guard) → Task 4. ✓
