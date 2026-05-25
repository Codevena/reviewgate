# flock: True Steal-Mutex Exclusivity (close the residual double-hold) — Design Spec

**Status:** approved 2026-05-25 (brainstorming). Next: implementation plan.

**Goal:** Close the residual cross-process double-hold in `src/utils/flock.ts` that the previous
fix (`fix/flock-steal-double-hold`, master) left open — flagged by code review and tracked in
`[[reference_flock_steal_mutex_deep_race]]`. Make the steal-mutex **truly exclusive** so the
existing main-lock re-check is airtight.

**Non-goals:** changing the no-TTL / dead-pid-only stale-recovery philosophy
(`[[reference_flock_dead_pid_only]]`); adopting an external lock library; changing flock's public
API or the common (single-reclaimer) fast path.

---

## 1. The residual race (recap)

The shipped fix re-checks `isReclaimable(path)` UNDER the steal-mutex before reclaiming the main
lock — airtight **iff the steal-mutex is exclusive**. It is not, in one path: `acquireStealMutex`
recovers a DEAD steal-mutex (a reclaimer that crashed cross-process while holding it) via
`reclaimIfDead(mutexPath)`, which uses *grab-to-inspect* (`rename` target→private, inspect, restore
if live). If the dead steal-mutex transitions dead→live between a recoverer's `isReclaimable` check
and its `rename`, the recoverer grabs a **live** mutex and its restore exposes a window where
`mutexPath` is absent while a holder is active → a third `tryCreate(mutexPath)` wins → **two steal-
mutex holders** → two reclaimers on the main lock → main double-hold (a third contender slips into
the main lock during one reclaimer's `reclaimIfDead(path)` rename of the other's freshly-acquired
live lock).

**Why grab-to-inspect is unavoidable in isolation:** POSIX has no atomic "remove/rename only if the
content is still the dead lock". The only way to never grab a live lock is to ensure the target
stays dead during the grab — i.e. **serialize the removal** (a mutex). That is exactly what the
steal-mutex does for the *main* lock; the gap is that the steal-mutex's OWN recovery isn't
serialized, so it can grab a live mutex.

## 2. Fix: a level-2 mutex over the steal-mutex recovery (terminating recursion)

Serialize the recovery of a dead **steal-mutex** under a second mutex (`<mutexPath>.2`). Under L2,
"the L1 steal-mutex is dead" is **stable** (removal is L2-gated, and dead→live needs a removal
first), so the recovery's `rename` always grabs the *dead* mutex — never a live one — and
`reclaimIfDead`'s restore branch is never reached. That makes the L1 steal-mutex truly exclusive,
which makes the main-lock re-check airtight.

