// tests/unit/hooks.test.ts
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../../src/core/state-store.ts";
import { handleReset, handleTrigger } from "../../src/hooks/handlers.ts";
import { dirtyFlagPath, stateJsonPath } from "../../src/utils/paths.ts";

function fakeRepo(): string {
  return mkdtempSync(join(tmpdir(), "rg-hooks-"));
}

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-hooks-git-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "a.ts"), "1\n");
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["-c", "user.email=e@e", "-c", "user.name=e", "commit", "-q", "-m", "init"], {
    cwd: dir,
  });
  return dir;
}
function headSha(dir: string): string {
  return spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();
}
function commit(dir: string, file: string): void {
  writeFileSync(join(dir, file), "x\n");
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["-c", "user.email=e@e", "-c", "user.name=e", "commit", "-q", "-m", file], {
    cwd: dir,
  });
}
const flag = (dir: string) => JSON.parse(readFileSync(dirtyFlagPath(dir), "utf8"));

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

  it("captures base_sha = HEAD at the clean→dirty transition", async () => {
    const repo = gitRepo();
    const base = headSha(repo);
    await handleTrigger({ repoRoot: repo, hookStdinRaw: "{}" });
    expect(flag(repo).base_sha).toBe(base);
  });

  it("PRESERVES base_sha across later edits even after a mid-batch commit", async () => {
    const repo = gitRepo();
    const base = headSha(repo);
    await handleTrigger({ repoRoot: repo, hookStdinRaw: "{}" }); // first edit → base captured
    commit(repo, "feature.ts"); // agent commits mid-batch → HEAD moves
    expect(headSha(repo)).not.toBe(base);
    await handleTrigger({ repoRoot: repo, hookStdinRaw: "{}" }); // next edit
    // base must still point at the PRE-batch HEAD, so `git diff base` sees the commit.
    expect(flag(repo).base_sha).toBe(base);
  });

  it("omits base_sha gracefully outside a git repo", async () => {
    const repo = fakeRepo();
    await handleTrigger({ repoRoot: repo, hookStdinRaw: "{}" });
    expect(flag(repo).base_sha).toBeUndefined();
  });
});

describe("handleReset", () => {
  it("removes dirty.flag and re-seeds state.json fresh on SessionStart", async () => {
    const repo = fakeRepo();
    // ensure .reviewgate/ exists so writeFileSync works
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(repo, ".reviewgate"), { recursive: true });
    writeFileSync(dirtyFlagPath(repo), "{}");
    writeFileSync(stateJsonPath(repo), "{}");
    await handleReset({ repoRoot: repo });
    expect(existsSync(dirtyFlagPath(repo))).toBe(false);
    // S1: state.json is no longer left ABSENT — the reset re-seeds a fresh
    // state (reviewed-through markers) so the very next Stop has an honest
    // baseline instead of an unconditional last===null fast-exit
    // (core-loop#2). It must be the fresh schema-valid state, not the stale
    // "{}" stub written above.
    expect(existsSync(stateJsonPath(repo))).toBe(true);
    const st = JSON.parse(readFileSync(stateJsonPath(repo), "utf8"));
    expect(st.iteration).toBe(0);
  });

  it("seeds last_reviewed_head_sha and last_reviewed_tree_hash (S1)", async () => {
    const repo = gitRepo();
    await handleReset({ repoRoot: repo });
    const st = await new StateStore(repo).load();
    expect(st.last_reviewed_head_sha).not.toBeNull(); // = current HEAD
    expect(st.last_reviewed_tree_hash).not.toBeNull();
  });

  it("clears ALL escalation metadata (round-5 C1)", async () => {
    const repo = gitRepo();
    const state = new StateStore(repo);
    await state.initialise("01HRESETESC1");
    await state.update((cur) => ({
      ...cur,
      escalated: true,
      escalation_announced: true,
      escalation_reason: "max-iterations",
      escalated_head_sha: "H1",
      escalated_tree_hash: "T",
    }));
    await handleReset({ repoRoot: repo });
    const st = await new StateStore(repo).load();
    expect(st.escalated).toBe(false);
    expect(st.escalation_reason).toBeNull();
    expect(st.escalation_announced).toBe(false);
    expect(st.escalated_head_sha).toBeNull();
    expect(st.escalated_tree_hash).toBeNull();
  });
});
