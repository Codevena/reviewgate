// tests/unit/hooks.test.ts
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleReset, handleTrigger } from "../../src/hooks/handlers.ts";
import { dirtyFlagPath, stateJsonPath } from "../../src/utils/paths.ts";

function fakeRepo(): string {
  return mkdtempSync(join(tmpdir(), "rg-hooks-"));
}

describe("handleTrigger", () => {
  it("writes a dirty.flag with diff_hash + ts when PostToolUse fires", async () => {
    const repo = fakeRepo();
    const hookStdin = JSON.stringify({ tool: { name: "Edit", path: "foo.ts" } });
    await handleTrigger({ repoRoot: repo, hookStdinRaw: hookStdin });
    const p = dirtyFlagPath(repo);
    expect(existsSync(p)).toBe(true);
    const obj = JSON.parse(readFileSync(p, "utf8"));
    expect(obj.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof obj.diff_hash).toBe("string");
  });
});

describe("handleReset", () => {
  it("removes dirty.flag and state.json on SessionStart", async () => {
    const repo = fakeRepo();
    // ensure .reviewgate/ exists so writeFileSync works
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(repo, ".reviewgate"), { recursive: true });
    writeFileSync(dirtyFlagPath(repo), "{}");
    writeFileSync(stateJsonPath(repo), "{}");
    await handleReset({ repoRoot: repo });
    expect(existsSync(dirtyFlagPath(repo))).toBe(false);
    expect(existsSync(stateJsonPath(repo))).toBe(false);
  });
});
