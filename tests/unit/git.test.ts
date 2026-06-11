// tests/unit/git.test.ts
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectDiff, collectGitInfo, gitHeadSha } from "../../src/utils/git.ts";

function commitAll(dir: string, msg: string): void {
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["-c", "user.email=e@e", "-c", "user.name=e", "commit", "-q", "-m", msg], {
    cwd: dir,
  });
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-git-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "existing.ts"), "export const a = 1;\n");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["-c", "user.email=e@e", "-c", "user.name=e", "commit", "-q", "-m", "init"], {
    cwd: dir,
  });
  return dir;
}

describe("collectDiff", () => {
  it("includes BOTH a tracked modification and an untracked new file", async () => {
    const dir = repo();
    writeFileSync(join(dir, "existing.ts"), "export const a = 2;\n"); // tracked change
    writeFileSync(join(dir, "newmod.ts"), "export const SECRET = 'x';\n"); // untracked new file
    const diff = await collectDiff(dir);
    expect(diff).toContain("diff --git a/existing.ts b/existing.ts");
    expect(diff).toContain("diff --git a/newmod.ts b/newmod.ts"); // the bug-1 fix
    expect(diff).toContain("SECRET"); // new-file content is present for the reviewer
  });

  it("reviews COMMITTED changes since a base SHA (commit-per-task), not just the working tree", async () => {
    const dir = repo();
    const base = await gitHeadSha(dir); // pre-batch HEAD
    expect(base).toMatch(/^[0-9a-f]{40}$/);
    // Agent edits AND commits (commit-per-task) → working tree is now clean.
    writeFileSync(join(dir, "feature.ts"), "export const FEATURE = 'shipped';\n");
    commitAll(dir, "feat: add feature");

    // Default (HEAD) sees NOTHING — the working tree is clean (the gap).
    expect(await collectDiff(dir)).toBe("");
    // Diffing against the pre-batch base captures the committed change.
    const sinceBase = await collectDiff(dir, base);
    expect(sinceBase).toContain("diff --git a/feature.ts b/feature.ts");
    expect(sinceBase).toContain("FEATURE");
  });

  it("includes committed AND uncommitted changes since the base", async () => {
    const dir = repo();
    const base = await gitHeadSha(dir);
    writeFileSync(join(dir, "committed.ts"), "export const C = 1;\n");
    commitAll(dir, "feat: committed");
    writeFileSync(join(dir, "wip.ts"), "export const W = 2;\n"); // uncommitted (untracked)
    const diff = await collectDiff(dir, base);
    expect(diff).toContain("committed.ts");
    expect(diff).toContain("wip.ts");
  });

  it("excludes a pre-existing untracked file (created before sinceTs), keeps a fresh one", async () => {
    const dir = repo();
    const base = await gitHeadSha(dir);
    // `old.ts` PRE-EXISTS this batch — the agent never touched it (a stray cache
    // file, a *.bak, a foreign migration). Use REAL creation-time ordering (not
    // utimes, which can't back-date ctime): old.ts is created, THEN sinceTs is
    // sampled, THEN fresh.ts is created — so only fresh.ts post-dates the batch start.
    writeFileSync(join(dir, "old.ts"), "export const OLD = 'preexisting';\n");
    await new Promise((r) => setTimeout(r, 20));
    const sinceTs = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(join(dir, "fresh.ts"), "export const FRESH = 'authored';\n");
    const diff = await collectDiff(dir, base, 60_000, sinceTs);
    expect(diff).toContain("fresh.ts");
    expect(diff).toContain("FRESH");
    expect(diff).not.toContain("old.ts");
    expect(diff).not.toContain("OLD");
    // Intentional scope exclusion is NOT an incompleteness failure.
    expect(diff).not.toContain("TRUNCATED or TIMED OUT");
  });

  it("includes a batch-created file even when its mtime was back-dated (ctime gate, F-007)", async () => {
    const dir = repo();
    const base = await gitHeadSha(dir);
    const sinceTs = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 20));
    // Created THIS batch, but mtime spoofed to long before the batch start. ctime
    // stays "now" (utimes can't back-date it) → the file must still be reviewed,
    // not silently excluded (a gate-bypass otherwise).
    writeFileSync(join(dir, "sneaky.ts"), "export const SNEAKY = 1;\n");
    const past = new Date(Date.now() - 600_000);
    utimesSync(join(dir, "sneaky.ts"), past, past);
    const diff = await collectDiff(dir, base, 60_000, sinceTs);
    expect(diff).toContain("sneaky.ts");
  });

  it("includes ALL untracked files when no sinceTs is given (legacy flag → no regression)", async () => {
    const dir = repo();
    writeFileSync(join(dir, "old.ts"), "export const OLD = 'preexisting';\n");
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(dir, "old.ts"), past, past);
    // No sinceTs → the mtime gate is inert → a brand-new module is still reviewed.
    const diff = await collectDiff(dir);
    expect(diff).toContain("old.ts");
  });

  it("appends an INCOMPLETE marker when the diff is truncated (>16 MiB), not silently partial", async () => {
    // spawnCapture caps stdout at 16 MiB. A diff past that must NOT be fed to
    // reviewers as if complete — collectDiff appends a visible incompleteness
    // marker so a "clean" partial diff isn't trusted.
    const dir = repo();
    // ~17 MiB untracked file → its --no-index diff exceeds the 16 MiB cap.
    writeFileSync(join(dir, "huge.ts"), `// ${"A".repeat(17 * 1024 * 1024)}\n`);
    const diff = await collectDiff(dir);
    expect(diff.toLowerCase()).toContain("incomplete");
  });

  it("bounds the untracked-diff loop by a wall-clock budget (skips extras when spent)", async () => {
    // The untracked `git diff --no-index` loop runs in runGate BEFORE the gate
    // self-deadline is active, so its aggregate time must be bounded. With a 0ms
    // budget the loop stops before synthesizing any untracked diff — but the
    // essential tracked diff is still produced.
    const dir = repo();
    writeFileSync(join(dir, "existing.ts"), "export const a = 5;\n"); // tracked change
    writeFileSync(join(dir, "untracked.ts"), "export const NOPE = 1;\n"); // untracked
    const diff = await collectDiff(dir, null, 0); // budget = 0 → skip untracked synthesis
    expect(diff).toContain("diff --git a/existing.ts b/existing.ts"); // tracked still present
    expect(diff).not.toContain("untracked.ts"); // untracked skipped under exhausted budget
    expect(diff.toLowerCase()).toContain("incomplete"); // …and the omission is marked, not silent
    // With the default budget the untracked file IS included (and no marker).
    const full = await collectDiff(dir);
    expect(full).toContain("untracked.ts");
    expect(full.toLowerCase()).not.toContain("incomplete");
  });

  it("includes an untracked file whose name starts with '-' (F-13: `--` separator)", async () => {
    // Without `--` before the paths, git parses `-foo.ts` as an OPTION → exit 129,
    // empty stdout, and the file silently vanishes from the review.
    const dir = repo();
    writeFileSync(join(dir, "-foo.ts"), "export const DASHED = 1;\n");
    const diff = await collectDiff(dir);
    expect(diff).toContain("DASHED");
    expect(diff.toLowerCase()).not.toContain("incomplete"); // captured cleanly, not just marked
  });

  it("marks the diff INCOMPLETE when an untracked file cannot be diffed (F-13: exit ≥2)", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root ignores 000
    const { chmodSync } = require("node:fs") as typeof import("node:fs");
    const dir = repo();
    writeFileSync(join(dir, "locked.txt"), "secret\n");
    chmodSync(join(dir, "locked.txt"), 0o000); // `git diff --no-index` → "cannot hash", exit 128
    const diff = await collectDiff(dir);
    chmodSync(join(dir, "locked.txt"), 0o644); // restore for tmpdir cleanup
    expect(diff.toLowerCase()).toContain("incomplete"); // dropped file is surfaced, not silent
  });

  it("marks the diff INCOMPLETE when the tracked diff fails with HEAD present (F-12 fail-closed)", async () => {
    const { rmSync } = require("node:fs") as typeof import("node:fs");
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const dir = repo();
    writeFileSync(join(dir, "existing.ts"), "export const a = 2;\n"); // tracked change
    // Corrupt the object store: remove the blob `git diff HEAD` must read to
    // produce the tracked diff → git exits 128 with empty stdout. Without the
    // fail-closed marker this is indistinguishable from a genuinely empty diff
    // (→ triage-skip PASS, change ships unreviewed).
    const blob = execSync("git rev-parse HEAD:existing.ts", { cwd: dir }).toString().trim();
    rmSync(join(dir, ".git", "objects", blob.slice(0, 2), blob.slice(2)), { force: true });
    const diff = await collectDiff(dir);
    expect(diff.toLowerCase()).toContain("incomplete");
  });

  it("does NOT mark a fresh repo (unborn HEAD) as incomplete (F-12 benign case)", async () => {
    // Before the first commit `git diff HEAD` fails by design; the whole working
    // tree is untracked and fully covered by the --no-index synthesis. Marking it
    // incomplete would defer-loop every pre-first-commit review.
    const dir = mkdtempSync(join(tmpdir(), "rg-git-unborn-"));
    spawnSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "first.ts"), "export const FIRST = 1;\n");
    const diff = await collectDiff(dir);
    expect(diff).toContain("FIRST");
    expect(diff.toLowerCase()).not.toContain("incomplete");
  });

  it("falls back to HEAD when the base SHA is invalid/stale", async () => {
    const dir = repo();
    writeFileSync(join(dir, "existing.ts"), "export const a = 9;\n"); // working-tree change
    const diff = await collectDiff(dir, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"); // nonexistent sha
    expect(diff).toContain("diff --git a/existing.ts b/existing.ts"); // still got the WT diff
  });

  it("excludes gitignored files (no diff header for the ignored file)", async () => {
    const dir = repo();
    writeFileSync(join(dir, ".gitignore"), "ignored.ts\n");
    writeFileSync(join(dir, "ignored.ts"), "export const SHOULD_NOT_APPEAR = 1;\n");
    const diff = await collectDiff(dir);
    // The ignored file is never reviewed: no diff block for it, and its content
    // is absent. (The .gitignore file itself IS reviewed, which is fine.)
    expect(diff).not.toContain("diff --git a/ignored.ts b/ignored.ts");
    expect(diff).not.toContain("SHOULD_NOT_APPEAR");
  });

  it("never reviews Reviewgate's own managed files (no self-review loop)", async () => {
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    const dir = repo();
    // Reviewgate scaffolding that sits permanently in the working tree:
    writeFileSync(join(dir, "reviewgate.config.ts"), "export default { providers: {} };\n");
    mkdirSync(join(dir, ".reviewgate", "bin"), { recursive: true });
    writeFileSync(join(dir, ".reviewgate", "bin", "gate"), "#!/usr/bin/env bash\n");
    // A real user file that MUST still be reviewed:
    writeFileSync(join(dir, "real.ts"), "export const x = 1;\n");
    const diff = await collectDiff(dir);
    expect(diff).toContain("diff --git a/real.ts b/real.ts"); // real file reviewed
    expect(diff).not.toContain("reviewgate.config.ts"); // own config excluded
    expect(diff).not.toContain(".reviewgate/bin/gate"); // own scaffolding excluded
  });
});

describe("collectGitInfo", () => {
  it("returns the real sha, branch, and dirty files", async () => {
    const dir = repo();
    writeFileSync(join(dir, "existing.ts"), "export const a = 2;\n");
    writeFileSync(join(dir, "newmod.ts"), "x");
    const info = await collectGitInfo(dir);
    expect(info.sha).toMatch(/^[0-9a-f]{40}$/); // real sha, not 000…
    expect(info.branch.length).toBeGreaterThan(0);
    expect(info.dirtyFiles).toContain("existing.ts");
    expect(info.dirtyFiles).toContain("newmod.ts");
  });
});
