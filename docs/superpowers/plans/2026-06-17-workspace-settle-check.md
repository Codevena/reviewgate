# Workspace Settle-Check Before Review (#7) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before `collectDiff` snapshots the working tree, briefly (bounded) wait for working-tree files to stop changing, so the reviewer panel reviews a quiescent snapshot rather than a half-written one. Fail-safe: only ever *delays* a review (≤~1.5s), never skips it; a never-settling tree is reviewed anyway with a WARN banner.

**Architecture:** A base-independent settle-check (`git diff --name-only HEAD` ∪ untracked, sample `max(mtime,ctime)`, wait an interval, re-sample; advancing ⇒ active writer) runs at the top of `gatherReviewContext` (before both `collectDiff` call sites), inside the gate's 120s setup budget. The result flows gather → runGate → Orchestrator input → `PendingReport` → a WARN banner, mirroring the existing `largeDiff` pattern.

**Tech Stack:** Bun, TypeScript, zod, `bun test`. Spec: `docs/superpowers/specs/2026-06-17-workspace-settle-check-design.md`.

---

## File structure

- `src/utils/git.ts` — new exported `workingTreeDirtyFiles` (it needs the module-private `git()` helper, so it lives here with the other git utils).
- `src/core/workspace-settle.ts` — new: `latestChangeMs`, `awaitWorkspaceSettle`, constants (imports `workingTreeDirtyFiles` from `git.ts`).
- `src/schemas/pending-report.ts` — optional `workspace_unsettled` field.
- `src/core/report-writer.ts` — the WARN banner in `renderMd`.
- `src/config/define-config.ts` + `defaults.ts` — `settleBeforeReview` toggle.
- `src/core/orchestrator.ts` — accept `workspaceUnsettled?` input, inject into `PendingReport`.
- `src/cli/commands/gate.ts` — call `awaitWorkspaceSettle` at the top of `gatherReviewContext`; thread the toggle; add to `ReviewContext`; pass to the Orchestrator in `runGate`; export `gatherReviewContext` for testing.
- `tests/unit/` — new tests per task.

---

## Task 1: `workingTreeDirtyFiles` in git.ts

**Files:**
- Modify: `src/utils/git.ts` (add an exported function; uses the private `git()` ~line 22)
- Test: `tests/unit/working-tree-dirty-files.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/working-tree-dirty-files.test.ts`:

```ts
// tests/unit/working-tree-dirty-files.test.ts
import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workingTreeDirtyFiles } from "../../src/utils/git.ts";

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-wtdf-"));
  const run = (...args: string[]) => execFileSync("git", args, { cwd: dir });
  run("init", "-q");
  run("config", "user.email", "t@t.t");
  run("config", "user.name", "t");
  writeFileSync(join(dir, "committed.ts"), "const a = 1;\n");
  run("add", "committed.ts");
  run("commit", "-qm", "init");
  return dir;
}

describe("workingTreeDirtyFiles", () => {
  it("lists a tracked uncommitted change and an untracked file, not a clean committed file", async () => {
    const dir = gitRepo();
    writeFileSync(join(dir, "committed.ts"), "const a = 2;\n"); // tracked change
    writeFileSync(join(dir, "new.ts"), "const b = 3;\n"); // untracked
    const files = await workingTreeDirtyFiles(dir);
    expect(files).toContain("committed.ts");
    expect(files).toContain("new.ts");
  });

  it("returns an empty array for a clean working tree", async () => {
    const dir = gitRepo();
    expect(await workingTreeDirtyFiles(dir)).toEqual([]);
  });

  it("returns an empty array (best-effort) for a non-git directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-wtdf-nogit-"));
    expect(await workingTreeDirtyFiles(dir)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/unit/working-tree-dirty-files.test.ts`
Expected: FAIL — `workingTreeDirtyFiles` is not exported.

- [ ] **Step 3: Implement `workingTreeDirtyFiles`**

In `src/utils/git.ts`, add (after the private `git()` helper / near `collectDiff`):

