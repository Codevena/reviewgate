// tests/unit/git-exclude-pathspec-shared.test.ts
//
// Guards F-072: the git-pathspec exclude list must stay in sync between
// collectDiff and collectChangedFileContents (and with isExcludedFromReview).
// Adding a new excluded path in only one of the two places would leak a
// reviewgate-managed file into one of the two reviewed surfaces. Rather than
// re-test every path in both functions, this pins the source-level invariant:
// both functions reference the SAME exported EXCLUDE_PATHSPEC constant, so a
// future edit cannot drift one copy without the other.
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXCLUDE_PATHSPEC,
  collectChangedFileContents,
  collectDiff,
  isExcludedFromReview,
} from "../../src/utils/git.ts";

const GIT_SRC = fileURLToPath(new URL("../../src/utils/git.ts", import.meta.url));

function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-excl-shared-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync(
    "git",
    ["-c", "user.email=e@e", "-c", "user.name=e", "commit", "-q", "--allow-empty", "-m", "init"],
    { cwd: dir },
  );
  return dir;
}

describe("git exclude-pathspec is a single shared source", () => {
  it("exports EXCLUDE_PATHSPEC covering reviewgate + antigravity artifacts", () => {
    // NOTE: .claude/ is deliberately NOT excluded from the diff — in-diff hook
    // changes are reviewed (F-003); off-diff .claude noise is demoted in the
    // aggregator (see aggregator-claude-scope.test.ts), not excluded here.
    expect(EXCLUDE_PATHSPEC).toEqual([
      ":(exclude)reviewgate.config.ts",
      ":(exclude).reviewgate",
      ":(exclude).reviewgate/**",
      // P6 (field report 2026-06-22): the user's DoD scratch dir (.review/, rm -rf'd
      // before commit) must not enter the reviewed diff or the cache key in repos that
      // don't gitignore it.
      ":(exclude).review",
      ":(exclude).review/**",
      ":(exclude)**/.review",
      ":(exclude)**/.review/**",
      ":(exclude).antigravitycli",
      ":(exclude).antigravitycli/**",
      ":(exclude)**/.antigravitycli",
      ":(exclude)**/.antigravitycli/**",
    ]);
  });

  it("isExcludedFromReview excludes .review scratch but NOT .reviewgate-unrelated names", () => {
    // P6: the untracked side must mirror EXCLUDE_PATHSPEC exactly.
    expect(isExcludedFromReview(".review")).toBe(true);
    expect(isExcludedFromReview(".review/plan-gate-prompt.txt")).toBe(true);
    expect(isExcludedFromReview("sub/.review/codex-a-findings.md")).toBe(true);
    // Over-broad-match guards: a file/dir that merely CONTAINS "review" is NOT excluded.
    expect(isExcludedFromReview("review-notes.md")).toBe(false);
    expect(isExcludedFromReview("src/review.ts")).toBe(false);
    expect(isExcludedFromReview("docs/reviews/x.md")).toBe(false);
    // .reviewgate stays excluded (regression).
    expect(isExcludedFromReview(".reviewgate/state.json")).toBe(true);
  });

  it("collectDiff excludes an UNTRACKED .review scratch file even with no gitignore line", async () => {
    // The field-report failure: F-001/F-002 were on .review/plan-gate-* in a checkout that
    // did not gitignore .review/, so they entered the diff (and the cache key). Pure
    // subtraction — verify the untracked side drops them and a real file still shows.
    const repo = tmpRepo();
    mkdirSync(join(repo, ".review"), { recursive: true });
    writeFileSync(join(repo, ".review", "plan-gate-prompt.txt"), "stale scratch\n");
    mkdirSync(join(repo, "sub", ".review"), { recursive: true });
    writeFileSync(join(repo, "sub", ".review", "codex-a-findings.md"), "## FINDINGS\n");
    writeFileSync(join(repo, "real.ts"), "export const r = 1;\n");
    writeFileSync(join(repo, "review-notes.md"), "# kept\n");

    const out = await collectDiff(repo);
    expect(out).toContain("real.ts");
    expect(out).toContain("review-notes.md"); // over-broad guard: NOT excluded
    expect(out).not.toContain(".review/plan-gate-prompt.txt");
    expect(out).not.toContain("codex-a-findings.md");
    // Exclusion must not trip the incomplete fail-CLOSED marker.
    expect(out).not.toContain("TRUNCATED or TIMED OUT");
  });

  it("does not hand-write a second copy of the exclude pathspec in git.ts", () => {
    // If a literal `:(exclude)reviewgate.config.ts` appears more than once in the
    // source, someone re-duplicated the list instead of reusing EXCLUDE_PATHSPEC.
    const src = readFileSync(GIT_SRC, "utf8");
    const occurrences = src.split(":(exclude)reviewgate.config.ts").length - 1;
    expect(occurrences).toBe(1);
  });

  it("collectChangedFileContents still excludes a COMMITTED .reviewgate file via the pathspec", async () => {
    // Behavioral guard: the shared constant must remain wired into the tracked
    // (committed) name listing, not just the untracked isExcludedFromReview path.
    const repo = tmpRepo();
    mkdirSync(join(repo, ".reviewgate"), { recursive: true });
    writeFileSync(join(repo, ".reviewgate", "state.json"), '{"a":1}\n');
    writeFileSync(join(repo, "keep.ts"), "export const k = 1;\n");
    spawnSync("git", ["add", "-A"], { cwd: repo });
    spawnSync("git", ["-c", "user.email=e@e", "-c", "user.name=e", "commit", "-q", "-m", "c"], {
      cwd: repo,
    });
    writeFileSync(join(repo, "keep.ts"), "export const k = 2;\n");
    writeFileSync(join(repo, ".reviewgate", "state.json"), '{"a":2}\n');

    const out = await collectChangedFileContents(repo);
    expect(out).toContain("### keep.ts");
    expect(out).not.toContain(".reviewgate/state.json");
  });
});
