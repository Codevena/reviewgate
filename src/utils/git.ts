// src/utils/git.ts
import { spawnSync } from "node:child_process";

export interface GitInfo {
  sha: string;
  branch: string;
  dirtyFiles: string[];
}

function git(repoRoot: string, args: string[]): { status: number | null; stdout: string } {
  const r = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "" };
}

// The working-tree diff Reviewgate reviews. Includes BOTH tracked modifications
// (`git diff HEAD`) AND untracked new files — the latter via `git diff
// --no-index`, because a brand-new module is the most common review case yet
// `git diff HEAD` omits it entirely. Non-mutating (never touches the index).
// .gitignored files are excluded (--exclude-standard), so `.reviewgate/` etc.
// are never reviewed.
export function collectDiff(repoRoot: string): string {
  const tracked = git(repoRoot, ["diff", "--no-color", "HEAD"]);
  let out = tracked.status === 0 ? tracked.stdout : "";

  const untracked = git(repoRoot, ["ls-files", "--others", "--exclude-standard"]);
  if (untracked.stdout.trim()) {
    for (const file of untracked.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)) {
      // --no-index exits 1 when differences exist (always true for a new file) —
      // that is expected, not an error; read stdout regardless.
      const d = git(repoRoot, ["diff", "--no-color", "--no-index", "/dev/null", file]);
      if (d.stdout) out += `${out.length > 0 && !out.endsWith("\n") ? "\n" : ""}${d.stdout}`;
    }
  }
  return out;
}

// Real git metadata for the report. Falls back to safe placeholders outside a
// git repo or before the first commit.
export function collectGitInfo(repoRoot: string): GitInfo {
  const sha = git(repoRoot, ["rev-parse", "HEAD"]).stdout.trim() || "0".repeat(40);
  const branch = git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim() || "main";
  const porcelain = git(repoRoot, ["status", "--porcelain"]).stdout;
  const dirtyFiles = porcelain
    .split("\n")
    .map((l) => l.slice(3).trim())
    .filter((l) => l.length > 0);
  return { sha, branch, dirtyFiles };
}