```ts
// #7: working-tree-dirty file paths, base-independent — `git diff --name-only -z HEAD`
// (tracked uncommitted changes) ∪ `git ls-files -z --others --exclude-standard`
// (untracked, non-ignored). Used ONLY by the pre-review settle-check to detect an
// active writer; NOT a review scope (so no base/base_ts filter). `-z` → raw NUL-
// separated paths (lstat-safe). Each git call is independent + best-effort; union,
// dedupe. Returns [] if both fail (e.g. a non-git dir, or a fresh repo with no HEAD).
export async function workingTreeDirtyFiles(repoRoot: string): Promise<string[]> {
  const out = new Set<string>();
  const tracked = await git(repoRoot, ["diff", "--name-only", "-z", "HEAD"]);
  if (tracked.status === 0) {
    for (const f of tracked.stdout.split("\0")) if (f.length > 0) out.add(f);
  }
  const untracked = await git(repoRoot, ["ls-files", "-z", "--others", "--exclude-standard"]);
  if (untracked.status === 0) {
    for (const f of untracked.stdout.split("\0")) if (f.length > 0) out.add(f);
  }
  return [...out];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/unit/working-tree-dirty-files.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + lint + commit**

```bash
bunx tsc --noEmit && bun run lint
git add src/utils/git.ts tests/unit/working-tree-dirty-files.test.ts
git commit -m "feat(#7): workingTreeDirtyFiles git helper (base-independent dirty-file enumeration)"
```

(If `bun run lint` flags formatting, run `bun run format`, re-check, then commit.)

---

## Task 2: `workspace-settle.ts` (latest-change + settle loop)

**Files:**
- Create: `src/core/workspace-settle.ts`
- Test: `tests/unit/workspace-settle.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/workspace-settle.test.ts`:

```ts
// tests/unit/workspace-settle.test.ts
import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awaitWorkspaceSettle, latestChangeMs } from "../../src/core/workspace-settle.ts";

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-settle-"));
  const run = (...args: string[]) => execFileSync("git", args, { cwd: dir });
  run("init", "-q");
  run("config", "user.email", "t@t.t");
  run("config", "user.name", "t");
  writeFileSync(join(dir, "seed.ts"), "x\n");
  run("add", "seed.ts");
  run("commit", "-qm", "init");
  return dir;
}

