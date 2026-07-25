# Agent-safe pending policy candidate (slice 3) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the Reviewgate gate from re-blocking an agent every turn on a pending `approval-required` policy candidate that only a human at a TTY can clear.

**Architecture:** Once-ness is derived from the existing `pending.reviewed_under_lkg_at` field — no new persisted state. `finalizeControlPlaneReview` reports whether this pass was the first (loud, blocking notice) or a repeat (quiet, non-blocking notice); the stop probe stops force-reviewing a candidate that already passed under the last-known-good policy; and the `allow_stop` path blocks only on the first notice. A shared renderer keeps the quiet notice visible on all four gate exits.

**Tech Stack:** TypeScript, Bun runtime, `bun test`, biome (lint/format), zod schemas.

**Spec:** `docs/superpowers/specs/2026-07-25-agent-safe-policy-candidate-design.md` — read it before Task 1. The plan-gate (agy round 1, GLM-5.2 rounds 1+2) is closed and recorded there.

## Global Constraints

- Runtime is **Bun**. Use `bun`/`bunx`, never `npm`/`node`/`npx`. Tests are `bun test`, not jest/vitest.
- `bunx tsc --noEmit` **and** `bun run lint` must both be clean before any task is considered done. Run the full `bun test` at the end of each task (baseline on `a745d37` is **2944 total / 0 fail** — 2929 pass / 15 skip on a clean worktree, or 2932 pass / 12 skip when `dist/reviewgate` already exists, since that flips 3 `tests/integration/binary.test.ts` tests from skipped to run; the total stays 2944 either way — compare the **total**, not the raw pass count).
- **Never `git add -A` in this repo** — it stages `.reviewgate/` runtime state. Stage explicit paths only.
- **Never run `bun run build`.** It deploys to every repo on this machine through the `~/.local/bin/reviewgate` → `dist/reviewgate` symlink. Building is not part of this plan.
- Commit messages carry **no** `Co-Authored-By` line and no "generated with" footer.
- **Never push.** Committing locally is the end state; Markus decides about pushing.
- Do not modify anything under `.reviewgate/` (runtime state, not source).
- Delete `.review/` before the final commit (it holds plan-gate scratch output).
- Every test that guards this bug is **mutation-checked in a git worktree copy** (procedure in Task 1, Step 6) — a test never seen red is worthless.

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `src/config/control-plane.ts` | Policy state, classification, finalize/approve | Modify: new exported `renderPendingPolicyNotice`, `alreadyNotified` on the `approval-required` result, first-vs-repeat branch in `finalizeControlPlaneReview` |
| `src/cli/commands/gate.ts` | Hook entry point, probe, block/allow decisions | Modify: probe no longer forced by a settled candidate; notice appended at the two skip exits; `allow_stop` blocks only on the first notice |
| `src/cli/commands/doctor.ts` | Health checks | Modify: the `acknowledgePass` warning text, which currently makes a claim this change falsifies |
| `tests/unit/control-plane.test.ts` | Control-plane unit coverage | Add 2 tests |
| `tests/integration/control-plane-gate.test.ts` | Gate + control-plane end-to-end | Add 4 tests + a call-counting reviewer stub |
| `CLAUDE.md` | Repo guidance | Modify: one clause in the `src/config/` bullet |

---

### Task 1: Control-plane — first-notice vs repeat

**Files:**
- Modify: `src/config/control-plane.ts:41-46` (the result union), `:439-445` (next to `approvalMessage`), `:516-520` (the finalize tail)
- Test: `tests/unit/control-plane.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `export function renderPendingPolicyNotice(repoRoot: string, approvedFingerprint: string): string`
  - `ControlPlaneFinalizeResult`'s `approval-required` member gains `alreadyNotified: boolean`.

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe("gate policy control plane", …)` block in `tests/unit/control-plane.test.ts`:

