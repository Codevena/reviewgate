# S2 — Arming Probe in Gate Entry: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the gate an explicit `armed()` probe so that a hook-invoked gate in an unarmed checkout allow-stops with zero writes — no `.reviewgate/` creation, no state, no panel, no `checks.commands` — while a checkout whose approved state was deleted keeps blocking.

**Architecture:** One new exported probe in `src/config/control-plane.ts` returns a four-valued arming decision derived from three already-computed signals (LKG presence, managed-hook presence, project-config presence). `src/cli/commands/gate.ts` calls it **once, at the top of `runGate`**, governing all three hooks (`stop`, `trigger`, `reset`) *before* anything that writes — `handleTrigger`'s `dirty.flag`, `handleReset`'s session state, and `resolveControlPlaneConfig`'s auto-baseline alike — and returns early for the two unarmed-allow cases. The probe is the single seam S3 later extends with the worktree-inheritance branch — no other call site changes.

**Tech Stack:** Bun, TypeScript, zod, `bun test`. No new dependencies.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-17-arming-consent-design.md`, slice **S2**, consent model **A**.
- **`gateEverywhere` is OUT of scope this pass** (spec §7.2, §8): `armed()` has exactly two true-branches — approved LKG for this checkout, or (S3, later) worktree-inherited. No new global-config field, no zod addition.
- **Zero writes when unarmed** (spec §4): no `state.json`, no `control-plane.json`, no `.reviewgate/` directory creation, no `dirty.flag`, no audit append.
- **Deletion must not disarm** (control-plane.ts:350-352): managed hook present + no LKG must keep throwing `ControlPlaneBootstrapRequiredError`. S2 must NOT convert that into an allow.
- **The `input.loadConfigFn` test seam bypasses the control plane by design** (gate.ts:334-336), so the probe is skipped when it is set. That seam is test-only — the real CLI never supplies it — so it is NOT a production bypass. It is also NOT sufficient on its own: ~15 test files use no seam and no state, which is why Task 0 exists.
- Runtime is Bun: `bun test`, `bunx tsc --noEmit`, `bun run lint` (biome) must all be clean.
- Never `git add -A` in this repo (stages `.reviewgate/` runtime state). Stage explicit paths.

---

## File Structure

- **Modify `src/config/control-plane.ts`** — add `ArmingProbe` type + exported `probeArming()`. Owns the arming *decision*; already owns `readState`, `managedHookExists`, `inspectConfigSources`. This keeps the whole trust rule in one module and gives S3 exactly one place to add its branch.
- **Modify `src/cli/commands/gate.ts`** — call the probe and act on it. Owns the *behavior* (early return, notice text, exit codes).
- **Test `tests/unit/control-plane-arming.test.ts`** (new) — the probe matrix, pure and fast.
- **Test `tests/unit/gate-arming-probe.test.ts`** (new) — end-to-end gate behavior + the zero-writes assertion.

---

### Task 0: Arm the existing gate tests (must land FIRST)

**Files:**
- Create: `tests/helpers/arm.ts`
- Modify: the gate tests that call `runGate`/`runGateSafe` on a bare temp checkout

**Why this task exists (plan-gate round 1, CRITICAL #3):** ~15 test files call
`runGate`/`runGateSafe` without the `loadConfigFn` seam and set up **no** control-plane
state at all — verified: `gate-defer`, `gate-lock`, `gate-fail-closed`, `gate-skip-lock`
have zero `bootstrapControlPlane`/`writeState`/`control-plane.json` hits. They encode
today's behavior, in which the gate fully services an unarmed checkout. Every one of them
breaks the moment the probe lands. Arming them FIRST keeps the suite green throughout and
makes the probe's own tests the only place unarmed behavior is asserted.

**Interfaces:**
- Produces: `export async function armCheckout(cwd: string): Promise<void>` — used by Tasks 1–3 and by the updated existing tests.

- [ ] **Step 1: Write the helper**

```ts
// tests/helpers/arm.ts
import { homedir } from "node:os";
import { bootstrapControlPlane } from "../../src/config/control-plane";

