// tests/unit/collect-diff-bytecap.test.ts
//
// F4 (MEDIUM, DoS): collectDiff's untracked-file synthesis was bounded only by a
// wall-clock budget — nothing capped the SUM of bytes accumulated across many
// untracked files, so a repo with thousands of new files (or a few large ones)
// could grow the in-memory diff without limit. The fix adds an aggregate byte
// cap; once exceeded, remaining untracked files are dropped and the diff is
// marked INCOMPLETE (fail closed — a clean verdict on a size-capped diff is not
// conclusive), never silently truncated.
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectDiff } from "../../src/utils/git.ts";

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-bytecap-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "e@e"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "e"], { cwd: dir });
  spawnSync(
    "git",
    ["-c", "user.email=e@e", "-c", "user.name=e", "commit", "-q", "--allow-empty", "-m", "init"],
    {
      cwd: dir,
    },
  );
  return dir;
}

describe("collectDiff: untracked-synthesis aggregate byte cap (F4 DoS)", () => {
  it("marks the diff incomplete and stops once the byte cap is crossed", async () => {
    const dir = repo();
    // Several untracked files; each ~2 KiB. A tiny injected cap (1 KiB) is crossed
    // after the first file is appended, so later files are dropped.
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(dir, `untracked-${i}.ts`), `export const x = "${"a".repeat(2000)}";\n`);
    }

    // 4th positional arg = sinceTs (null = include all); 5th = untrackedByteCap.
    const diff = await collectDiff(dir, null, 60_000, null, 1024);

    // Fail-closed: the truncation is surfaced, not silent.
    expect(diff.toLowerCase()).toContain("incomplete");
    // Bounded: at most one full file's worth of synthesis past the cap plus the
    // marker — nowhere near all five files.
    expect(diff.length).toBeLessThan(1024 + 4000);
    // At least the first file was captured (best-effort, not an empty diff).
    expect(diff).toContain("untracked-0.ts");
  });

  it("does NOT mark incomplete when the accumulated diff stays under the cap", async () => {
    const dir = repo();
    writeFileSync(join(dir, "small.ts"), "export const x = 1;\n");

    // Generous cap — the single small file fits well under it.
    const diff = await collectDiff(dir, null, 60_000, null, 16 * 1024 * 1024);

    expect(diff).toContain("small.ts");
    expect(diff.toLowerCase()).not.toContain("incomplete");
  });
});
