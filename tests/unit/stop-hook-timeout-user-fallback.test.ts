import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installedGateStopTimeoutS } from "../../src/utils/stop-hook-timeout.ts";

function dir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeStop(root: string, command: string, timeout: number): void {
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(
    join(root, ".claude", "settings.json"),
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command, timeout }] }] } }),
  );
}

// The repo timeout only counts when the repo-local gate will really fire, so the shim has
// to be a runnable regular file for that arm to be eligible at all.
function addRepoShim(repo: string, executable = true): void {
  mkdirSync(join(repo, ".reviewgate", "bin"), { recursive: true });
  const shim = join(repo, ".reviewgate", "bin", "gate");
  writeFileSync(shim, "#!/bin/sh\n");
  chmodSync(shim, executable ? 0o755 : 0o644);
}

const REPO_CMD = '"${CLAUDE_PROJECT_DIR}/.reviewgate/bin/gate"';
const userCmd = (home: string) => `'${join(home, ".reviewgate", "bin", "gate")}'`;

describe("installedGateStopTimeoutS user-scope fallback", () => {
  test("repo-local hook wins when it will actually fire", () => {
    const repo = dir("rg-tmo-repo-");
    const home = dir("rg-tmo-home-");
    writeStop(repo, REPO_CMD, 2400);
    addRepoShim(repo);
    writeStop(home, userCmd(home), 900);
    expect(installedGateStopTimeoutS(repo, home)).toBe(2400);
  });

  test("repo names the gate but its shim is GONE → the user timeout is the live one", () => {
    // The user shim RUNS in this repo (its stand-down needs the shim too), so clamping to
    // the stale repo timeout would leave the hook that actually fires unclamped — the
    // silent mid-review kill this module exists to prevent.
    const repo = dir("rg-tmo-repo-");
    const home = dir("rg-tmo-home-");
    writeStop(repo, REPO_CMD, 2400);
    writeStop(home, userCmd(home), 900);
    expect(installedGateStopTimeoutS(repo, home)).toBe(900);
  });

  test("repo shim present but NOT executable → the user timeout applies", () => {
    const repo = dir("rg-tmo-repo-");
    const home = dir("rg-tmo-home-");
    writeStop(repo, REPO_CMD, 2400);
    addRepoShim(repo, false);
    writeStop(home, userCmd(home), 900);
    expect(installedGateStopTimeoutS(repo, home)).toBe(900);
  });

  test("a repo with only a FOREIGN Stop hook falls back to the user timeout", () => {
    const repo = dir("rg-tmo-repo-");
    const home = dir("rg-tmo-home-");
    writeStop(repo, "/usr/local/bin/my-linter", 30);
    addRepoShim(repo);
    writeStop(home, userCmd(home), 900);
    expect(installedGateStopTimeoutS(repo, home)).toBe(900);
  });

  test("no reviewgate Stop hook anywhere → null (caller keeps its configured deadline)", () => {
    expect(installedGateStopTimeoutS(dir("rg-tmo-repo-"), dir("rg-tmo-home-"))).toBeNull();
  });

  test("a LEGACY repo command form still clamps rather than losing the clamp entirely", () => {
    // An older init may have written a different command spelling. Exact-matching alone
    // would report "no repo hook" and, with no user hooks installed, return null — i.e.
    // the loop would run UNCLAMPED against a real 900s OS timeout. Losing the clamp is a
    // worse failure than reading a slightly less precisely matched timeout, so the repo
    // arm tolerates any Stop command naming the gate shim.
    const repo = dir("rg-tmo-repo-");
    const home = dir("rg-tmo-home-");
    writeStop(repo, `"${join(repo, ".reviewgate", "bin", "gate")}"`, 900);
    addRepoShim(repo);
    expect(installedGateStopTimeoutS(repo, home)).toBe(900);
  });

  test("a user Stop hook with a non-positive timeout is not treated as a clamp", () => {
    const repo = dir("rg-tmo-repo-");
    const home = dir("rg-tmo-home-");
    writeStop(home, userCmd(home), 0);
    expect(installedGateStopTimeoutS(repo, home)).toBeNull();
  });
});