```ts
  it("delivers the approval notice once per candidate and never refreshes the review timestamp", async () => {
    const repo = temp("rg-control-once-");
    const home = temp("rg-control-home-");
    writeConfig(repo, "{ providers: { codex: { model: 'approved-model' } } }");
    await bootstrapControlPlane({ cwd: repo, ...envFor(home), approvedVia: "init" });
    writeConfig(repo, "{ providers: { codex: { model: 'candidate-model' } } }");

    const first = await resolveControlPlaneConfig({ cwd: repo, ...envFor(home) });
    const a = await finalizeControlPlaneReview(repo, first, envFor(home));
    expect(a).toMatchObject({ kind: "approval-required", alreadyNotified: false });
    const t1 = (await controlPlaneStatus(repo, envFor(home))).state?.pending
      ?.reviewed_under_lkg_at;
    expect(t1).not.toBeNull();

    // Advance the wall clock past ISO millisecond resolution so a regression that
    // re-stamps the timestamp is actually VISIBLE to the assertion below.
    await Bun.sleep(5);

    const second = await resolveControlPlaneConfig({ cwd: repo, ...envFor(home) });
    const b = await finalizeControlPlaneReview(repo, second, envFor(home));
    expect(b).toMatchObject({ kind: "approval-required", alreadyNotified: true });
    expect(b.kind === "approval-required" && b.message).toContain("pending human approval");
    const t2 = (await controlPlaneStatus(repo, envFor(home))).state?.pending
      ?.reviewed_under_lkg_at;
    expect(t2).toBe(t1 as string);

    // The quiet path must still leave the candidate approvable by a human.
    const challenge = `APPROVE ${second.observedEffectiveFingerprint?.slice(0, 12)}`;
    await approveControlPlane(repo, challenge, envFor(home));
    const approved = await resolveControlPlaneConfig({ cwd: repo, ...envFor(home) });
    expect(approved.change).toBeNull();
    expect(approved.config.providers.codex.model).toBe("candidate-model");
  });

  it("re-arms the one-time notice when the config changes to a new candidate", async () => {
    const repo = temp("rg-control-rearm-");
    const home = temp("rg-control-home-");
    writeConfig(repo, "{ providers: { codex: { model: 'approved-model' } } }");
    await bootstrapControlPlane({ cwd: repo, ...envFor(home), approvedVia: "init" });

    writeConfig(repo, "{ providers: { codex: { model: 'candidate-one' } } }");
    const first = await resolveControlPlaneConfig({ cwd: repo, ...envFor(home) });
    expect(await finalizeControlPlaneReview(repo, first, envFor(home))).toMatchObject({
      alreadyNotified: false,
    });
    const repeat = await resolveControlPlaneConfig({ cwd: repo, ...envFor(home) });
    expect(await finalizeControlPlaneReview(repo, repeat, envFor(home))).toMatchObject({
      alreadyNotified: true,
    });

    // A DIFFERENT candidate is a different trust decision — the notice re-arms.
    writeConfig(repo, "{ providers: { codex: { model: 'candidate-two' } } }");
    const third = await resolveControlPlaneConfig({ cwd: repo, ...envFor(home) });
    expect(third.change?.reviewed_under_lkg_at).toBeNull();
    expect(await finalizeControlPlaneReview(repo, third, envFor(home))).toMatchObject({
      alreadyNotified: false,
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/unit/control-plane.test.ts -t "once per candidate"`
Expected: FAIL — the returned object has no `alreadyNotified` property, so `toMatchObject({ alreadyNotified: false })` does not match.

- [ ] **Step 3: Add the shared renderer**

In `src/config/control-plane.ts`, directly **above** the existing `approvalMessage` function (currently line 439):

```ts
// Slice 3: the loud, blocking approval notice is delivered ONCE per candidate.
// Every later gate message carries this quiet reminder instead, so the pending
// candidate stays visible without costing the agent another turn on a decision
// only a human at a terminal can make. Single source of truth for that text —
// see docs/superpowers/specs/2026-07-25-agent-safe-policy-candidate-design.md.
export function renderPendingPolicyNotice(repoRoot: string, approvedFingerprint: string): string {
  const report = policyChangeReportPath(repoRoot).replace(`${repoRoot}/`, "");
  return `🔐 Gate policy candidate still pending human approval — code was reviewed under approved policy ${approvedFingerprint.slice(0, 12)}. Run \`reviewgate config approve\` in an interactive terminal to adopt it. Details: ${report}.`;
}
```

- [ ] **Step 4: Widen the result union**

Replace line 44 of `src/config/control-plane.ts`:

```ts
  | { kind: "approval-required"; message: string; alreadyNotified: boolean }
