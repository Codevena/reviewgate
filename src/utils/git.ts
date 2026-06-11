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
// NOTE: `.claude/` (the harness config where Reviewgate installs its hooks) is
// deliberately NOT excluded here — an IN-DIFF change to a hook IS a supply-chain
// change worth reviewing (F-003). The every-branch "repo-local hooks = RCE"
// wolf-cry on PRE-EXISTING .claude config (I-17) is suppressed diff-awarely in the
// aggregator instead (off-diff harness findings demoted; see scopeFindings).
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

export function isExcludedFromReview(path: string): boolean {
  return (
    path === "reviewgate.config.ts" ||
    path === ".reviewgate" ||
    path.startsWith(".reviewgate/") ||
    ANTIGRAVITY_ARTIFACT.test(path)
  );
}

// Harness/tooling config dirs whose OFF-DIFF findings are exploration noise (I-17):
// reviewers with filesystem access flag the pre-existing `.claude/` hook model as a
// CRITICAL RCE on every branch. Unlike isExcludedFromReview (which drops a path
// ENTIRELY), this is diff-aware — the aggregator demotes findings on these paths
// only when the file is NOT in the diff; an IN-DIFF change to a hook is still
// reviewed and can block (F-003). `.claude/` is the harness config dir.
export function isHarnessConfigPath(path: string): boolean {
  return path === ".claude" || path.startsWith(".claude/");
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

// True iff `ancestor` is an ancestor of (or equal to) `descendant`. False if not,
// or if the check can't run (missing ref, not a repo). Used to detect a rebase:
// when the captured review base is no longer an ancestor of HEAD, history was
// rewritten (M-A5) and diffing against it would pull in foreign commits.
export async function isAncestor(
  repoRoot: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const r = await git(repoRoot, ["merge-base", "--is-ancestor", ancestor, descendant]);
  return r.status === 0;
}

// The branch's divergence point from the INTEGRATION branch it was rebased onto —
// the base that excludes the foreign commits a rebase pulled in (rebase-stable).
// It is the MOST RECENT (deepest) merge-base of HEAD with any common integration
// branch (the remote default branch, origin/main|master, local main|master).
// Most-recent = excludes the MOST foreign commits while staying a valid ancestor
// of HEAD. DELIBERATELY does NOT use the configured upstream `@{u}`: that is often
// `origin/<feature>` (the branch's OWN remote ref), whose merge-base sits AFTER
// some of the branch's own commits → using it would DROP committed branch-owned
// work from review (codex). Merge-bases that equal HEAD are skipped (a ref at/ahead
// of HEAD gives an empty diff). Null when none resolve (detached HEAD, no remote,
// no such branches) — the caller then falls back to merge-base(HEAD, stale-base).
export async function mergeBaseUpstream(repoRoot: string): Promise<string | null> {
  const head = await gitHeadSha(repoRoot);
  const candidates = ["origin/HEAD", "origin/main", "origin/master", "main", "master"];
  let best: string | null = null;
  for (const ref of candidates) {
    const r = await git(repoRoot, ["merge-base", "HEAD", ref]);
    const sha = r.stdout.trim();
    if (r.status !== 0 || !/^[0-9a-f]{40}$/i.test(sha)) continue;
    // Skip a merge-base that IS HEAD: it means the ref is HEAD or ahead of it (e.g.
    // we're ON the integration branch, or @{u} already points at the rewritten
    // HEAD), so diffing against it would be EMPTY → committed work hidden
    // (under-review). The caller then falls back to merge-base(HEAD, stale-base).
    if (head !== null && sha === head) continue;
    // Keep the more-recent merge-base (the one that is a DESCENDANT of the current
    // best), since a deeper divergence point excludes more foreign commits. All
    // merge-bases with HEAD are ancestors of HEAD, so this never under-reviews.
    if (best === null || (await isAncestor(repoRoot, best, sha))) best = sha;
  }
  return best;
}

// The merge-base (common ancestor) of two commits: `git merge-base <a> <b>`. It is
// an ancestor of both, so using it as a diff base never under-reviews `a`'s side.
// Null if they share no common ancestor (unrelated histories) or it can't run.
export async function mergeBase(repoRoot: string, a: string, b: string): Promise<string | null> {
  const r = await git(repoRoot, ["merge-base", a, b]);
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
  // ISO timestamp of this batch's clean→dirty transition (dirty.flag base_ts).
  // When set, an UNTRACKED file whose mtime predates it is OUT OF SCOPE — it
  // existed before the agent started this batch and was never touched (a stray
  // cache file, a *.bak, a foreign migration). Such files were the #1 source of
  // confidently-wrong CRITICALs on code the agent never authored (both field
  // reports). Null/absent (legacy flag, or the HEAD-advanced synthesis path) →
  // the gate is inert and ALL untracked files are included (a brand-new module
  // must still be reviewed — no regression).
  sinceTs?: string | null,
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
  // F-12 fail-closed: a tracked diff that FAILED (non-zero/null exit — corrupt
  // index/objects, git unable to run) yields out="" above, which is otherwise
  // indistinguishable from a genuinely empty diff — triage would skip-PASS and the
  // change would ship unreviewed. Mark it incomplete UNLESS the failure is the one
  // expected benign case: an unborn HEAD (fresh repo before the first commit),
  // where the tracked side is legitimately empty and the untracked synthesis below
  // covers the whole working tree. The unborn-HEAD probe must itself come from a
  // HEALTHY repo (`--is-inside-work-tree` succeeds) — if git is broken outright,
  // both probes fail and we still mark incomplete (fail closed).
  if (tracked.status !== 0 && !incomplete) {
    const head = await git(repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    if (head.status === 0) {
      incomplete = true; // HEAD exists → the diff failure is a real collection failure
    } else {
      const probe = await git(repoRoot, ["rev-parse", "--is-inside-work-tree"]);
      if (probe.status !== 0 || probe.stdout.trim() !== "true") incomplete = true;
    }
  }

  // `-z`: NUL-terminated, UNQUOTED paths. Without it, git C-quotes any non-ASCII
  // path (core.quotePath defaults to true) — e.g. `"\351\233\242.ts"` — and the
  // quoted token is passed verbatim to `git diff --no-index`, which can't find
  // the file, so a brand-new non-ASCII file is silently dropped from the review.
  const untracked = await git(repoRoot, ["ls-files", "-z", "--others", "--exclude-standard"]);
  // A hung/capped untracked listing can silently omit files → mark incomplete.
  if (untracked.timedOut || untracked.truncated) incomplete = true;
  if (untracked.stdout) {
    // Sequential awaits (not parallel): preserves the exact output ordering of the
    // previous sync version, so the reviewed diff is byte-stable across runs.
    // Bounded by an aggregate wall-clock budget so a pathological repo (many
    // untracked files, or hung `git diff --no-index` calls) can't run up N×30s
    // here, before the gate self-deadline is even active.
    const deadline = Date.now() + untrackedBudgetMs;
    const sinceMs = sinceTs ? Date.parse(sinceTs) : Number.NaN;
    // NUL-delimited: split on \0, no per-token trim (paths are exact between
    // terminators; trimming could corrupt a filename with leading/trailing space).
    for (const file of untracked.stdout
      .split("\0")
      .filter((s) => s.length > 0 && !isExcludedFromReview(s))) {
      // Pre-existing untracked noise (predates this batch's start) is out of scope.
      // Skip WITHOUT marking the diff incomplete: this is a deliberate scope decision,
      // not a file dropped due to a timeout/truncation failure. Gate on
      // max(mtime, ctime), NOT mtime alone: mtime is settable to the PAST (`utimes`,
      // `git checkout`, `rsync -a`), so a file genuinely created/modified THIS batch
      // with a back-dated mtime would be wrongly excluded (a silent under-review of new
      // content). ctime (inode change time) updates to "now" on create/metadata-change
      // and cannot be back-dated by `utimes`, so it catches that case → fewer
      // false-excludes. lstat is guarded — a racing unlink falls through to --no-index.
      if (!Number.isNaN(sinceMs)) {
        try {
          const st = lstatSync(join(repoRoot, file));
          if (Math.max(st.mtimeMs, st.ctimeMs) < sinceMs) continue;
        } catch {
          /* file vanished mid-listing — let --no-index handle it */
        }
      }
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
      // `--` before the paths: an untracked filename starting with `-` (listable
      // by ls-files) would otherwise be parsed by git as an OPTION → exit ≥2,
      // empty stdout, file silently dropped from the review (F-13).
      const d = await git(
        repoRoot,
        ["diff", "--no-color", "--no-index", "--", "/dev/null", file],
        Math.min(GIT_TIMEOUT_MS, remaining),
      );
      // Exit 0 (identical/empty file) and 1 (differences) are the expected
      // outcomes. ANY other status (≥2 option mis-parse, 128 EACCES/cannot-hash,
      // null spawn failure) means this file was NOT captured — mark the diff
      // incomplete instead of letting the file vanish silently (F-13).
      if (d.timedOut || d.truncated || (d.status !== 0 && d.status !== 1)) incomplete = true;
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
  // `-z`: NUL-terminated, UNQUOTED paths — same fix as the untracked side below
  // (F-18). Without it, a tracked non-ASCII path is C-quoted (`"\351\233\242.ts"`),
  // the quoted token fails lstat, and the file silently loses its full-file
  // FP-suppression context while still appearing in the reviewed diff.
  const nameArgs = (ref: string) => [
    "diff",
    "--name-only",
    "-z",
    ref,
    "--",
    ".",
    ...EXCLUDE_PATHSPEC,
  ];
  const names = new Set<string>();
  let tracked = await git(repoRoot, nameArgs(base), GIT_TIMEOUT_MS, signal);
  if (tracked.status !== 0 && base !== "HEAD")
    tracked = await git(repoRoot, nameArgs("HEAD"), GIT_TIMEOUT_MS, signal);
  if (tracked.status === 0) {
    // NUL-delimited: paths are exact between terminators — no per-token trim
    // (trimming could corrupt a filename with leading/trailing whitespace).
    for (const f of tracked.stdout.split("\0").filter((s) => s.length > 0)) names.add(f);
  }
  // `-z`: NUL-terminated, UNQUOTED paths (see collectDiff) — otherwise non-ASCII
  // untracked files are C-quoted and silently dropped from the full-file context.
  const untracked = await git(
    repoRoot,
    ["ls-files", "-z", "--others", "--exclude-standard"],
    GIT_TIMEOUT_MS,
    signal,
  );
  for (const f of untracked.stdout.split("\0").filter((s) => s.length > 0)) names.add(f);
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
