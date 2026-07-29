import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// REAL git checkouts, never faked directories. S3's trust rule is a statement about git's
// on-disk layout — a linked worktree's `.git` is a FILE pointing at
// <main>/.git/worktrees/<name>, and `git rev-parse --git-common-dir` resolves to
// <main>/.git. A hand-built directory tree would assert nothing about that.

// A main checkout with one commit. `config` (when given) is COMMITTED, so any worktree
// added afterwards checks it out too — which is exactly the real case: policy is
// committed, the arming mechanism is not.
export async function makeMainRepo(config?: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "rg-wt-main-"));
  await Bun.$`git -C ${dir} init -q`.quiet();
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  if (config !== undefined) writeFileSync(join(dir, "reviewgate.config.ts"), config);
  await Bun.$`git -C ${dir} add -A`.quiet();
  await Bun.$`git -C ${dir} -c user.email=t@t -c user.name=t commit -q -m init`.quiet();
  return dir;
}

// A linked worktree of `main`. The target dir must not exist yet, so it is created as a
// child of a fresh mkdtemp dir.
export async function addWorktree(main: string, name = "wt"): Promise<string> {
  const dir = join(mkdtempSync(join(tmpdir(), "rg-wt-link-")), name);
  await Bun.$`git -C ${main} worktree add -q ${dir} -b ${name}`.quiet();
  return dir;
}

// A worktree whose parent is a BARE repo: `--git-common-dir` is then `<…>/x.git`, whose
// basename is NOT ".git", so there is no main checkout to inherit from. `bareDir` places
// that bare repo at a chosen path — used to park it INSIDE an armed checkout, which is
// the only case that discriminates the basename guard (without the guard, dirname() would
// resolve to that unrelated armed checkout).
export async function addWorktreeOfBare(main: string, bareDir?: string): Promise<string> {
  const bare = bareDir ?? join(mkdtempSync(join(tmpdir(), "rg-wt-bare-")), "x.git");
  await Bun.$`git clone -q --bare ${main} ${bare}`.quiet();
  const dir = join(mkdtempSync(join(tmpdir(), "rg-wt-blink-")), "wtb");
  await Bun.$`git -C ${bare} worktree add -q ${dir} -b fromBare`.quiet();
  return dir;
}