// Create a REAL, schema-valid approved baseline for `cwd`.
//
// Two traps this helper exists to avoid:
//
// 1. Hand-written control-plane.json fixtures: approved_source_fingerprint /
//    approved_effective_fingerprint are `z.string().min(64).max(64)` and
//    approved_config is the full ConfigSchema, so a short-string fixture fails
//    to parse, readState returns null, and the test silently exercises the
//    UNARMED path while looking green (plan-gate round 1, CRITICAL #1).
//
// 2. Mismatched config context: `runGate` resolves the control plane with
//    `process.env` and `homedir()`. Arming with a FAKE home (e.g. <cwd>/home)
//    bootstraps the LKG from defaults only, and on any machine that has a
//    global ~/.config/reviewgate/reviewgate.config.ts the very next runGate call
//    sees a different effective config → an `approval-required` candidate →
//    the forced review path → unrelated assertions break. This machine HAS such
//    a global config, and the spec already recorded this exact failure mode for
//    S1 (spec §S1, "forced by the failing gate tests on a machine that has a
//    global config"). The helper MUST use the same inputs runGate uses
//    (plan-gate round 2, CRITICAL #2).
export async function armCheckout(cwd: string): Promise<void> {
  await bootstrapControlPlane({
    cwd,
    env: process.env as Record<string, string | undefined>,
    home: homedir(),
    approvedVia: "init",
  });
}
```

- [ ] **Step 2: Find every affected file**

**Audit per CALL SITE, never per file** (plan-gate round 2, CRITICAL #1). A file-level
`grep -q loadConfigFn` filter is wrong: `tests/unit/codex-host-protocol.test.ts` has four
`runGate`/`runGateSafe` call sites — trigger (~line 31), stop (~line 44), reset (~line 64)
— and **only the reset one** passes `loadConfigFn`. A file-level filter skips the whole
file, leaving its trigger and stop checkouts unarmed, and their `dirty.flag` assertions
fail once the probe lands.

```bash
# List every call site with its line number, then judge each one individually.
grep -rn "runGate\|runGateSafe" tests/ | grep -v "^tests/helpers/"
```

For each call site ask, in this order:
1. Is it `runGateSafe(input, customRun)` with an **injected second `run` argument**? → skip
   it. Those never reach `runGate` or the control plane at all (e.g. `gate-fail-closed.test.ts`,
   the synthetic-error call in `codex-host-protocol.test.ts`); arming them is dead work and
   writes state into throwaway paths like `/tmp/nope` that several cases share
   (plan-gate round 3, INFO #2).
2. Does **this call** pass `loadConfigFn`? → skip it (seam bypasses the control plane).
3. Does its checkout come from `runInit` (or another path that writes an LKG)? → already
   armed, skip it.
4. Otherwise → `await armCheckout(<that call's repo path>)` before it.

Do not assume two call sites in one file share a checkout — several tests create a fresh
temp repo per case.

- [ ] **Step 3: Arm each affected checkout**

In every affected file, after the temp repo is created and before the first
`runGate`/`runGateSafe` call:

```ts
import { armCheckout } from "../helpers/arm";
// …
await armCheckout(repoRoot);
```

Use the file's existing variable name for the repo path. Do NOT change any assertion —
if an assertion has to change, that file was testing unarmed behavior on purpose and
belongs in the discussion, not in a silent edit.

- [ ] **Step 4: Verify the suite is still green BEFORE the probe exists**

Run: `bun test`
Expected: 0 fail. This proves arming is behavior-neutral today — so any failure after
Task 2 is caused by the probe, not by this task.

- [ ] **Step 5: Commit**

```bash
git add tests/helpers/arm.ts tests/unit tests/integration
git commit -m "test: arm the gate tests' checkouts before the S2 probe lands"
```

---

### Task 1: The arming probe

**Files:**
- Modify: `src/config/control-plane.ts` (add after `managedHookExists`, ~line 338)
- Test: `tests/unit/control-plane-arming.test.ts` (create)

**Interfaces:**
- Consumes: existing module-private `readState(repoRoot)`, `managedHookExists(repoRoot)`, `inspectConfigSources(input)`.
- Produces: `export type ArmingProbe` and `export async function probeArming(input: EffectiveConfigInput): Promise<ArmingProbe>` — Task 2 consumes both.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/control-plane-arming.test.ts
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeArming } from "../../src/config/control-plane";