**Terminating the recursion:** the L2 mutex is **not** recovered. `acquireL2` is a single
`tryCreate` — if `<mutexPath>.2` is held (live OR a dead crash-remnant), it returns false and the
caller backs off (the L1 recovery is skipped this cycle → the main lock degrades to the acquire
**timeout**, the codebase's accepted safe fallback — never a double-hold). Crashing while holding
L2 requires a crash within the microseconds of recovering a dead L1 mutex, which itself only
happens after a crash-while-holding-L1 — i.e. a double-nested-crash, astronomically rarer than the
already-rare L1 case, and it degrades to timeout, not double-hold. So depth 2 is sufficient; no
deeper level is warranted (YAGNI).

### Code shape (`src/utils/flock.ts`)

```ts
// Level-2 mutex over a dead steal-mutex's recovery. Deliberately NOT recovered itself:
// if `.2` is held (live or a crash-remnant), we back off and the L1 recovery is skipped
// this cycle (the main lock degrades to the acquire timeout — never a double-hold). This
// terminates the recursion: a crash while holding `.2` (within the microseconds of an L1
// recovery, itself post-crash) is doubly-improbable and fails safe.
async function recoverDeadStealMutex(mutexPath: string): Promise<void> {
  const l2 = `${mutexPath}.2`;
  const l2Token = newToken();
  if (!(await tryCreate(l2, l2Token))) return; // L2 busy/crash-remnant → back off (degrade to timeout)
  try {
    // Stable under L2: removal of the dead L1 mutex is L2-gated, so dead→live cannot happen
    // here → reclaimIfDead grabs the DEAD mutex (never a live one); its restore branch is
    // unreachable under L2.
    if (await isReclaimable(mutexPath)) await reclaimIfDead(mutexPath);
  } finally {
    await releaseOwned(l2, l2Token);
  }
}
```

`acquireStealMutex` changes only its recovery call:

```ts
async function acquireStealMutex(mutexPath: string, token: string): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await tryCreate(mutexPath, token)) return true;
    if (await isReclaimable(mutexPath)) {
      await recoverDeadStealMutex(mutexPath); // was: reclaimIfDead(mutexPath)
    } else {
      return false; // a live reclaim is in progress
    }
  }
  return false;
}
```

`reclaimDeadLock`, the main-lock re-check, `reclaimIfDead`, `tryCreate`, `releaseOwned`,
`isReclaimable`, and `flock` are **unchanged**. (The `<mutexPath>.2` files are transient and
cleaned by `releaseOwned`; a crash-orphaned `.2` is the rare degrade-to-timeout case.)

## 3. Why this is airtight against double-hold

- L1 steal-mutex recovery is now L2-serialized → grabs only the dead mutex → no live-move → **L1
  steal-mutex is truly exclusive.**
- Given L1 exclusivity, the existing main-lock re-check (`isReclaimable(path)` under the L1 mutex)
  is airtight: a dead main lock is stable under L1, so the reclaimer never renames a live lock.
- L2 has no recovery → its only failure mode is "skip recovery this cycle" → main lock degrades to
  the acquire timeout. **No path produces a double-hold; the worst case is a (vanishingly rare)
  liveness degrade to timeout** — consistent with the existing dead-pid-only philosophy.

## 4. Verification (the hard part — must be REAL)

In-process *end-to-end* stress of the deep race is **not viable**: seeding a dead `.steal` + dead
main lock under heavy contention wedges into a timeout rather than emitting a clean double-hold
signal (verified empirically). So we verify the **exact defect** — steal-mutex mutual exclusion —
directly, decoupled from the main-lock machinery:

1. **Targeted exclusivity test (primary).** Export `acquireStealMutex` + a release for testing (or
   a thin test-only wrapper). Seed a dead `<path>.steal` (dead pid). Run N concurrent workers that
   loop: `acquireStealMutex` → if won, increment a holder counter, hold briefly, decrement,
   `releaseOwned`. Assert the holder counter never exceeds 1 (mutual exclusion), over enough
   rounds. **Pre-fix** (leaky recovery) this can reach 2; **post-fix** it stays 1. During
   implementation, confirm this reproduces pre-fix; **if the targeted stress is also unreliable**,
   fall back to **fault-injection await-seams** (test-only optional hooks at the
   isReclaimable→rename boundary) to force the interleaving deterministically.
2. **Main path unchanged.** The existing `flock.test.ts` "never double-hold" test + the 12-worker
   stress (used to verify the prior fix) must stay green — the main path and fast path are untouched.
3. **No-recovery degrade.** A test that a dead `<path>.steal.2` makes `recoverDeadStealMutex` back
   off (returns without throwing) and the caller proceeds (does not double-hold; may time out) —
   asserting the terminating base case.
4. **Codex design + code review.** Codex found the residual; it reviews the fix design AND the diff.
5. Full suite green; `bunx tsc --noEmit` + `bun run lint` clean.

## 5. File map

- **Modify:** `src/utils/flock.ts` — add `recoverDeadStealMutex`, change `acquireStealMutex`'s one
  recovery call; export `acquireStealMutex` (+ `releaseOwned` or a test helper) for the exclusivity
  test. No other function changes.
- **Tests:** `tests/unit/flock.test.ts` — add the steal-mutex exclusivity stress + the L2
  degrade-to-timeout-base-case test. (Fault-injection seams only if the stress proves unreliable.)

Related: `[[reference_flock_steal_mutex_deep_race]]`, `[[reference_flock_dead_pid_only]]`.
