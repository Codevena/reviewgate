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
  if (/(^|\/)(package-lock\.json|pnpm-lock\.yaml|bun\.lock[b]?|yarn\.lock)$/.test(path))
    return "lockfile";
  if (/\.(md|mdx|txt|rst)$|(^|\/)LICENSE$/.test(path)) return "docs";
  if (/\.(test|spec)\.[a-z]+$|(^|\/)tests?\//.test(path)) return "tests";
  if (/\.(json|ya?ml|toml|ini|config\.[a-z]+)$/.test(path)) return "config";
  if (/\.(ts|tsx|js|jsx|py|go|rs|java|kt|c|cc|cpp|h|hpp|rb|php|cs)$/.test(path)) return "code";
  return "other";
}

export function computeDiffFacts(diff: string): DiffFacts {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  for (const line of diff.split("\n")) {
    const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (m) {
      current = {
        path: m[2] ?? m[1] ?? "",
        added: 0,
        removed: 0,
        kind: classify(m[2] ?? m[1] ?? ""),
      };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) current.added += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) current.removed += 1;
  }
  const tags = new Set<string>();
  for (const f of files) for (const [re, tag] of SENSITIVE) if (re.test(f.path)) tags.add(tag);
  const totalAdded = files.reduce((s, f) => s + f.added, 0);
  const totalRemoved = files.reduce((s, f) => s + f.removed, 0);
  const nonDoc = files.filter((f) => f.kind !== "docs");
  const nonTest = files.filter((f) => f.kind !== "tests");
  return {
    files,
    totalAdded,
    totalRemoved,
    sensitivityTags: [...tags],
    docOnly: files.length > 0 && nonDoc.length === 0,
    testsOnly: files.length > 0 && nonTest.length === 0,
  };
}