function repo(): string {
  return mkdtempSync(join(tmpdir(), "rg-arming-"));
}
function input(cwd: string) {
  return { cwd, env: {} as Record<string, string | undefined>, home: join(cwd, "home") };
}

describe("probeArming", () => {
  test("approved LKG present → armed, even with a managed hook present", async () => {
    const cwd = repo();
    // A managed hook is added deliberately: without it, reordering the two checks
    // inside probeArming would still yield {armed:true} and the Step 5 mutation
    // would not go red (plan-gate round 1, CRITICAL #1).
    mkdirSync(join(cwd, ".reviewgate", "bin"), { recursive: true });
    writeFileSync(join(cwd, ".reviewgate", "bin", "gate"), "#!/bin/sh\n");
    await armCheckout(cwd); // real, schema-valid LKG — never hand-write this JSON
    expect(await probeArming(input(cwd))).toEqual({ armed: true });
  });

  test("managed hook but no LKG → state-missing (must keep blocking)", async () => {
    const cwd = repo();
    mkdirSync(join(cwd, ".reviewgate", "bin"), { recursive: true });
    writeFileSync(join(cwd, ".reviewgate", "bin", "gate"), "#!/bin/sh\n");
    expect(await probeArming(input(cwd))).toEqual({ armed: false, kind: "state-missing" });
  });

  test("project config, no hook, no LKG → unarmed-with-config", async () => {
    const cwd = repo();
    writeFileSync(join(cwd, "reviewgate.config.ts"), "export default {};\n");
    expect(await probeArming(input(cwd))).toEqual({ armed: false, kind: "unarmed-with-config" });
  });

  test("bare tree → unarmed-bare", async () => {
    expect(await probeArming(input(repo()))).toEqual({ armed: false, kind: "unarmed-bare" });
  });

  test("probe never creates .reviewgate/", async () => {
    const cwd = repo();
    writeFileSync(join(cwd, "reviewgate.config.ts"), "export default {};\n");
    await probeArming(input(cwd));
    expect(existsSync(join(cwd, ".reviewgate"))).toBe(false);
  });
});
```

Add `existsSync` to the `node:fs` import line.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/control-plane-arming.test.ts`
Expected: FAIL — `probeArming` is not exported from `src/config/control-plane.ts`.

- [ ] **Step 3: Write minimal implementation**

In `src/config/control-plane.ts`, directly after `managedHookExists` (~line 338):

```ts
// S2 arming probe. `armed` answers exactly one question: may this checkout run the
// gate's writing/reviewing machinery at all? It is derived, never persisted — the
// probe itself must not create `.reviewgate/` (that is the whole point of the
// zero-writes guarantee), so it only READS.
//
// The three unarmed kinds are NOT interchangeable:
//   - "state-missing": a managed hook proves `init` armed this checkout, so a
//     missing LKG means the approval was DELETED. That must keep blocking —
//     otherwise `rm .reviewgate/control-plane.json` is a gate bypass.
//   - "unarmed-with-config": a fresh clone / worktree carrying a committed policy
//     nobody approved here. Allow-stop, but say so LOUDLY.
//   - "unarmed-bare": no policy, no hook. A user-scoped hook (S4) must be
//     invisible in random repos, so this one is silent.
//
// S3 extends ONLY this function with the worktree-inheritance branch.
export type ArmingProbe =
  | { armed: true }
  | { armed: false; kind: "state-missing" | "unarmed-with-config" | "unarmed-bare" };

export async function probeArming(input: EffectiveConfigInput): Promise<ArmingProbe> {
  if (readState(input.cwd)) return { armed: true };
  if (managedHookExists(input.cwd)) return { armed: false, kind: "state-missing" };
  const source = inspectConfigSources(input);
  return {
    armed: false,
    kind: source.hasProjectSource ? "unarmed-with-config" : "unarmed-bare",
  };
}
```

