# Deterministic Checker Tier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run repo-configured deterministic commands (typecheck/build/tests) as a fail-fast, $0 gate BEFORE the LLM reviewer panel — a failing check blocks the turn with the real output and skips the panel.

**Architecture:** A new `phases.checks` config block (default off) drives a runner module that runs each command via `spawnCapture` (fail-fast, abort-aware, output-capped). The check stage is inserted in `Orchestrator.runIteration` after triage and before the cache read / research / panel. A failure short-circuits to `verdict: "FAIL"` with a **decidable, reject-forbidden** finding (stable signature `check:<name>`, `deterministic: true`) that rides the existing decisions / fix-verification / escalation loop — so loop accounting stays sound (no infinite loop, no fail-open).

**Tech Stack:** Bun, TypeScript, zod, bun:test. Existing helpers: `spawnCapture` (`src/utils/spawn-capture.ts`), `FindingSchema` (`src/schemas/finding.ts`), `evaluateDecisions` (`src/core/loop-driver.ts`), `buildRunSummary` (`src/core/run-summary.ts`).

Spec: `docs/superpowers/specs/2026-06-15-deterministic-checker-tier-design.md`.

---

## File Structure

- **Create** `src/core/checks/runner.ts` — the command runner (`runChecks`) + the deterministic-finding builder. One responsibility: run commands, return pass or the first failure as a `Finding`.
- **Modify** `src/config/define-config.ts` — add the `phases.checks` zod schema.
- **Modify** `src/config/defaults.ts` — add `phases.checks: null` default.
- **Modify** `src/schemas/finding.ts` — add the optional `deterministic` flag.
- **Modify** `src/core/loop-driver.ts` — `evaluateDecisions`: a `rejected` decision for a `deterministic` finding is invalid.
- **Modify** `src/core/orchestrator.ts` — insert the check stage in `runIteration`.
- **Modify** `src/core/run-summary.ts` — allow `source: "checks"`.
- **Modify** `src/core/report-writer.ts` — render a "deterministic check" badge.
- **Tests** under `tests/unit/` + one `tests/e2e/`.

---

### Task 1: `deterministic` flag on the Finding schema

**Files:**
- Modify: `src/schemas/finding.ts` (add a field to `FindingSchema`, ~after line 149 `claimed_fixed_recurred`)
- Test: `tests/unit/finding-deterministic.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/finding-deterministic.test.ts
import { describe, expect, it } from "bun:test";
import { FindingSchema } from "../../src/schemas/finding.ts";

const base = {
  id: "check-typecheck",
  signature: "check:typecheck",
  severity: "CRITICAL",
  category: "correctness",
  rule_id: "deterministic-check/typecheck",
  file: "(deterministic check: typecheck)",
  line_start: 1,
  line_end: 1,
  message: "Deterministic check failed",
  details: "tsc error TS2532",
  reviewer: { provider: "checks", model: "deterministic", persona: "checks" },
  confidence: 1,
  consensus: "singleton",
};

describe("FindingSchema deterministic flag", () => {
  it("accepts deterministic: true", () => {
    const r = FindingSchema.safeParse({ ...base, deterministic: true });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.deterministic).toBe(true);
  });
  it("defaults to undefined when omitted (back-compat)", () => {
    const r = FindingSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.deterministic).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/unit/finding-deterministic.test.ts`
Expected: FAIL — `deterministic` is stripped (zod ignores unknown keys), so `r.data.deterministic` is `undefined` even when set to `true` → first assertion fails.

- [ ] **Step 3: Add the field**

In `src/schemas/finding.ts`, inside `FindingSchema` (right after the `claimed_fixed_recurred` field, ~line 149), add:

```ts
  // Deterministic checker tier: set true when this finding represents a configured
  // command (tsc/build/test) that exited non-zero — ground truth, not a reviewer
  // opinion. It is reject-forbidden in the decisions gate (you can't "reject" a
  // compiler) and exempt from the aggregator's demote passes (it short-circuits
  // the panel entirely). Signature is stable per check (`check:<name>`).
  deterministic: z.boolean().optional(),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/unit/finding-deterministic.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/schemas/finding.ts tests/unit/finding-deterministic.test.ts
git commit -m "feat(schema): add deterministic flag to Finding"
```

---

### Task 2: `phases.checks` config schema + default

**Files:**
- Modify: `src/config/define-config.ts` (inside the `phases: z.object({ ... })`, ~after the `review` block ends at line 111)
- Modify: `src/config/defaults.ts` (inside `phases:`, alongside `triage`/`brain`, ~line 101-111)
- Test: `tests/unit/config-checks.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/config-checks.test.ts
import { describe, expect, it } from "bun:test";
import { ConfigSchema } from "../../src/config/define-config.ts";

describe("phases.checks config", () => {
  it("accepts a valid checks block", () => {
    const r = ConfigSchema.safeParse({
      phases: {
        review: { reviewers: [{ provider: "codex", persona: "security" }] },
        checks: { commands: [{ name: "typecheck", run: "bun run typecheck", timeoutMs: 120000 }] },
      },
    });
    expect(r.success).toBe(true);
  });
  it("rejects a command missing `run`", () => {
    const r = ConfigSchema.safeParse({
      phases: {
        review: { reviewers: [{ provider: "codex", persona: "security" }] },
        checks: { commands: [{ name: "typecheck" }] },
      },
    });
    expect(r.success).toBe(false);
  });
  it("rejects an empty commands array", () => {
    const r = ConfigSchema.safeParse({
      phases: {
        review: { reviewers: [{ provider: "codex", persona: "security" }] },
        checks: { commands: [] },
      },
    });
    expect(r.success).toBe(false);
  });
  it("defaults checks to null when omitted", () => {
    const r = ConfigSchema.safeParse({
      phases: { review: { reviewers: [{ provider: "codex", persona: "security" }] } },
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.phases.checks).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/unit/config-checks.test.ts`
Expected: FAIL — `checks` is unknown so the valid-block/`toBeNull` expectations don't hold and malformed blocks are accepted.

- [ ] **Step 3: Add the schema**

In `src/config/define-config.ts`, inside `phases: z.object({ ... })`, after the `review: z.object({ ... }),` block (the one ending ~line 111), add:

```ts
    // Deterministic checker tier: commands run fail-fast BEFORE the LLM panel.
    // First non-zero exit (or timeout/error) blocks the turn and skips the panel.
    // Default off (null). See docs/superpowers/specs/2026-06-15-deterministic-checker-tier-design.md
    checks: z
      .object({
        commands: z
          .array(
            z.object({
              name: z.string().min(1),
              run: z.string().min(1),
              timeoutMs: z.number().int().positive().optional(),
            }),
          )
          .min(1),
        defaultTimeoutMs: z.number().int().positive().optional(),
        outputCapBytes: z.number().int().positive().optional(),
      })
      .nullable()
      .default(null)
      .optional(),
```

- [ ] **Step 4: Add the default**

In `src/config/defaults.ts`, inside `phases: {`, alongside `triage` / `brain` (~line 101-111), add:

```ts
    checks: null as null | {
      commands: Array<{ name: string; run: string; timeoutMs?: number }>;
      defaultTimeoutMs?: number;
      outputCapBytes?: number;
    },
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test tests/unit/config-checks.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Typecheck + commit**

```bash
bunx tsc --noEmit
git add src/config/define-config.ts src/config/defaults.ts tests/unit/config-checks.test.ts
git commit -m "feat(config): add phases.checks schema + default (off)"
```

---

### Task 3: The checks runner

**Files:**
- Create: `src/core/checks/runner.ts`
- Test: `tests/unit/checks-runner.test.ts`

Verified interfaces: `spawnCapture(command, args, { cwd?, timeoutMs?, maxBytes?, signal? }) → Promise<{ status: number|null; stdout: string; stderr: string; timedOut: boolean; truncated: boolean; aborted: boolean; spawnError: Error|null }>`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/checks-runner.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { runChecks } from "../../src/core/checks/runner.ts";

const repo = () => mkdtempSync(`${tmpdir()}/rg-checks-`);

describe("runChecks", () => {
  it("passes when every command exits 0", async () => {
    const r = await runChecks({ repoRoot: repo(), commands: [{ name: "ok", run: "true" }] });
    expect(r.ok).toBe(true);
  });

  it("fails on the first non-zero command (fail-fast) and does not run later ones", async () => {
    // The second command would create a marker file; fail-fast means it never runs.
    const dir = repo();
    const r = await runChecks({
      repoRoot: dir,
      commands: [
        { name: "typecheck", run: "false" },
        { name: "second", run: "touch ran-second" },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.finding.signature).toBe("check:typecheck");
      expect(r.finding.deterministic).toBe(true);
      expect(r.finding.severity).toBe("CRITICAL");
    }
    expect(await Bun.file(`${dir}/ran-second`).exists()).toBe(false);
  });

  it("treats command-not-found as a FAIL (fail-closed)", async () => {
    const r = await runChecks({
      repoRoot: repo(),
      commands: [{ name: "missing", run: "this-binary-does-not-exist-xyz" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.finding.details).toContain("Status:");
  });

  it("treats a timeout as a FAIL", async () => {
    const r = await runChecks({
      repoRoot: repo(),
      commands: [{ name: "slow", run: "sleep 5", timeoutMs: 100 }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.finding.details.toLowerCase()).toContain("timed out");
  });

  it("captures command output into the finding details (capped)", async () => {
    const r = await runChecks({
      repoRoot: repo(),
      commands: [{ name: "noisy", run: "echo BUILD_BROKEN_MARKER; exit 1" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.finding.details).toContain("BUILD_BROKEN_MARKER");
  });

  it("aborts immediately when the signal is already aborted (fail-closed)", async () => {
    const r = await runChecks({
      repoRoot: repo(),
      commands: [{ name: "x", run: "true" }],
      signal: AbortSignal.abort(),
    });
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/unit/checks-runner.test.ts`
Expected: FAIL — `runChecks` does not exist yet (module not found).

- [ ] **Step 3: Write the runner**

