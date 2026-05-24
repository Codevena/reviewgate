// tests/unit/spawn-capture.test.ts
// Phase 4 #3 — async subprocess capture for git/rg on the Stop-hook hot path.
// The whole point: a slow/hung child must NOT block the event loop (so the gate
// self-deadline timer can still fire) and must be bounded by a per-command
// timeout. spawnSync could do neither.
import { describe, expect, it } from "bun:test";
import { spawnCapture } from "../../src/utils/spawn-capture.ts";

describe("spawnCapture", () => {
  it("captures stdout and the exit status of a normal command", async () => {
    const r = await spawnCapture("sh", ["-c", "printf hello; exit 0"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("hello");
    expect(r.spawnError).toBeNull();
    expect(r.timedOut).toBe(false);
  });

  it("propagates a non-zero exit status (stdout still captured)", async () => {
    const r = await spawnCapture("sh", ["-c", "printf out; exit 1"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("out");
  });

  it("returns status=null + spawnError on a missing binary (ENOENT)", async () => {
    const r = await spawnCapture("definitely-not-a-real-binary-xyz", ["--nope"]);
    expect(r.status).toBeNull();
    expect(r.spawnError).not.toBeNull();
  });

  it("enforces the per-command timeout (SIGKILL) and reports timedOut", async () => {
    const start = Date.now();
    const r = await spawnCapture("sh", ["-c", "sleep 5"], { timeoutMs: 200 });
    const elapsed = Date.now() - start;
    expect(r.timedOut).toBe(true);
    expect(r.status).toBeNull(); // killed by signal → no exit code
    expect(elapsed).toBeLessThan(2000); // killed promptly, not after sleep 5
  });

  it("does NOT block the event loop (a concurrent timer fires during a slow child)", async () => {
    // The crux of this PR: with spawnSync a pending timer could NOT fire while
    // the child runs. With async spawn it can — which is what lets the gate
    // self-deadline (loop.runTimeoutMs) fire during a hung git call.
    let timerFiredAt = 0;
    const t = setTimeout(() => {
      timerFiredAt = Date.now();
    }, 50);
    const start = Date.now();
    await spawnCapture("sh", ["-c", "sleep 0.5"], { timeoutMs: 5000 });
    clearTimeout(t);
    expect(timerFiredAt).toBeGreaterThan(0); // the 50ms timer fired…
    expect(timerFiredAt - start).toBeLessThan(450); // …well before the 500ms child finished
  });

  it("aborts a running child promptly when the AbortSignal fires", async () => {
    // The gate self-deadline aborts mid-run; an in-flight git/rg must stop
    // promptly (not run to its own 30s timeout) so the fail-closed path isn't
    // delayed by N×30s of research subprocesses.
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const start = Date.now();
    const r = await spawnCapture("sh", ["-c", "sleep 5"], { timeoutMs: 30_000, signal: ac.signal });
    const elapsed = Date.now() - start;
    expect(r.aborted).toBe(true);
    expect(elapsed).toBeLessThan(2000); // killed at ~100ms, not the 5s sleep / 30s timeout
  });

  it("returns immediately (no spawn) when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await spawnCapture("sh", ["-c", "sleep 5"], { signal: ac.signal });
    expect(r.aborted).toBe(true);
    expect(r.status).toBeNull();
    expect(r.stdout).toBe("");
  });

  it("bounds stdout at maxBytes and flags truncation (no unbounded buffer)", async () => {
    // 200 KiB of output, capped at 1 KiB.
    const r = await spawnCapture("sh", ["-c", "yes x | head -c 204800"], { maxBytes: 1024 });
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBeLessThanOrEqual(1024);
  });

  it("captures large output fully when under the cap", async () => {
    const r = await spawnCapture("sh", ["-c", "printf '%0.sA' $(seq 1 5000)"], {
      maxBytes: 1024 * 1024,
    });
    expect(r.truncated).toBe(false);
    expect(r.stdout.length).toBe(5000);
  });
});
