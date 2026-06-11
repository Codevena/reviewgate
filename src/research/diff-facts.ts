// src/research/diff-facts.ts
export type FileKind = "code" | "docs" | "tests" | "config" | "lockfile" | "other";

export interface DiffFile {
  path: string;
  added: number;
  removed: number;
  kind: FileKind;
}

export interface DiffFacts {
  files: DiffFile[];
  totalAdded: number;
  totalRemoved: number;
  sensitivityTags: string[];
  docOnly: boolean;
  testsOnly: boolean;
  // True when EVERY changed file is a lockfile (regenerated package-lock.json /
  // bun.lock / … churn). Computed here (F-17) so the triage matrix can tier
  // lockfile-only diffs down (triageFromFacts maps it to the minimal tier)
  // instead of running the full default panel on thousands of machine-generated
  // lines; analogous to docOnly/testsOnly.
  lockfileOnly: boolean;
}

const SENSITIVE: Array<[RegExp, string]> = [
  [/(^|\/)auth\//, "auth"],
  [/(^|\/)crypto\//, "crypto"],
  [/\.sql$/, "sql"],
  [/(^|\/)migrations?\//, "migrations"],
  [/(^|\/)payment/, "payment"],
  [/\.env(\.|$)/, "env"],
];

function classify(path: string): FileKind {
  // "lockfile" feeds DiffFacts.lockfileOnly (the triage-side signal) and the
  // research.md per-file kind display (research-writer.ts). Without this branch
  // these files would classify as "config" via their .json/.yaml extensions.
  if (/(^|\/)(package-lock\.json|pnpm-lock\.yaml|bun\.lock[b]?|yarn\.lock)$/.test(path))
    return "lockfile";
  // Tests are checked BEFORE docs so a markdown fixture under tests/ (e.g.
  // tests/fixtures/expected.md) classifies as "tests", not "docs".
  if (/\.(test|spec)\.[a-z]+$|(^|\/)tests?\//.test(path)) return "tests";
  if (/\.(md|mdx|txt|rst)$|(^|\/)LICENSE$/.test(path)) return "docs";
  if (/\.(json|ya?ml|toml|ini|config\.[a-z]+)$/.test(path)) return "config";
  if (/\.(ts|tsx|js|jsx|py|go|rs|java|kt|c|cc|cpp|h|hpp|rb|php|cs)$/.test(path)) return "code";
  return "other";
}

export function computeDiffFacts(diff: string): DiffFacts {
  const parsed: DiffFile[] = [];
  let current: DiffFile | null = null;
  // @@-state tracking (F-14): only lines INSIDE a hunk are content. The naive
  // `startsWith("+") && !startsWith("+++")` filter also excluded real CONTENT
  // lines that begin with '++'/'--' (an added `++i;` renders as `+++i;`, a
  // removed SQL/Lua comment `-- foo` as `--- foo`), so a diff made up entirely
  // of such lines counted zero files and skipped review (fail-open). The
  // `--- a/…` / `+++ b/…` file headers only ever appear BETWEEN the `diff --git`
  // line and the first `@@`, so header-vs-content is decided by position, not
  // by prefix pattern.
  let inHunk = false;
  for (const line of diff.split("\n")) {
    // `diff --git a/<X> b/<X>` is symmetric with IDENTICAL X on both sides. A
    // lazy/greedy split on " b/" mis-parses any filename that itself contains
    // " b/" (the b-side path repeats the substring). So first try a backreference
    // (\1): require the b-side to EQUAL the a-side — this anchors the true
    // a/↔b/ boundary regardless of " b/" inside the name. Fall back to a greedy
    // split only for renames/copies (a/old b/new), where the sides differ.
    let path: string | undefined;
    const sym = line.match(/^diff --git a\/(.+) b\/\1$/);
    if (sym) {
      path = sym[1];
    } else {
      const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      if (m) path = m[2] ?? m[1];
    }
    if (path !== undefined && path !== "") {
      current = { path, added: 0, removed: 0, kind: classify(path) };
      parsed.push(current);
      inHunk = false; // next file's header zone starts here
      continue;
    }
    if (!current) continue;
    if (line.startsWith("@@")) {
      inHunk = true; // hunk header — content lines follow
      continue;
    }
    // Header zone (---/+++/index/mode/rename/Binary lines) is never content.
    if (!inHunk) continue;
    if (line.startsWith("+")) current.added += 1;
    else if (line.startsWith("-")) current.removed += 1;
  }
  // Drop entries with no added/removed content lines. These are pure renames
  // (100% similarity, header + rename lines, no @@), binary-file changes
  // (`Binary files … differ`, no @@), and mode-only changes. They carry zero
  // reviewable lines — parseChangedRanges yields no ranges, so scopeToDiff
  // would demote any finding anyway — but counting them inflates files.length
  // and skews docOnly/testsOnly, spawning a full panel on a no-op change.
  const files = parsed.filter((f) => f.added > 0 || f.removed > 0);
  const tags = new Set<string>();
  for (const f of files) for (const [re, tag] of SENSITIVE) if (re.test(f.path)) tags.add(tag);
  const totalAdded = files.reduce((s, f) => s + f.added, 0);
  const totalRemoved = files.reduce((s, f) => s + f.removed, 0);
  const nonDoc = files.filter((f) => f.kind !== "docs");
  const nonTest = files.filter((f) => f.kind !== "tests");
  const nonLockfile = files.filter((f) => f.kind !== "lockfile");
  return {
    files,
    totalAdded,
    totalRemoved,
    sensitivityTags: [...tags],
    docOnly: files.length > 0 && nonDoc.length === 0,
    testsOnly: files.length > 0 && nonTest.length === 0,
    lockfileOnly: files.length > 0 && nonLockfile.length === 0,
  };
}