`probeArming` is `async` because `inspectConfigSources` may be; if it is synchronous in this tree, keep the `async` signature anyway so S3 can add an `await`ed git call without changing every call site.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/control-plane-arming.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Mutation-check the two load-bearing guards**

In a **copy** of the repo (`cp -r . /tmp/mut-s2-t1`, never in place):
1. Swap the order so `managedHookExists` is checked before `readState` → the "approved LKG present" test must go RED.
2. Change `kind: "state-missing"` to `"unarmed-with-config"` → the managed-hook test must go RED.
Discard the copy; confirm `git diff` in the real repo is unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/config/control-plane.ts tests/unit/control-plane-arming.test.ts
git commit -m "feat(control-plane): add the S2 arming probe"
```

---

### Task 2: Gate honours the probe on the stop path

**Files:**
- Modify: `src/cli/commands/gate.ts` (insert after the `trigger` early-return at line 322, before the config-load block at line 337)
- Test: `tests/unit/gate-arming-probe.test.ts` (create)

**Interfaces:**
- Consumes: `probeArming`, `ArmingProbe` from Task 1.
- Produces: no new exports; changes `runGate`'s observable behavior for unarmed checkouts.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/gate-arming-probe.test.ts
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGate } from "../../src/cli/commands/gate";

function repo(): string {
  return mkdtempSync(join(tmpdir(), "rg-gate-arming-"));
}

describe("gate arming probe (S2)", () => {
  test("unarmed with a project config → allow-stop, loud notice, ZERO writes", async () => {
    const cwd = repo();
    writeFileSync(join(cwd, "reviewgate.config.ts"), "export default {};\n");
    const out = await runGate({ hook: "stop", repoRoot: cwd, hookStdinRaw: "" });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe("");            // no block decision
    expect(out.stderr).toContain("config approve");
    expect(existsSync(join(cwd, ".reviewgate"))).toBe(false);
  });

  test("unarmed bare tree → allow-stop, SILENT, zero writes", async () => {
    const cwd = repo();
    const out = await runGate({ hook: "stop", repoRoot: cwd, hookStdinRaw: "" });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe("");
    expect(out.stderr).toBe("");
    expect(existsSync(join(cwd, ".reviewgate"))).toBe(false);
  });
});
```