```

(The other four members are untouched. This is additive: both production call sites narrow on `.kind` and then read `.message`, which is retained.)

- [ ] **Step 5: Branch first-vs-repeat in `finalizeControlPlaneReview`**

Replace the current tail of the function (lines 516-520, from `const reviewed = …` through `return { kind: "approval-required", message: approvalMessage(repoRoot, reviewed) };`):

```ts
    // Slice 3: the FIRST completed pass under the LKG delivers the loud, blocking
    // approval notice; every later pass is a quiet, non-blocking reminder. The
    // null->set transition is decided HERE, inside the control-plane lock, so two
    // racing stop hooks can never both believe they are first. Do NOT refresh the
    // timestamp on a repeat: it records when the candidate first passed, and
    // approveControlPlane only requires it to be non-null.
    if (pending.reviewed_under_lkg_at !== null) {
      return {
        kind: "approval-required",
        message: renderPendingPolicyNotice(repoRoot, state.approved_effective_fingerprint),
        alreadyNotified: true,
      };
    }
    const reviewed = { ...pending, reviewed_under_lkg_at: new Date().toISOString() };
    const next = { ...state, pending: reviewed };
    writeState(repoRoot, next);
    writeFileAtomic(policyChangeReportPath(repoRoot), renderReport(next), { mode: 0o600 });
    return {
      kind: "approval-required",
      message: approvalMessage(repoRoot, reviewed),
      alreadyNotified: false,
    };
```

- [ ] **Step 6: Run the tests to verify they pass, then verify the whole surface**

Run, in order:
```bash
bun test tests/unit/control-plane.test.ts
bunx tsc --noEmit
bun run lint
```
Expected: all tests pass; `tsc` clean (adding a required field to one union member does not break the two `gate.ts` call sites, which only read `.kind` and `.message`); lint clean.

- [ ] **Step 7: Commit**

```bash
git add src/config/control-plane.ts tests/unit/control-plane.test.ts
git commit -m "fix(control-plane): deliver the approval-required notice once per candidate

