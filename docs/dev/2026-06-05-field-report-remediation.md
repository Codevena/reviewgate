# Field-Report Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the five convergent failure modes two independent production field-reports identified in Reviewgate — untracked/pre-existing files reviewed as CRITICAL, confidently-hallucinated facts, infra-failure conflated with code-FAIL, the claude-code 300s-every-iteration burn, and dishonest singleton confidence — plus four secondary improvements.

**Architecture:** All five core fixes are surgical, well-isolated changes to existing modules (no new subsystems). They are demote-only / fail-safe / additive where they touch the verdict, preserving Reviewgate's fail-closed invariant. Two new tiny modules: a deterministic finding fact-validator (`src/core/fact-check.ts`) and an untracked-file mtime gate inside `collectDiff`.

**Tech Stack:** Bun + TypeScript, zod schemas as source of truth, `bun test`, biome lint, `bunx tsc --noEmit`.

---

## Background — the two field reports (convergence)

Both reports independently ranked the same two issues #1–#2, and both raised the same infra/confidence complaints. Grounded root causes (verified by 5 code-investigation passes):

| # | Symptom | Root cause (file:line) |
|---|---------|------------------------|
| **P1** | Untracked / pre-existing files (a foreign prisma migration; `cache/`, `*.bak`, empty `pnpm-workspace.yaml`) become CRITICAL findings on code the agent never touched. | `src/utils/git.ts:195` (`git ls-files --others` lists ALL untracked files) + `:222` (`git diff --no-index /dev/null <file>` renders the whole file as *added*) — **no base/timestamp filter**. Downstream `orchestrator.ts:1358` derives `changedRanges` from this over-inclusive diff, so `scopeFindings` (`aggregator.ts:198-244`) sees the finding as 100% in-range and cannot demote it. |
| **P2** | A reviewer hallucinates content in an **empty** file (`pnpm-workspace.yaml:2`) at 0.97 CRITICAL; the cited line does not exist. | **No deterministic content-level fact-check exists.** Grounding L1 (`grounding.ts:74-91`) is substring-only, CRITICAL-only, and *exempts* security/correctness (`:76`). Confidence is taken verbatim from the reviewer (`review-output.ts:257`). |
| **P3** | All reviewers fail (quota/timeout/error) → verdict `ERROR` → rendered as 🔴 GATE CLOSED (indistinguishable from a quality FAIL) → **advances the iteration** and hard-blocks. An automated agent loop deadlocks. | Verdict enum has no UNAVAILABLE state. 0-reviewer ⇒ `ERROR` (`orchestrator.ts:1196-1220`); `passed=false` ⇒ iteration advances (`loop-driver.ts:1069`); rendered as a block (`loop-driver.ts:1167-1176`). Only *all-quota* is deferred — the trigger `settled.every(status==="quota-exhausted")` (`orchestrator.ts:1201`) is too strict for a mixed quota+timeout+error outage. |
| **P4** | claude-code times out at **exactly 300s every iteration** (equivalent Opus review finished in ~160s). | claude runs Sonnet on a large prompt with buffered output + the zero-byte watchdog disabled (`claude.ts:141`, `zeroByteWatchdogMs = timeoutMs`), so only the 300s wall bounds it. A `timeout` yields **no cooldown** (`cooldownEffectFor` returns `null` for non-ok-non-quota, `orchestrator.ts:258-259`) → the provider is re-spawned and re-burns 300s every iteration. |
| **P5** | A single-reviewer run prints `Consensus: singleton · Confidence: 1.00` — dishonest; "one confidently-phrased opinion" presented as corroborated certainty. | Confidence propagated verbatim, never dampened by panel size; `report-writer.ts:68` prints the raw `consensus` + `confidence` side by side with no qualification. |

Secondary (one report each): **P6** doc/spec commits reviewed by the code-security persona (mixed-diff defeats the `docOnly && glob` gate); **P7** no cross-run memory of an already-adjudicated design decision (`priorAdjudications` is cycle-scoped, wiped on re-arm — `loop-driver.ts:355-361`); **P8** a CRITICAL whose "fix" edits an already-applied migration (migrations detected only as a *sensitivity* escalation, no append-only concept); **P9** decisions are hand-written JSONL (no `reviewgate decide` CLI).

---

## Priority & sequencing

Implement P1, P2, P5, P4 first (unambiguously safe, demote-only / additive, both reports request them). P3 changes the fail-closed default posture, so it is **config-gated with a conservative bounded default** and a back-compat escape hatch (`infraDeferMaxConsecutive: 0` → exact current behavior). P6–P9 are follow-up specs.

