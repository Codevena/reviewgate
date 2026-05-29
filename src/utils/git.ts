// src/utils/git.ts
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnCapture } from "./spawn-capture.ts";

export interface GitInfo {
  sha: string;
  branch: string;
  dirtyFiles: string[];
}

// Per-git-command timeout. These run on the Stop-hook hot path; a hung git
// (index.lock contention, a slow/network FS) must not stall the gate. Async +
// this bound also lets the gate self-deadline timer fire during a hang —
// spawnSync would block the event loop and defeat it.
const GIT_TIMEOUT_MS = 30_000;

async function git(
  repoRoot: string,
  args: string[],
  timeoutMs: number = GIT_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<{ status: number | null; stdout: string; timedOut: boolean; truncated: boolean }> {
  const r = await spawnCapture("git", args, { cwd: repoRoot, timeoutMs, signal });
  // Surface timedOut/truncated so callers don't treat a partial diff as complete.
  // (aborted → status null too, so callers fall back to empty like a failure.)
  return { status: r.status, stdout: r.stdout, timedOut: r.timedOut, truncated: r.truncated };
}

// Aggregate wall-clock budget for collectDiff's untracked-file synthesis loop.
// collectDiff runs in runGate BEFORE the gate self-deadline (loop.runTimeoutMs)
// is active, so the per-command timeout alone leaves N untracked files at up to
// N×30s. This caps the whole loop: once spent, remaining untracked files are
// skipped (best-effort — reviewing most of the diff beats hanging the turn).
const COLLECT_DIFF_UNTRACKED_BUDGET_MS = 60_000;

// Appended to a diff that was truncated/timed-out/budget-capped during collection.
// Exported so callers (the gate) can detect incompleteness and surface it as
// TRUSTED context (outside the untrusted-diff fence), where reviewers will heed it
// — inside the fence it reads as inert data they're told to ignore.
export const DIFF_INCOMPLETE_MARKER =
  "[reviewgate] WARNING: this diff was TRUNCATED or TIMED OUT during collection and may be INCOMPLETE — do not treat a clean result as conclusive.";

// Paths excluded from review entirely: Reviewgate's own managed files AND the
// Antigravity CLI's (`agy`, the gemini reviewer) `.antigravitycli` working-tree
// artifact — matched at ANY depth, since agy run in a subdir yields
// `sub/.antigravitycli`. Reviewing these (a) loops the gate on its own scaffold
// and (b) emits false "committed credential" positives on the artifact dir.
const ANTIGRAVITY_ARTIFACT = /(^|\/)\.antigravitycli(\/|$)/i;

// The git-pathspec form of the same exclusion set isExcludedFromReview() applies
// to path strings. Defined ONCE here so collectDiff and collectChangedFileContents
// can't drift apart: adding a new reviewgate-managed / agy-artifact dir means
// editing this list AND isExcludedFromReview, not three hand-written copies. A miss
// would leak reviewgate-managed files into the reviewed diff (see the loop/FP
// warning above). Exported so tests can pin the shared-source invariant.
export const EXCLUDE_PATHSPEC = [
  ":(exclude)reviewgate.config.ts",
  ":(exclude).reviewgate",
  ":(exclude).reviewgate/**",
  ":(exclude).antigravitycli",
  ":(exclude).antigravitycli/**",
  ":(exclude)**/.antigravitycli",
  ":(exclude)**/.antigravitycli/**",
] as const;

function isExcludedFromReview(path: string): boolean {
  return (
    path === "reviewgate.config.ts" ||
    path === ".reviewgate" ||
    path.startsWith(".reviewgate/") ||
    ANTIGRAVITY_ARTIFACT.test(path)
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
export async function gitHeadSha(repoRoot: string): Promise<string | null> {
  const r = await git(repoRoot, ["rev-parse", "HEAD"]);
  const sha = r.stdout.trim();
  return r.status === 0 && /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
}

// `baseSha` (optional) — the commit to diff the working tree against. When the
// agent commits work mid-batch (commit-per-task), `git diff HEAD` is empty at
// turn-end so the gate would review nothing; diffing against the pre-batch base
// (captured in dirty.flag at the clean→dirty transition) captures BOTH committed
// and uncommitted changes since then. Defaults to HEAD — the original
// working-tree-only behavior — when no base is given or the base ref is invalid.
export async function collectDiff(
  repoRoot: string,
  baseSha?: string | null,
  untrackedBudgetMs: number = COLLECT_DIFF_UNTRACKED_BUDGET_MS,
): Promise<string> {
  const base = baseSha && /^[0-9a-f]{7,40}$/i.test(baseSha) ? baseSha : "HEAD";
  const diffArgs = (ref: string) => ["diff", "--no-color", ref, "--", ".", ...EXCLUDE_PATHSPEC];
  let tracked = await git(repoRoot, diffArgs(base));
  // Track partial output: a timed-out OR truncated (>maxBytes) diff must not be
  // fed to reviewers as if it were the WHOLE change — a clean verdict on a
  // partial diff is a false reassurance. We still review what we got (best-effort)
  // but append a visible marker below so the incompleteness is explicit. Captured
  // from the FIRST (base) attempt so a base-diff timeout that triggers the HEAD
  // fallback below is still marked, even if the fallback itself succeeds cleanly.
  let incomplete = tracked.timedOut || tracked.truncated;
  // A stale/rewritten base (rebase, amend, branch switch) makes `git diff <base>`
  // fail → fall back to HEAD so the working-tree diff is still reviewed. NOTE: a
  // base timeout/spawn-failure also lands here and the HEAD fallback can return a
  // NARROWER diff (dropping committed-since-base changes) — which is why the base
  // result's incomplete flag is preserved above.
  if (tracked.status !== 0 && base !== "HEAD") {
    tracked = await git(repoRoot, diffArgs("HEAD"));
    incomplete = incomplete || tracked.timedOut || tracked.truncated;
  }
  let out = tracked.status === 0 ? tracked.stdout : "";

  const untracked = await git(repoRoot, ["ls-files", "--others", "--exclude-standard"]);
  // A hung/capped untracked listing can silently omit files → mark incomplete.
  if (untracked.timedOut || untracked.truncated) incomplete = true;
  if (untracked.stdout.trim()) {
    // Sequential awaits (not parallel): preserves the exact output ordering of the
    // previous sync version, so the reviewed diff is byte-stable across runs.
    // Bounded by an aggregate wall-clock budget so a pathological repo (many
    // untracked files, or hung `git diff --no-index` calls) can't run up N×30s
    // here, before the gate self-deadline is even active.
    const deadline = Date.now() + untrackedBudgetMs;
    for (const file of untracked.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !isExcludedFromReview(s))) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        // Budget spent with untracked files still unprocessed → the diff omits
        // known files, so mark it incomplete (same as a timeout/truncation).
        incomplete = true;
        break;
      }
      // --no-index exits 1 when differences exist (always true for a new file) —
      // that is expected, not an error; read stdout regardless. Cap each call to
      // the remaining budget so the whole loop stays within untrackedBudgetMs.
      const d = await git(
        repoRoot,
        ["diff", "--no-color", "--no-index", "/dev/null", file],
        Math.min(GIT_TIMEOUT_MS, remaining),
      );
      if (d.timedOut || d.truncated) incomplete = true;
      if (d.stdout) out += `${out.length > 0 && !out.endsWith("\n") ? "\n" : ""}${d.stdout}`;
    }
  }
  if (incomplete) {
    out += `${out.endsWith("\n") ? "" : "\n"}\n${DIFF_INCOMPLETE_MARKER}\n`;
  }
  return out;
}

