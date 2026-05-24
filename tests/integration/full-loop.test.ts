// tests/integration/full-loop.test.ts
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGate } from "../../src/cli/commands/gate.ts";
import { runInit } from "../../src/cli/commands/init.ts";
import { StateStore } from "../../src/core/state-store.ts";
import { CodexAdapter } from "../../src/providers/codex.ts";

function sha(repo: string): string {
  return spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
}
function commit(repo: string, content: string): void {
  writeFileSync(join(repo, "foo.ts"), content);
  spawnSync("git", ["add", "-A"], { cwd: repo });
  spawnSync("git", ["-c", "user.email=x@x", "-c", "user.name=x", "commit", "-q", "-m", "change"], {
    cwd: repo,
  });
}

const FAKE_CODEX = join(process.cwd(), "tests/fixtures/fake-codex.sh");

function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-loop-it-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "foo.ts"), "function compare(a, b) { return a == b; }");
  spawnSync("git", ["add", "foo.ts"], { cwd: dir });
  spawnSync("git", ["-c", "user.email=x@x", "-c", "user.name=x", "commit", "-q", "-m", "init"], {
    cwd: dir,
  });
  return dir;
}

describe("full loop integration", () => {
  it("init → trigger → gate (block) → decisions → gate (pass)", async () => {
    const repo = tmpRepo();
    await runInit({ repoRoot: repo, mode: "agent-loop" });

    // 1. Simulate PostToolUse: write a dirty.flag.
    const triggerOut = await runGate({
      repoRoot: repo,
      hook: "trigger",
      hookStdinRaw: JSON.stringify({ tool: { name: "Edit", path: "foo.ts" } }),
      providerOverrides: { codex: new CodexAdapter({ binPath: FAKE_CODEX }) },
      sandboxModeOverride: "off",
    });
    expect(triggerOut.exitCode).toBe(0);

    // 2. First Stop hook: should BLOCK because findings exist and no decisions yet.
    const firstStop = await runGate({
      repoRoot: repo,
      hook: "stop",
      hookStdinRaw: "{}",
      providerOverrides: { codex: new CodexAdapter({ binPath: FAKE_CODEX }) },
      sandboxModeOverride: "off",
    });
    expect(firstStop.exitCode).toBe(0);
    const firstDecision = JSON.parse(firstStop.stdout);
    expect(firstDecision.decision).toBe("block");
    expect(existsSync(join(repo, ".reviewgate", "pending.md"))).toBe(true);
    // Rich block message: severity + per-reviewer breakdown (not just a bare count).
    expect(firstDecision.reason).toContain("reviewers: codex");
    expect(firstDecision.reason).toMatch(/CRITICAL|WARN|INFO/);

    // 3. Claude "fixes" the issue and writes decisions/1.jsonl (using the F-001 ID
    //    emitted by fake-codex.sh).
    const decisionsDir = join(repo, ".reviewgate", "decisions");
    spawnSync("mkdir", ["-p", decisionsDir]);
    writeFileSync(
      join(decisionsDir, "1.jsonl"),
      `${JSON.stringify({
        schema: "reviewgate.decision.v1",
        finding_id: "F-001",
        verdict: "accepted",
        action: "fixed",
        files_touched: ["foo.ts"],
      })}\n`,
    );

    // Touch the dirty.flag again to simulate a follow-up edit.
    await runGate({
      repoRoot: repo,
      hook: "trigger",
      hookStdinRaw: JSON.stringify({ tool: { name: "Edit", path: "foo.ts" } }),
      providerOverrides: { codex: new CodexAdapter({ binPath: FAKE_CODEX }) },
      sandboxModeOverride: "off",
    });

    // 4. Second Stop hook with decisions present: the decisions-gate must
    //    ACCEPT decisions/1.jsonl (which covers finding F-001) and proceed to
    //    run a NEW iteration (iter 2). fake-codex always emits one CRITICAL,
    //    so iter 2 also FAILs and blocks — but the key proof is that the gate
    //    did NOT block on the decisions-check: iteration advanced to 2.
    //    (Regression guard: an earlier bug compared signatures against
    //    finding_id and would have blocked here, leaving iteration at 1.)
    const secondStop = await runGate({
      repoRoot: repo,
      hook: "stop",
      hookStdinRaw: "{}",
      providerOverrides: { codex: new CodexAdapter({ binPath: FAKE_CODEX }) },
      sandboxModeOverride: "off",
    });
    expect(secondStop.exitCode).toBe(0);
    const state = JSON.parse(readFileSync(join(repo, ".reviewgate", "state.json"), "utf8"));
    expect(state.iteration).toBe(2);
  });

  it("reviews committed work that arrived WITHOUT an Edit/Write (HEAD-advanced trigger)", async () => {
    // Simulates a `git merge`/`git commit` via Bash (or a worktree merge): HEAD
    // moves past the last reviewed sha with NO dirty.flag. The gate must still
    // review it (synthesize the trigger), not silently allow the turn.
    const repo = tmpRepo();
    await runInit({ repoRoot: repo, mode: "agent-loop" });
    const base = sha(repo); // "last reviewed" baseline
    const st = new StateStore(repo);
    await st.initialise("01HXQHEADADV");
    await st.update((c) => ({ ...c, last_reviewed_head_sha: base }));

    // Commit a change via git (no Edit/Write tool → no PostToolUse → no dirty.flag).
    commit(repo, "function compare(a, b) { return a == b; } // committed via bash");
    expect(sha(repo)).not.toBe(base);
    expect(existsSync(join(repo, ".reviewgate", "dirty.flag"))).toBe(false);

    const stop = await runGate({
      repoRoot: repo,
      hook: "stop",
      hookStdinRaw: "{}",
      providerOverrides: { codex: new CodexAdapter({ binPath: FAKE_CODEX }) },
      sandboxModeOverride: "off",
    });
    // fake-codex always emits a finding → if the committed work was reviewed, BLOCK.
    const decision = JSON.parse(stop.stdout || "{}");
    expect(decision.decision).toBe("block");
    expect(existsSync(join(repo, ".reviewgate", "pending.md"))).toBe(true);
  });

  it("does NOT review when HEAD == last reviewed and there is no dirty.flag (no false trigger)", async () => {
    const repo = tmpRepo();
    await runInit({ repoRoot: repo, mode: "agent-loop" });
    const head = sha(repo);
    const st = new StateStore(repo);
    await st.initialise("01HXQNOADV");
    await st.update((c) => ({ ...c, last_reviewed_head_sha: head }));

    const stop = await runGate({
      repoRoot: repo,
      hook: "stop",
      hookStdinRaw: "{}",
      providerOverrides: { codex: new CodexAdapter({ binPath: FAKE_CODEX }) },
      sandboxModeOverride: "off",
    });
    expect(stop.stdout).toBe(""); // allow_stop (no block JSON)
    expect(stop.stderr).toContain("No code changes");
  });
});