`GateInput` may require more fields than shown — copy the minimal literal used by the existing stop-path tests in `tests/unit/gate*.test.ts` rather than inventing fields.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/gate-arming-probe.test.ts`
Expected: FAIL — today the project-config case throws `ControlPlaneBootstrapRequiredError`, so `runGate` rejects (and via `runGateSafe` would emit a `decision:"block"`); the bare case creates `.reviewgate/` via `bootstrapControlPlane`.

- [ ] **Step 3: Write minimal implementation**

Place the probe at the **very top of `runGate`, before the `trigger` branch** (i.e. before
today's line 319), so a single call governs all three hooks. `trigger` writes `dirty.flag`,
`reset` writes session state, `stop` writes everything — all three are hook invocations, and
spec §4's zero-writes rule is stated for *the hook-invoked gate*, not for the stop path
alone. One probe, one rule, no half-guarantee for S4 to reopen:

```ts
  // S2: probe arming BEFORE anything that writes. `resolveControlPlaneConfig` can
  // auto-baseline (bootstrapControlPlane → mkdir .reviewgate/ + writeState), and the
  // panel/`checks.commands` run under a policy nobody approved here. An unarmed
  // checkout must therefore be answered from a pure READ.
  //
  // Skipped when `loadConfigFn` is injected: that seam deliberately bypasses the
  // control plane for tests, so probing would fail every test that uses it.
  if (!input.loadConfigFn) {
    const arming = await probeArming({
      cwd: input.repoRoot,
      env: process.env as Record<string, string | undefined>,
      home: homedir(),
    });
    // "state-missing" deliberately falls through to the normal path, where
    // resolveControlPlaneConfig throws ControlPlaneBootstrapRequiredError and
    // runGateSafe turns it into a fail-closed block. Deleting the approval must
    // NOT be a way to disarm the gate.
    if (!arming.armed && arming.kind !== "state-missing") {
      // The notice belongs on `stop` only. A PostToolUse/SessionStart hook printing
      // it would repeat it on every tool call and every session start in every
      // unarmed repo — under S4's user-scoped hooks that is most repos.
      const stderr =
        input.hook === "stop" && arming.kind === "unarmed-with-config"
          ? "🟠 Reviewgate · NOT ARMED here — this checkout ships a committed Reviewgate policy (reviewgate.config.ts) that has not been approved in this checkout, so the gate did NOT review this turn. Run `reviewgate config approve` in an interactive terminal (or `reviewgate init`) to arm it."
          : "";
      return { exitCode: 0, stdout: "", stderr };
    }
  }
```

Add `probeArming` to the existing `src/config/control-plane` import in `gate.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/gate-arming-probe.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Prove the deletion case still blocks**

Add to the same test file:

```ts
  test("managed hook + deleted LKG → still fail-closed block", async () => {
    const cwd = repo();
    mkdirSync(join(cwd, ".reviewgate", "bin"), { recursive: true });
    writeFileSync(join(cwd, ".reviewgate", "bin", "gate"), "#!/bin/sh\n");
    const out = await runGateSafe({ hook: "stop", repoRoot: cwd, hookStdinRaw: "" });
    expect(JSON.parse(out.stdout).decision).toBe("block");
  });
```

Import `runGateSafe` and `mkdirSync`. Run: `bun test tests/unit/gate-arming-probe.test.ts` → PASS (3 tests).

- [ ] **Step 5b: Prove `reset` is governed too**

```ts
  test("unarmed reset writes nothing", async () => {
    const cwd = repo();
    const out = await runGate({ hook: "reset", repoRoot: cwd, hookStdinRaw: "" });
    expect(out.exitCode).toBe(0);
    expect(existsSync(join(cwd, ".reviewgate"))).toBe(false);
  });
```

Run: `bun test tests/unit/gate-arming-probe.test.ts` → PASS (4 tests).

- [ ] **Step 6: Mutation-check the bypass guard**

In a **copy**: change the condition to `if (!arming.armed)` (i.e. let `state-missing` take the allow path). The deletion test from Step 5 must go RED. Discard the copy; `git diff` unchanged.

- [ ] **Step 7: Verify no dogfood regression**

Run: `bun test` (full suite). Expected: 0 fail. This repo is itself armed (an approved LKG exists), so the probe must return `{armed:true}` here and change nothing. If any existing gate test now fails, the `loadConfigFn` skip is wrong — fix that, do not weaken the probe.

- [ ] **Step 8: Commit**

```bash
git add src/cli/commands/gate.ts tests/unit/gate-arming-probe.test.ts
git commit -m "feat(gate): allow-stop with zero writes in an unarmed checkout (S2)"
```

---

### Task 3: Trigger path writes nothing when unarmed

**Files:**
- Modify: `src/cli/commands/gate.ts:319-322` (the `trigger` early return)
- Test: `tests/unit/gate-arming-probe.test.ts` (extend)

**Interfaces:**
- Consumes: `probeArming` from Task 1.
- Produces: nothing new.

**Why this task exists:** spec §4 says zero writes covers `.reviewgate/` creation, and `handleTrigger` writes `.reviewgate/dirty.flag` unconditionally. Within S1–S3 the PostToolUse hook only exists where `init` ran (armed), so this is preparation for S4 rather than a live bug — call that out to the reviewer rather than overselling it.