**This session:** P1 → P2 → P5 → P4 → P3. **Follow-up:** P9 (decide CLI), P8 (migration house-rule), P6 (doc-glob/mixed-diff), P7 (cross-run adjudication memory).

Run after every task: `bunx tsc --noEmit && bun run lint && bun test`. Commit per task.

---

## P1 — Strict diff scoping: drop pre-existing untracked files

**Approach:** Persist the batch-start timestamp (`base_ts`) in `dirty.flag` alongside `base_sha` (preserved across the batch, exactly like `base_sha`). In `collectDiff`, include an untracked file only if its filesystem mtime is **≥ base_ts** (i.e. it was created/modified during this batch). A pre-existing untracked file the agent never touched (mtime < base_ts) is silently skipped — not marked "incomplete" (intentional exclusion, not a failure). With no `base_ts` (legacy flag / HEAD-advanced path) the behavior is unchanged (all untracked included) so we never *under*-review a genuinely-new file.

**Files:**
- Modify: `src/hooks/handlers.ts:33-46` (preserve + write `base_ts`)
- Modify: `src/cli/commands/gate.ts:381-435` (read `base_ts`, thread to `collectDiff`)
- Modify: `src/utils/git.ts:165-233` (`collectDiff` gains a `sinceTs` param + mtime filter)
- Test: `tests/unit/git.test.ts`, `tests/unit/handlers-trigger.test.ts` (or nearest)

- [ ] **Step 1 — Failing test: `collectDiff` excludes a pre-existing untracked file.** In `tests/unit/git.test.ts`, add a test that creates a temp git repo, writes an untracked file `old.ts` and back-dates its mtime (`utimesSync(path, past, past)`), then a `new.ts` with a current mtime, calls `collectDiff(repo, base, budget, sinceTs)` with `sinceTs` between the two mtimes, and asserts the diff contains `new.ts` but **not** `old.ts`.

```ts
import { utimesSync } from "node:fs";
test("collectDiff excludes untracked files older than sinceTs", async () => {
  // ...init repo, commit a base...
  writeFileSync(join(repo, "old.ts"), "export const old = 1;\n");
  writeFileSync(join(repo, "new.ts"), "export const fresh = 2;\n");
  const past = new Date(Date.now() - 60_000); // 1 min ago
  utimesSync(join(repo, "old.ts"), past, past);
  const sinceTs = new Date(Date.now() - 30_000).toISOString(); // 30s ago
  const diff = await collectDiff(repo, base, 60_000, sinceTs);
  expect(diff).toContain("new.ts");
  expect(diff).not.toContain("old.ts");
});
```

- [ ] **Step 2 — Run, verify it fails.** `bun test tests/unit/git.test.ts -t "older than sinceTs"` → FAIL (param ignored / `old.ts` present).

- [ ] **Step 3 — Implement the mtime gate in `collectDiff`.** Add a 4th param `sinceTs?: string | null` to the signature (default `null`). Inside the untracked loop (`git.ts:207-227`), after the `isExcludedFromReview` filter, when `sinceTs` is set, `lstatSync(join(repoRoot, file))` and `continue` (skip, do NOT set `incomplete`) if `stat.mtimeMs < Date.parse(sinceTs)`. Guard the `lstat` in try/catch (a racing unlink → skip). Keep the existing budget/`incomplete` logic intact for files that pass the gate.

```ts
export async function collectDiff(
  repoRoot: string,
  baseSha?: string | null,
  untrackedBudgetMs: number = COLLECT_DIFF_UNTRACKED_BUDGET_MS,
  sinceTs?: string | null,
): Promise<string> {
  // ...unchanged tracked-diff + ls-files...
  const sinceMs = sinceTs ? Date.parse(sinceTs) : NaN;
  for (const file of untracked.stdout.split("\0").filter((s) => s.length > 0 && !isExcludedFromReview(s))) {
    // Pre-existing untracked noise (mtime predates this batch's start) is OUT OF
    // SCOPE — the agent never touched it. Skip WITHOUT marking incomplete: this is
    // a deliberate scope decision, not a dropped-due-to-failure file. With no
    // sinceTs (legacy flag) the gate is inert → all untracked included (no regression).
    if (!Number.isNaN(sinceMs)) {
      try {
        if (lstatSync(join(repoRoot, file)).mtimeMs < sinceMs) continue;
      } catch { /* racing unlink — fall through, the --no-index below will no-op */ }
    }
    // ...unchanged remaining-budget + git diff --no-index...
  }
}
```

