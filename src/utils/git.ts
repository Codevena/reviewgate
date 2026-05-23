import { spawnSync } from "node:child_process";
// src/utils/git.ts
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface GitInfo {
  sha: string;
  branch: string;
  dirtyFiles: string[];
}

function git(repoRoot: string, args: string[]): { status: number | null; stdout: string } {
  const r = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "" };
}

// Reviewgate's OWN managed files must never be reviewed: they sit permanently in
// the working tree (until the user commits them), which would (a) make the gate
// review itself forever — an escalation loop — and (b) emit false positives on
// the tool's own config/scaffolding (e.g. flagging `apiKeyEnv: "X"` as a leaked
// secret). Excluded: reviewgate.config.ts and everything under .reviewgate/.
function isReviewgateManaged(path: string): boolean {
  return (
    path === "reviewgate.config.ts" || path === ".reviewgate" || path.startsWith(".reviewgate/")
  );
}

// The working-tree diff Reviewgate reviews. Includes BOTH tracked modifications
// (`git diff HEAD`) AND untracked new files — the latter via `git diff
// --no-index`, because a brand-new module is the most common review case yet
// `git diff HEAD` omits it entirely. Non-mutating (never touches the index).
// .gitignored files are excluded (--exclude-standard); Reviewgate's own managed
// files are excluded explicitly (they aren't all gitignored, e.g. .reviewgate/bin).
// Current HEAD sha, or null if there is none (e.g. an empty repo). Used to anchor
// a review BASE in dirty.flag so commit-per-task work is still reviewed.
export function gitHeadSha(repoRoot: string): string | null {
  const r = git(repoRoot, ["rev-parse", "HEAD"]);
  const sha = r.stdout.trim();
  return r.status === 0 && /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
}

// `baseSha` (optional) — the commit to diff the working tree against. When the
// agent commits work mid-batch (commit-per-task), `git diff HEAD` is empty at
// turn-end so the gate would review nothing; diffing against the pre-batch base
// (captured in dirty.flag at the clean→dirty transition) captures BOTH committed
// and uncommitted changes since then. Defaults to HEAD — the original
// working-tree-only behavior — when no base is given or the base ref is invalid.
export function collectDiff(repoRoot: string, baseSha?: string | null): string {
  const base = baseSha && /^[0-9a-f]{7,40}$/i.test(baseSha) ? baseSha : "HEAD";
  const diffArgs = (ref: string) => [
    "diff",
    "--no-color",
    ref,
    "--",
    ".",
    ":(exclude)reviewgate.config.ts",
    ":(exclude).reviewgate",
    ":(exclude).reviewgate/**",
  ];
  let tracked = git(repoRoot, diffArgs(base));
  // A stale/rewritten base (rebase, amend, branch switch) makes `git diff <base>`
  // fail → fall back to HEAD so the working-tree diff is still reviewed.
  if (tracked.status !== 0 && base !== "HEAD") tracked = git(repoRoot, diffArgs("HEAD"));
  let out = tracked.status === 0 ? tracked.stdout : "";

  const untracked = git(repoRoot, ["ls-files", "--others", "--exclude-standard"]);
  if (untracked.stdout.trim()) {
    for (const file of untracked.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !isReviewgateManaged(s))) {
      // --no-index exits 1 when differences exist (always true for a new file) —
      // that is expected, not an error; read stdout regardless.
      const d = git(repoRoot, ["diff", "--no-color", "--no-index", "/dev/null", file]);
      if (d.stdout) out += `${out.length > 0 && !out.endsWith("\n") ? "\n" : ""}${d.stdout}`;
    }
  }
  return out;
}

// The full current content of every changed (non-reviewgate, non-deleted) file,
// labeled per file and capped by a total byte budget. Reviewers get this ALONGSIDE
// the diff so they can verify a symbol exists before reporting it as missing — the
// #1 source of false-positive "undefined" findings on refactors. Skips binaries
// (read failure) and reviewgate-managed paths.
export function collectChangedFileContents(repoRoot: string, maxBytes = 32_000): string {
  const names = new Set<string>();
  const tracked = git(repoRoot, [
    "diff",
    "--name-only",
    "HEAD",
    "--",
    ".",
    ":(exclude)reviewgate.config.ts",
    ":(exclude).reviewgate",
    ":(exclude).reviewgate/**",
  ]);
  if (tracked.status === 0) {
    for (const f of tracked.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0))
      names.add(f);
  }
  const untracked = git(repoRoot, ["ls-files", "--others", "--exclude-standard"]);
  for (const f of untracked.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0))
    names.add(f);
  let out = "";
  let used = 0;
  // Omission markers count toward `used` too, and once the budget is spent we
  // stop entirely — so the total output (content + markers) is hard-bounded by
  // ~maxBytes regardless of how many oversized files the change set contains.
  const omit = (f: string): boolean => {
    const note = `### ${f}\n(omitted — context budget exceeded)\n`;
    out += note;
    used += note.length;
    return used >= maxBytes;
  };
  for (const f of [...names].sort()) {
    if (used >= maxBytes) break;
    if (isReviewgateManaged(f)) continue;
    const abs = join(repoRoot, f);
    let content: string;
    try {
      // lstat (not stat): never FOLLOW a symlink. A changed/untracked symlink
      // could point outside the repo (e.g. ~/.ssh/id_rsa); reading its target
      // would leak that file's content into the reviewer prompt. Only ever read
      // regular files; skip symlinks/dirs/special files.
      const st = lstatSync(abs);
      if (!st.isFile()) continue;
      // Size-guard BEFORE reading: never load a file that can't fit the remaining
      // budget into memory just to omit its block later (avoids a huge-file stall).
      if (st.size > maxBytes - used) {
        if (omit(f)) break;
        continue;
      }
      content = readFileSync(abs, "utf8");
    } catch {
      continue; // deleted or binary
    }
    const block = `### ${f}\n\`\`\`\n${content}\n\`\`\`\n`;
    if (used + block.length > maxBytes) {
      if (omit(f)) break;
      continue;
    }
    used += block.length;
    out += block;
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