```ts
// src/core/checks/runner.ts
//
// Deterministic checker tier: run configured commands (typecheck/build/test) as a
// fail-fast, $0 gate BEFORE the LLM panel. The FIRST command that exits non-zero
// (or times out / errors / is aborted) becomes a single blocking finding and the
// rest are NOT run. A failure is fail-CLOSED: a command that cannot run is a FAIL,
// never a silent skip. The finding is deterministic (reject-forbidden, stable
// signature) so it rides the existing decisions / fix-verification loop.
import type { Finding } from "../../schemas/finding.ts";
import { spawnCapture } from "../../utils/spawn-capture.ts";

export interface CheckCommand {
  name: string;
  run: string;
  timeoutMs?: number;
}

export interface RunChecksOptions {
  repoRoot: string;
  commands: CheckCommand[];
  /** fallback per-command timeout; default 300_000ms */
  defaultTimeoutMs?: number;
  /** captured-output cap (bytes); default 16_384 */
  outputCapBytes?: number;
  /** the iteration's abort signal (gate self-deadline) */
  signal?: AbortSignal | undefined;
}

export type CheckResult = { ok: true } | { ok: false; finding: Finding };

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_OUTPUT_CAP = 16_384;

function checkFinding(name: string, run: string, status: string, output: string): Finding {
  const body = output.trim().length > 0 ? output : "(no output)";
  return {
    id: `check-${name}`,
    signature: `check:${name}`,
    severity: "CRITICAL",
    category: "correctness",
    rule_id: `deterministic-check/${name}`,
    file: `(deterministic check: ${name})`,
    line_start: 1,
    line_end: 1,
    message: `Deterministic check "${name}" failed: ${status}`.slice(0, 200),
    details: `Command: ${run}\nStatus: ${status}\n\n${body}`.slice(0, 2000),
    reviewer: { provider: "checks", model: "deterministic", persona: "checks" },
    confidence: 1,
    consensus: "singleton",
    deterministic: true,
  };
}

export async function runChecks(opts: RunChecksOptions): Promise<CheckResult> {
  const defaultTimeout = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cap = opts.outputCapBytes ?? DEFAULT_OUTPUT_CAP;
  for (const cmd of opts.commands) {
    const timeoutMs = cmd.timeoutMs ?? defaultTimeout;
    const res = await spawnCapture("/bin/sh", ["-c", cmd.run], {
      cwd: opts.repoRoot,
      timeoutMs,
      maxBytes: cap,
      signal: opts.signal,
    });
    const failed =
      res.status !== 0 || res.timedOut || res.aborted || res.spawnError !== null;
    if (failed) {
      const status = res.spawnError
        ? `could not run (${res.spawnError.message})`
        : res.timedOut
          ? `timed out after ${timeoutMs}ms`
          : res.aborted
            ? "aborted (gate deadline)"
            : `exited ${res.status}`;
      const parts = [res.stdout, res.stderr].filter((s) => s.trim().length > 0);
      const combined = parts.join("\n--- stderr ---\n");
      const output = res.truncated ? `${combined}\n…(output truncated)` : combined;
      return { ok: false, finding: checkFinding(cmd.name, cmd.run, status, output) };
    }
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/unit/checks-runner.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
bunx tsc --noEmit
git add src/core/checks/runner.ts tests/unit/checks-runner.test.ts
git commit -m "feat(checks): deterministic command runner (fail-fast, abort-aware)"
```

---

### Task 4: Reject-forbidden for deterministic findings in `evaluateDecisions`

**Files:**
- Modify: `src/core/loop-driver.ts` (`metaOf` ~line 439-461; the decision-validation loop ~line 473-492)
- Test: `tests/unit/loop-driver-deterministic.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/loop-driver-deterministic.test.ts
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateDecisions } from "../../src/core/loop-driver.ts";
import { decisionsPath, pendingJsonPath } from "../../src/utils/paths.ts";

function repoWithDeterministicFinding(): string {
  const repo = mkdtempSync(join(tmpdir(), "rg-det-dec-"));
  mkdirSync(join(repo, ".reviewgate", "decisions"), { recursive: true });
  const finding = {
    id: "check-typecheck",
    signature: "check:typecheck",
    severity: "CRITICAL",
    category: "correctness",
    rule_id: "deterministic-check/typecheck",
    file: "(deterministic check: typecheck)",
    line_start: 1,
    line_end: 1,
    message: "Deterministic check failed",
    details: "tsc error",
    reviewer: { provider: "checks", model: "deterministic", persona: "checks" },
    confidence: 1,
    consensus: "singleton",
    deterministic: true,
  };
  writeFileSync(
    pendingJsonPath(repo),
    JSON.stringify({ schema: "reviewgate.pending.v1", iteration: 1, findings: [finding] }),
  );
  return repo;
}

describe("evaluateDecisions — deterministic findings are reject-forbidden", () => {
  it("treats a `rejected` decision for a deterministic finding as invalid", () => {
    const repo = repoWithDeterministicFinding();
    writeFileSync(
      decisionsPath(repo, 1),
      `${JSON.stringify({ schema: "reviewgate.decision.v1", finding_id: "check-typecheck", verdict: "rejected", reason: "I think the compiler is wrong about this one." })}\n`,
    );
    const gate = evaluateDecisions(repo, 1, ["check-typecheck"]);
    expect(gate.addressed).toBe(false);
    expect(gate.invalid.join(" ")).toContain("deterministic");
  });

  it("accepts an `accepted/fixed` decision for a deterministic finding", () => {
    const repo = repoWithDeterministicFinding();
    writeFileSync(
      decisionsPath(repo, 1),
      `${JSON.stringify({ schema: "reviewgate.decision.v1", finding_id: "check-typecheck", verdict: "accepted", action: "fixed", files_touched: ["src/x.ts"] })}\n`,
    );
    const gate = evaluateDecisions(repo, 1, ["check-typecheck"]);
    expect(gate.addressed).toBe(true);
  });
});
```

