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
import { EXCLUDE_PATHSPEC, collectChangedFileContents } from "../../src/utils/git.ts";

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
  it("exports EXCLUDE_PATHSPEC covering reviewgate + .claude harness + antigravity artifacts", () => {
    expect(EXCLUDE_PATHSPEC).toEqual([
      ":(exclude)reviewgate.config.ts",
      ":(exclude).reviewgate",
      ":(exclude).reviewgate/**",
      ":(exclude).claude",
      ":(exclude).claude/**",
      ":(exclude).antigravitycli",
      ":(exclude).antigravitycli/**",
      ":(exclude)**/.antigravitycli",
      ":(exclude)**/.antigravitycli/**",
    ]);
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
