import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGate, runGateSafe } from "../../src/cli/commands/gate.ts";
import { dirtyFlagPath } from "../../src/utils/paths.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rg-codex-protocol-"));
}

describe("Codex hook wire protocol", () => {
  it("arms the same dirty-state safety net for Codex apply_patch and Bash payloads", async () => {
    for (const payload of [
      {
        hook_event_name: "PostToolUse",
        session_id: "codex-session",
        turn_id: "turn-1",
        tool_name: "apply_patch",
        tool_input: { command: "*** Begin Patch" },
      },
      {
        hook_event_name: "PostToolUse",
        session_id: "codex-session",
        turn_id: "turn-2",
        tool_name: "Bash",
        tool_input: { command: "printf changed > src/a.ts" },
      },
    ]) {
      const repo = tmp();
      const result = await runGate({
        repoRoot: repo,
        hook: "trigger",
        hookStdinRaw: JSON.stringify(payload),
      });
      expect(result.exitCode).toBe(0);
      expect(existsSync(dirtyFlagPath(repo))).toBe(true);
      expect(JSON.parse(readFileSync(dirtyFlagPath(repo), "utf8")).diff_hash).toBeString();
    }
  });

  it("emits the Codex Stop continuation shape on fail-closed errors", async () => {
    const repo = tmp();
    const result = await runGateSafe(
      {
        repoRoot: repo,
        hook: "stop",
        hookStdinRaw: JSON.stringify({ stop_hook_active: true }),
        snapshotVerifyOpts: { dwellMs: 0 },
      },
      async () => {
        throw new Error("synthetic failure");
      },
    );
    const output = JSON.parse(result.stdout) as { decision?: string; reason?: string };
    expect(result.exitCode).toBe(0);
    expect(output.decision).toBe("block");
    expect(output.reason).toContain("GATE CLOSED");
  });

  it("accepts Codex SessionStart fields and seeds session state", async () => {
    const repo = tmp();
    writeFileSync(join(repo, "reviewgate.config.ts"), "export default {};\n");
    const result = await runGate({
      repoRoot: repo,
      hook: "reset",
      hookStdinRaw: JSON.stringify({
        hook_event_name: "SessionStart",
        source: "startup",
        session_id: "codex-session",
        cwd: repo,
        model: "gpt-5.5",
      }),
      loadConfigFn: async () =>
        (await import("../../src/config/define-config.ts")).defineConfig({}),
    });
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(repo, ".reviewgate", "state.json"))).toBe(true);
  });
});