finalizeControlPlaneReview now reports whether this pass was the candidate's
first under the LKG policy. A repeat leaves reviewed_under_lkg_at untouched and
returns a quiet notice instead of the loud approval demand, so callers can stop
blocking on a decision only a human at a TTY can make."
```

- [ ] **Step 8: Mutation-check the new tests (in a COPY — never the real repo)**

This procedure is reused verbatim in later tasks; `<SCRATCH>` is the session scratchpad directory.

```bash
git worktree add <SCRATCH>/mut-task1 HEAD
ln -s "$(pwd)/node_modules" <SCRATCH>/mut-task1/node_modules
```

In `<SCRATCH>/mut-task1/src/config/control-plane.ts`, re-introduce the bug: delete the
`if (pending.reviewed_under_lkg_at !== null) { … }` early return added in Step 5, and set
`alreadyNotified: false` on the remaining return.

```bash
cd <SCRATCH>/mut-task1 && bun test tests/unit/control-plane.test.ts
```
Expected: **RED** — both new tests fail (`alreadyNotified` is never `true`, and the timestamp is re-stamped).
If either stays green, the test is vacuous — rewrite it and `git commit --amend`.

```bash
git worktree remove --force <SCRATCH>/mut-task1
git status --short          # expected: only the untracked/modified files you intended
```

---

### Task 2: Gate probe — a settled candidate stops forcing a review

**Files:**
- Modify: `src/cli/commands/gate.ts:405-433` (the probe and the two skip exits), plus the import from `../../config/control-plane.ts`
- Test: `tests/integration/control-plane-gate.test.ts`

**Interfaces:**
- Consumes: `renderPendingPolicyNotice(repoRoot, approvedFingerprint)` from Task 1.
- Produces: `skip-clean` and `skip-escalated` stderr now end with the pending-policy notice when a non-invalid candidate is pending.

- [ ] **Step 1: Add the call-counting reviewer stub**

In `tests/integration/control-plane-gate.test.ts`, after the existing `cleanReviewer()` helper:

```ts
// A clean reviewer that records how many times the panel actually ran. The point
// of slice 3 is that a settled candidate stops re-reviewing an unchanged tree —
// asserting only "the turn was allowed" would NOT catch a regression that keeps
// paying for a full panel run on every stop.
function countingCleanReviewer(): ProviderAdapter & { calls: number } {
  const adapter = {
    calls: 0,
    id: "codex",
    async preflight() {
      return { available: true, version: "stub", authMode: "oauth" as const, error: null };
    },
    async review(input: Parameters<ProviderAdapter["review"]>[0]): Promise<ReviewResult> {
      adapter.calls += 1;
      return {
        reviewerId: input.reviewerId,
        verdict: "PASS",
        findings: [],
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
        durationMs: 1,
        exitCode: 0,
        rawEventsPath: "",
        status: "ok",
      };
    },
  };
  return adapter;
}
```

- [ ] **Step 2: Write the failing test**

Append inside `describe("control-plane gate integration", …)`:

```ts
  it("stops re-reviewing an unchanged tree once the candidate has passed under the LKG", async () => {
    const repo = await repoWithApprovedPolicy("allow");
    writeFileSync(join(repo, "a.ts"), "export const a = 7;\n");
    writePolicy(repo, "allow", "candidate-model");
    await runGate({
      repoRoot: repo,
      hook: "trigger",
      hookStdinRaw: JSON.stringify({
        tool_name: "Edit",
        tool_input: { file_path: join(repo, "a.ts") },
      }),
    });
    const reviewer = countingCleanReviewer();
    const first = await runGate({
      repoRoot: repo,
      hook: "stop",
      snapshotVerifyOpts: { dwellMs: 0 },
      hookStdinRaw: "{}",
      providerOverrides: { codex: reviewer },
      sandboxModeOverride: "off",
    });
    expect((JSON.parse(first.stdout || "{}") as { decision?: string }).decision).toBe("block");
    expect(reviewer.calls).toBe(1);

    // Second stop, nothing changed: the candidate is settled, so the gate must NOT
    // force another full panel run on something the agent cannot resolve.
    const second = await runGate({
      repoRoot: repo,
      hook: "stop",
      snapshotVerifyOpts: { dwellMs: 0 },
      hookStdinRaw: "{}",
      providerOverrides: { codex: reviewer },
      sandboxModeOverride: "off",
    });
    expect(second.stderr).toContain("No code changes since last review");
    expect(second.stderr).toContain("pending human approval");
    expect(reviewer.calls).toBe(1);
  }, 30_000);
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test tests/integration/control-plane-gate.test.ts -t "stops re-reviewing"`
Expected: FAIL, but **not** on `reviewer.calls` — the second stop's diff is unchanged, so
`Orchestrator.runIteration()`'s cache-hit branch serves the cached PASS without calling
`reviewer.review()` again, and `reviewer.calls` stays at `1` on this buggy path too.
The failure is on `expect(second.stderr).toContain("No code changes since last review")`:
`policy?.change` still forces `probe = "review"` on every stop, so the `skip-clean` fast
exit in `gate.ts` is unreachable and the stderr instead reads a full-pass message
(`"🟢 Reviewgate · GATE OPEN — PASS (iteration 1) · ⚠ PRELIMINARY …"`).

- [ ] **Step 4: Import the renderer**

In `src/cli/commands/gate.ts`, add `renderPendingPolicyNotice` to the existing named import block from `../../config/control-plane.ts` (the one that already brings in `finalizeControlPlaneReview` at line 9), keeping the entries alphabetically ordered as biome expects.

- [ ] **Step 5: Relax the probe and thread the notice into both skip exits**

Replace `src/cli/commands/gate.ts:413` (`const probe = policy?.change ? "review" : await stopProbe(input.repoRoot);`) and the two `if (probe === …)` return bodies that follow with:

```ts
  // Slice 3: a candidate that has ALREADY passed under the LKG no longer forces a
  // review on every stop. Only a human TTY `reviewgate config approve` can clear
  // it, so re-running the panel on an unchanged tree every turn burns the agent's
  // turns on something it cannot resolve. An `invalid` candidate keeps forcing
  // forever — that one the agent CAN fix, so it must stay fail-closed.
  const policyForcesReview =
    policy?.change != null &&
    (policy.change.classification === "invalid" || policy.change.reviewed_under_lkg_at === null);
  const probe = policyForcesReview ? "review" : await stopProbe(input.repoRoot);
  // Keep a settled candidate visible on the exits that never reach the block/allow
  // messages below. Suppressed for `invalid` — "pending human approval" would be
  // the wrong story for a config that simply does not parse.
  const pendingPolicyNotice =
    policy?.change != null && policy.change.classification !== "invalid"
      ? ` ${renderPendingPolicyNotice(input.repoRoot, policy.approvedEffectiveFingerprint)}`
      : "";
  if (probe === "skip-clean") {
    return {
      exitCode: 0,
      stdout: "",
      stderr: `🟢 Reviewgate · GATE OPEN — No code changes since last review.${pendingPolicyNotice}`,
    };
  }
  if (probe === "skip-escalated") {
    // stopProbe's escalated standing-down branch (escalated + HEAD/tree unmoved
    // since the announce) PRODUCES this value; mapped here — never silently
    // falls through to the green message.
    return {
      exitCode: 0,
      stdout: "",
      stderr: `🟠 Reviewgate · GATE STANDING DOWN — an escalation is pending human review (.reviewgate/ESCALATION.md). The escalated change-set has NOT been machine-reviewed; new work will re-arm the gate.${pendingPolicyNotice}`,
    };
  }
