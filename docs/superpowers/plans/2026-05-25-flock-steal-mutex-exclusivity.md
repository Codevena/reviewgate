# flock: True Steal-Mutex Exclusivity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the residual cross-process double-hold in `src/utils/flock.ts` by making the steal-mutex truly exclusive — its dead-holder recovery is serialized under a level-2 mutex that terminates the recursion by degrading to timeout.

**Architecture:** Add `recoverDeadStealMutex` (serializes the dead-L1-steal-mutex recovery under `<mutexPath>.2`, which is itself not recovered → degrade-to-timeout base case). `acquireStealMutex` calls it instead of `reclaimIfDead(mutexPath)` directly. `reclaimDeadLock` returns a progress boolean; `flock` backs off when reclaim made no progress (avoids a busy-spin in the degrade case).

**Tech Stack:** Bun, TypeScript. Verification: Option A — deterministic tests of the new L2-gating mechanism (the emergent race is not stress-reproducible; see spec §4).

Spec: `docs/superpowers/specs/2026-05-25-flock-steal-mutex-exclusivity-design.md`.

---

## File Structure

- `src/utils/flock.ts` — add `recoverDeadStealMutex`; change `acquireStealMutex`'s recovery call; `reclaimDeadLock` returns `boolean`; `flock` backs off on no-progress; export `acquireStealMutex`, `reclaimDeadLock`, `releaseOwned` for tests.
- `tests/unit/flock.test.ts` — add the deterministic L2-gating tests.

---

## Task 1: Level-2 steal-mutex exclusivity + busy-spin backoff

**Files:**
- Modify: `src/utils/flock.ts`
- Test: `tests/unit/flock.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/unit/flock.test.ts`, check the existing imports include `existsSync`, `readFileSync`, `mkdtempSync`, `writeFileSync` from `node:fs`, `tmpdir`, `join`, and a `lockPath()`/`deadPid()` helper (the file already has these — reuse them; if `readFileSync` is missing from the import, add it). Add a new `describe` block:

```ts
describe("flock steal-mutex exclusivity (L2)", () => {
  const liveToken = () => `${process.pid}-live-${Math.random().toString(36).slice(2)}`;

  it("recovers a dead steal-mutex when L2 is free (acquireStealMutex succeeds, L2 released)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-l2-"));
    const m = join(dir, "x.steal");
    writeFileSync(m, `pid=${deadPid()}\nts=${new Date().toISOString()}\ntoken=stale\n`);
    const tok = liveToken();
    expect(await acquireStealMutex(m, tok)).toBe(true); // dead L1 recovered + acquired
    expect(readFileSync(m, "utf8")).toContain(`token=${tok}`); // we hold it now
    expect(existsSync(`${m}.2`)).toBe(false); // L2 released
    await releaseOwned(m, tok);
    expect(existsSync(m)).toBe(false);
  });

  it("does NOT touch a dead steal-mutex while L2 is held (no live-move; back off)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-l2held-"));
    const m = join(dir, "x.steal");
    const dead = `pid=${deadPid()}\nts=${new Date().toISOString()}\ntoken=stale\n`;
    writeFileSync(m, dead);
    // Simulate another recoverer mid-recovery: L2 held by a LIVE token.
    writeFileSync(`${m}.2`, `pid=${process.pid}\nts=${new Date().toISOString()}\ntoken=${liveToken()}\n`);
    expect(await acquireStealMutex(m, liveToken())).toBe(false); // L2 held → cannot recover/acquire
    expect(readFileSync(m, "utf8")).toBe(dead); // dead mutex UNCHANGED — never grabbed/live-moved
  });

  it("reclaimDeadLock returns false (no progress) when the steal-mutex recovery is blocked by a held L2", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-noprog-"));
    const p = join(dir, "lock");
    writeFileSync(p, `pid=${deadPid()}\nts=${new Date().toISOString()}\n`); // dead main lock
    writeFileSync(`${p}.steal`, `pid=${deadPid()}\nts=${new Date().toISOString()}\ntoken=stale\n`); // dead L1
    writeFileSync(`${p}.steal.2`, `pid=${process.pid}\nts=${new Date().toISOString()}\ntoken=${liveToken()}\n`); // L2 held
    expect(await reclaimDeadLock(p)).toBe(false); // could not acquire the steal-mutex → no progress
  });
});
```

