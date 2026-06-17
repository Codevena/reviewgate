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
      repoRoot: dir,
      ...OPTS,
      now: clk.now,
      sleep: async (ms) => {
        slept += ms;
        clk.advance(ms);
      },
    });
    expect(r.settled).toBe(true);
    expect(r.waitedMs).toBe(0);
    expect(slept).toBe(0);
  });

  it("returns settled after one interval when the tree is stable", async () => {
    const dir = gitRepo();
    writeFileSync(join(dir, "fresh.ts"), "fresh\n"); // mtime ≈ now → enters the loop
    const clk = fakeClock(Date.now());
    const r = await awaitWorkspaceSettle({
      repoRoot: dir,
      ...OPTS,
      now: clk.now,
      sleep: clk.sleep,
    });
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
      utimesSync(f, t, t);
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
      repoRoot: dir,
      ...OPTS,
      now: clk.now,
      sleep: async (ms) => {
        slept += ms;
        clk.advance(ms);
      },
    });
    expect(r.settled).toBe(true);
    expect(r.waitedMs).toBe(0);
    expect(slept).toBe(0);
  });
});
