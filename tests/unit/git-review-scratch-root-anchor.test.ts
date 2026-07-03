// tests/unit/git-review-scratch-root-anchor.test.ts
//
// S6 (2026-07-03 fail-open-remediation plan): P6 excluded the user's DoD scratch
// dir `.review/` at ANY depth "like the antigravity artifact" — but the DoD
// workflow only ever creates that scratch dir at the repo ROOT, while an
// any-depth exclude is a place to hide reviewable code (`sub/.review/evil.ts`
// shipped silently, out of the diff, out of the cache key). This file pins the
// root-anchored fix: top-level `.review/` stays excluded, a NESTED `.review/`
// is reviewed again (over-review — the safe direction). `.antigravitycli` is
// UNCHANGED (still any-depth — agy legitimately scaffolds in subdirs).
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXCLUDE_PATHSPEC,
  collectDiff,
  isExcludedFromReview,
  workingTreeStateHash,
} from "../../src/utils/git.ts";

// Task 1's initRepo helper (tests/unit/working-tree-state-hash.test.ts), reused
// verbatim here since it isn't exported from that file.
async function initRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "rg-review-anchor-"));
  await Bun.$`git -C ${dir} init -q`.quiet();
  await Bun.$`git -C ${dir} -c user.email=t@t -c user.name=t commit -q --allow-empty -m init`.quiet();
  return dir;
}

describe("root-anchored .review/ exclusion (S6)", () => {
  test("top-level .review/ stays excluded; nested .review/ is REVIEWED (S6)", () => {
    expect(isExcludedFromReview(".review/prompt.txt")).toBe(true);
    expect(isExcludedFromReview(".review")).toBe(true);
    expect(isExcludedFromReview("sub/.review/evil.ts")).toBe(false);
    expect(isExcludedFromReview("deep/nested/.review/evil.ts")).toBe(false);
    expect(isExcludedFromReview("review-notes.md")).toBe(false);
    expect(isExcludedFromReview("docs/reviews/x.md")).toBe(false);
  });

  test(".antigravitycli stays excluded at any depth", () => {
    expect(isExcludedFromReview("sub/.antigravitycli/x")).toBe(true);
  });

  test("EXCLUDE_PATHSPEC carries no any-depth .review patterns", () => {
    // EXCLUDE_PATHSPEC is ALREADY exported ("Exported so tests can pin the
    // shared-source invariant" — src/utils/git.ts) — no surface widening here.
    expect(EXCLUDE_PATHSPEC).not.toContain(":(exclude)**/.review");
    expect(EXCLUDE_PATHSPEC).not.toContain(":(exclude)**/.review/**");
    expect(EXCLUDE_PATHSPEC).toContain(":(exclude).review");
    expect(EXCLUDE_PATHSPEC).toContain(":(exclude).review/**");
  });

  // Plan-Gate W3: the Stop probe (Task 1) filters through the SAME predicate —
  // after S6 the two must stay in lockstep, or a nested-.review Bash edit passes
  // the diff but not the probe (fast-exit skips it → S1 reopens for this path).
  test("tree-hash parity: nested .review/ changes the hash; root .review/ does not (S6xS1)", async () => {
    const dir = await initRepo(); // reuse Task 1's helper
    const clean = await workingTreeStateHash(dir);
    mkdirSync(join(dir, ".review"), { recursive: true });
    writeFileSync(join(dir, ".review", "scratch.md"), "x");
    expect(await workingTreeStateHash(dir)).toBe(clean); // root scratch: invisible
    mkdirSync(join(dir, "sub", ".review"), { recursive: true });
    writeFileSync(join(dir, "sub", ".review", "evil.ts"), "x");
    expect(await workingTreeStateHash(dir)).not.toBe(clean); // nested: visible
  });

  // Plan-Gate round-2 W2: the defect lives in the git PATHSPEC too — prove the
  // actual collected diff, not just the predicate/constant.
  test("collectDiff: root .review/ stays out of the diff; nested .review/ is IN it (S6 end-to-end)", async () => {
    const dir = await initRepo();
    mkdirSync(join(dir, ".review"), { recursive: true });
    writeFileSync(join(dir, ".review", "prompt.txt"), "scratch");
    mkdirSync(join(dir, "sub", ".review"), { recursive: true });
    writeFileSync(join(dir, "sub", ".review", "evil.ts"), "export const evil = 1;\n");
    const diff = await collectDiff(dir);
    expect(diff).not.toContain(".review/prompt.txt");
    expect(diff).toContain("sub/.review/evil.ts");
  });
});