(If `pendingJsonPath` / `decisionsPath` are not exported from `src/utils/paths.ts`, import them from wherever `loop-driver.ts` imports them — grep `pendingJsonPath` to confirm the source module before writing the test.)

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/unit/loop-driver-deterministic.test.ts`
Expected: FAIL — today a well-formed `rejected` decision satisfies the gate, so `addressed` is `true` and no "deterministic" invalid reason exists.

- [ ] **Step 3: Extend `metaOf` to carry `deterministic`**

In `src/core/loop-driver.ts`, in `evaluateDecisions`, change the `metaOf` map value to include `deterministic` (the `findingMeta` map built ~line 441-458):

```ts
  let findingMeta: Map<string, { severity: string; highStakes: boolean; deterministic: boolean }> | null = null;
  const metaOf = (
    id: string,
  ): { severity: string; highStakes: boolean; deterministic: boolean } | undefined => {
    if (!findingMeta) {
      findingMeta = new Map(
        readPendingReport(repoRoot).findings.map((f) => [
          f.id,
          {
            severity: f.severity,
            highStakes:
              f.category === "security" ||
              f.category === "correctness" ||
              (f.members ?? []).some(
                (m) => m.category === "security" || m.category === "correctness",
              ),
            deterministic: f.deterministic === true,
          },
        ]),
      );
    }
    return findingMeta.get(id);
  };
