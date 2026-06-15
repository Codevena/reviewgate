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

// C-unquote a git-quoted path. With core.quotePath=true (git's default) a path
// with non-ASCII/space/control bytes is wrapped in double quotes and C-escaped
// (octal `\351`, plus `\t \n \" \\` …) in `diff --git`/`+++ ` headers. collectDiff
// now passes `-c core.quotePath=false` so the live path is raw, but this stays
// defensively so a quoted header from any OTHER diff source isn't dropped (which
// would skip-PASS unreviewed code). Bytes are decoded as UTF-8 (git quotes the
// raw UTF-8 octets). Returns the input unchanged if it isn't a quoted token.
function gitUnquotePath(token: string): string {
  if (!(token.length >= 2 && token.startsWith('"') && token.endsWith('"'))) return token;
  const body = token.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== "\\") {
      bytes.push(body.charCodeAt(i));
      continue;
    }
    const n = body[i + 1];
    if (n === undefined) {
      bytes.push(0x5c);
      break;
    }
    if (n >= "0" && n <= "7") {
      // Octal escape: up to 3 octal digits (\351).
      let oct = n;
      let j = i + 2;
      while (oct.length < 3) {
        const d = body[j];
        if (d === undefined || d < "0" || d > "7") break;
        oct += d;
        j++;
      }
      bytes.push(Number.parseInt(oct, 8) & 0xff);
      i = j - 1;
      continue;
    }
    const simple: Record<string, number> = {
      a: 0x07,
      b: 0x08,
      t: 0x09,
      n: 0x0a,
      v: 0x0b,
      f: 0x0c,
      r: 0x0d,
      '"': 0x22,
      "\\": 0x5c,
    };
    bytes.push(simple[n] ?? n.charCodeAt(0));
    i++;
  }
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(Uint8Array.from(bytes));
  } catch {
    return token;
  }
}

export function classify(path: string): FileKind {
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
    // Quoted header (a diff source that left core.quotePath on): both sides are
    // double-quoted C-escaped tokens — `diff --git "a/<X>" "b/<X>"`. Unquote the
    // b-side. Matched BEFORE the unquoted forms so the quotes/escapes don't leak
    // into the path (which would mis-classify and drop range attribution).
    const q = line.match(/^diff --git "a\/(.+)" "b\/(.+)"$/);
    if (q) {
      path = gitUnquotePath(`"${q[2] ?? q[1]}"`);
    } else {
      const sym = line.match(/^diff --git a\/(.+) b\/\1$/);
      if (sym) {
        path = sym[1];
      } else {
        const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
        if (m) path = m[2] ?? m[1];
      }
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