- [ ] **Step 1: Write the failing test**

```ts
  test("unarmed trigger writes nothing", async () => {
    const cwd = repo();
    writeFileSync(join(cwd, "reviewgate.config.ts"), "export default {};\n");
    const out = await runGate({ hook: "trigger", repoRoot: cwd, hookStdinRaw: "" });
    expect(out.exitCode).toBe(0);
    expect(existsSync(join(cwd, ".reviewgate"))).toBe(false);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/gate-arming-probe.test.ts -t "unarmed trigger"`
Expected: **PASS**, because Task 2's probe already covers `trigger`. To confirm the test is
not vacuous, temporarily move the probe back below the `trigger` branch in a **copy** of
the repo — the test must go RED there. Discard the copy. (If it stays green in the copy,
the test is asserting nothing: `.reviewgate/` is probably being created by the test's own
setup rather than by `handleTrigger`.)

- [ ] **Step 3: Write minimal implementation**

**No implementation change is needed.** Task 2 placed the single probe above the `trigger`
branch, so `trigger` and `reset` are already governed by it. This task exists to *prove*
that with tests, and to prove the two invariants the unified placement could plausibly
break (Steps 1 and 5). If the Step 1 test already passes after Task 2, record that — a
passing test written before its own step is fine here precisely because Task 2's probe is
the implementation; do NOT add a second probe call to make this task feel like work.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/gate-arming-probe.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Guard the config-edit signal**

The comment at gate.ts:316-318 warns that triggering must not depend on a *valid* config — the edit that makes `reviewgate.config.ts` invalid must still arm the control-plane flag. `probeArming` never parses the config for validity (it only asks `hasProjectSource`), so that invariant holds. Add a regression test:

```ts
  test("armed checkout still arms the control-plane flag on an INVALID config", async () => {
    const cwd = repo();
    await armCheckout(cwd);
    writeFileSync(join(cwd, "reviewgate.config.ts"), "this is not valid typescript {{{\n");
    // A real PostToolUse payload is REQUIRED: handleTrigger derives the edited path
    // from tool_input.file_path (handlers.ts:51-54). With an empty stdin it takes the
    // generic dirty.flag path and never arms the control-plane flag, so the assertion
    // would fail without testing anything (plan-gate round 1, CRITICAL #2).
    const payload = JSON.stringify({
      tool_name: "Edit",
      tool_input: { file_path: join(cwd, "reviewgate.config.ts") },
    });
    const out = await runGate({ hook: "trigger", repoRoot: cwd, hookStdinRaw: payload });
    expect(out.exitCode).toBe(0);
    expect(existsSync(controlPlaneFlagPath(cwd))).toBe(true);
  });
```

Import `controlPlaneFlagPath` from `../../src/utils/paths` (it resolves to
`.reviewgate/control-plane.flag`) rather than hard-coding the filename.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/gate.ts tests/unit/gate-arming-probe.test.ts
git commit -m "feat(gate): no trigger writes in an unarmed checkout (S2)"
```

---

### Task 4: Docs + doctor honesty

**Files:**
- Modify: `docs/AGENTS.md` (the "Worktrees (coverage limitation)" section, ~line 298)
- Modify: `CLAUDE.md` (the worktree gotcha bullet)
- Test: none (documentation)

- [ ] **Step 1: Describe the new unarmed behavior in `docs/AGENTS.md`**

Add under the worktree section:

```markdown
### Unarmed checkouts (S2)

A checkout is **armed** when an approved control-plane baseline exists for it
(`reviewgate init` or `reviewgate config approve` wrote one). A hook-invoked gate in
an UNARMED checkout does nothing and writes nothing:

- ships a `reviewgate.config.ts` nobody approved here → allow-stop with a loud
  `NOT ARMED here` notice naming `reviewgate config approve`;
- no policy at all → allow-stop, silent.