Also import the three internals at the top of the test file (add to the existing `flock` import):
```ts
import { flock, acquireStealMutex, reclaimDeadLock, releaseOwned } from "../../src/utils/flock.ts";
```
(Adjust the existing import line — it currently imports `flock` and maybe a `lockPath` helper from a paths module; only the `../../src/utils/flock.ts` import needs the three new names.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/unit/flock.test.ts -t "steal-mutex exclusivity"`
Expected: FAIL — `acquireStealMutex` / `reclaimDeadLock` / `releaseOwned` aren't exported yet (import error), and pre-fix `acquireStealMutex` calls `reclaimIfDead(mutexPath)` directly (no L2 gate), so the "does NOT touch while L2 held" test would fail (it WOULD touch the dead mutex), and `reclaimDeadLock` returns `void` not `false`.

- [ ] **Step 3: Add `recoverDeadStealMutex` and update `acquireStealMutex`**

In `src/utils/flock.ts`, add `recoverDeadStealMutex` just above `acquireStealMutex`:

```ts
// Recover a DEAD steal-mutex, serialized under a level-2 mutex (`<mutexPath>.2`) so the
// recovery is exclusive: under L2, "the L1 steal-mutex is dead" is STABLE (its removal is
// L2-gated, and a dead→live transition needs a removal first), so reclaimIfDead grabs only
// the DEAD mutex — never a live one — and its restore branch is unreachable. The L2 mutex is
// deliberately NOT recovered: if `<mutexPath>.2` is held (a live recoverer, or the rare
// crash-remnant), we back off and skip the L1 recovery this cycle (the main lock degrades to
// the acquire timeout — never a double-hold). This terminates the recursion at depth 2.
async function recoverDeadStealMutex(mutexPath: string): Promise<void> {
  const l2 = `${mutexPath}.2`;
  const l2Token = newToken();
  if (!(await tryCreate(l2, l2Token))) return; // L2 busy/crash-remnant → degrade to timeout
  try {
    if (await isReclaimable(mutexPath)) await reclaimIfDead(mutexPath);
  } finally {
    await releaseOwned(l2, l2Token);
  }
}
```

Change the one recovery call inside `acquireStealMutex` from:
```ts
      await reclaimIfDead(mutexPath);
```
to:
```ts
      await recoverDeadStealMutex(mutexPath);
```

- [ ] **Step 4: Make `reclaimDeadLock` return a progress boolean**

Replace `reclaimDeadLock` with:
```ts
async function reclaimDeadLock(path: string): Promise<boolean> {
  const mutexPath = `${path}.steal`;
  const mutexToken = newToken();
  if (!(await acquireStealMutex(mutexPath, mutexToken))) return false; // contended / L2-degrade → no progress
  try {
    // Re-validate UNDER the mutex before removing anything (see fix/flock-steal-double-hold):
    // the steal-mutex is now truly exclusive, so a dead `path` is stable here.
    if (await isReclaimable(path)) await reclaimIfDead(path);
    return true; // held the mutex + ran the reclaim → caller may retry tryCreate immediately
  } finally {
    await releaseOwned(mutexPath, mutexToken);
  }
}
```

- [ ] **Step 5: Back off in `flock` when reclaim made no progress**

In `flock`'s loop, replace:
```ts
    if (await isReclaimable(path)) {
      await reclaimDeadLock(path);
    } else {
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 500);
    }
```
with:
```ts
    if (await isReclaimable(path)) {
      const progressed = await reclaimDeadLock(path);
      if (!progressed) {
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 500);
      }
    } else {
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 500);
    }
```

- [ ] **Step 6: Export the internals needed for the deterministic tests**

In `src/utils/flock.ts`, add the `export` keyword to these three function declarations (mark them clearly):
```ts
// Exported for white-box concurrency tests (see flock.test.ts "steal-mutex exclusivity").
export async function releaseOwned(path: string, token: string): Promise<void> {
// ...
export async function acquireStealMutex(mutexPath: string, token: string): Promise<boolean> {
// ...
export async function reclaimDeadLock(path: string): Promise<boolean> {
```
(`recoverDeadStealMutex` stays private — it's exercised through `acquireStealMutex`.)

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bun test tests/unit/flock.test.ts`
Expected: PASS — all existing flock tests (incl. "never double-hold") + the 3 new L2 tests.

- [ ] **Step 8: Typecheck + lint**

Run: `bunx tsc --noEmit && bun run lint`
Expected: both clean (run `bun run format` then re-check if biome flags formatting).

- [ ] **Step 9: Commit**

```bash
git add src/utils/flock.ts tests/unit/flock.test.ts
git commit -m "fix(flock): serialize steal-mutex recovery under an L2 mutex (true exclusivity)"
```

---

## Task 2: Final verification

**Files:** none (verification only).

- [ ] **Step 1: Full suite + static checks**

Run:
```bash
bunx tsc --noEmit
bun run lint
bun test
```
Expected: all green. The known intermittent `runDoctor` timeout flake is unrelated — re-run `bun test` once if it flakes. Any other failure → STOP and report BLOCKED.

- [ ] **Step 2: Confirm the main-path guard still holds**

Run: `bun test tests/unit/flock.test.ts` a few times.
Expected: the existing "concurrent contenders racing to steal a stale lock never double-hold" test stays green (the main path and fast path are untouched by this change).

- [ ] **Step 3: No commit (verification task).** Report the suite result + the Task 1 commit SHA for the final review gate.

---

## Final Verification (before the cross-agent review gate)

- [ ] `bunx tsc --noEmit` clean
- [ ] `bun run lint` clean
- [ ] `bun test` green (full suite)
- [ ] The 3 deterministic L2 tests pass; the existing double-hold test stays green

Then run the cross-agent review (Codex code review of the diff — it found the residual), fix findings, and stop for push approval.