```

- [ ] **Step 6: Run the test to verify it passes**

Run:
```bash
bun test tests/integration/control-plane-gate.test.ts
bunx tsc --noEmit
bun run lint
```
Expected: all 5 tests in the file pass (the 4 pre-existing ones must be untouched and green), `tsc` and lint clean.

- [ ] **Step 7: Commit**

```bash
git add src/cli/commands/gate.ts tests/integration/control-plane-gate.test.ts
git commit -m "fix(gate): stop force-reviewing a policy candidate that already passed

A pending candidate forced probe=review on every stop, so the skip-clean fast
exit was unreachable and each idle turn paid a full panel run for a verdict
nothing had changed. Force it only while the candidate is unreviewed or invalid,
and carry a quiet pending notice on the two skip exits."
```

- [ ] **Step 8: Mutation-check (worktree copy, procedure from Task 1 Step 8)**

Worktree name `<SCRATCH>/mut-task2`. Mutation: restore
`const probe = policy?.change ? "review" : await stopProbe(input.repoRoot);`.
Run `bun test tests/integration/control-plane-gate.test.ts -t "stops re-reviewing"`.
Expected: **RED** on `expect(reviewer.calls).toBe(1)`. Remove the worktree, confirm `git status`.

---

### Task 3: Gate decision — block only on the first notice

**Files:**
- Modify: `src/cli/commands/gate.ts:1143-1186` (the `allow_stop` policy handling), `:1108-1141` (a clarifying comment only)
- Test: `tests/integration/control-plane-gate.test.ts`

**Interfaces:**
- Consumes: `alreadyNotified` from Task 1; the relaxed probe from Task 2.
- Produces: no new exports. Behavioural contract: `approval-required` blocks only when `alreadyNotified === false`.

- [ ] **Step 1: Write the failing tests**

Append inside `describe("control-plane gate integration", …)`:

```ts
  it("blocks once per candidate, then allows later passing turns with a quiet notice", async () => {
    const repo = await repoWithApprovedPolicy("allow");
    writeFileSync(join(repo, "a.ts"), "export const a = 11;\n");
    writePolicy(repo, "allow", "candidate-model");
    const trigger = (file: string) =>
      runGate({
        repoRoot: repo,
        hook: "trigger",
        hookStdinRaw: JSON.stringify({ tool_name: "Edit", tool_input: { file_path: file } }),
      });
    const stop = (reviewer: ProviderAdapter) =>
      runGate({
        repoRoot: repo,
        hook: "stop",
        snapshotVerifyOpts: { dwellMs: 0 },
        hookStdinRaw: "{}",
        providerOverrides: { codex: reviewer },
        sandboxModeOverride: "off",
      });

    await trigger(join(repo, "a.ts"));
    const reviewer = countingCleanReviewer();
    const first = await stop(reviewer);
    expect((JSON.parse(first.stdout || "{}") as { decision?: string }).decision).toBe("block");
    expect(first.stderr).toContain("GATE POLICY CHANGED");

    // New code, still nothing the agent can do about the candidate: the panel runs
    // and the turn is ALLOWED, with the candidate merely annotated.
    writeFileSync(join(repo, "a.ts"), "export const a = 12;\n");
    await trigger(join(repo, "a.ts"));
    const second = await stop(reviewer);
    expect(second.stdout).toBe("");
    expect(second.stderr).toContain("pending human approval");
    expect(second.stderr).not.toContain("GATE POLICY CHANGED");
    expect(reviewer.calls).toBe(2);
  }, 30_000);

  it("does not re-block an agent on a settled candidate even with acknowledgePass", async () => {
    // The FlashBuddy field bug: acknowledgePass + a pending house-rule candidate
    // re-blocked every single turn, and `config approve` is TTY-only.
    const repo = await repoWithApprovedPolicy("allow", { acknowledgePass: true });
    writeFileSync(join(repo, "a.ts"), "export const a = 13;\n");
    writePolicy(repo, "allow", "candidate-model", { acknowledgePass: true });
    await runGate({
      repoRoot: repo,
      hook: "trigger",
      hookStdinRaw: JSON.stringify({
        tool_name: "Edit",
        tool_input: { file_path: join(repo, "a.ts") },
      }),
    });
    const stop = () =>
      runGate({
        repoRoot: repo,
        hook: "stop",
        snapshotVerifyOpts: { dwellMs: 0 },
        hookStdinRaw: "{}",
        providerOverrides: { codex: cleanReviewer() },
        sandboxModeOverride: "off",
      });
    const first = await stop();
    expect((JSON.parse(first.stdout || "{}") as { decision?: string }).decision).toBe("block");
    const second = await stop();
    expect(second.stdout).toBe("");
    expect(second.stderr).toContain("pending human approval");
  }, 30_000);

  it("keeps blocking every stop while the config is invalid", async () => {
    const repo = await repoWithApprovedPolicy("allow");
    writeFileSync(join(repo, "reviewgate.config.ts"), "export default { not: valid ts ;\n");
    const stop = () =>
      runGate({
        repoRoot: repo,
        hook: "stop",
        snapshotVerifyOpts: { dwellMs: 0 },
        hookStdinRaw: "{}",
        providerOverrides: { codex: cleanReviewer() },
        sandboxModeOverride: "off",
      });
    for (const _ of [1, 2]) {
      const out = await stop();
      expect((JSON.parse(out.stdout || "{}") as { decision?: string }).decision).toBe("block");
      expect(out.stderr).toContain("GATE POLICY INVALID");
    }
    const control = JSON.parse(
      readFileSync(join(repo, ".reviewgate", "control-plane.json"), "utf8"),
    ) as { pending?: { reviewed_under_lkg_at: string | null } };
    expect(control.pending?.reviewed_under_lkg_at).toBeNull();
  }, 30_000);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/integration/control-plane-gate.test.ts -t "blocks once per candidate"`
Expected: FAIL — `second.stdout` is a `{"decision":"block"}` payload, not `""`, because `approval-required` is still converted into a block unconditionally.

Run: `bun test tests/integration/control-plane-gate.test.ts -t "does not re-block an agent"`
Expected: **PASS even before this task's fix** — its second stop is idle (no code change), so it takes
Task 2's `skip-clean` exit in `gate.ts` before the request ever reaches this task's `allow_stop`
code. It exercises the original field bug end-to-end but is not a red/green guard for *this*
task's change; only the "blocks once per candidate" test above is.

(The "keeps blocking every stop while the config is invalid" test should already PASS — it is a regression guard for behaviour Task 2 and Task 3 must not break. Note it as green now and re-run it after Step 3.)

- [ ] **Step 3: Block only on the first notice**

In `src/cli/commands/gate.ts`, replace the `finalized` handling in the `allow_stop` path (currently lines 1167-1181):

```ts
    if (
      finalized.kind === "invalid" ||
      finalized.kind === "changed-during-review" ||
      (finalized.kind === "approval-required" && !finalized.alreadyNotified)
    ) {
      if (cfg.notify.desktop) notifyDesktop("Reviewgate", finalized.message);
      return {
        exitCode: 0,
        stdout: JSON.stringify({ decision: "block", reason: finalized.message }),
        stderr: finalized.message,
      };
    }
    if (finalized.kind === "approval-required") {
      // Slice 3: the human was already told once, in a blocked turn, and the
      // candidate is unchanged since. Keep it visible but never spend another of
      // the agent's turns on it — `reviewgate config approve` is TTY-only, so the
      // agent has no way to clear this and would just re-block forever.
      signal = `${decision.reason}\n${finalized.message}`;
    }
    if (finalized.kind === "auto-approved") {
      signal = `${decision.reason}\n🔐 Gate policy ${finalized.classification === "strengthening" ? "strengthening" : "source-equivalent change"} adopted after this pass under the prior approved policy.`;
    }