- [ ] **Step 4 — Run, verify it passes.** `bun test tests/unit/git.test.ts` → PASS. Confirm the existing untracked-inclusion tests (`:28-36`, `:54-63`) still pass (they pass no `sinceTs` → inert).

- [ ] **Step 5 — Persist `base_ts` in `dirty.flag` (`handlers.ts`).** In `handleTrigger`, preserve an existing `base_ts` exactly like `base_sha`; when absent, set it to the current `ts`. Write it into the flag body.

```ts
let baseSha: string | null = null;
let baseTs: string | null = null;
if (existsSync(p)) {
  try {
    const prev = JSON.parse(readFileSync(p, "utf8")) as { base_sha?: string; base_ts?: string };
    baseSha = prev.base_sha ?? null;
    baseTs = prev.base_ts ?? null;
  } catch { baseSha = null; baseTs = null; }
}
if (!baseSha) baseSha = await gitHeadSha(input.repoRoot);
const nowIso = new Date().toISOString();
if (!baseTs) baseTs = nowIso; // batch-start timestamp, preserved across the batch
const body = JSON.stringify({
  diff_hash: diffHash,
  ts: nowIso,
  ...(baseSha ? { base_sha: baseSha } : {}),
  base_ts: baseTs,
});
```

- [ ] **Step 6 — Thread `base_ts` through the gate (`gate.ts`).** In `gatherReviewContext`, read `base_ts` from the dirty.flag next to `base_sha` (around `:383`), and pass it as the 4th arg to `diffFn(input.repoRoot, reviewBase, undefined, baseTs)` at `:435`. For the HEAD-advanced synthesis path (`:400`, no dirty.flag) pass `null` (unchanged: review all untracked). When `resolveReviewBase` corrects the base for a rebase (`:431`), keep `base_ts` (the batch start is unchanged by a rebase).

```ts
let reviewBaseTs: string | null = null;
if (hasDirtyFlag) {
  try {
    const flag = JSON.parse(readFileSync(dp, "utf8")) as { base_sha?: string; base_ts?: string };
    reviewBase = flag.base_sha ?? null;
    reviewBaseTs = flag.base_ts ?? null;
  } catch { reviewBase = null; }
}
// ...
const diff = precomputedDiff ?? (await diffFn(input.repoRoot, reviewBase, undefined, reviewBaseTs));
```

- [ ] **Step 7 — Test the flag round-trip.** Add/extend a handlers test asserting `base_ts` is written on first trigger and preserved (unchanged value) on a second trigger. Run `bun test tests/unit/handlers-trigger.test.ts`.

- [ ] **Step 8 — Full suite + commit.** `bunx tsc --noEmit && bun run lint && bun test`.

```bash
git add src/utils/git.ts src/hooks/handlers.ts src/cli/commands/gate.ts tests/
git commit -m "fix(scope): exclude pre-existing untracked files from the reviewed diff (mtime gate)"
```

---

## P2 — Deterministic finding fact-validator