// The full current content of every changed (non-reviewgate, non-deleted) file,
// labeled per file and capped by a total byte budget. Reviewers get this ALONGSIDE
// the diff so they can verify a symbol exists before reporting it as missing — the
// #1 source of false-positive "undefined" findings on refactors. Skips binaries
// (read failure) and reviewgate-managed paths.
export async function collectChangedFileContents(
  repoRoot: string,
  maxBytes = 32_000,
  baseSha?: string | null,
  signal?: AbortSignal,
): Promise<string> {
  // Match collectDiff's base so committed-mid-batch files also get full-file
  // context (for undefined-symbol FP suppression), not just working-tree changes.
  const base = baseSha && /^[0-9a-f]{7,40}$/i.test(baseSha) ? baseSha : "HEAD";
  const nameArgs = (ref: string) => ["diff", "--name-only", ref, "--", ".", ...EXCLUDE_PATHSPEC];
  const names = new Set<string>();
  let tracked = await git(repoRoot, nameArgs(base), GIT_TIMEOUT_MS, signal);
  if (tracked.status !== 0 && base !== "HEAD")
    tracked = await git(repoRoot, nameArgs("HEAD"), GIT_TIMEOUT_MS, signal);
  if (tracked.status === 0) {
    for (const f of tracked.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0))
      names.add(f);
  }
  const untracked = await git(
    repoRoot,
    ["ls-files", "--others", "--exclude-standard"],
    GIT_TIMEOUT_MS,
    signal,
  );
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
    if (isExcludedFromReview(f)) continue;
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
export async function collectGitInfo(repoRoot: string): Promise<GitInfo> {
  const sha = (await git(repoRoot, ["rev-parse", "HEAD"])).stdout.trim() || "0".repeat(40);
  const branch =
    (await git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim() || "main";
  const porcelain = (await git(repoRoot, ["status", "--porcelain"])).stdout;
  const dirtyFiles = porcelain
    .split("\n")
    .map((l) => l.slice(3).trim())
    .filter((l) => l.length > 0);
  return { sha, branch, dirtyFiles };
}