// A fake clock + sleep that advances the clock by the slept ms (no real waiting).
function fakeClock(startMs: number) {
  let t = startMs;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

const OPTS = { quietWindowMs: 2000, settleIntervalMs: 250, maxSettleMs: 1500 };

describe("latestChangeMs", () => {
  it("returns the newest max(mtime,ctime) across files; 0 for empty", () => {
    const dir = gitRepo();
    writeFileSync(join(dir, "a.ts"), "a\n");
    expect(latestChangeMs(dir, [])).toBe(0);
    expect(latestChangeMs(dir, ["a.ts"])).toBeGreaterThan(0);
  });
});

describe("awaitWorkspaceSettle", () => {
  it("returns settled immediately when the last change is older than the quiet window (no sleep)", async () => {
    const dir = gitRepo();
    writeFileSync(join(dir, "old.ts"), "old\n"); // real mtime+ctime ≈ realNow
    // Drive `now()` 60s AHEAD of the file's real change time so it reads as quiescent.
    // (We do NOT use utimes to back-date: utimes updates ctime to now, and
    // latestChangeMs uses max(mtime, ctime) — so a fake clock offset is the right lever.)
    const clk = fakeClock(Date.now() + 60_000);
    let slept = 0;
    const r = await awaitWorkspaceSettle({
      repoRoot: dir, ...OPTS, now: clk.now, sleep: async (ms) => { slept += ms; clk.advance(ms); },
    });
    expect(r.settled).toBe(true);
    expect(r.waitedMs).toBe(0);
    expect(slept).toBe(0);
  });

  it("returns settled after one interval when the tree is stable", async () => {
    const dir = gitRepo();
    writeFileSync(join(dir, "fresh.ts"), "fresh\n"); // mtime ≈ now → enters the loop
    const clk = fakeClock(Date.now());
    const r = await awaitWorkspaceSettle({ repoRoot: dir, ...OPTS, now: clk.now, sleep: clk.sleep });
    expect(r.settled).toBe(true);
    expect(r.waitedMs).toBe(250); // one interval, then stable
  });

  it("returns NOT settled (churning) when the tree keeps changing every interval", async () => {
    const dir = gitRepo();
    const f = join(dir, "churn.ts");
    writeFileSync(f, "0\n");
    const clk = fakeClock(Date.now());
    // Each sleep also bumps the file's change time forward → always "advancing".
    const sleep = async (ms: number) => {
      clk.advance(ms);
      const t = clk.now() / 1000;
      utimesSync(f, t as unknown as number, t as unknown as number);
    };
    const r = await awaitWorkspaceSettle({ repoRoot: dir, ...OPTS, now: clk.now, sleep });
    expect(r.settled).toBe(false);
    expect(r.waitedMs).toBe(1500); // hit the cap
  });

  it("returns settled immediately for an empty (clean) working tree", async () => {
    const dir = gitRepo(); // clean
    const clk = fakeClock(Date.now());
    let slept = 0;
    const r = await awaitWorkspaceSettle({
      repoRoot: dir, ...OPTS, now: clk.now, sleep: async (ms) => { slept += ms; clk.advance(ms); },
    });
    expect(r.settled).toBe(true);
    expect(r.waitedMs).toBe(0);
    expect(slept).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/unit/workspace-settle.test.ts`
Expected: FAIL — `src/core/workspace-settle.ts` does not exist.

- [ ] **Step 3: Create the module**

Create `src/core/workspace-settle.ts`:

```ts
// src/core/workspace-settle.ts
// #7: bounded "settle" check — before collectDiff snapshots the working tree, wait
// (≤ maxSettleMs) for it to stop changing, so the panel reviews a quiescent snapshot
// rather than a half-written one. Fail-safe by design: the caller ONLY uses this to
// DELAY (and optionally warn), never to skip a review. See the design spec.
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { workingTreeDirtyFiles } from "../utils/git.ts";

export const SETTLE_QUIET_WINDOW_MS = 2000;
export const SETTLE_INTERVAL_MS = 250;
export const SETTLE_MAX_MS = 1500;

export interface SettleResult {
  settled: boolean; // false → still advancing at the cap (churning)
  waitedMs: number;
  lastWriteMsAgo: number; // now − latestChange at the final sample (0 if no files)
}

// Newest max(mtime, ctime) across files (ms). ctime is not back-datable, so it
// catches a create/metadata change mtime alone would miss. Best-effort per file.
export function latestChangeMs(repoRoot: string, files: string[]): number {
  let max = 0;
  for (const f of files) {
    try {
      const st = lstatSync(join(repoRoot, f));
      const c = Math.max(st.mtimeMs, st.ctimeMs);
      if (c > max) max = c;
    } catch {
      /* racing unlink / unstattable → skip */
    }
  }
  return max;
}

export async function awaitWorkspaceSettle(opts: {
  repoRoot: string;
  quietWindowMs: number;
  settleIntervalMs: number;
  maxSettleMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}): Promise<SettleResult> {
  const { repoRoot, quietWindowMs, settleIntervalMs, maxSettleMs, now, sleep } = opts;
  let files = await workingTreeDirtyFiles(repoRoot);
  if (files.length === 0) return { settled: true, waitedMs: 0, lastWriteMsAgo: 0 };
  let last = latestChangeMs(repoRoot, files);
  if (now() - last >= quietWindowMs) {
    return { settled: true, waitedMs: 0, lastWriteMsAgo: now() - last };
  }
  let waited = 0;
  while (waited < maxSettleMs) {
    const step = Math.min(settleIntervalMs, maxSettleMs - waited);
    await sleep(step);
    waited += step;
    files = await workingTreeDirtyFiles(repoRoot); // re-enumerate → catch newly created files
    const cur = latestChangeMs(repoRoot, files);
    if (cur <= last) return { settled: true, waitedMs: waited, lastWriteMsAgo: now() - cur };
    last = cur;
  }
  return { settled: false, waitedMs: waited, lastWriteMsAgo: now() - last };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/unit/workspace-settle.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck + lint + commit**

```bash
bunx tsc --noEmit && bun run lint
git add src/core/workspace-settle.ts tests/unit/workspace-settle.test.ts
git commit -m "feat(#7): awaitWorkspaceSettle + latestChangeMs (bounded settle loop)"
```

---

## Task 3: `workspace_unsettled` schema field + report banner

**Files:**
- Modify: `src/schemas/pending-report.ts` (add field near `large_diff`)
- Modify: `src/core/report-writer.ts` (`renderMd`, near `largeDiffBanner`)
- Test: `tests/unit/report-writer-unsettled.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/report-writer-unsettled.test.ts`:

```ts
// tests/unit/report-writer-unsettled.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReportWriter } from "../../src/core/report-writer.ts";
import type { PendingReport } from "../../src/schemas/pending-report.ts";

const base: PendingReport = {
  schema: "reviewgate.pending.v1",
  run_id: "r1", iter: 1, max_iter: 3, verdict: "FAIL",
  counts: { critical: 0, warn: 0, info: 0 },
  reviewers: [{ id: "codex", provider: "codex", model: "m", persona: "security", status: "ok", cost_usd: 0, duration_ms: 1 }],
  findings: [],
  cost_usd_total: 0, duration_ms_total: 1, generated_at: "2026-06-17T00:00:00Z",
  git: { sha: "abc1234", branch: "main", dirty_files: [] },
};

describe("report-writer workspace_unsettled banner (#7)", () => {
  it("renders the not-quiescent banner when workspace_unsettled is present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-uns-"));
    await new ReportWriter(dir).write({ ...base, workspace_unsettled: { last_write_ms_ago: 120, waited_ms: 1500 } });
    const md = readFileSync(join(dir, ".reviewgate", "pending.md"), "utf8");
    expect(md).toContain("Workspace not quiescent");
    expect(md).toContain("120ms");
    expect(md).toContain("1500ms");
  });

  it("omits the banner when workspace_unsettled is absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-uns2-"));
    await new ReportWriter(dir).write(base);
    const md = readFileSync(join(dir, ".reviewgate", "pending.md"), "utf8");
    expect(md).not.toContain("Workspace not quiescent");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/unit/report-writer-unsettled.test.ts`
Expected: FAIL — the field is rejected by the schema and the banner is not rendered.

- [ ] **Step 3: Add the schema field**

In `src/schemas/pending-report.ts`, immediately after the `large_diff` field (the one ending `.optional(),`), add:

```ts
  // #7: set when the working tree was still being written when the panel ran (the
  // settle-check hit its cap without the tree going quiet). Render-only / advisory —
  // the verdict is unaffected; warns the agent the review may reflect a half-finished state.
  workspace_unsettled: z
    .object({ last_write_ms_ago: z.number().int().nonnegative(), waited_ms: z.number().int().nonnegative() })
    .optional(),
```

- [ ] **Step 4: Render the banner**

In `src/core/report-writer.ts` `renderMd`, immediately after the `largeDiffBanner` const block, add:

```ts
  // #7: workspace-not-quiescent warning (the settle-check hit its cap). Advisory.
  const unsettledBanner = r.workspace_unsettled
    ? [
        `> ⚠ **Workspace not quiescent:** a file was still being written ~${r.workspace_unsettled.last_write_ms_ago}ms before this review (waited ${r.workspace_unsettled.waited_ms}ms for it to settle). This review may reflect a HALF-FINISHED state — if findings look spurious, let the writer (a background build/codegen or a parallel session) finish, then re-run.`,
        "",
      ]
    : [];
```

Then add `...unsettledBanner,` to the `head` array immediately after `...largeDiffBanner,`:

```ts
    ...coverageBanner,
    ...singleReviewerBanner,
    ...largeDiffBanner,
    ...unsettledBanner,
    ...(r.panel_note ? [`> ⛔ **Panel:** ${r.panel_note}`, ""] : []),
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test tests/unit/report-writer-unsettled.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Typecheck + lint + commit**

```bash
bunx tsc --noEmit && bun run lint
git add src/schemas/pending-report.ts src/core/report-writer.ts tests/unit/report-writer-unsettled.test.ts
git commit -m "feat(#7): workspace_unsettled report field + not-quiescent banner"
```

---

## Task 4: `settleBeforeReview` config toggle

**Files:**
- Modify: `src/config/define-config.ts` (phases.review)
- Modify: `src/config/defaults.ts` (phases.review)
- Test: `tests/unit/settle-before-review-config.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/settle-before-review-config.test.ts`:

```ts
// tests/unit/settle-before-review-config.test.ts
import { describe, expect, it } from "bun:test";
import { defaultConfig } from "../../src/config/defaults.ts";
import { ConfigSchema } from "../../src/config/define-config.ts";

describe("#7 settleBeforeReview config", () => {
  it("defaults to true in defaultConfig", () => {
    expect(defaultConfig.phases.review.settleBeforeReview).toBe(true);
  });

  it("re-defaults to true when omitted from a parsed config", () => {
    const { settleBeforeReview: _omit, ...reviewWithout } = defaultConfig.phases.review;
    const parsed = ConfigSchema.parse({
      ...defaultConfig,
      phases: { ...defaultConfig.phases, review: reviewWithout },
    });
    expect(parsed.phases.review.settleBeforeReview).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/unit/settle-before-review-config.test.ts`
Expected: FAIL — `settleBeforeReview` is `undefined`.

- [ ] **Step 3: Add the config field + default**

In `src/config/define-config.ts`, inside the `phases.review` object schema (near `providerPrecisionContext` / `depSurface`), add:

```ts
    // #7: before collectDiff snapshots the working tree, briefly wait (≤ ~1.5s) for
    // working-tree files to stop changing (a background build/codegen or a parallel
    // session may still be writing), so the panel reviews a quiescent snapshot.
    // Bounded and fail-safe: only delays a review, never skips it. Default on.
    settleBeforeReview: z.boolean().optional(),
```

In `src/config/defaults.ts`, inside `phases.review` (near `providerPrecisionContext: true`), add:

```ts
      settleBeforeReview: true,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/unit/settle-before-review-config.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck + lint + commit**

```bash
bunx tsc --noEmit && bun run lint
git add src/config/define-config.ts src/config/defaults.ts tests/unit/settle-before-review-config.test.ts
git commit -m "feat(#7): add phases.review.settleBeforeReview toggle (default true)"
```

---

## Task 5: Orchestrator passthrough (`workspaceUnsettled` input → report)

**Files:**
- Modify: `src/core/orchestrator.ts` (input type ~line 152, near `largeDiff`; `writeReport` ~2145, near `large_diff`)
- Test: `tests/unit/orchestrator-unsettled.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/orchestrator-unsettled.test.ts`:

```ts
// tests/unit/orchestrator-unsettled.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../src/config/defaults.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";
import type { Finding } from "../../src/schemas/finding.ts";

const DIFF = "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-a\n+b\n";

function stub(): ProviderAdapter {
  const f: Finding = {
    id: "F", signature: "s", severity: "CRITICAL", category: "security", rule_id: "r",
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

describe("orchestrator passes workspaceUnsettled into the report (#7)", () => {
  it("renders the not-quiescent banner when given workspaceUnsettled", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-orch-uns-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    const config = {
      ...defaultConfig,
      phases: { ...defaultConfig.phases, review: { reviewers: [{ provider: "codex" as const, persona: "security" }] }, critic: null, triage: null },
    };
    const orch = new Orchestrator({
      repoRoot: repo, config, adapters: { codex: stub() },
      sandboxMode: "off", hostTier: "opus", diff: DIFF, reasonOnFailEnabled: true,
      workspaceUnsettled: { last_write_ms_ago: 80, waited_ms: 1500 },
    });
    await orch.runIteration({ runId: "RUN", iter: 1 });
    const md = readFileSync(join(repo, ".reviewgate", "pending.md"), "utf8");
    expect(md).toContain("Workspace not quiescent");
    expect(md).toContain("80ms");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/unit/orchestrator-unsettled.test.ts --timeout 20000`
Expected: FAIL — `workspaceUnsettled` is not a valid Orchestrator input / not in the report.

- [ ] **Step 3: Add the input field**

In `src/core/orchestrator.ts`, immediately after the `largeDiff?: { files: number; bytes: number };` input field (~line 152), add:

```ts
  // #7: set by the gate when the pre-review settle-check hit its cap without the
  // working tree going quiet. Render-only — passed straight into the PendingReport.
  workspaceUnsettled?: { last_write_ms_ago: number; waited_ms: number };
```

- [ ] **Step 4: Inject into the PendingReport**

In `src/core/orchestrator.ts` `writeReport`, immediately after the `...(this.input.largeDiff ? { large_diff: this.input.largeDiff } : {}),` line (~2145), add:

```ts
        ...(this.input.workspaceUnsettled ? { workspace_unsettled: this.input.workspaceUnsettled } : {}),
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test tests/unit/orchestrator-unsettled.test.ts --timeout 20000`
Expected: PASS.

- [ ] **Step 6: Typecheck + lint + commit**

```bash
bunx tsc --noEmit && bun run lint
git add src/core/orchestrator.ts tests/unit/orchestrator-unsettled.test.ts
git commit -m "feat(#7): orchestrator passes workspaceUnsettled into the report"
```

---

## Task 6: Gate wiring (`gatherReviewContext` + `runGate`)

**Files:**
- Modify: `src/cli/commands/gate.ts` — `gatherReviewContext` (~426): add a `settleBeforeReview: boolean` param, call `awaitWorkspaceSettle` at the TOP (before both `diffFn` calls), add `workspaceUnsettled` to the `ReviewContext` type + return; `export` `gatherReviewContext`; in the `runGate` caller (~565), pass `cfg.phases.review.settleBeforeReview ?? false` and forward `ctx.workspaceUnsettled` to the Orchestrator input (~611).
- Test: `tests/unit/gate-settle.test.ts`

### Context
- `gatherReviewContext(input, state, gitInfoFn, diffFn)` runs `const gitInfo = await gitInfoFn(...)` first, then resolves the base and calls `diffFn` at two sites (~485, ~527). The settle-check goes immediately after `gitInfo` (still before both `diffFn` calls), gated by the new param.
- `ReviewContext` is the return type (has `gitInfo`, `diff`, `reviewBase`, `diffIncomplete`).
- The Orchestrator is constructed in `runGate` (~594) with `...(largeDiff ? { largeDiff } : {})` — mirror that for `workspaceUnsettled`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/gate-settle.test.ts`:

```ts
// tests/unit/gate-settle.test.ts
//
// Gate wiring: gatherReviewContext runs the settle-check when settleBeforeReview is
// on, and on a QUIESCENT working tree returns workspaceUnsettled: undefined and a
// valid diff (i.e. it settled and proceeded). With the toggle off it skips entirely.
import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatherReviewContext } from "../../src/cli/commands/gate.ts";
import { StateStore } from "../../src/core/state-store.ts";

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-gate-settle-"));
  const run = (...a: string[]) => execFileSync("git", a, { cwd: dir });
  run("init", "-q");
  run("config", "user.email", "t@t.t");
  run("config", "user.name", "t");
  writeFileSync(join(dir, "a.ts"), "x\n");
  run("add", "a.ts");
  run("commit", "-qm", "init");
  return dir;
}

const stubGitInfo = async () => ({ sha: "0".repeat(40), branch: "main", dirty_files: [] as string[] });
const stubDiff = async () => ""; // empty diff → nothing else to do

describe("gatherReviewContext settle wiring (#7)", () => {
  it("ON + quiescent tree → workspaceUnsettled undefined, proceeds", async () => {
    const dir = gitRepo();
    const state = new StateStore(dir);
    await state.initialise("01HXSETTLE01");
    const ctx = await gatherReviewContext(
      { repoRoot: dir } as never, state, stubGitInfo as never, stubDiff as never, true,
    );
    expect(ctx.workspaceUnsettled).toBeUndefined(); // clean tree → settled, no banner
  });

  it("OFF → settle skipped, workspaceUnsettled undefined", async () => {
    const dir = gitRepo();
    const state = new StateStore(dir);
    await state.initialise("01HXSETTLE02");
    const ctx = await gatherReviewContext(
      { repoRoot: dir } as never, state, stubGitInfo as never, stubDiff as never, false,
    );
    expect(ctx.workspaceUnsettled).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/unit/gate-settle.test.ts`
Expected: FAIL — `gatherReviewContext` is not exported / has no 5th param / no `workspaceUnsettled` on the ctx.

- [ ] **Step 3: Add imports + export + the settle call**

In `src/cli/commands/gate.ts`:

(a) Add the import near the other `../../core` / `../../utils` imports:

```ts
import { SETTLE_INTERVAL_MS, SETTLE_MAX_MS, SETTLE_QUIET_WINDOW_MS, awaitWorkspaceSettle } from "../../core/workspace-settle.ts";
```

(b) Add `workspaceUnsettled?` to the `ReviewContext` type (the interface with `reviewBase: string | null`):

```ts
  workspaceUnsettled?: { last_write_ms_ago: number; waited_ms: number };
```

(c) Change `gatherReviewContext` to `export` and add the 5th param + the settle call at the top:

```ts
export async function gatherReviewContext(
  input: GateInput,
  state: StateStore,
  gitInfoFn: typeof collectGitInfo,
  diffFn: typeof collectDiff,
  settleBeforeReview: boolean,
): Promise<ReviewContext> {
  const gitInfo = await gitInfoFn(input.repoRoot);
  // #7: before snapshotting the working tree (either diffFn call below), wait
  // (bounded) for it to stop changing so we don't review a half-written state.
  // Best-effort and fail-safe — never blocks/skips the review.
  let workspaceUnsettled: { last_write_ms_ago: number; waited_ms: number } | undefined;
  if (settleBeforeReview) {
    try {
      const r = await awaitWorkspaceSettle({
        repoRoot: input.repoRoot,
        quietWindowMs: SETTLE_QUIET_WINDOW_MS,
        settleIntervalMs: SETTLE_INTERVAL_MS,
        maxSettleMs: SETTLE_MAX_MS,
        now: () => Date.now(),
        sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
      });
      if (!r.settled) workspaceUnsettled = { last_write_ms_ago: r.lastWriteMsAgo, waited_ms: r.waitedMs };
    } catch {
      /* best-effort: a settle failure must never block or skip the review */
    }
  }
  // ... the existing base-resolution + diffFn logic, unchanged ...
```

(d) At the END of `gatherReviewContext`, include it in the returned object:

```ts
  return { gitInfo, diff, reviewBase, diffIncomplete: dirtyFlagUnparsed, ...(workspaceUnsettled ? { workspaceUnsettled } : {}) };
```

- [ ] **Step 4: Wire it through `runGate`**

In the `runGate` body, update the `gatherReviewContext` call (~565) to pass the toggle:

```ts
      const ctx = await gatherReviewContext(input, state, gitInfoFn, diffFn, cfg.phases.review.settleBeforeReview ?? false);
```

Destructure `workspaceUnsettled` from `ctx` where `{ gitInfo, diff, reviewBase } = ctx;` is done (~578):

```ts
  const { gitInfo, diff, reviewBase, workspaceUnsettled } = ctx;
```

And add it to the `Orchestrator` input (~611), after `...(largeDiff ? { largeDiff } : {})`:

```ts
    ...(workspaceUnsettled ? { workspaceUnsettled } : {}),
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test tests/unit/gate-settle.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Typecheck + lint + commit**

```bash
bunx tsc --noEmit && bun run lint
git add src/cli/commands/gate.ts tests/unit/gate-settle.test.ts
git commit -m "feat(#7): run the settle-check in gatherReviewContext before collectDiff"
```

---

## Task 7: Full-suite regression + DoD

**Files:** none (verification only).

- [ ] **Step 1: Full unit suite**

Run: `bun test tests/unit --timeout 20000`
Expected: all green (baseline ~1817 + the new tests). Watch existing `gate-*.test.ts` and `report-writer*.test.ts` — note that some gate tests may now construct config WITHOUT `settleBeforeReview` (undefined → settle skipped), so they are unaffected; the merged `defaultConfig` has it `true`.

- [ ] **Step 2: Typecheck + lint (final)**

Run: `bunx tsc --noEmit && bun run lint`
Expected: both clean.

- [ ] **Step 3: No commit** — verification only. Proceed to the DoD review chain (codex, opus whole-branch) before merge.

---

## Self-review notes (spec coverage)

- Base-independent dirty-file enumeration → Task 1 (`workingTreeDirtyFiles` in git.ts; `git diff --name-only -z HEAD` ∪ untracked). ✓
- `latestChangeMs = max(mtime,ctime)` + bounded 2-sample settle loop (quiet-window fast path, re-enumerate, empty→settled, cap→churning) → Task 2 + unit tests. ✓
- `workspace_unsettled` schema field + WARN banner → Task 3. ✓
- `settleBeforeReview` toggle (default true, `.optional()` pattern) → Task 4. ✓
- Orchestrator passthrough (input → PendingReport, mirror largeDiff) → Task 5. ✓
- Gate wiring: settle at the TOP of `gatherReviewContext` (before BOTH diffFn calls), toggle-gated, best-effort, result → Orchestrator input → report → Task 6. ✓
- Fail-safe: the settle result NEVER gates the review (only a banner); thrown → caught; runs in the 120s setup budget (overrun → fail-CLOSED) → Task 6 placement + best-effort try/catch. ✓
- Tests cover the settle logic deterministically (injected clock) + the enumeration (temp repo) + banner + config + orchestrator passthrough + gate wiring (quiescent). ✓
