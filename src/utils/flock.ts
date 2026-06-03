import { existsSync, mkdirSync, readFileSync } from "node:fs";
// src/utils/flock.ts
import { link, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface FileLock {
  release(): Promise<void>;
}

let counter = 0;
function newToken(): string {
  // Unique per acquisition: pid + monotonic counter + time + randomness. Used as
  // the lock's identity so release only deletes a lock THIS call still owns.
  counter = (counter + 1) % Number.MAX_SAFE_INTEGER;
  return `${process.pid}-${counter}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function parsePid(raw: string): number | undefined {
  const m = raw.match(/pid=(\d+)/);
  const pid = m ? Number(m[1]) : Number.NaN;
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

// Diagnostics for the deferred/contention message (M-A3): who currently holds the
// lock and since when, so a human can identify (and, if hung, kill) the holder.
// Best-effort and synchronous — returns null if the lock file is gone/unreadable.
export function readLockHolder(path: string): { pid: number | null; ts: string | null } | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const pid = parsePid(raw);
  const tsM = raw.match(/ts=([^\n]+)/);
  return { pid: pid ?? null, ts: tsM ? (tsM[1] ?? null) : null };
}

// `process.kill(pid, 0)` sends no signal — it only probes existence/permission.
// ESRCH ⇒ no such process (dead). EPERM ⇒ the process exists but we may not signal
// it (alive). We err toward "alive" for anything other than a definite ESRCH, so
// we never reclaim a live holder. NOTE: on Windows a dead pid often surfaces as
// EPERM rather than ESRCH, so dead-holder reclaim effectively no-ops there and a
// stale lock degrades to the acquire timeout — the safe (no double-acquire)
// fallback, just without the fast recovery POSIX gets.
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// A lock is RECLAIMABLE only when its holder process is provably gone (dead pid)
// or there is no parseable holder (malformed/empty file). We deliberately do NOT
// reclaim on a TTL/age basis: stealing a lock whose holder is still ALIVE is by
// definition a double-acquire, and no lockfile protocol can make that safe without
// holder-side cooperation. The cost: a crashed holder whose pid was REUSED by an
// unrelated live process is not auto-reclaimed — it degrades to the acquire
// timeout (the pre-existing behaviour), which is far rarer than the common crash
// case this recovers and is no worse than before.
async function isReclaimable(path: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return false; // vanished (holder released) → not reclaimable, just retry the create
  }
  const pid = parsePid(raw);
  if (pid === undefined) return true; // malformed/empty → no real holder
  return !isProcessAlive(pid); // dead holder → reclaimable
}

// Create the lock with full content via the atomic link() protocol: write the
// pid/ts/token to a uniquely-named temp file, then link() it into place. link()
// fails with EEXIST if the lock is held (exclusivity), and because the link only
// ever appears fully-formed the lock file is NEVER observable empty/partial — so a
// contender can't read it mid-write and misjudge it. Returns true if we won.
async function tryCreate(path: string, token: string): Promise<boolean> {
  const tmp = `${path}.${token}.tmp`;
  await writeFile(tmp, `pid=${process.pid}\nts=${new Date().toISOString()}\ntoken=${token}\n`);
  try {
    await link(tmp, path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  } finally {
    await unlink(tmp).catch(() => undefined); // path keeps the inode alive on success
  }
}

export async function releaseOwned(path: string, token: string): Promise<void> {
  try {
    const raw = await readFile(path, "utf8");
    if (raw.includes(`token=${token}`)) await unlink(path).catch(() => undefined);
  } catch {
    // already gone
  }
}

// Race-safely remove a lock at `target` IF its holder is dead. The caller has
// already seen `target` as reclaimable; this performs the removal WITHOUT the
// check-then-unlink TOCTOU that a plain `unlink(target)` has (a fresh lock could
// replace the dead one between check and unlink). We atomically `rename` the file
// to a PRIVATE name — only ONE caller can move a given file (the rest get ENOENT
// and bail) — then delete ONLY that private copy. We never `unlink(target)` after
// vacating it, so a fresh lock legitimately created at `target` is never clobbered.
// If the privately-grabbed file turns out LIVE (a dead→live transition raced us),
// we restore it; and if `target` was retaken in that window we leave the private
// copy as a harmless orphan rather than destroy a live holder's lock.
async function reclaimIfDead(target: string): Promise<void> {
  const claimed = `${target}.reclaim.${newToken()}`;
  try {
    await rename(target, claimed);
  } catch {
    return; // ENOENT: already freed/claimed by someone else
  }
  if (await isReclaimable(claimed)) {
    await unlink(claimed).catch(() => undefined); // confirmed dead → drop the private copy
  } else {
    try {
      await link(claimed, target); // put the live lock back (fails if target retaken)
      await unlink(claimed).catch(() => undefined);
    } catch {
      // target retaken by a live lock → leave `claimed` as a harmless orphan
      // (deleting it would orphan a live holder → double acquire).
    }
  }
}

// Recover a DEAD steal-mutex, serialized under a level-2 mutex (`<mutexPath>.2`) so the
// recovery is exclusive: under L2, "the L1 steal-mutex is dead" is STABLE (its removal is
// L2-gated, and a dead→live transition needs a removal first), so reclaimIfDead grabs only
// the DEAD mutex — never a live one — and its restore branch is unreachable. The L2 mutex is
// deliberately NOT recovered: if `<mutexPath>.2` is held (a live recoverer, or the rare
// crash-remnant), we back off and skip the L1 recovery this cycle (the main lock degrades to
// the acquire timeout — never a double-hold). This terminates the recursion at depth 2.
// NOTE: a crash-orphaned `.2` is intentionally left un-reclaimed — reclaiming it would
// itself need an L3 mutex (unbounded recursion). It only disables the FAST recovery of one
// already-dead L1 steal-mutex (every future recover hits EEXIST → degrade to the acquire
// timeout); it never blocks the main lock and never causes a double-hold.
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

// The steal-mutex serializes reclaimers so at most ONE is removing a given dead
// lock at a time. Grabbed via the same atomic-link protocol. If the mutex itself
// is held by a DEAD process (a reclaimer that crashed mid-operation), we clear it
// race-safely via reclaimIfDead (NOT a blind unlink — two reclaimers must not be
// able to delete each other's fresh mutex, which would put two reclaimers in
// flight); if a live reclaim is in progress we return false so the caller backs
// off (no second reclaimer — exactly the contention we're serializing away).
export async function acquireStealMutex(mutexPath: string, token: string): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await tryCreate(mutexPath, token)) return true;
    if (await isReclaimable(mutexPath)) {
      await recoverDeadStealMutex(mutexPath);
    } else {
      return false; // a live reclaim is in progress
    }
  }
  return false;
}

// Reclaim a DEAD holder's main lock — serialized by the steal-mutex so the lock
// is STABLE during the reclaim (no other reclaimer is active, the dead holder
// can't release, and a normal acquirer can't create over the still-present file).
// The actual removal goes through reclaimIfDead (rename-to-private), so even the
// crash-broken-mutex edge can't clobber a live lock.
// Returns true if we held the mutex and ran the reclaim attempt (caller may retry
// tryCreate immediately); returns false if the mutex was contended or L2-blocked
// (no progress this cycle → caller should back off with a delay).
export async function reclaimDeadLock(path: string): Promise<boolean> {
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

// Cross-platform exclusive lock. On contention we retry with exponential backoff,
// but if the existing lock's holder is provably dead we reclaim it (so a holder
// SIGKILLed without releasing doesn't wedge every future acquire until timeout).
export async function flock(path: string, timeoutMs = 30_000): Promise<FileLock> {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const token = newToken();
  const start = Date.now();
  let delay = 25;
  for (;;) {
    if (await tryCreate(path, token)) {
      return {
        // Ownership-checked: only delete the lock if it still carries OUR token.
        // If we were reclaimed (we shouldn't be, being alive) the file belongs to
        // another holder — deleting it would let a third caller in concurrently.
        release: () => releaseOwned(path, token),
      };
    }
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
    if (Date.now() - start > timeoutMs) {
      throw new Error(`flock: timed out acquiring ${path} after ${timeoutMs}ms`);
    }
  }
}
