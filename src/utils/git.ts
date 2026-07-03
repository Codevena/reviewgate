// src/utils/git.ts
import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readSync, readlinkSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { safeReadContained } from "./safe-read.ts";
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

// Aggregate BYTE cap on collectDiff's accumulated untracked synthesis. Each
// `git diff --no-index` is individually capped (spawnCapture maxBytes), but
// nothing bounded the SUM across many untracked files — a repo with thousands of
// new files (or a few large ones) could grow `out` without limit and OOM the
// gate. Once the accumulated diff exceeds this, the remaining untracked files are
// dropped and the diff is marked incomplete (fail closed — same as a timeout):
// reviewers must not treat a clean verdict on a size-capped diff as conclusive.
const COLLECT_DIFF_UNTRACKED_BYTE_CAP = 16 * 1024 * 1024;

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

// P6 (field report 2026-06-22): the user's DoD scratch dir `.review/` (codex/agy prompt +
// findings files, `rm -rf`'d before commit). In a repo that doesn't gitignore it, these
// transient files entered the reviewed diff AND the cache key and got reviewed (F-001/F-002
// in the field report were on `.review/plan-gate-*`). Matched as a DOTDIR boundary so it
// never catches `review-notes.md` or `docs/reviews/…` (over-broad-match guard).
//
// S6 (2026-07-03, documented deviation from P6): root-anchored ONLY, not any-depth like the
// antigravity artifact below. The DoD scratch dir only ever exists at the repo ROOT (it's a
// fixed convention, not something agy scaffolds per-subdir like `.antigravitycli`); an
// any-depth exclude is a place to hide reviewable code — `sub/.review/evil.ts` shipped
// silently, out of both the diff and the cache key. Worst case after root-anchoring: a
// nested `.review/` in some repo gets reviewed and produces FP noise — over-review, the
// safe direction.
const REVIEW_SCRATCH = /^\.review(\/|$)/i;

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
  // P6/S6: the user's DoD scratch dir — see REVIEW_SCRATCH. Root-anchored only (S6) —
  // NO `**/.review` any-depth pair, unlike `.antigravitycli` below. Mirror this set in
  // isExcludedFromReview (the untracked side) exactly (shared-source invariant).
  ":(exclude).review",
  ":(exclude).review/**",
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
    REVIEW_SCRATCH.test(path) ||
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
export interface WorktreeInfo {
  // True for a `git worktree`-linked checkout (git-dir resolves under the main
  // .git/worktrees/<name> while git-common-dir points at the shared main .git).
  // False for the main checkout, a submodule (git-dir == git-common-dir), or a
  // non-git dir (fail-safe: treat as a normal repo so detection never blocks).
  isLinkedWorktree: boolean;
  gitDir: string | null;
  commonDir: string | null;
}

