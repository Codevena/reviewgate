// tests/unit/gate-rebase-base.test.ts
//
// M-A5 — review-base drift on rebase (I-12). The pre-batch base_sha captured in
// dirty.flag becomes invalid after a rebase (history rewritten): it is no longer
// an ancestor of HEAD, so `git diff base_sha..HEAD` pulls in the foreign commits
// the rebase landed (e.g. a parallel merged PR), blocking the agent's small change
// with findings in code it never touched. resolveReviewBase detects this (base not
// an ancestor of HEAD) and re-bases the review on the branch's upstream divergence
// point (rebase-stable), falling back to working-tree-only when there's no upstream.
import { describe, expect, it } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveReviewBase } from "../../src/cli/commands/gate.ts";
import { isAncestor, mergeBaseUpstream } from "../../src/utils/git.ts";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
function sh(repo: string, cmd: string): string {
  return execSync(cmd, { cwd: repo, env: GIT_ENV, stdio: ["ignore", "pipe", "ignore"] })
    .toString()
    .trim();
}
function commit(repo: string, file: string, msg: string): string {
  writeFileSync(join(repo, file), `${msg}\n`);
  sh(repo, `git add -A && git commit -q -m ${JSON.stringify(msg)}`);
  return sh(repo, "git rev-parse HEAD");
}

describe("resolveReviewBase", () => {
  it("returns null unchanged (no captured base → working-tree review)", async () => {
    expect(await resolveReviewBase("/repo", null, { isAncestor: async () => true })).toBeNull();
  });

  it("keeps the base when it is still an ancestor of HEAD (normal, no rebase)", async () => {
    const out = await resolveReviewBase("/repo", "base111", {
      isAncestor: async () => true,
      mergeBaseUpstream: async () => "should-not-be-used",
    });
    expect(out).toBe("base111");
  });

  it("re-bases on the upstream divergence point when the base is no longer an ancestor (rebase)", async () => {
    const out = await resolveReviewBase("/repo", "stalebase", {
      isAncestor: async () => false, // base no longer an ancestor of HEAD → rebase
      mergeBaseUpstream: async () => "forkpoint999",
    });
    expect(out).toBe("forkpoint999"); // foreign commits excluded
  });

  it("over-reviews from the common ancestor (NEVER working-tree-only) when rebased with no upstream", async () => {
    // Must not drop committed branch-owned work → never narrow to null here.
    const out = await resolveReviewBase("/repo", "stalebase", {
      isAncestor: async () => false,
      mergeBaseUpstream: async () => null,
      mergeBase: async () => "common777",
    });
    expect(out).toBe("common777");
  });

  it("returns null (NOT the non-ancestor stale base) when there is no common ancestor either", async () => {
    // A non-ancestor base would make `git diff base..HEAD` a tree-compare that can
    // hide real changes — never return it. null → working-tree-only is the safe last resort.
    const out = await resolveReviewBase("/repo", "stalebase", {
      isAncestor: async () => false,
      mergeBaseUpstream: async () => null,
      mergeBase: async () => null,
    });
    expect(out).toBeNull();
  });
});

describe("M-A5 against real git (a rebase makes the captured base stale)", () => {
  it("detects the stale base and re-bases the review on the upstream divergence point", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-rebase-"));
    sh(repo, "git init -q -b main");
    commit(repo, "a.txt", "A"); // main @ A
    sh(repo, "git checkout -q -b feature");
    sh(repo, "git branch -q --set-upstream-to=main feature"); // @{u} = main
    const bOld = commit(repo, "b.txt", "B"); // feature's own commit (pre-rebase sha)

    // A parallel batch lands FOREIGN commits on main, then feature is rebased onto it.
    sh(repo, "git checkout -q main");
    commit(repo, "f1.txt", "F1");
    const f2 = commit(repo, "f2.txt", "F2"); // new upstream tip
    sh(repo, "git checkout -q feature");
    sh(repo, "git rebase -q main"); // replays B on top of F2 → bOld is now orphaned

    // The captured pre-rebase base (bOld) is no longer an ancestor of HEAD.
    expect(await isAncestor(repo, bOld, "HEAD")).toBe(false);
    // The upstream divergence point is the new main tip (F2) — foreign commits excluded.
    expect(await mergeBaseUpstream(repo)).toBe(f2);
    // resolveReviewBase with the real git helpers re-bases off the stale bOld → F2.
    expect(await resolveReviewBase(repo, bOld)).toBe(f2);
    // Sanity: a still-valid base (F2 IS an ancestor of HEAD) is kept unchanged.
    expect(await resolveReviewBase(repo, f2)).toBe(f2);
  }, 20_000);

  it("does NOT under-review committed work when HEAD is the integration branch (amend on main, no remote)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-amend-"));
    sh(repo, "git init -q -b main");
    const a = commit(repo, "a.txt", "A");
    const bOld = commit(repo, "b.txt", "B"); // committed work, sha B
    // Amend B → C: rewrites the last commit, so bOld is no longer an ancestor of HEAD.
    writeFileSync(join(repo, "b.txt"), "B-amended\n");
    sh(repo, 'git add -A && git commit -q --amend -m "B2"');
    const c = sh(repo, "git rev-parse HEAD");
    expect(await isAncestor(repo, bOld, "HEAD")).toBe(false);
    // merge-base(HEAD, main) would be HEAD (main IS HEAD) → must be skipped, else the
    // diff is empty and the committed amend is never reviewed. Expect the common
    // ancestor A instead, so diff(A..C) reviews the committed (amended) work.
    const resolved = await resolveReviewBase(repo, bOld);
    expect(resolved).not.toBe(c); // never HEAD (would empty the diff)
    expect(resolved).toBe(a); // common ancestor → committed work IS reviewed
  }, 20_000);

  it("uses the INTEGRATION branch, not the feature's own upstream (partial origin/<feature> must not drop committed work)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-upstream-"));
    sh(repo, "git init -q -b main");
    commit(repo, "a.txt", "A");
    sh(repo, "git checkout -q -b feature");
    commit(repo, "c.txt", "C");
    commit(repo, "d.txt", "D");
    // Foreign commits land on main; feature is rebased onto them.
    sh(repo, "git checkout -q main");
    commit(repo, "f1.txt", "F1");
    const f2 = commit(repo, "f2.txt", "F2");
    sh(repo, "git checkout -q feature");
    sh(repo, "git rebase -q main"); // → C', D' replayed on F2
    const cNew = sh(repo, "git rev-parse HEAD~1"); // C' (only this got "pushed")
    // Simulate @{u} = origin/feature pointing at the PARTIAL replayed C'.
    sh(repo, "git remote add origin .");
    sh(repo, "git config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'");
    sh(repo, `git update-ref refs/remotes/origin/feature ${cNew}`);
    sh(repo, "git branch -q --set-upstream-to=origin/feature feature");
    // The feature upstream (C') would, if used, drop C' from review. The fix must
    // use the integration branch (main → F2) so BOTH C' and D' are reviewed.
    const base = await mergeBaseUpstream(repo);
    expect(base).toBe(f2);
    expect(base).not.toBe(cNew);
  }, 20_000);
});
