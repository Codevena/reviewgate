// tests/unit/handlers-session-manifest.test.ts
//
// Slice A (P1): the SessionStart/PostToolUse hooks parse session_id from stdin and maintain
// the per-session ownership manifest. Verifies handleReset captures the baseline and
// handleTrigger records owned paths (incl. MultiEdit/NotebookEdit shapes + absolute→relative),
// and that an absent session_id fails closed (no manifest → full review downstream).
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSessionManifest } from "../../src/core/session-manifest.ts";
import { handleReset, handleTrigger } from "../../src/hooks/handlers.ts";

function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-hsm-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync(
    "git",
    ["-c", "user.email=e@e", "-c", "user.name=e", "commit", "-q", "--allow-empty", "-m", "init"],
    {
      cwd: dir,
    },
  );
  return dir;
}

describe("hook wiring: session ownership manifest", () => {
  test("handleReset captures the dirty baseline keyed by the SessionStart session_id", async () => {
    const repo = tmpRepo();
    writeFileSync(join(repo, "tracked.ts"), "export const a = 1;\n");
    spawnSync("git", ["add", "-A"], { cwd: repo });
    spawnSync("git", ["-c", "user.email=e@e", "-c", "user.name=e", "commit", "-q", "-m", "c"], {
      cwd: repo,
    });
    // A parallel agent left it dirty before our session starts.
    writeFileSync(join(repo, "tracked.ts"), "export const a = 2;\n");

    await handleReset({
      repoRoot: repo,
      hookStdinRaw: JSON.stringify({ session_id: "sid-1", source: "startup", cwd: repo }),
    });
    const m = readSessionManifest(repo, "sid-1");
    expect(m?.session_id).toBe("sid-1");
    expect(m?.baseline["tracked.ts"]).toBeDefined();
  });

  test("handleReset with NO session_id writes no manifest (manual reset / older CLI)", async () => {
    const repo = tmpRepo();
    await handleReset({ repoRoot: repo, hookStdinRaw: "" });
    expect(readSessionManifest(repo, "anything")).toBeNull();
  });

  test("handleTrigger records Edit/MultiEdit/NotebookEdit paths (absolute → repo-relative)", async () => {
    const repo = tmpRepo();
    await handleReset({
      repoRoot: repo,
      hookStdinRaw: JSON.stringify({ session_id: "sid-2", source: "startup" }),
    });
    // Write tool (absolute path)
    await handleTrigger({
      repoRoot: repo,
      hookStdinRaw: JSON.stringify({
        session_id: "sid-2",
        tool_name: "Write",
        tool_input: { file_path: join(repo, "src/a.ts") },
      }),
    });
    // MultiEdit (edits[].file_path)
    await handleTrigger({
      repoRoot: repo,
      hookStdinRaw: JSON.stringify({
        session_id: "sid-2",
        tool_name: "MultiEdit",
        tool_input: { edits: [{ file_path: "src/b.ts" }, { file_path: "src/c.ts" }] },
      }),
    });
    // NotebookEdit (notebook_path)
    await handleTrigger({
      repoRoot: repo,
      hookStdinRaw: JSON.stringify({
        session_id: "sid-2",
        tool_name: "NotebookEdit",
        tool_input: { notebook_path: "nb.ipynb" },
      }),
    });
    const owned = readSessionManifest(repo, "sid-2")?.owned ?? [];
    expect(owned).toContain("src/a.ts"); // absolute normalized to repo-relative (M10)
    expect(owned).toContain("src/b.ts");
    expect(owned).toContain("src/c.ts");
    expect(owned).toContain("nb.ipynb");
    // No absolute path leaked into the manifest.
    expect(owned.some((p) => p.startsWith("/"))).toBe(false);
  });

  test("handleTrigger for a non-edit tool (Bash) records nothing", async () => {
    const repo = tmpRepo();
    await handleReset({
      repoRoot: repo,
      hookStdinRaw: JSON.stringify({ session_id: "sid-3", source: "startup" }),
    });
    await handleTrigger({
      repoRoot: repo,
      hookStdinRaw: JSON.stringify({
        session_id: "sid-3",
        tool_name: "Bash",
        tool_input: { command: "sed -i s/a/b/ src/x.ts" },
      }),
    });
    expect(readSessionManifest(repo, "sid-3")?.owned ?? []).toHaveLength(0);
  });
});
