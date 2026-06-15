// tests/unit/init-malformed-settings.test.ts
// F-001: when .claude/settings.json exists but is NOT valid JSON, init must NOT
// overwrite it with only the 3 Reviewgate hooks (that would silently destroy the
// user's permissions/env/model/foreign hooks). It must back the file up and abort.
import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../../src/cli/commands/init.ts";

function tmp() {
  return mkdtempSync(join(tmpdir(), "rg-init-malformed-"));
}

describe("runInit with a malformed settings.json", () => {
  it("backs up the unparseable file and ABORTS instead of overwriting it", async () => {
    const repo = tmp();
    const settingsDir = join(repo, ".claude");
    mkdirSync(settingsDir, { recursive: true });
    const settingsPath = join(settingsDir, "settings.json");
    // Half-saved / JSONC-with-comment: valid-looking but not strict JSON. Carries a
    // user permission that overwriting would destroy.
    const original = '{\n  "permissions": { "allow": ["Bash(npm:*)"] },\n  // trailing comment\n}';
    writeFileSync(settingsPath, original);

    let err: Error | undefined;
    try {
      await runInit({ repoRoot: repo, mode: "agent-loop" });
    } catch (e) {
      err = e as Error;
    }

    // 1. It aborted with a clear, actionable error (not a silent overwrite).
    expect(err).toBeInstanceOf(Error);
    expect(err?.message ?? "").toContain("settings.json");
    expect(err?.message ?? "").toMatch(/backed up|\.bak/);

    // 2. The original file content was NOT overwritten/destroyed — it was either
    //    left in place or moved to .bak; either way the user's permission survives.
    const bak = `${settingsPath}.bak`;
    expect(existsSync(bak)).toBe(true);
    expect(readFileSync(bak, "utf8")).toBe(original);

    // 3. settings.json does NOT now contain only the Reviewgate hooks. (After the
    //    backup move it should be gone, never silently replaced.)
    if (existsSync(settingsPath)) {
      const after = readFileSync(settingsPath, "utf8");
      expect(after).toContain("npm:*"); // user content preserved, not clobbered
    }
  });

  it("writes settings.json atomically (no leftover .tmp) on a clean install", async () => {
    const repo = tmp();
    await runInit({ repoRoot: repo, mode: "agent-loop" });
    const settingsPath = join(repo, ".claude", "settings.json");
    expect(existsSync(settingsPath)).toBe(true);
    // The atomic-write tmp sibling must not be left behind.
    expect(existsSync(`${settingsPath}.tmp`)).toBe(false);
    const s = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(JSON.stringify(s.hooks).includes(".reviewgate/bin/")).toBe(true);
  });
});
