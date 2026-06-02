// tests/integration/git-untracked-nonascii.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { collectDiff } from "../../src/utils/git.ts";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

describe("collectDiff: untracked non-ASCII files", () => {
  it("includes a CJK-named new file in the reviewed diff", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-cjk-"));
    await $`git init -q`.cwd(dir).env(GIT_ENV);
    await $`git commit -q --allow-empty -m init`.cwd(dir).env(GIT_ENV);
    // Default core.quotePath=true makes git C-quote this path in `ls-files`
    // output ("\351\233\242\347\202\271.ts"); without `-z` the quoted token is
    // passed verbatim to `git diff --no-index`, which fails to find the file and
    // silently drops it from the review.
    writeFileSync(join(dir, "離点.ts"), "export const secret = 1;\n");

    const diff = await collectDiff(dir, null);

    // The core contract: the new file's CONTENT reaches the reviewer (so it can
    // be reviewed at all). Before the `-z` fix the whole file was silently
    // dropped and `diff` was empty. (git still C-quotes the path in the diff
    // HEADER via core.quotePath — a separate, cosmetic concern — but the added
    // lines are now present.)
    expect(diff).toContain("export const secret = 1;");
    expect(diff).toContain("new file mode");
  });
});
