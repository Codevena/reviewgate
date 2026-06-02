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

// runTimeoutMs = 840_000 (840s) in defaultConfig.
describe("hookTimeoutCheck", () => {
  it("warns when the Stop-hook timeout is <= the gate self-deadline (fail-open risk)", () => {
    const repo = repoWithSettings({
      hooks: { Stop: [stopHook(180)], SessionStart: [sessionStartHook(30)] },
    });
    const c = hookTimeoutCheck(repo, defaultConfig);
    expect(c?.status).toBe("warn");
    expect(c?.detail.toLowerCase()).toContain("fail-open");
  });

  it("is ok when the Stop-hook timeout exceeds the self-deadline AND SessionStart is bounded", () => {
    const repo = repoWithSettings({
      hooks: { Stop: [stopHook(900)], SessionStart: [sessionStartHook(30)] },
    });
    const c = hookTimeoutCheck(repo, defaultConfig);
    expect(c?.status).toBe("ok");
  });

  it("warns when the SessionStart hook has no timeout", () => {
    const repo = repoWithSettings({
      hooks: { Stop: [stopHook(900)], SessionStart: [sessionStartHook(undefined)] },
    });
    const c = hookTimeoutCheck(repo, defaultConfig);
    expect(c?.status).toBe("warn");
  });

  it("returns null when reviewgate hooks are not installed (nothing to check)", () => {
    const repo = repoWithSettings({ hooks: {} });
    expect(hookTimeoutCheck(repo, defaultConfig)).toBeNull();
  });
});