Deleting `.reviewgate/control-plane.json` does NOT disarm a checkout that `init`
armed: the managed hook is still there, so the gate fail-closed blocks until the
approval is restored.
```

- [ ] **Step 2: Correct the CLAUDE.md worktree bullet**

The current bullet says a worktree's work "ends un-reviewed (fail-open)". That stays true — S2 does **not** make hooks fire in a worktree (that is S4). Append one sentence so the two are not confused:

```markdown
  S2's arming probe does not change this: it makes an unarmed checkout SAFE (zero
  writes, no panel) when a hook fires there, but installing hooks in a worktree is
  still `reviewgate init` inside it (or S4's user-scoped hooks).
```

- [ ] **Step 3: Commit**

```bash
git add docs/AGENTS.md CLAUDE.md
git commit -m "docs: describe unarmed-checkout behavior (S2)"
```

---

## Verification (end gate)

- [ ] `bunx tsc --noEmit` — clean
- [ ] `bun run lint` — clean
- [ ] `bun test` — 0 fail (expect +~9 tests over the 2951 baseline)
- [ ] `bun run dev gate --hook stop </dev/null` in this repo still reviews normally (dogfood is armed)
- [ ] Manual: `mkdtemp` a bare dir, run the compiled gate's stop hook there, confirm no `.reviewgate/` appears

## Self-review notes

- **Spec coverage:** §4 arming rule (two branches, no `gateEverywhere`) → Task 1; zero-writes + loud/silent notice split → Tasks 2–3; "stop-probe becomes read-only until armed" → Task 2. §7.2 `gateEverywhere` deferral is honoured by omission. S3's inheritance branch has exactly one insertion point (`probeArming`).
- **Deliberate scope call:** Task 3 (trigger) is preparation for S4, not a live bug in S1–S3 scope, and is flagged as such.
- **Known gap carried forward:** the manual/bench paths (F-004, F9) still bypass arming entirely — explicitly out of scope per spec §6.

---

## Plan-Gate findings mapping — round 1 (codex, 2026-07-25)

Verdict: **FAIL**, 3 CRITICAL. All three verified against source before acceptance; all
three accepted (none rejected).

| # | Finding | Verified how | Fix | Task |
|---|---------|--------------|-----|------|
| C1 | Hand-written `ControlPlaneState` fixtures are schema-invalid, so `readState` returns null and the "armed" test silently exercises the UNARMED path | `src/schemas/control-plane.ts:24-26` — `approved_source_fingerprint`/`approved_effective_fingerprint` are `z.string().min(64).max(64)`, `approved_config` is the full `ConfigSchema` | Build every LKG with the real `bootstrapControlPlane` via a new `armCheckout()` helper; never hand-write the JSON. Also add a managed hook to the armed case so the check-order mutation actually goes red | Task 0 (helper), Task 1 Step 1 |
| C2 | The invalid-config regression passes empty `hookStdinRaw`, so `handleTrigger` takes the generic `dirty.flag` path and never arms `control-plane.flag` — the assertion fails while testing nothing | `src/hooks/handlers.ts:51-54` derives the edited path from `tool_input.file_path` | Send a real PostToolUse payload (`tool_name:"Edit"`, `tool_input.file_path` = the config) and assert via `controlPlaneFlagPath()` instead of a hard-coded filename | Task 3 Step 5 |
| C3 | ~15 existing test files call `runGate` with neither `loadConfigFn` nor any control-plane state, so the probe breaks them and the end gate cannot pass | Verified: 18 files call `runGate`/`runGateSafe` without the seam; sampled `gate-defer`, `gate-lock`, `gate-fail-closed`, `gate-skip-lock` have **0** state-setup hits | New **Task 0**, landing FIRST: `armCheckout()` helper applied to every affected file, with the suite proven green *before* the probe exists | Task 0 |

**Design change triggered by C3 (not a finding, a consequence):** with the tests armed, the
`reset` path no longer has to be exempted, so the probe moved to a single call at the top
of `runGate` governing `stop`, `trigger` and `reset` alike. The `NOT ARMED` notice is
restricted to `stop` so it cannot repeat on every tool call under S4's user-scoped hooks.

**Scope note for the human:** S2 is bigger than the spec implied. The spec says the unarmed
notice is "the ONLY behavioral change users will see — and they won't". That is true of
*users*; it is not true of the *test suite*, which encodes unarmed-checkout servicing in
~15 files. The extra work is mechanical (one helper in setup), not risky.

## Plan-Gate findings mapping — round 2 delta (codex, 2026-07-26)

Verdict: **FAIL**, 2 CRITICAL + 3 INFO. Both CRITICALs concern Task 0 (the round-1 fix
itself); both verified against source and accepted. The three INFO items are confirmations,
not findings — they close round 2's questions 1, 2 and 4 affirmatively.

| # | Finding | Verified how | Fix | Task |
|---|---------|--------------|-----|------|
| C1 | Task 0's **file-level** `loadConfigFn` filter skips `codex-host-protocol.test.ts`, whose trigger/stop checkouts then stay unarmed and fail | That file has 4 call sites — trigger (~31), stop (~44), reset (~64) — and only reset passes `loadConfigFn` | Audit per CALL SITE, not per file; explicit 3-question decision procedure; treat `runInit` sites as already armed | Task 0 Step 2 |
| C2 | `armCheckout` used `env:{}` + `home:<cwd>/home` while `runGate` uses `process.env` + `homedir()`; on a machine with a global config the armed LKG mismatches the very next resolve → `approval-required` candidate → forced review → unrelated assertions break | `~/.config/reviewgate/reviewgate.config.ts` **exists on this machine** (846 B, 2026-05-25); spec §S1 already records this exact failure mode ("forced by the failing gate tests on a machine that has a global config") | Helper uses the identical env/home inputs as `runGate` | Task 0 Step 1 |

Confirmations (INFO, no action):
- Moving the probe above `trigger` **preserves** the gate.ts:316-318 invariant: an existing
  LKG returns before config inspection, and `inspectConfigSources` reads raw bytes without
  parsing config syntax. Task 3's real `Edit` payload correctly exercises `controlPlaneFlagPath`.
- Gating `reset` strands nothing: a valid LKG makes the probe return `armed:true`.
- The deleted-LKG stop path stays airtight: `state-missing` falls through,
  `resolveControlPlaneConfig` rechecks the managed hook and throws, `runGateSafe` converts
  it to `decision:"block"`.

**Round count: 2 of 3.** Per the plan-gate calibration rule, a third FAIL goes to Markus for
an accept/fix decision per open finding rather than a fourth round.

## Plan-Gate findings mapping — round 3 delta (codex, 2026-07-26)

Verdict: **PASS** — 0 CRITICAL, 0 WARN, 2 INFO. The plan-gate is satisfied; implementation
may begin.

| # | Finding | Disposition |
|---|---------|-------------|
| I1 | Confirms the round-2 fix: with `process.env` + `homedir()`, a fresh test checkout gets the same source and effective fingerprints `runGate` resolves — on this machine *including* the global config, and in CI *including* its absence, because both sides use identical inputs. The real-home dependency already existed for the affected stop/reset paths. | No action (confirmation) |
| I2 | Step 2's audit misses a fourth category: `runGateSafe(input, customRun)` with an injected `run` never reaches `runGate`/the control plane, so arming it is dead work and writes into shared throwaway paths (`/tmp/nope`) | **Adopted** — added as audit question 1 in Task 0 Step 2 |

**Plan-gate summary across all rounds:** round 1 FAIL (3 CRITICAL) → round 2 FAIL
(2 CRITICAL, both introduced by round 1's own fix) → round 3 PASS. Every CRITICAL was
verified against source before acceptance; none were rejected. Two of the five would have
produced tests that were green while asserting nothing — the failure class this repo keeps
re-learning.
