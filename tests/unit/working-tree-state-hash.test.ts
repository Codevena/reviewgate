// tests/unit/working-tree-state-hash.test.ts
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workingTreeStateHash } from "../../src/utils/git.ts";

async function initRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "rg-wtsh-"));
  await Bun.$`git -C ${dir} init -q`.quiet();
  await Bun.$`git -C ${dir} -c user.email=t@t -c user.name=t commit -q --allow-empty -m init`.quiet();
  return dir;
}

describe("workingTreeStateHash", () => {
  test("clean tree hashes stably; a new untracked file changes the hash", async () => {
    const dir = await initRepo();
    const clean1 = await workingTreeStateHash(dir);
    const clean2 = await workingTreeStateHash(dir);
    expect(clean1).not.toBeNull();
    expect(clean1).toBe(clean2);
    writeFileSync(join(dir, "evil.ts"), "x\n");
    expect(await workingTreeStateHash(dir)).not.toBe(clean1);
  });

  test("excluded paths (.reviewgate state writes) do NOT change the hash", async () => {
    const dir = await initRepo();
    const clean = await workingTreeStateHash(dir);
    mkdirSync(join(dir, ".reviewgate"), { recursive: true });
    writeFileSync(join(dir, ".reviewgate", "state.json"), "{}");
    expect(await workingTreeStateHash(dir)).toBe(clean);
  });

  test("a tracked-file modification changes the hash", async () => {
    const dir = await initRepo();
    writeFileSync(join(dir, "a.ts"), "1\n");
    await Bun.$`git -C ${dir} add a.ts`.quiet();
    await Bun.$`git -C ${dir} -c user.email=t@t -c user.name=t commit -q -m a`.quiet();
    const clean = await workingTreeStateHash(dir);
    writeFileSync(join(dir, "a.ts"), "2\n");
    expect(await workingTreeStateHash(dir)).not.toBe(clean);
  });

  // Round-3 C1: the fingerprint must be CONTENT-true, not status/path-true.
  test("a SECOND edit to an already-modified file changes the hash (M→M)", async () => {
    const dir = await initRepo();
    writeFileSync(join(dir, "a.ts"), "1\n");
    await Bun.$`git -C ${dir} add a.ts`.quiet();
    await Bun.$`git -C ${dir} -c user.email=t@t -c user.name=t commit -q -m a`.quiet();
    writeFileSync(join(dir, "a.ts"), "2\n"); // tree now dirty: M a.ts
    const dirty1 = await workingTreeStateHash(dir); // recorded post-review
    writeFileSync(join(dir, "a.ts"), "3\n"); // Bash edits it AGAIN
    expect(await workingTreeStateHash(dir)).not.toBe(dirty1); // status line identical, content not
  });

  test("an UNTRACKED file's content change (same path) changes the hash (??→??)", async () => {
    const dir = await initRepo();
    writeFileSync(join(dir, "new.ts"), "v1\n");
    const dirty1 = await workingTreeStateHash(dir);
    writeFileSync(join(dir, "new.ts"), "v2\n");
    expect(await workingTreeStateHash(dir)).not.toBe(dirty1);
  });

  // Round-5 W3: over-cap trees fall back to a stable metadata fingerprint.
  // Hermetic via the injectable cap (round-10 I1) — no giant fixture files.
  //
  // ADAPTED from the brief: collectDiff's aggregate untrackedByteCap check runs
  // BEFORE spawning the diff for the file about to be processed (checked against
  // bytes accumulated from PRIOR files), not after — verified empirically against
  // the real collectDiff. A single oversized untracked file therefore does NOT
  // trip DIFF_INCOMPLETE_MARKER (its own diff is never pre-checked against the
  // cap); a second, later-sorted untracked file is required so the cap check
  // (now seeing the first file's accumulated bytes) skips it and marks the diff
  // incomplete. "a-*"/"b-*" naming pins `git ls-files -z` ordering so the large
  // file is processed first.
  test("truncated diff falls back to 'meta:' fingerprint — stable AND edit-sensitive", async () => {
    const dir = await initRepo();
    writeFileSync(join(dir, "a-new.ts"), "0123456789".repeat(10)); // 100 bytes > tiny cap
    writeFileSync(join(dir, "b-new.ts"), "z"); // trips the cap once "a-new.ts" is counted
    const cap = { untrackedByteCap: 10 };
    const h1 = await workingTreeStateHash(dir, cap);
    const h2 = await workingTreeStateHash(dir, cap);
    expect(h1).toStartWith("meta:");
    expect(h1).toBe(h2); // stable → fast-exit works on over-cap trees
    writeFileSync(join(dir, "a-new.ts"), "0123456789".repeat(11)); // later edit (size differs → deterministic)
    expect(await workingTreeStateHash(dir, cap)).not.toBe(h1); // edit visible via size/mtime/ctime
  });

  // Round-11 W3 + round-15 W1: a SAME-SIZE rewrite must flip the meta
  // fingerprint even in the SAME timestamp tick — pins the head-hash component
  // (not just status+size+times). Same two-file adaptation as above, so the
  // tree is actually over-cap (see comment there).
  test("meta: fallback catches a same-size SAME-TICK rewrite via the head sample", async () => {
    const dir = await initRepo();
    writeFileSync(join(dir, "a-new.ts"), "aaaaaaaaaa".repeat(10));
    writeFileSync(join(dir, "b-new.ts"), "z");
    const cap = { untrackedByteCap: 10 };
    const h1 = await workingTreeStateHash(dir, cap);
    writeFileSync(join(dir, "a-new.ts"), "bbbbbbbbbb".repeat(10)); // same byte length, immediately
    expect(await workingTreeStateHash(dir, cap)).not.toBe(h1); // caught by headHash
  });

  // Final-review pre-merge fix: a head-read failure on a regular file (permission
  // denied, vanished mid-scan, …) must fail the WHOLE fingerprint toward review —
  // same posture as the readlink failure above — not settle for a stable,
  // non-content-sensitive "unreadable" sentinel line, which would make two
  // genuinely different unreadable-file states hash identically (under-review).
  // chmod 000 on the untracked file makes BOTH `git diff --no-index` (exit 128 →
  // DIFF_INCOMPLETE_MARKER, routing into the meta: fallback with no cap trick
  // needed) and the fallback's own head-read fail the same way. Skipped when
  // running as root, where an unreadable-by-mode file is still openable and the
  // test premise (a real read failure) would not hold.
  test.skipIf(process.getuid?.() === 0)(
    "an unreadable regular file fails the WHOLE fingerprint toward review, not a stable 'unreadable' sentinel",
    async () => {
      const dir = await initRepo();
      writeFileSync(join(dir, "secret.ts"), "x\n");
      chmodSync(join(dir, "secret.ts"), 0o000);
      try {
        expect(await workingTreeStateHash(dir)).toBeNull();
      } finally {
        chmodSync(join(dir, "secret.ts"), 0o644); // restore so tmpdir cleanup can remove it
      }
    },
  );

  test("non-repo directory returns null", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-wtsh-norepo-"));
    expect(await workingTreeStateHash(dir)).toBeNull();
  });

  // Critical-finding regression: a symlink entry in the `meta:` fallback used to
  // carry ONLY `status path size mtimeMs ctimeMs` — no content component. A
  // same-length retarget (`ln -sf b link` -> `ln -sf c link`) on a coarse-
  // timestamp filesystem changes neither size nor times, so the old line was
  // identical across two Stops despite a real change (under-review). The fix
  // adds a readlink-target hash (`link:<sha256>`) to the line, which is
  // content-true REGARDLESS of what size/mtime/ctime happen to do — that is
  // the property this test pins. (On this dev machine's fine-grained-timestamp
  // filesystem, mtimeMs/ctimeMs already drift across the two calls below by the
  // time it takes the intervening `git status` subprocess to run, so this
  // specific scenario was not reliably RED pre-fix here — same caveat as the
  // pre-existing "SAME-TICK" test above; the coarse-FS collision this guards
  // against is real but not reproducible from userspace on APFS/ext4. The
  // assertion is still a true regression guard: post-fix it is guaranteed by
  // content, not by hoping timestamps collide.)
  test("a same-length symlink retarget under the meta: fallback flips the hash", async () => {
    const dir = await initRepo();
    writeFileSync(join(dir, "a-new.ts"), "0123456789".repeat(10)); // trips the cap
    writeFileSync(join(dir, "b-new.ts"), "z");
    symlinkSync("aaaa", join(dir, "link")); // target length 4
    const cap = { untrackedByteCap: 10 };
    const h1 = await workingTreeStateHash(dir, cap);
    expect(h1).toStartWith("meta:");
    unlinkSync(join(dir, "link"));
    symlinkSync("bbbb", join(dir, "link")); // same-length retarget, different target
    const h2 = await workingTreeStateHash(dir, cap);
    expect(h2).toStartWith("meta:");
    expect(h2).not.toBe(h1);
  });

  // Critical-finding regression: ANY non-regular, non-symlink dirty entry
  // (directory/gitlink, fifo, …) cannot be made content-sensitive by this
  // coarse fallback — a submodule-dirty tree's "content" is the nested repo's
  // own state, not something a stat/read on the gitlink path exposes. Fail
  // the WHOLE fingerprint toward review (null) rather than emit a line that
  // can miss a real change. Exercised via an embedded git repo (a directory
  // containing its own .git) — `git status --porcelain` collapses it to a
  // single `?? sub/` entry it will not recurse into, and `lstatSync` reports
  // it as a plain directory — the same shape a real gitlink/submodule takes
  // on the filesystem, without needing `git submodule add` machinery.
  test("a non-regular non-symlink dirty entry (embedded repo dir) fails the whole fingerprint toward review", async () => {
    const dir = await initRepo();
    writeFileSync(join(dir, "a-new.ts"), "0123456789".repeat(10)); // trips the cap
    writeFileSync(join(dir, "b-new.ts"), "z");
    const subDir = join(dir, "sub");
    mkdirSync(subDir);
    await Bun.$`git -C ${subDir} init -q`.quiet();
    writeFileSync(join(subDir, "f.txt"), "x");
    await Bun.$`git -C ${subDir} add f.txt`.quiet();
    await Bun.$`git -C ${subDir} -c user.email=t@t -c user.name=t commit -q -m sub`.quiet();
    const cap = { untrackedByteCap: 10 };
    expect(await workingTreeStateHash(dir, cap)).toBeNull();
  });
});
