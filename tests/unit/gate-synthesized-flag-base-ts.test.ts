// tests/unit/gate-synthesized-flag-base-ts.test.ts
//
// F-15: the two dirty.flag SYNTHESIS paths (consumeDeferredFlag + the
// HEAD-advanced trigger in gatherReviewContext) wrote base_sha but NO base_ts.
// The next handleTrigger then back-dated base_ts only 30s from the fix edit —
// pairing an OLD review base with a FRESH batch-start time, which silently
// scoped batch-created untracked files out of the re-review. Post-fix both
// paths persist an explicit epoch-0 "no untracked scoping" sentinel.
import { describe, expect, it } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consumeDeferredFlag, runGate } from "../../src/cli/commands/gate.ts";
import { StateStore } from "../../src/core/state-store.ts";
import { BASE_TS_NO_SCOPING_SENTINEL } from "../../src/hooks/handlers.ts";
import { CodexAdapter } from "../../src/providers/codex.ts";
import { deferredFlagPath, dirtyFlagPath, reviewgateDir } from "../../src/utils/paths.ts";

const FAKE_CODEX = join(process.cwd(), "tests/fixtures/fake-codex.sh");

function gitRepo(prefix: string): string {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
  writeFileSync(join(repo, "foo.ts"), "function compare(a, b) { return a == b; }");
  execSync("git init -q && git add foo.ts && git commit -q -m init", {
    cwd: repo,
    env,
    stdio: "ignore",
  });
  mkdirSync(reviewgateDir(repo), { recursive: true });
  return repo;
}

function headSha(repo: string): string {
  return execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
}

describe("synthesized dirty.flag carries an explicit base_ts (F-15)", () => {
  it("consumeDeferredFlag synthesis writes the no-scoping sentinel", async () => {
    const repo = gitRepo("rg-synth-defer-");
    const base = headSha(repo);
    const st = new StateStore(repo);
    await st.initialise("01HXF15DEFER");
    await st.update((c) => ({ ...c, last_reviewed_head_sha: base }));
    writeFileSync(deferredFlagPath(repo), JSON.stringify({ ts: new Date().toISOString() }));
    consumeDeferredFlag(repo);
    expect(existsSync(dirtyFlagPath(repo))).toBe(true);
    const flag = JSON.parse(readFileSync(dirtyFlagPath(repo), "utf8")) as {
      base_sha?: string;
      base_ts?: string;
    };
    expect(flag.base_sha).toBe(base);
    expect(flag.base_ts).toBe(BASE_TS_NO_SCOPING_SENTINEL);
  });

  it("HEAD-advanced trigger synthesis writes the no-scoping sentinel", async () => {
    const repo = gitRepo("rg-synth-headadv-");
    const base = headSha(repo);
    const st = new StateStore(repo);
    await st.initialise("01HXF15HEADADV");
    await st.update((c) => ({ ...c, last_reviewed_head_sha: base }));
    // Commit via git (no Edit/Write → no PostToolUse → no dirty.flag): the gate
    // synthesizes the trigger with base = last reviewed sha.
    writeFileSync(join(repo, "foo.ts"), "function compare(a, b) { return a === b; } // bash");
    execSync("git add foo.ts && git commit -q -m change", {
      cwd: repo,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
      stdio: "ignore",
    });
    expect(existsSync(dirtyFlagPath(repo))).toBe(false);
    const out = await runGate({
      repoRoot: repo,
      hook: "stop",
      hookStdinRaw: "{}",
      providerOverrides: { codex: new CodexAdapter({ binPath: FAKE_CODEX }) },
      sandboxModeOverride: "off",
    });
    expect(out.exitCode).toBe(0);
    // fake-codex emits a finding → the iteration FAILs/blocks, so the synthesized
    // flag persists on disk for inspection.
    expect(existsSync(dirtyFlagPath(repo))).toBe(true);
    const flag = JSON.parse(readFileSync(dirtyFlagPath(repo), "utf8")) as {
      base_sha?: string;
      base_ts?: string;
    };
    expect(flag.base_sha).toBe(base);
    expect(flag.base_ts).toBe(BASE_TS_NO_SCOPING_SENTINEL);
  }, 60_000);
});
