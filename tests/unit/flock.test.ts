// tests/unit/flock.test.ts
// Phase 4 #4 — flock must recover from a STALE lock (holder SIGKILLed without
// releasing). Previously it wrote a pid but never checked it, so a dead holder's
// .lock made every subsequent acquire spin the full timeout then throw. Recovery
// = steal the lock when the holder pid is dead OR the lock is older than a TTL.
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flock } from "../../src/utils/flock.ts";

function lockPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rg-flock-")), "x.lock");
}

// A pid that is (almost certainly) not a live process. We spawn a trivial child,
// wait for it to exit, and reuse its now-dead pid.
function deadPid(): number {
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
  const r = spawnSync("sh", ["-c", "exit 0"]);
  return r.pid ?? 2_147_483_646;
}

describe("flock", () => {
  it("acquires when no lock exists, and release() removes the file", async () => {
    const p = lockPath();
    const lock = await flock(p);
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, "utf8")).toContain(`pid=${process.pid}`);
    await lock.release();
    expect(existsSync(p)).toBe(false);
  });

  it("steals a stale lock whose holder pid is DEAD (no full-timeout spin)", async () => {
    const p = lockPath();
    writeFileSync(p, `pid=${deadPid()}\nts=${new Date().toISOString()}\n`);
    const start = Date.now();
    const lock = await flock(p, 30_000); // would spin 30s under the old behavior
    expect(Date.now() - start).toBeLessThan(2_000); // stolen promptly
    expect(readFileSync(p, "utf8")).toContain(`pid=${process.pid}`); // now ours
    await lock.release();
  });

  it("does NOT reclaim a lock held by a LIVE pid, even an old one (no live double-acquire)", async () => {
    const p = lockPath();
    // Our OWN pid (definitely alive) but an ancient timestamp. Reclaiming a live
    // holder is by definition a double-acquire, so we must NOT steal it — a
    // genuinely wedged-but-alive holder degrades to the acquire timeout instead.
    const old = new Date(Date.now() - 600_000).toISOString();
    writeFileSync(p, `pid=${process.pid}\nts=${old}\n`);
    await expect(flock(p, 200)).rejects.toThrow(/timed out/);
    expect(readFileSync(p, "utf8")).toContain(`pid=${process.pid}`); // untouched
  });

  it("does NOT steal a fresh lock held by a live process → times out instead", async () => {
    const p = lockPath();
    // Live pid (ours) + fresh ts → a legitimately-held lock. Must not be stolen.
    writeFileSync(p, `pid=${process.pid}\nts=${new Date().toISOString()}\n`);
    await expect(flock(p, 200)).rejects.toThrow(/timed out/);
    expect(readFileSync(p, "utf8")).toContain(`pid=${process.pid}`); // untouched
  });

  it("steals a malformed/empty lock (no parseable pid)", async () => {
    const p = lockPath();
    writeFileSync(p, "garbage-without-pid\n");
    const lock = await flock(p, 30_000);
    expect(readFileSync(p, "utf8")).toContain(`pid=${process.pid}`);
    await lock.release();
  });

  it("the lock file is ALWAYS fully written (never an empty/partial TOCTOU window)", async () => {
    // With the atomic link() protocol the lock file only ever appears with its
    // full pid/ts/token content — so a contender can never read it empty and
    // wrongly classify it as a malformed/stealable lock.
    const p = lockPath();
    const lock = await flock(p);
    const raw = readFileSync(p, "utf8");
    expect(raw).toMatch(/pid=\d+/);
    expect(raw).toMatch(/ts=/);
    expect(raw).toMatch(/token=/);
    await lock.release();
  });

  it("release() does NOT delete a lock we no longer own (ownership-checked)", async () => {
    // Simulate: we acquired, then were stolen (another holder now owns the file
    // with a different token). Our release must not delete THEIR lock.
    const p = lockPath();
    const lock = await flock(p);
    writeFileSync(p, `pid=${process.pid}\nts=${new Date().toISOString()}\ntoken=someone-else\n`);
    await lock.release();
    expect(existsSync(p)).toBe(true); // not ours → left intact
  });

  it("concurrent contenders racing to steal a stale lock never double-hold", async () => {
    const p = lockPath();
    // Pre-existing STALE lock (dead holder) → every contender wants to steal it,
    // exercising the steal race. The invariant: at most ONE holder at any instant.
    writeFileSync(p, `pid=${deadPid()}\nts=${new Date().toISOString()}\n`);
    let active = 0;
    let maxActive = 0;
    async function worker() {
      const l = await flock(p, 10_000);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5)); // hold the critical section briefly
      active -= 1;
      await l.release();
    }
    await Promise.all(Array.from({ length: 8 }, worker));
    expect(maxActive).toBe(1); // never two holders at once
    expect(existsSync(p)).toBe(false);
  });

  it("provides mutual exclusion: a second acquire waits until release", async () => {
    const p = lockPath();
    const a = await flock(p, 5_000);
    let bAcquired = false;
    const bPromise = flock(p, 5_000).then((l) => {
      bAcquired = true;
      return l;
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(bAcquired).toBe(false); // blocked while A holds it
    await a.release();
    const b = await bPromise;
    expect(bAcquired).toBe(true);
    await b.release();
  });
});
