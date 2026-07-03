// tests/unit/working-tree-state-hash.test.ts
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

  test("non-repo directory returns null", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-wtsh-norepo-"));
    expect(await workingTreeStateHash(dir)).toBeNull();
  });
});