```

- [ ] **Step 4: Record why the block path keeps its own text**

In the block path, immediately above the `} else {` at line 1130, add:

```ts
        // NOTE: the else branch below deliberately keeps its own wording and does
        // NOT use renderPendingPolicyNotice — it is reached when the run did not
        // complete cleanly (policyReviewPassed !== true), which is a different
        // story from a settled candidate waiting on a human.
```

Nothing else on the block path changes: the reason is still composed as
`${decision.reason}${policyNotice}` at line 1134, so the driver's own explanation
always precedes the notice and the block is never unexplained.

- [ ] **Step 5: Run the tests to verify they pass**

Run:
```bash
bun test tests/integration/control-plane-gate.test.ts
bunx tsc --noEmit
bun run lint
```
Expected: all 8 tests in the file pass, including the 4 pre-existing ones — in particular `:233` ("never treats an infrastructure defer as a successful LKG policy review"), which proves a non-PASS run still blocks with "GATE POLICY PENDING" and leaves the marker `null`.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/gate.ts tests/integration/control-plane-gate.test.ts
git commit -m "fix(gate): block once per policy candidate instead of every turn

An approval-required candidate was converted into a block on every completed
pass, so an agent that edited reviewgate.config.ts re-blocked forever on a TTY-only
approval it cannot run. Block on the first notice, annotate afterwards. Invalid
and changed-during-review candidates keep blocking unchanged."
```

- [ ] **Step 7: Mutation-check (worktree copy, procedure from Task 1 Step 8)**

Worktree `<SCRATCH>/mut-task3`. Mutation: change the guard back to
`if (finalized.kind === "approval-required" || finalized.kind === "invalid" || finalized.kind === "changed-during-review")`.
Run `bun test tests/integration/control-plane-gate.test.ts`.
Expected: **RED** on both new tests. Remove the worktree, confirm `git status`.

---

### Task 4: Correct the now-false doctor claim, docs, and full verification

**Files:**
- Modify: `src/cli/commands/doctor.ts:126-141`, `CLAUDE.md`
- Test: `tests/unit/doctor-acknowledgepass.test.ts` (must stay green unmodified)

**Interfaces:**
- Consumes: the behaviour from Tasks 1-3.
- Produces: nothing consumed by other tasks.

- [ ] **Step 1: Fix the doctor warning**

`src/cli/commands/doctor.ts:138` currently claims a pending policy candidate makes acknowledgePass "re-nag every turn" and that "the loop never clears itself". After Tasks 1-3 that is false. Replace the comment at lines 126-131 and the `detail` string:

```ts
// loop.acknowledgePass turns every clean PASS into a one-time block so the agent
// is TOLD the review passed. Still not the recommended setting: with an actively-
// editing agent it costs a turn on every clean round. Since slice 3 a pending
// policy candidate no longer compounds it (the approval notice blocks once per
// candidate, then only annotates), but notify.desktop remains the loop-safe way
// to surface a pass. Advisory (warn), never a hard fail. Returns null when off
// (the default). (FlashBuddy field bug.)
```

```ts
    detail:
      "acknowledgePass blocks every clean PASS for the agent to acknowledge — one extra turn per clean round, and with an actively-editing agent that is every turn. A pending policy candidate awaiting `reviewgate config approve` no longer compounds it (the notice blocks once per candidate, then only annotates), but notify.desktop reaches you without spending a turn.",
```

The existing test asserts `detail` contains `"config approve"` and `hint` contains `"notify.desktop"` — both still hold, so `tests/unit/doctor-acknowledgepass.test.ts` must pass **unmodified**. If it fails, the replacement text is wrong, not the test.

- [ ] **Step 2: Run the doctor test**

Run: `bun test tests/unit/doctor-acknowledgepass.test.ts`
Expected: both tests PASS, with no edit to the test file.

- [ ] **Step 3: Update `CLAUDE.md`**

In the `src/config/` bullet under "Architecture map", replace the clause
`and weakening/non-monotonic changes need TTY-only `reviewgate config approve``
with:

```
and weakening/non-monotonic changes need TTY-only `reviewgate config approve` — which blocks the agent exactly ONCE per candidate and then only annotates later gate messages, since no agent can run that approval
```

- [ ] **Step 4: Full verification**

Run, in order, and read the output rather than assuming:
```bash
bunx tsc --noEmit
bun run lint
bun test
```
Expected: `tsc` clean; lint clean; the suite at **2950 total / 0 fail** (2944 baseline total + 6 new tests) — 2935 pass / 15 skip on a clean worktree, or 2938 pass / 12 skip with `dist/reviewgate` present (see the baseline note above; same total either way). If the **total** differs from baseline+6, find out why before continuing — a silently skipped test is a failed gate.

- [ ] **Step 5: Remove plan-gate scratch and commit**

```bash
rm -rf .review/
git add src/cli/commands/doctor.ts CLAUDE.md docs/superpowers/specs/2026-07-25-agent-safe-policy-candidate-design.md docs/superpowers/plans/2026-07-25-agent-safe-policy-candidate.md
git commit -m "docs: correct the acknowledgePass warning and record the slice-3 design

The doctor warning claimed a pending policy candidate makes acknowledgePass
re-nag every turn and that the loop never clears itself. Both are now false."
```

- [ ] **Step 6: Report, do not push**

Report to Markus: the suite count, the four commits, and that nothing was pushed and no binary was built. Pushing and `bun run build` both require his explicit go-ahead.

---

## Self-Review

**Spec coverage:** Change 1 → Task 1 (Steps 3-5). Change 2 → Task 2 (Step 5). Change 3 → Task 3 (Steps 3-4). Change 4 → Task 1 Step 3 (the renderer) + Task 2 Step 5 (skip-clean, skip-escalated) + Task 3 Step 3 (allow_stop) + the existing `policyNotice` composition on the block path (unchanged, Task 3 Step 4). Spec tests 1-8: test 1 → Task 3 test "blocks once per candidate"; test 2 → Task 2 test (with the `reviewer.calls` assertion); test 3 → Task 3 test "blocks once per candidate", second half; test 4 → Task 1 test "re-arms the one-time notice"; test 5 → Task 3 test "does not re-block an agent"; test 6 → Task 3 test "keeps blocking every stop while the config is invalid"; test 7 → Task 1 test "once per candidate"; test 8 → Task 1 test "once per candidate", the `approveControlPlane` tail. Invariant 3 is covered by the pre-existing test at `control-plane-gate.test.ts:233`, which Task 3 Step 5 explicitly re-runs.

**Placeholder scan:** No TBD/TODO. Every code step carries the actual code. Every test step carries the actual test body. `<SCRATCH>` is the one intentional substitution and is defined at first use.

**Type consistency:** `renderPendingPolicyNotice(repoRoot: string, approvedFingerprint: string): string` is defined in Task 1 Step 3 and called with exactly two arguments in Task 1 Step 5 (`repoRoot`, `state.approved_effective_fingerprint`) and Task 2 Step 5 (`input.repoRoot`, `policy.approvedEffectiveFingerprint`) — both `string`. `alreadyNotified` is spelled identically in Tasks 1 and 3. `countingCleanReviewer()` is defined in Task 2 Step 1 and reused in Task 3 Step 1.