// Detect whether `repoRoot` is a LINKED git worktree. Reviewgate arms per-checkout
// (.reviewgate/ + the .claude/settings.json hooks), and a worktree shares only .git — so
// a worktree created AFTER the main-clone `init` has NO hooks and the Stop gate never
// fires there (the worktree-blindness blind spot, field report 2026-06-21). `doctor` uses
// this to fail LOUD. A linked worktree has `--git-dir` != `--git-common-dir`; the main
// checkout and a submodule have them equal, so neither false-positives.
export async function worktreeInfo(repoRoot: string): Promise<WorktreeInfo> {
  const r = await git(repoRoot, ["rev-parse", "--git-dir", "--git-common-dir"]);
  if (r.status !== 0) return { isLinkedWorktree: false, gitDir: null, commonDir: null };
  const [gitDir, commonDir] = r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (!gitDir || !commonDir) {
    return { isLinkedWorktree: false, gitDir: gitDir ?? null, commonDir: commonDir ?? null };
  }
  // git may print these relative to CWD or absolute — resolve both against repoRoot so
  // the comparison is path-form-independent.
  const isLinkedWorktree = resolve(repoRoot, gitDir) !== resolve(repoRoot, commonDir);
  return { isLinkedWorktree, gitDir, commonDir };
}

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
  // Aggregate byte cap for the accumulated untracked synthesis (param so tests
  // can drive the cap without writing 16 MiB; defaults to the production cap).
  untrackedByteCap: number = COLLECT_DIFF_UNTRACKED_BYTE_CAP,
): Promise<string> {
  const base = baseSha && /^[0-9a-f]{7,40}$/i.test(baseSha) ? baseSha : "HEAD";
  // `-c core.quotePath=false`: emit RAW UTF-8 paths in the `diff --git`/`+++ `
  // headers. With git's default quotePath=true a non-ASCII/space/control path is
  // C-quoted (`diff --git "a/\351\233\242.ts" "b/…"`); the header regex in
  // diff-facts.ts/hunks.ts then fails to match → the file is dropped from triage
  // facts (and if it's the only change, files:[] → triage skip-PASSes UNREVIEWED
  // code, fail-open) and its hunks lose range attribution (findings demoted to
  // INFO). The untracked `ls-files -z` side is already quote-safe via `-z`.
  const diffArgs = (ref: string) => [
    "-c",
    "core.quotePath=false",
    "diff",
    "--no-color",
    ref,
    "--",
    ".",
    ...EXCLUDE_PATHSPEC,
  ];
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
      // Aggregate byte cap: stop accumulating once the synthesized diff is too
      // large (a repo with thousands of untracked files, or a few huge ones).
      // Checked BEFORE spawning the next --no-index so memory stays bounded by
      // ~cap + one file's stdout. Remaining files are dropped → mark incomplete
      // (fail closed, same as a timeout): a clean verdict on a size-capped diff
      // is not conclusive.
      if (out.length >= untrackedByteCap) {
        incomplete = true;
        break;
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
        // `-c core.quotePath=false`: keep the synthesized header path RAW (UTF-8),
        // same as the tracked diff above — `--no-index` honors it too. Otherwise a
        // non-ASCII untracked file's `diff --git`/`+++ ` header is C-quoted
        // (`"a/\351…"`) and diff-facts.ts/hunks.ts drop it from triage facts /
        // range attribution even though `-z` made `ls-files` find it.
        ["-c", "core.quotePath=false", "diff", "--no-color", "--no-index", "--", "/dev/null", file],
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

// Content-true working-tree fingerprint for the Stop fast-exit (S1): sha256
// over collectDiff's working-tree-vs-HEAD output. collectDiff already carries
// full content hunks (tracked mods) + --no-index synthesis (untracked),
// applies the review exclusions (hash scope ≡ diff scope), and is byte/time-
// capped. A status/path fingerprint would be blind to a SECOND edit of an
// already-dirty file (round-3 C1).
//
// Truncated diff (cap exceeded): a `null` here on EVERY stop would make each
// post-review Stop on a large dirty tree take the lock path forever (round-5
// W3). Fall back to a METADATA fingerprint over the non-excluded dirty paths —
// status line + size + mtimeMs + ctimeMs per file. size/ctime changes catch a
// practical M→M or ??→?? content edit (ctime cannot be back-dated by touch;
// same resistance the untracked mtime-gate relies on). The "meta:"/"diff:"
// prefixes keep the two forms from EVER comparing equal across a cap-status
// change — a stored content hash vs a current meta hash mismatches → review.
// `null` = could not determine at all — callers MUST treat null as "changed"
// (fail toward review, never toward skip).
export async function workingTreeStateHash(
  repoRoot: string,
  opts?: { untrackedByteCap?: number },
): Promise<string | null> {
  try {
    const diff =
      opts?.untrackedByteCap !== undefined
        ? await collectDiff(repoRoot, null, undefined, null, opts.untrackedByteCap)
        : await collectDiff(repoRoot, null);
    if (!diff.includes(DIFF_INCOMPLETE_MARKER)) {
      return `diff:${createHash("sha256").update(diff).digest("hex")}`;
    }
    return await workingTreeMetaFingerprint(repoRoot); // "meta:…" or null
  } catch {
    return null;
  }
}

// Reads at most `n` bytes from the start of `absPath`. Used for the meta
// fallback's head-sample (below) — a cheap, bounded stand-in for a full
// content hash. null on any open/read failure (gone, EACCES, …).
function readHeadBytes(absPath: string, n: number): Buffer | null {
  let fd: number;
  try {
    fd = openSync(absPath, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(n);
    const bytesRead = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

// Fallback: `git status --porcelain=v1 -uall -z` (quote-safe), drop excluded
// paths (isExcludedFromReview on path AND rename-origin), then for each entry
// stat() the file and hash `XY path size mtimeMs ctimeMs headHash` lines,
// sorted, where headHash = sha256 of the file's FIRST 4096 bytes (round-15 W1:
// coarse-timestamp filesystems — HFS+ has 1-second granularity — can leave a
// same-size same-tick rewrite invisible to size+times alone; the head sample
// catches it cheaply). A head-read failure (permission change, vanished
// mid-scan, …) fails the WHOLE fingerprint to `null`, not just this line —
// same posture as a readlink failure below. Deleted files stat-fail → keep the
// status line with `gone` — a deletion is still a change. Bounded: more than
// 500 dirty entries → return null (fail toward review). Any git error → null.
//
// ACCEPTED RESIDUAL (documented, not silent), per entry kind:
//   - Regular files: a rewrite evades the fallback only if it is simultaneously
//     (a) on an over-cap tree, (b) same size, (c) within one timestamp tick, AND
//     (d) byte-identical in the first 4096 bytes. Full content hashing is
//     exactly what the `diff:` form does — the fallback exists because content
//     was too large; this four-way conjunction is the deliberate trade against
//     re-reading multi-GB trees on every Stop.
//   - Symlinks: the entry line includes a sha256 of the link's readlink target,
//     so ANY retarget (same-length or not) changes the hash regardless of
//     size/mtime/ctime — the four-way conjunction above does not apply here.
//     The only residual is a symlink pointing to the exact same target string
//     both times, which is not a change to detect. A readlink failure fails
//     the WHOLE fingerprint to `null` (toward review), not just this line.
//   - Any other non-regular entry (directory/gitlink submodule, fifo, socket,
//     device, …): content-sensitivity cannot be guaranteed by a stat/read on
//     the path (a gitlink's "content" is the nested repo's own dirty state),
//     so the WHOLE fingerprint fails to `null` — this tree never fast-exits.
//     Over-review (never skipping) is acceptable; under-review is the bug
//     class this function exists to close.
async function workingTreeMetaFingerprint(repoRoot: string): Promise<string | null> {
  const r = await git(repoRoot, ["status", "--porcelain=v1", "-uall", "-z"]);
  if (r.status !== 0 || r.timedOut || r.truncated) return null;
  // -z record layout: `XY PATH\0` per entry, except a rename/copy (X === 'R' or
  // 'C') which emits an EXTRA `ORIG_PATH\0` token immediately after — consume it
  // as part of the SAME entry rather than mis-parsing it as its own record.
  const tokens = r.stdout.split("\0").filter((s) => s.length > 0);
  const entries: { status: string; path: string; origPath?: string }[] = [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    i++;
    if (token === undefined || token.length < 3) continue; // malformed record guard — skip, don't crash
    const status = token.slice(0, 2);
    const path = token.slice(3);
    const entry: { status: string; path: string; origPath?: string } = { status, path };
    if (status[0] === "R" || status[0] === "C") {
      const origPath = tokens[i];
      if (origPath !== undefined) {
        entry.origPath = origPath;
        i++;
      }
    }
    entries.push(entry);
  }
  const filtered = entries.filter(
    (e) =>
      !isExcludedFromReview(e.path) &&
      !(e.origPath !== undefined && isExcludedFromReview(e.origPath)),
  );
  // Bounded: a massive dirty tree would mean per-file stat + head-read on every
  // Stop — fail toward review instead of doing unbounded work on the hot path.
  if (filtered.length > 500) return null;
  const lines: string[] = [];
  for (const e of filtered) {
    const abs = join(repoRoot, e.path);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(abs);
    } catch {
      // Deleted (or vanished mid-read) — a deletion is still a change; the
      // status line alone still perturbs the hash without a nonexistent stat.
      lines.push(`${e.status} ${e.path} gone`);
      continue;
    }
    if (st.isSymbolicLink()) {
      // Content-sensitive: hash the readlink target so a same-length retarget
      // (`ln -sf b link` -> `ln -sf c link`) flips the line even when size and
      // times land on the same coarse tick — status+size+times alone cannot
      // cover this entry type (see ACCEPTED RESIDUAL above).
      let target: string;
      try {
        target = readlinkSync(abs);
      } catch {
        // Vanished/permission failure mid-scan: can't guarantee content-
        // sensitivity for this entry — fail the whole fingerprint toward
        // review rather than silently degrade to a non-content line.
        return null;
      }
      const linkHash = createHash("sha256").update(target).digest("hex");
      lines.push(`${e.status} ${e.path} ${st.size} ${st.mtimeMs} ${st.ctimeMs} link:${linkHash}`);
      continue;
    }
    if (!st.isFile()) {
      // Directory (submodule gitlink), fifo, socket, device, …: no reliable
      // way to make these content-sensitive within this coarse fallback — fail
      // the WHOLE fingerprint toward review instead of emitting a status+size+
      // times-only line that can under-report a real change (see ACCEPTED
      // RESIDUAL above).
      return null;
    }
    const head = readHeadBytes(abs, 4096);
    if (!head) {
      // Stat succeeded but the content read failed (permission change, vanished
      // mid-scan, …): can't guarantee content-sensitivity for this entry — fail
      // the whole fingerprint toward review, same posture as the readlink
      // failure two branches above, rather than emit a stable non-content
      // sentinel line that would silently defeat the head-sample's purpose.
      return null;
    }
    const headHash = createHash("sha256").update(head).digest("hex");
    lines.push(`${e.status} ${e.path} ${st.size} ${st.mtimeMs} ${st.ctimeMs} ${headHash}`);
  }
  lines.sort();
  return `meta:${createHash("sha256").update(lines.join("\n")).digest("hex")}`;
}

// #7: working-tree-dirty file paths, base-independent — `git diff --name-only -z HEAD`
// (tracked uncommitted changes) ∪ `git ls-files -z --others --exclude-standard`
// (untracked, non-ignored). Used ONLY by the pre-review settle-check to detect an
// active writer; NOT a review scope (so no base/base_ts filter). `-z` → raw NUL-
// separated paths (lstat-safe). Each git call is independent + best-effort; union,
// dedupe. Returns [] if both fail (e.g. a non-git dir, or a fresh repo with no HEAD).
export async function workingTreeDirtyFiles(repoRoot: string): Promise<string[]> {
  const out = new Set<string>();
  const tracked = await git(repoRoot, ["diff", "--name-only", "-z", "HEAD"]);
  if (tracked.status === 0 && !tracked.timedOut && !tracked.truncated) {
    for (const f of tracked.stdout.split("\0")) if (f.length > 0) out.add(f);
  }
  const untracked = await git(repoRoot, ["ls-files", "-z", "--others", "--exclude-standard"]);
  if (untracked.status === 0 && !untracked.timedOut && !untracked.truncated) {
    for (const f of untracked.stdout.split("\0")) if (f.length > 0) out.add(f);
  }
  return [...out];
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
  // Resolve the repo realpath ONCE for the loop's contained reads (avoids
  // re-resolving per file). Unresolvable repo root → every read refuses (null).
  let repoReal: string | undefined;
  try {
    repoReal = realpathSync(repoRoot);
  } catch {
    repoReal = undefined;
  }
  for (const f of [...names].sort()) {
    if (used >= maxBytes) break;
    if (isExcludedFromReview(f)) continue;
    const abs = join(repoRoot, f);
    // Pre-read size probe ONLY to decide oversize-omit vs read (the omit marker
    // must still fire for a too-big regular file). lstat never FOLLOWs a symlink,
    // so a symlink/dir/special is skipped here; the ACTUAL read below goes through
    // safeReadContained (O_NOFOLLOW + fstat + read on one fd), which closes the
    // lstat→read TOCTOU — a symlink swapped in after this probe fails the open
    // instead of leaking an out-of-repo target (e.g. ~/.ssh/id_rsa). The size
    // budget is re-enforced inside safeReadContained too (defence in depth).
    const remaining = maxBytes - used;
    try {
      const st = lstatSync(abs);
      if (!st.isFile()) continue; // symlink/dir/special → skip
      if (st.size > remaining) {
        // Too big for the remaining budget: emit the omit marker (don't load it).
        if (omit(f)) break;
        continue;
      }
    } catch {
      continue; // deleted/vanished mid-listing
    }
    // Symlink-safe, realpath-contained read on a single fd. null = skip (a
    // swapped-in symlink, a binary/NUL file, a containment violation, or now-
    // oversize/gone) — fall through to the next file, same as the old catch.
    const content = safeReadContained(repoRoot, f, remaining, repoReal);
    if (content === null) continue;
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