```

- [ ] **Step 4: Reject the `rejected` verdict for a deterministic finding**

Still in the `for (const l of lines)` loop, inside the `if (res.success) {` block, BEFORE the existing acknowledged-low-value guard (before line 479), add:

```ts
      // A deterministic check failure (tsc/build/test) is ground truth — you cannot
      // "reject" a compiler. A rejected decision does NOT satisfy the gate; it must be
      // FIXED (the check re-runs and clears on its own) or the check removed from config.
      if (res.data.verdict === "rejected" && metaOf(res.data.finding_id)?.deterministic) {
        invalidIds.add(res.data.finding_id);
        invalid.push(
          `${res.data.finding_id}: verdict — a deterministic check failure can't be rejected; fix the build/test (it re-runs and clears automatically) or remove the check from reviewgate.config.ts`,
        );
        continue;
      }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test tests/unit/loop-driver-deterministic.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Run the full loop-driver suite (no regressions)**

Run: `bun test tests/unit/loop-driver.test.ts tests/unit/gate-defer.test.ts`
Expected: PASS (all existing tests still green).

- [ ] **Step 7: Typecheck + commit**

```bash
bunx tsc --noEmit
git add src/core/loop-driver.ts tests/unit/loop-driver-deterministic.test.ts
git commit -m "feat(loop-driver): deterministic findings are reject-forbidden in the decisions gate"
```

---

### Task 5: Wire the checks tier into `runIteration`

**Files:**
- Modify: `src/core/run-summary.ts` (add `"checks"` to the `source` union)
- Modify: `src/core/orchestrator.ts` (insert the stage after the triage skip block at ~line 555, before the brain-read at ~line 557; add the `runChecks` import)
- Test: `tests/unit/orchestrator-checks.test.ts`

- [ ] **Step 1: Allow `source: "checks"` in run-summary**

In `src/core/run-summary.ts`, find the `source` field type (a string union like `"skipped" | "cached" | ...`) used by `buildRunSummary` and add `"checks"` to it. (Grep `source` in the file to find the union; if it is already `string`, no change is needed — note that and skip.)

- [ ] **Step 2: Write the failing test**

```ts
// tests/unit/orchestrator-checks.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "../../src/config/define-config.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";

function countingStub(state: { calls: number }): ProviderAdapter {
  return {
    id: "codex",
    async preflight() {
      return { available: true, version: "x", authMode: "oauth", error: null };
    },
    async review(inp) {
      state.calls++;
      return {
        reviewerId: inp.reviewerId,
        verdict: "PASS",
        findings: [],
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
        durationMs: 1,
        exitCode: 0,
        rawEventsPath: "",
        status: "ok",
      } satisfies ReviewResult;
    },
  };
}

const diff = "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-a\n+b\n";

function orch(repo: string, state: { calls: number }, run: string) {
  return new Orchestrator({
    repoRoot: repo,
    config: defineConfig({
      phases: {
        review: { reviewers: [{ provider: "codex", persona: "security" }] },
        triage: null,
        checks: { commands: [{ name: "typecheck", run, timeoutMs: 10000 }] },
      },
    }),
    adapters: { codex: countingStub(state) },
    sandboxMode: "off",
    hostTier: "opus",
    diff,
    reasonOnFailEnabled: true,
  });
}

describe("orchestrator deterministic checks tier", () => {
  it("a failing check short-circuits to FAIL and never invokes the panel", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-orch-chk-fail-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    const state = { calls: 0 };
    const res = await orch(repo, state, "exit 1").runIteration({ runId: "R", iter: 1 });
    expect(res.verdict).toBe("FAIL");
    expect(state.calls).toBe(0); // panel skipped
  });

  it("a passing check lets the panel run as usual", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-orch-chk-pass-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    const state = { calls: 0 };
    const res = await orch(repo, state, "true").runIteration({ runId: "R", iter: 1 });
    expect(res.verdict).toBe("PASS");
    expect(state.calls).toBe(1); // panel ran
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun test tests/unit/orchestrator-checks.test.ts`
Expected: FAIL — checks are not wired, so the failing-check case still runs the panel (`state.calls === 1`) and returns PASS.

- [ ] **Step 4: Add the import**

At the top of `src/core/orchestrator.ts` with the other `../core` imports, add:

```ts
import { runChecks } from "./checks/runner.ts";
```

- [ ] **Step 5: Insert the stage**

In `Orchestrator.runIteration`, immediately AFTER the triage skip-PASS block closes (the `}` at ~line 555) and BEFORE the brain-read comment block (`// --- Brain read path:` ~line 557), insert:

```ts
    // Deterministic checker tier (fail-fast, $0): run BEFORE the cache read,
    // research, and the panel. A failing check short-circuits to FAIL with the
    // captured output and skips the expensive panel — there's no point reviewing
    // (or paying for) code that doesn't compile. Reaches here only when we would
    // review (triage.runReview true, or forcePersona). See the design spec.
    const checksCfg = this.input.config.phases.checks;
    if (checksCfg) {
      const checkRes = await runChecks({
        repoRoot: repo,
        commands: checksCfg.commands,
        defaultTimeoutMs: checksCfg.defaultTimeoutMs,
        outputCapBytes: checksCfg.outputCapBytes,
        signal: this.input.signal,
      });
      if (!checkRes.ok) {
        const f = checkRes.finding;
        await this.writeReport(opts, start, [f], [], "FAIL");
        return {
          verdict: "FAIL",
          costUsd: 0,
          durationMs: Date.now() - start,
          signaturesThisIter: [f.signature],
          maxIterationsOverride,
          summary: buildRunSummary({
            verdict: "FAIL",
            source: "checks",
            counts: { critical: 1, warn: 0, info: 0 },
            durationMs: Date.now() - start,
            criticCostUsd: 0,
            findings: [f],
            runs: [],
          }),
        };
      }
    }
```

NOTE on `this.input.signal`: confirm the AbortSignal field the orchestrator already uses to abort the panel on the gate self-deadline (grep `signal` / `AbortSignal` in `orchestrator.ts`). Use that exact accessor. If `runIteration` receives the signal via its `opts` instead, use `opts.signal`. If no signal is plumbed to the orchestrator at all, pass `undefined` (each check is still bounded by its own `timeoutMs`) and note it for a follow-up.

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun test tests/unit/orchestrator-checks.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Typecheck + commit**

```bash
bunx tsc --noEmit
git add src/core/orchestrator.ts src/core/run-summary.ts tests/unit/orchestrator-checks.test.ts
git commit -m "feat(orchestrator): run the deterministic checks tier before cache/research/panel"
```

---

### Task 6: Render a deterministic-check badge in the report

**Files:**
- Modify: `src/core/report-writer.ts` (`demoteBadges` ~line 36-57 — add the badge AND `export` the function as a test seam)
- Test: `tests/unit/report-writer-deterministic.test.ts`

`demoteBadges` is module-private today. Export it as a small test seam so the badge
logic can be unit-tested directly with a complete `Finding` object (no full
`PendingReport`/`writeReport` round-trip needed).

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/report-writer-deterministic.test.ts
import { describe, expect, it } from "bun:test";
import { demoteBadges } from "../../src/core/report-writer.ts";
import type { Finding } from "../../src/schemas/finding.ts";

const finding = (extra: Partial<Finding>): Finding => ({
  id: "check-typecheck",
  signature: "check:typecheck",
  severity: "CRITICAL",
  category: "correctness",
  rule_id: "deterministic-check/typecheck",
  file: "(deterministic check: typecheck)",
  line_start: 1,
  line_end: 1,
  message: "Deterministic check failed",
  details: "Command: bun run typecheck\nStatus: exited 1\n\nerror TS2532",
  reviewer: { provider: "checks", model: "deterministic", persona: "checks" },
  confidence: 1,
  consensus: "singleton",
  ...extra,
});

describe("report-writer deterministic badge", () => {
  it("renders a non-rejectable badge for a deterministic finding", () => {
    const badges = demoteBadges(finding({ deterministic: true }));
    expect(badges).not.toBeNull();
    expect(badges?.toLowerCase()).toContain("deterministic check");
  });

  it("renders no such badge for a normal finding", () => {
    const badges = demoteBadges(finding({}));
    // either null (no badges at all) or, if other badges exist, not the deterministic one
    expect(badges === null || !badges.toLowerCase().includes("deterministic check")).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/unit/report-writer-deterministic.test.ts`
Expected: FAIL — `demoteBadges` is not exported (import error), and the badge doesn't exist.

- [ ] **Step 3: Export the function + add the badge**

In `src/core/report-writer.ts`, change `function demoteBadges(` to `export function demoteBadges(`, and in its `badges.push(...)` sequence (~line 38-46) add:

```ts
  if (f.deterministic)
    badges.push("🔒 deterministic check — fix it (re-runs automatically; not rejectable)");
```

The finding's `details` (which already carries `Command: … / Status: … / <output>`) renders in the finding body via the existing `fmtFinding`, so the command output appears with no further change.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/unit/report-writer-deterministic.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
bunx tsc --noEmit
git add src/core/report-writer.ts tests/unit/report-writer-deterministic.test.ts
git commit -m "feat(report): badge deterministic check failures as non-rejectable"
```

---

### Task 7: Real e2e + docs + dogfood config

**Files:**
- Test: `tests/e2e/checks-real.test.ts`
- Modify: `README.md` (config section — document `phases.checks`)
- Modify: `reviewgate.config.ts` (this repo's dogfood config — add a `checks` block, OPTIONAL/local; do not commit if Markus keeps dogfood config local)

- [ ] **Step 1: Write a real e2e (gated like the other e2e tests)**

```ts
// tests/e2e/checks-real.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChecks } from "../../src/core/checks/runner.ts";

// No external services — runs real /bin/sh. Kept in e2e because it shells out.
describe("runChecks (real shell)", () => {
  it("passes a real green command and fails a real red one", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-checks-e2e-"));
    writeFileSync(join(repo, "ok.txt"), "1");
    const green = await runChecks({ repoRoot: repo, commands: [{ name: "ls", run: "ls ok.txt" }] });
    expect(green.ok).toBe(true);
    const red = await runChecks({ repoRoot: repo, commands: [{ name: "ls", run: "ls nope.txt" }] });
    expect(red.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run the e2e**

Run: `bun test tests/e2e/checks-real.test.ts`
Expected: PASS (2 assertions).

- [ ] **Step 3: Document `phases.checks` in the README**

Add a short subsection to the README config docs showing:

```ts
// reviewgate.config.ts — run tsc + tests before the LLM panel; a failure blocks
// the turn (with the output) and skips the panel. Order cheap → expensive.
phases: {
  checks: {
    commands: [
      { name: "typecheck", run: "bun run typecheck", timeoutMs: 120_000 },
      { name: "test",      run: "bun test",          timeoutMs: 300_000 },
    ],
  },
}
```
Note: commands run UNSANDBOXED (they are your own trusted config, same as `reviewgate.config.ts`); a check failure is not rejectable — fix it or remove the check.

- [ ] **Step 4: Commit (docs + e2e)**

```bash
git add tests/e2e/checks-real.test.ts README.md
git commit -m "test(e2e)+docs: real checks runner + phases.checks documentation"
```

- [ ] **Step 5: Full verification**

```bash
bunx tsc --noEmit
bun run lint
bun test
```
Expected: tsc clean, biome clean, all tests pass.

---

## Self-Review

**Spec coverage:**
- Fail-fast short-circuit → Task 5 (panel skipped on failure). ✓
- `phases.checks` config, default off → Task 2. ✓
- Decidable, reject-forbidden, stable `check:<name>` signature → Task 1 (flag) + Task 3 (finding/signature) + Task 4 (reject-forbidden). ✓
- Run before cache read + research → Task 5 (inserted before the brain-read at ~557, which precedes the cache key/read). ✓
- Fail-closed exit codes (127/timeout/abort) → Task 3. ✓
- Output capping → Task 3 (`maxBytes`). ✓
- AbortSignal propagation → Task 3 (`signal`) + Task 5 (plumb `this.input.signal`, with a verification note). ✓
- Unsandboxed (no sandbox profile passed; full `process.env` inherited) → Task 3 (`spawnCapture` with no sandbox). ✓
- Report rendering → Task 6. ✓
- No caching of check results → inherent (the runner has no cache; Task 5 returns before the cache logic). ✓
- Loop accounting / no infinite loop / no fail-open → Task 4 (reject-forbidden) + the finding being a normal CRITICAL in `pending.json` so the existing decisions/fix-verification/escalation loop governs it. ✓
- Testing strategy → Tasks 1-7 cover runner, config, orchestrator integration, loop-driver, report, real e2e. ✓

**Placeholder scan:** All test/impl code blocks are complete. Two intentional "grep to confirm the exact symbol" verification notes remain — Task 4 (the `pendingJsonPath`/`decisionsPath` import source) and Task 5 (the AbortSignal accessor + whether the run-summary `source` union needs `"checks"` added). These are verification instructions with complete fallbacks, not content placeholders. Task 6's earlier `...` placeholder was removed by testing `demoteBadges` directly.

**Type consistency:** `Finding.deterministic` (Task 1) is read in Task 3 (set), Task 4 (`metaOf.deterministic`), Task 6 (`f.deterministic`). `runChecks` signature (Task 3) matches its call in Task 5. `CheckResult.finding.signature === "check:<name>"` is asserted in Task 3 and used as `signaturesThisIter` in Task 5 and as the decisions key in Task 4. Consistent.
