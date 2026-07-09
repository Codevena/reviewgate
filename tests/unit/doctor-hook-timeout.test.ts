// tests/unit/doctor-hook-timeout.test.ts
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookTimeoutCheck } from "../../src/cli/commands/doctor.ts";
import { defaultConfig } from "../../src/config/defaults.ts";

function repoWithSettings(settings: unknown): string {
  const repo = mkdtempSync(join(tmpdir(), "rg-hooktimeout-"));
  mkdirSync(join(repo, ".claude"), { recursive: true });
  writeFileSync(join(repo, ".claude", "settings.json"), JSON.stringify(settings));
  return repo;
}

const stopHook = (timeout?: number) => ({
  matcher: "*",
  hooks: [
    {
      type: "command",
      command: "${CLAUDE_PROJECT_DIR}/.reviewgate/bin/gate",
      ...(timeout !== undefined ? { timeout } : {}),
    },
  ],
});
const sessionStartHook = (timeout?: number) => ({
  hooks: [
    {
      type: "command",
      command: "${CLAUDE_PROJECT_DIR}/.reviewgate/bin/reset",
      ...(timeout !== undefined ? { timeout } : {}),
    },
  ],
});

// runTimeoutMs = 1_800_000 (1800s) in defaultConfig (deadline-aware budgeting;
// was 720s — see docs/superpowers/plans/2026-07-09-deadline-aware-gate-budgeting.md).
describe("hookTimeoutCheck", () => {
  it("warns when the Stop-hook timeout is <= the gate self-deadline (fail-open risk)", () => {
    const repo = repoWithSettings({
      hooks: { Stop: [stopHook(180)], SessionStart: [sessionStartHook(30)] },
    });
    const c = hookTimeoutCheck(repo, defaultConfig);
    expect(c?.status).toBe("warn");
    expect(c?.detail.toLowerCase()).toContain("fail-open");
  });

  it("warns when the Stop-hook timeout exceeds the self-deadline but leaves too little setup margin (M-A0.4)", () => {
    // 1840s > 1800s self-deadline (no fail-open) but only 40s margin for the
    // pre-deadline setup work (config + git + state load can take far longer
    // under index.lock contention → OS kill mid-run → fail-open).
    const repo = repoWithSettings({
      hooks: { Stop: [stopHook(1840)], SessionStart: [sessionStartHook(30)] },
    });
    const c = hookTimeoutCheck(repo, defaultConfig);
    expect(c?.status).toBe("warn");
    expect(c?.detail.toLowerCase()).toContain("margin");
  });

  it("warns at the EXACT margin boundary (margin == setup+settle leaves no teardown slack)", () => {
    // runTimeoutMs 1800s + setup 120s + settle 30s = 1950s. A Stop-hook timeout
    // of exactly 1950s leaves ZERO slack for post-settle state/audit/stdout work →
    // can still tip into an OS-kill / empty-stdout fail-open at the boundary. The
    // invariant is STRICT (<), so margin == 150 must warn, not pass.
    const repo = repoWithSettings({
      hooks: { Stop: [stopHook(1950)], SessionStart: [sessionStartHook(30)] },
    });
    const c = hookTimeoutCheck(repo, defaultConfig);
    expect(c?.status).toBe("warn");
    expect(c?.detail.toLowerCase()).toContain("margin");
  });

  it("is ok when the Stop-hook timeout exceeds the self-deadline AND SessionStart is bounded", () => {
    // 2400s = what init writes (1950s invariant + slack).
    const repo = repoWithSettings({
      hooks: { Stop: [stopHook(2400)], SessionStart: [sessionStartHook(30)] },
    });
    const c = hookTimeoutCheck(repo, defaultConfig);
    expect(c?.status).toBe("ok");
  });

  it("warns when the SessionStart hook has no timeout", () => {
    const repo = repoWithSettings({
      hooks: { Stop: [stopHook(2400)], SessionStart: [sessionStartHook(undefined)] },
    });
    const c = hookTimeoutCheck(repo, defaultConfig);
    expect(c?.status).toBe("warn");
  });

  it("returns null when reviewgate hooks are not installed (nothing to check)", () => {
    const repo = repoWithSettings({ hooks: {} });
    expect(hookTimeoutCheck(repo, defaultConfig)).toBeNull();
  });
});