**Approach:** A new demote-only pass, run in the orchestrator between `applySymbolSignatures` (`orchestrator.ts:1231`) and `groundFindings` (`:1239`). For each finding, deterministically check whether its cited `file:line_start` actually exists in the working tree: file present (and not a deleted-in-diff path), non-empty if a positive line is cited, and `line_start ≤ lineCount`. A finding whose location is **provably fabricated** is demoted to INFO (non-blocking advisory) and flagged. Unlike grounding L1, this does **not** exempt security/correctness — a non-existent line is a fabrication regardless of category, and demoting it (vs blocking on a phantom) is strictly safer. All file reads are realpath-contained + `lstat`-guarded against symlink escape (reuse the orchestrator's existing `safeReadWithinRepo` pattern at `orchestrator.ts:545-555`).

**Files:**
- Create: `src/core/fact-check.ts`
- Modify: `src/schemas/finding.ts` (add `fact_invalid?: boolean` flag)
- Modify: `src/core/orchestrator.ts:1231-1239` (wire the pass)
- Modify: `src/core/report-writer.ts:34-53` (`demoteBadges` — render the flag)
- Test: `tests/unit/fact-check.test.ts`

- [ ] **Step 1 — Add the schema flag.** In `src/schemas/finding.ts`, next to `grounding_demoted`, add:

```ts
/** Set by the deterministic fact-validator: the cited file:line does not exist
 *  in the working tree (file absent / empty / line out of range) — almost
 *  certainly a hallucination. Demoted to INFO (advisory). */
fact_invalid: z.boolean().optional(),
```

- [ ] **Step 2 — Failing test for `validateFindingFacts`.** `tests/unit/fact-check.test.ts`: a CRITICAL citing `empty.yaml:2` where `empty.yaml` exists but is 0 bytes → demoted to INFO with `fact_invalid:true`; a CRITICAL citing `real.ts:3` where `real.ts` has ≥3 lines → unchanged; a finding citing `ghost.ts:5` where the file is absent (and not in the diff as deleted) → demoted.

```ts
import { validateFindingFacts } from "../../src/core/fact-check.ts";
test("demotes a finding citing a line in an empty file", () => {
  // write empty.yaml (0 bytes) + real.ts (3 lines) under a temp repoRoot
  const findings = [
    mkFinding({ id: "F-1", file: "empty.yaml", line_start: 2, severity: "CRITICAL", category: "config" }),
    mkFinding({ id: "F-2", file: "real.ts", line_start: 3, severity: "CRITICAL", category: "security" }),
    mkFinding({ id: "F-3", file: "ghost.ts", line_start: 5, severity: "WARN", category: "correctness" }),
  ];
  const out = validateFindingFacts(findings, repoRoot, new Set()); // empty deleted-set
  expect(out.find((f) => f.id === "F-1")).toMatchObject({ severity: "INFO", fact_invalid: true });
  expect(out.find((f) => f.id === "F-2")).toMatchObject({ severity: "CRITICAL" });
  expect(out.find((f) => f.id === "F-3")).toMatchObject({ severity: "INFO", fact_invalid: true });
});
```

- [ ] **Step 3 — Run, verify FAIL.** `bun test tests/unit/fact-check.test.ts` → FAIL (module missing).

- [ ] **Step 4 — Implement `src/core/fact-check.ts`.** Signature: `validateFindingFacts(findings: Finding[], repoRoot: string, deletedPaths: Set<string>): Finding[]`. For each finding: skip if `f.file` is in `deletedPaths` (legitimately gone) or empty/`"."`; resolve `realpathSync(join(repoRoot, f.file))` and require it to start with `realpathSync(repoRoot)` (else skip — out-of-repo path, don't touch); `lstatSync` and skip symlinks/dirs; read the file, count `\n`-newlines (+1); if `f.line_start >= 1` and `lineCount < f.line_start` (covers empty file = 0 usable lines), demote. Demotion = `{ ...f, severity: "INFO", fact_invalid: true, details: f.details + "\n\n[reviewgate fact-check] cited location not found in the working tree (file empty / line out of range) — demoted as a likely hallucination." }`. Any fs error on a file = skip (fail-safe, never demote on uncertainty). Pure-sync, no LLM, no network.

- [ ] **Step 5 — Run, verify PASS.** `bun test tests/unit/fact-check.test.ts` → PASS.

- [ ] **Step 6 — Wire into the orchestrator.** Compute `deletedPaths` from the diff (parse `^diff --git a/X b/X` blocks followed by `deleted file mode`, or reuse an existing diff-parser if present — check `src/diff/hunks.ts`). Insert between `:1231` and `:1239`:

```ts
const allFindings0 = await this.applySymbolSignatures(rawFindings);
// Deterministic fact-check BEFORE grounding: drop the gating power of a finding
// whose cited file:line provably does not exist (empty file / out-of-range line).
// Demote-only + fail-safe (any fs uncertainty → leave the finding untouched).
const allFindings = validateFindingFacts(allFindings0, this.input.repoRoot, deletedPaths);
```

- [ ] **Step 7 — Render the badge.** In `report-writer.ts` `demoteBadges`, add: `if (f.fact_invalid) badges.push("🔎 cited location not found — likely hallucinated");`.

- [ ] **Step 8 — Full suite + commit.** `bunx tsc --noEmit && bun run lint && bun test`.

```bash
git add src/core/fact-check.ts src/schemas/finding.ts src/core/orchestrator.ts src/core/report-writer.ts tests/unit/fact-check.test.ts
git commit -m "feat(fact-check): demote findings citing non-existent file:line (deterministic, pre-grounding)"
```

---

## P5 — Honest singleton confidence

**Approach:** Two parts. (a) Report rendering: when `consensus === "singleton"`, qualify the confidence so the UI never presents one model's opinion as corroborated certainty. (b) Add a coverage-style "single effective reviewer" banner even on a *clean* (status-ok) single-reviewer run — today the banner only triggers on a degraded (`status !== "ok"`) panel. No verdict change (this is presentation honesty; the singleton-CRITICAL hard-FAIL failsafe at `aggregator.ts:597-606` is intentional and stays).

**Files:**
- Modify: `src/core/report-writer.ts:56-77` (`fmtFinding`), `:79-107` (`renderMd` banner)
- Test: `tests/unit/report-writer.test.ts`

- [ ] **Step 1 — Failing test.** A singleton finding renders confidence qualified (e.g. contains `single reviewer — uncorroborated`), and a clean single-reviewer report renders a "single effective reviewer" banner.

```ts
test("singleton confidence is labeled as uncorroborated", () => {
  const md = renderReport(mkReport({ reviewers: [{ id: "codex:security", status: "ok" }], findings: [mkFinding({ consensus: "singleton", confidence: 1.0, severity: "CRITICAL" })] }), "gate");
  expect(md).toContain("single reviewer");
  expect(md).not.toMatch(/Consensus:\*\* singleton\s+·\s+\*\*Confidence:\*\* 1\.00(?!.*single)/);
});
```

- [ ] **Step 2 — Run, verify FAIL.** `bun test tests/unit/report-writer.test.ts -t "uncorroborated"`.

- [ ] **Step 3 — Implement the qualifier in `fmtFinding`.** Change `:68` to append a qualifier when singleton:

```ts
const consNote = f.consensus === "singleton" ? " — single reviewer, uncorroborated" : "";
// ...
`**Category:** ${f.category}  ·  **Consensus:** ${f.consensus}${consNote}  ·  **Confidence:** ${f.confidence.toFixed(2)}${confirmed}`,
```

- [ ] **Step 4 — Add the single-effective-reviewer banner in `renderMd`.** Where the coverage banner is computed (`:97`), also surface when the panel that finished OK numbered exactly one:

```ts
const okReviewers = r.reviewers.filter((x) => x.status === "ok");
const singleReviewerBanner =
  degraded.length === 0 && okReviewers.length === 1
    ? [`> ℹ️ **Single effective reviewer** (${okReviewers[0].id}): consensus, FP-ledger promotion and reputation-demote are all inert with one reviewer. Treat lone CRITICAL/WARN findings as one model's opinion, not corroborated — verify the cited code yourself.`, ""]
    : [];
```

Include `...singleReviewerBanner` in the rendered output next to `...coverageBanner`.

- [ ] **Step 5 — Run, verify PASS.** `bun test tests/unit/report-writer.test.ts`.

- [ ] **Step 6 — Commit.** `bunx tsc --noEmit && bun run lint && bun test`.

```bash
git add src/core/report-writer.ts tests/unit/report-writer.test.ts
git commit -m "feat(report): label singleton confidence honestly + single-effective-reviewer banner"
```

---

## P4 — Cool down a timed-out reviewer (stop the 300s-every-iteration burn)

**Approach:** A reviewer `timeout` is non-conclusive (we don't know if it's slow or wedged), but re-spawning it every iteration to burn the full wall-clock is wasteful and was the field reports' biggest latency cost. Give `timeout` a **short** cooldown (distinct from a quota cooldown's reset time) so the provider is pre-spawn-skipped on the immediately-following iteration(s), failing over to a working reviewer instead of re-timing-out. The cooldown is short (default 5 min) and self-expiring, so a transiently-slow reviewer recovers quickly. Also: surface per-provider cooldown reset times in the ERROR block message instead of the bare "run reviewgate doctor".

**Files:**
- Modify: `src/core/orchestrator.ts:243-260` (`cooldownEffectFor` — add a timeout branch)
- Modify: `src/config/defaults.ts` (add `timeoutCooldownMs`), `src/config/schema.ts`
- Modify: `src/core/loop-driver.ts:1173-1176` (richer ERROR message via `quotaDegradationNote`)
- Test: `tests/unit/cooldown-effect.test.ts` (the test at `:29-35` currently pins timeout→null — update it)

- [ ] **Step 1 — Failing test.** In `tests/unit/cooldown-effect.test.ts`, change the expectation: a `timeout` result now yields a cooldown effect with a `resetAt` ~`timeoutCooldownMs` in the future and `source:"default"`.

```ts
test("timeout yields a short cooldown so the provider is skipped next iteration", () => {
  const now = new Date("2026-06-05T12:00:00Z");
  const eff = cooldownEffectFor("claude-code", { status: "timeout", /* ...usage */ } as ReviewResult, now, 300_000);
  expect(eff).not.toBeNull();
  expect(eff).toMatchObject({ provider: "claude-code", source: "default" });
  expect(Date.parse((eff as { resetAt: string }).resetAt)).toBe(now.getTime() + 300_000);
});
```

- [ ] **Step 2 — Run, verify FAIL.** `bun test tests/unit/cooldown-effect.test.ts`.

- [ ] **Step 3 — Implement.** Add a `timeoutCooldownMs` param (default 0 = disabled, but defaults.ts sets 300_000) to `cooldownEffectFor`. After the `ok` branch, before `return null`:

```ts
if (res.status === "timeout" && timeoutCooldownMs > 0) {
  // A timeout is non-conclusive, but re-spawning a wedged reviewer to burn the
  // full wall-clock EVERY iteration is the field-report's #1 latency cost. A
  // short, self-expiring cooldown skips it next iteration (failover covers the
  // slot); it re-probes automatically once the window passes.
  return { provider, resetAt: new Date(now.getTime() + timeoutCooldownMs).toISOString(), source: "default" };
}
return null;
```

Thread `this.input.config.loop.timeoutCooldownMs` (or wherever the cooldown call sites live) into every `cooldownEffectFor` call. Add `timeoutCooldownMs: 300_000` to `defaults.ts` (under `loop` or a new `cooldown` block) and the zod schema.

- [ ] **Step 4 — Run, verify PASS.** `bun test tests/unit/cooldown-effect.test.ts`.

- [ ] **Step 5 — Richer ERROR message.** In `loop-driver.ts:1173-1176`, append `this.quotaDegradationNote(new Date())` (already surfaces capped providers + reset times) to the ERROR reason so a stuck panel tells the dev *which* provider and *when* it recovers, not just "run reviewgate doctor".

- [ ] **Step 6 — Commit.** `bunx tsc --noEmit && bun run lint && bun test`.

```bash
git add src/core/orchestrator.ts src/config/defaults.ts src/config/schema.ts src/core/loop-driver.ts tests/
git commit -m "fix(infra): short cooldown for timed-out reviewers + reset-time in error message"
```

---

## P3 — Bounded infra-defer (UNAVAILABLE ≠ code-FAIL)

**Approach:** Distinguish, inside the `ERROR` branch, **misconfiguration** (`settled.length === 0` — no reviewer even attempted; none enabled/available/all threw) from a **transient infra outage** (`settled.length > 0` and every attempt failed quota/timeout/error). The former keeps the current hard-block ("check provider availability/config") — correct. The latter is *deferred* like the existing all-quota path (allow_stop, **keep** the dirty flag, **don't** advance the iteration), but **bounded**: after `infraDeferMaxConsecutive` consecutive infra-defers, stop deferring and **escalate to the human** (`ESCALATION.md`, reason `infra-unavailable`) so a persistent outage/misconfig is never silently waved through forever. Default `infraDeferMaxConsecutive: 2`; setting `0` restores exact current behavior (always hard-block).

**Security guardrails (the gate's value is fail-closed — these keep the defer honest):** (1) it never emits PASS — it defers and re-reviews on the next turn; (2) the dirty flag persists, so the change is never permanently un-reviewed; (3) the consecutive-defer cap forces escalation to the human; (4) every infra-defer writes an audit event; (5) the 0-reviewer *misconfig* case still hard-blocks (this is NOT eligible for defer).

**Files:**
- Modify: `src/core/orchestrator.ts:1196-1220` (add `allReviewersInfraFailed` to the ERROR return)
- Modify: `src/core/orchestrator.ts` (the `IterationResult` type — add the flag)
- Modify: `src/schemas/state.ts` (add `consecutive_infra_defers: number`, default 0)
- Modify: `src/config/defaults.ts` + `schema.ts` (`loop.infraDeferMaxConsecutive: 2`)
- Modify: `src/core/loop-driver.ts:1050-1052` (route infra-failure), new `handleInfraUnavailable`, reset the counter in the normal state update
- Test: `tests/unit/orchestrator-fail-closed.test.ts`, `tests/unit/loop-driver.test.ts`

- [ ] **Step 1 — Failing orchestrator test.** Extend `orchestrator-fail-closed.test.ts`: when all reviewers return `timeout`/`error` (settled > 0), the result has `allReviewersInfraFailed:true`; when zero reviewers are enabled (settled === 0), it is `false` (stays a misconfig hard-block).

- [ ] **Step 2 — Run, verify FAIL.**

- [ ] **Step 3 — Implement the flag (orchestrator).** At `:1201`, alongside `allReviewersQuotaLocked`:

```ts
// settled.length > 0 means reviewers WERE attempted but every one failed
// transiently (quota/timeout/error) — "couldn't review", not "code is bad".
// settled.length === 0 (nothing attempted: none enabled/available/all threw)
// is a real MISCONFIG and stays a hard block (not infra-failed).
const allReviewersInfraFailed = settled.length > 0; // in this branch every settled run is non-ok
```

Add `allReviewersInfraFailed` to the `IterationResult` return object and its type.

- [ ] **Step 4 — Run, verify the orchestrator test passes.**

- [ ] **Step 5 — State field + config.** Add `consecutive_infra_defers: z.number().int().nonnegative().default(0)` to `ReviewgateStateSchema`; add `infraDeferMaxConsecutive: 2` to `defaults.ts` `loop` + the zod schema.

- [ ] **Step 6 — Failing loop-driver test.** Two infra-ERROR turns in a row → both `allow_stop` (deferred), iteration NOT advanced, dirty flag kept; the third → `escalateAndDecide("infra-unavailable", …)`. With `infraDeferMaxConsecutive: 0` → first infra-ERROR hard-blocks (current behavior).

- [ ] **Step 7 — Implement routing in `loop-driver.ts`.** After the existing quota-defer at `:1050-1052`:

```ts
if (result.verdict === "ERROR" && result.allReviewersInfraFailed) {
  return await this.handleInfraUnavailable(state, result);
}
```

Add `handleInfraUnavailable` (modeled on `handleAllQuotaLocked` but bounded):

```ts
private async handleInfraUnavailable(state: ReviewgateState, result: IterationResult): Promise<LoopDecision> {
  const cap = this.i.config.loop.infraDeferMaxConsecutive;
  const next = state.consecutive_infra_defers + 1;
  await this.i.audit.append({ event: "gate.decision", run_id: state.session_id, iter: state.iteration, trigger: "stop-hook", note: `infra-defer ${next}/${cap}` }).catch(() => {});
  if (cap <= 0 || next > cap) {
    // Exhausted the bounded defer (or defer disabled) → surface to the human; a
    // persistent outage must not silently defer forever. Reset the counter.
    await this.i.state.update((cur) => ReviewgateStateSchema.parse({ ...cur, consecutive_infra_defers: 0 }));
    if (cap <= 0) {
      return { kind: "block", reason: `🔴 Reviewgate · GATE CLOSED — reviewer infrastructure unavailable (iteration ${state.iteration}): ${formatErrorBreakdown(result.summary)}.${this.quotaDegradationNote(new Date()) ?? ""}` };
    }
    const fresh = await this.i.state.load();
    return this.escalateAndDecide(fresh, "infra-unavailable", `No reviewer could complete a review for ${next} consecutive turns (transient infra outage: ${formatErrorBreakdown(result.summary)}).`);
  }
  // Bounded defer: keep the dirty flag, don't advance the iteration, re-review next turn.
  await this.i.state.update((cur) => ReviewgateStateSchema.parse({ ...cur, consecutive_infra_defers: next, last_stop_ts: new Date().toISOString() }));
  return {
    kind: "allow_stop",
    reason: `🟠 Reviewgate · GATE DEFERRED (iteration ${state.iteration}) — no reviewer could complete this turn (${formatErrorBreakdown(result.summary)}); transient infra outage, NOT your code. The change stays flagged and is re-reviewed next turn. Will escalate to the human if this persists (${next}/${cap}).${this.quotaDegradationNote(new Date()) ?? ""}`,
  };
}
```

Add `"infra-unavailable"` to the escalation-reason union (`src/schemas/` / wherever reasons are typed) and to `ALLOW_STOP_ESCALATIONS` consideration (it should BLOCK-once to surface, like other escalations — so do NOT add it to `ALLOW_STOP_ESCALATIONS`).

- [ ] **Step 8 — Reset the counter on any real review.** In the normal `state.update` (`loop-driver.ts:1066-1116`), add `consecutive_infra_defers: 0` (any turn that reaches a real PASS/FAIL/SOFT-PASS verdict — i.e. reviewers ran — breaks the infra-outage streak). Quota-defer leaves it untouched (quota has its own uncapped path; an interleaved quota turn shouldn't reset the infra streak, but also shouldn't extend it — leaving untouched is correct).

- [ ] **Step 9 — Run loop-driver tests, verify PASS.** `bun test tests/unit/loop-driver.test.ts`.

- [ ] **Step 10 — Full suite + commit.** `bunx tsc --noEmit && bun run lint && bun test`.

```bash
git add src/core/orchestrator.ts src/core/loop-driver.ts src/schemas/state.ts src/config/defaults.ts src/config/schema.ts tests/
git commit -m "feat(infra): bounded infra-defer (UNAVAILABLE != code-FAIL) with escalation cap"
```

---

## Follow-up specs (implement after the core five)

### P9 — `reviewgate decide` CLI
Thin, schema-validated writer over the existing decision flow. `reviewgate decide <finding_id> <accept|reject|ack> [reason]`: load `state.json` → `iteration`; read `pending.json` finding ids (mirror `previousFindingIds`, CRITICAL/WARN only) to validate `<finding_id>` is blocking; for `ack` mirror the N2 high-stakes refusal (`evaluateDecisions` — reject on CRITICAL/security/correctness); build the `reviewgate.decision.v1` line (`accept`→`{verdict:"accepted",action:"fixed"}`, `reject`→`{verdict:"rejected",reason}` with `reason.length>=20`, `ack`→`{verdict:"accepted",action:"acknowledged-low-value"}`); `DecisionEntrySchema.parse` it; append atomically to `decisions/<iter>.jsonl`; print remaining undecided ids. Extract the high-stakes check from `loop-driver.ts` so the CLI and gate share one implementation (no drift). New `src/cli/commands/decide.ts`, wired in `src/cli/index.ts`. Tests: `tests/unit/cli-decide.test.ts`.

### P8 — Migration append-only house-rule
Add a default `houseRules` directive injected when the diff touches `migrations?/` or `*.sql` (the `migrations`/`sql` sensitivity tags already exist at `diff-facts.ts:23-24`): *"Migration files that are already applied are append-only — never suggest editing or removing an existing migration statement; corrections must be a NEW migration."* Reuses the existing `renderHouseRules` trusted-preamble path (`orchestrator.ts:916-917`). Largely subsumed by P1 for the *foreign* migration case (it's dropped from the diff), but this protects against a dangerous fix on an in-scope migration. Tests: extend `tests/unit/diff-facts.test.ts` + a house-rules render test.

### P6 — Doc/spec mixed-diff handling
Two parts: (a) widen `docReview.globs` in `defaults.ts:191-196` to catch common design-doc locations (e.g. `docs/**/*.md`, `**/*design*.md`); (b) when a diff mixes docs + a single trivial non-doc file, still treat the doc hunks under the `plan` persona rather than letting one non-doc file force the whole diff onto the `security` persona. The cleanest minimal change: if `docOnly` is false *only because* of config/lockfile files (not code), and the substantive change is docs, route to the doc persona. Tests: `tests/unit/triage-matrix.test.ts`, `tests/unit/orchestrator-docreview.test.ts`.

### P7 — Cross-run adjudication memory
Persist accepted/rejected adjudications across cycles so a settled design decision isn't re-litigated by a later run (the Gemini-vs-Gemini contradiction). Instead of only wiping `decisions/` on re-arm (`loop-driver.ts:355-361`), snapshot each cycle's `Adjudication[]` (location + disposition + reason) into an append-only `.reviewgate/adjudications.jsonl`, and feed location-matching entries into `priorAdjudications` across runs (decay by age + drop when the cited region changed). Reuses the existing `renderAdjudications` trusted-prompt path. Tests: `tests/unit/prior-adjudications.test.ts`, a new cross-run test.

---

## Risks & notes

- **P1 mtime is heuristic** (clock skew, `touch`, checkout resetting mtime). Mitigation: it only *excludes* untracked files and only when a `base_ts` exists; a false-exclude under-reviews a genuinely-new file (acceptable, rare), a false-include is just the status quo. The aggregator demote (tagging untracked-pre-existing findings) is a documented fallback if mtime proves unreliable in the field.
- **P2 must stay fail-safe:** any fs uncertainty (read error, symlink, out-of-repo path) → leave the finding untouched. Only a *provable* non-existent location demotes. Never block-promote; demote-only.
- **P3 is the only fail-closed-posture change.** It is config-gated, bounded, audited, never PASSes, and keeps the dirty flag. The `settled.length === 0` misconfig case is deliberately excluded from defer. Default cap = 2.
- This repo **dogfoods itself** — the gate will run on these very commits. Expect to address its findings via the decisions protocol.
- Do **not** commit the local-only artifacts (`.reviewgate/bin/`, `.reviewgate/brain/`, `.reviewgate/reputation.json`, `.reviewgate/quota-cooldowns.json`, `.gitignore` mod) — they are kept local/uncommitted per project convention.

## Self-review checklist (run before handing off)
- [ ] Every spec item (P1–P9) maps to a task above.
- [ ] No placeholders; each core task has a failing test, implementation, and commands.
- [ ] Type names consistent: `validateFindingFacts`, `fact_invalid`, `allReviewersInfraFailed`, `consecutive_infra_defers`, `infraDeferMaxConsecutive`, `timeoutCooldownMs`, `base_ts`, `sinceTs`.
