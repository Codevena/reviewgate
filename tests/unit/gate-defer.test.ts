// tests/unit/gate-defer.test.ts
//
// M-A2 (D-1 fail-safe-degrade) — a contended gate lock must NEVER end as a turn
// BLOCK (the old behavior busy-looped every parallel session). Instead the turn
// is DEFERRED: allow_stop + a deferred.flag that forces the next stop to review
// (eventual-review guarantee), and is consumed once the lock is acquired.
import { describe, expect, it } from "bun:test";
import { execSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  consumeDeferredFlag,
  lockContentionDecision,
  runGate,
  stopHasNothingToReview,
} from "../../src/cli/commands/gate.ts";
import { StateStore } from "../../src/core/state-store.ts";
import { handleReset } from "../../src/hooks/handlers.ts";
import { FlockTimeoutError, flock, readLockHolder } from "../../src/utils/flock.ts";
import {
  deferredFlagPath,
  dirtyFlagPath,
  gateLockPath,
  reviewgateDir,
} from "../../src/utils/paths.ts";

function gitRepo(prefix: string): string {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
  execSync("git init -q && git commit -q --allow-empty -m init", {
    cwd: repo,
    env,
    stdio: "ignore",
  });
  mkdirSync(reviewgateDir(repo), { recursive: true });
  return repo;
}

describe("gate defer-on-contention", () => {
  it("DEFERS (allow_stop) instead of blocking when the lock is held, and writes deferred.flag", async () => {
    const repo = gitRepo("rg-defer-");
    writeFileSync(
      dirtyFlagPath(repo),
      JSON.stringify({ diff_hash: "h", ts: new Date().toISOString() }),
    );
    const held = await flock(gateLockPath(repo));
    try {
      const out = await runGate({
        repoRoot: repo,
        hook: "stop",
        hookStdinRaw: "{}",
        lockTimeoutMs: 200,
      });
      expect(out.stdout).toBe(""); // allow_stop, NOT a block decision
      expect(out.stderr.toLowerCase()).toContain("deferred");
      // M-A3 diagnostics: name the holder so a human can identify/kill a hung one.
      expect(out.stderr).toContain(`PID ${process.pid}`);
      expect(existsSync(deferredFlagPath(repo))).toBe(true);
    } finally {
      await held.release();
    }
  });

  it("readLockHolder reports the holding pid (M-A3 diagnostics)", async () => {
    const repo = gitRepo("rg-defer-holder-");
    const held = await flock(gateLockPath(repo));
    try {
      const h = readLockHolder(gateLockPath(repo));
      expect(h?.pid).toBe(process.pid);
      expect(typeof h?.ts).toBe("string");
    } finally {
      await held.release();
    }
    expect(readLockHolder(gateLockPath(repo))).toBeNull(); // gone after release
  });

  it("a deferred.flag forces the lock path (stopHasNothingToReview returns false)", async () => {
    const repo = gitRepo("rg-defer-force-");
    await new StateStore(repo).initialise("01HDEFER02"); // last sha null → would normally skip
    writeFileSync(deferredFlagPath(repo), JSON.stringify({ ts: new Date().toISOString() }));
    expect(await stopHasNothingToReview(repo, async () => "x")).toBe(false);
  });

  it("consumes the deferred.flag once the lock is acquired (no defer loop)", async () => {
    const repo = gitRepo("rg-defer-consume-");
    await new StateStore(repo).initialise("01HDEFER03");
    writeFileSync(deferredFlagPath(repo), JSON.stringify({ ts: new Date().toISOString() }));
    const out = await runGate({ repoRoot: repo, hook: "stop", hookStdinRaw: "{}" });
    expect(out.exitCode).toBe(0);
    expect(existsSync(deferredFlagPath(repo))).toBe(false); // consumed by the review
  }, 30_000);

  it("keeps the deferred.flag when dirty-flag synthesis fails (never drops a review — codex CRITICAL)", () => {
    const repo = gitRepo("rg-defer-failsafe-");
    writeFileSync(deferredFlagPath(repo), JSON.stringify({ ts: new Date().toISOString() }));
    // Force writeFileAtomic(dirtyFlagPath) to throw: make .reviewgate read-only so the
    // per-write-unique temp file can't be created (EACCES). (writeFileAtomic now uses a
    // per-write-unique `.tmp` name, so obstructing a fixed `${path}.tmp` no longer works;
    // a dir AT dirtyFlagPath would break the not-exists assertion below. Requires non-root.)
    chmodSync(reviewgateDir(repo), 0o555);
    consumeDeferredFlag(repo);
    chmodSync(reviewgateDir(repo), 0o755);
    // Synthesis failed → the marker MUST be preserved so the next stop retries;
    // it must NOT be consumed with no dirty.flag (that would drop the review).
    expect(existsSync(deferredFlagPath(repo))).toBe(true);
    expect(existsSync(dirtyFlagPath(repo))).toBe(false);
  });

  it("handleReset clears the deferred.flag", async () => {
    const repo = gitRepo("rg-defer-reset-");
    writeFileSync(deferredFlagPath(repo), JSON.stringify({ ts: new Date().toISOString() }));
    await handleReset({ repoRoot: repo });
    expect(existsSync(deferredFlagPath(repo))).toBe(false);
  });
});

describe("lockContentionDecision — only genuine contention defers (F-002)", () => {
  it("defers on a FlockTimeoutError (real contention) and writes the marker", () => {
    const repo = gitRepo("rg-lcd-defer-");
    const out = lockContentionDecision(repo, new FlockTimeoutError("timed out"));
    expect(out.stdout).toBe(""); // allow_stop
    expect(out.stderr.toLowerCase()).toContain("deferred");
    expect(existsSync(deferredFlagPath(repo))).toBe(true);
  });

  it("FAILS CLOSED on a lock-SYSTEM error (non-timeout), never defers", () => {
    const repo = gitRepo("rg-lcd-infra-");
    const err = Object.assign(new Error("EACCES: permission denied, open lock"), {
      code: "EACCES",
    });
    const out = lockContentionDecision(repo, err);
    const parsed = JSON.parse(out.stdout || "{}") as { decision?: string };
    expect(parsed.decision).toBe("block");
    expect(existsSync(deferredFlagPath(repo))).toBe(false); // no spurious marker
  });

  it("FAILS CLOSED on contention when the deferred marker cannot be durably written", () => {
    const repo = gitRepo("rg-lcd-nomark-");
    // Force writeFileAtomic(deferredFlagPath) to throw: a DIRECTORY at the target path
    // makes the final renameSync(tmp, path) fail (EISDIR). (Per-write-unique temp names
    // mean obstructing a fixed `${path}.tmp` no longer works.)
    mkdirSync(deferredFlagPath(repo), { recursive: true });
    const out = lockContentionDecision(repo, new FlockTimeoutError("timed out"));
    const parsed = JSON.parse(out.stdout || "{}") as { decision?: string };
    expect(parsed.decision).toBe("block");
  });
});
