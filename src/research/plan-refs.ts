// src/research/plan-refs.ts
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { neutralizeFences, neutralizeInjectionMarkers } from "../diff/sanitizer.ts";
import { spawnCapture } from "../utils/spawn-capture.ts";

function defangSentinels(s: string): string {
  return s
    .replace(/<<UNTRUSTED_DIFF>>/gi, "<!UNTRUSTED_DIFF!>")
    .replace(/<<END_UNTRUSTED>>/gi, "<!END_UNTRUSTED!>");
}

const CODE_EXT = "ts|tsx|js|jsx|py|go|rs|java|kt|c|cc|cpp|h|hpp|rb|php|cs";
const EXT_RE = new RegExp(`\\.(?:${CODE_EXT})$`);
const PATH_CHARS = /[^A-Za-z0-9_./-]+/; // anything NOT allowed in a path token = a delimiter
const MAX_CANDIDATES = 200;

/** Extract repo-relative-looking code-file paths from arbitrary plan text (raw or
 *  a git-diff body — the `+`/`-`/` ` columns aren't in the token charset so they
 *  don't interfere). Dedupes, preserves first-seen order, caps the list. */
export function extractReferencedPaths(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  // Split on delimiters first (linear), then test each short token — avoids the
  // O(n²) backtracking of one greedy regex over untrusted/long plan text.
  for (const tok of text.split(PATH_CHARS)) {
    if (!tok || tok.includes("..") || seen.has(tok)) continue;
    if (!EXT_RE.test(tok)) continue;
    seen.add(tok);
    out.push(tok);
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

export interface ReferencedFilesInput {
  repoRoot: string;
  planText: string;
  budgetBytes: number;
  maxFiles?: number;
  excludePaths?: string[];
  signal?: AbortSignal;
}

const PROTECTED_PREFIXES = [".reviewgate/", ".git/", ".hg/", ".svn/"];
const PROTECTED_FILES = ["reviewgate.config.ts"];

/**
 * Returns the subset of `paths` that git does NOT ignore, or `null` on a real
 * gate failure (timeout / truncated / null status / status > 1).
 * Callers must fail closed (inject nothing) on `null`.
 *
 * Exit-code semantics:
 *   0 = some paths are ignored (they're listed on stdout — drop them)
 *   1 = no paths are ignored (keep all)
 *   Both 0 and 1 are SUCCESS. Anything else (incl. 128 "not a git repo" /
 *   corrupt repo) is fail-closed: in production Reviewgate always runs inside a
 *   git repo, so a non-0/1 exit means the privacy-determining gitignore state is
 *   unknown — inject nothing rather than risk leaking an ignored file.
 */
async function gitignoreGate(
  repoRoot: string,
  paths: string[],
  signal?: AbortSignal,
): Promise<string[] | null> {
  if (paths.length === 0) return [];
  const r = await spawnCapture("git", ["check-ignore", "--", ...paths], {
    cwd: repoRoot,
    timeoutMs: 10_000,
    signal,
  });
  // exit 0 = some ignored (listed on stdout); 1 = none ignored. Both are success.
  if (r.timedOut || r.truncated || r.status === null || r.status > 1) return null; // fail closed
  const ignored = new Set(
    (r.stdout ?? "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return paths.filter((p) => !ignored.has(p));
}

export async function collectReferencedFileContents(input: ReferencedFilesInput): Promise<string> {
  try {
    const { repoRoot, planText } = input;
    const exclude = new Set((input.excludePaths ?? []).map((p) => p.toLowerCase()));
    let repoReal: string;
    try {
      repoReal = realpathSync(repoRoot);
    } catch {
      return "";
    }
    // Drop absolute paths BEFORE the gate: an out-of-repo path makes
    // `git check-ignore` exit 128, which would fail-close the WHOLE batch and
    // silently suppress all legit candidates. They'd be rejected by the
    // downstream repo-relative guard anyway, so nothing is lost.
    const candidates = extractReferencedPaths(planText).filter((p) => !isAbsolute(p));
    const gated = await gitignoreGate(repoRoot, candidates, input.signal);
    if (gated === null) return ""; // gate failure → fail closed
    const budget = input.budgetBytes;
    const maxFiles = input.maxFiles ?? 20;
    let out = "";
    let used = 0;
    let rendered = 0;
    const omit = (f: string): boolean => {
      const note = `### ${f}\n(omitted — context budget exceeded)\n`;
      out += note;
      used += note.length;
      return used >= budget;
    };
    for (const rel of gated) {
      if (input.signal?.aborted) break;
      if (rendered >= maxFiles) break; // silent cap — no marker
      const lower = rel.toLowerCase();
      if (exclude.has(lower)) continue;
      if (PROTECTED_FILES.includes(lower)) continue;
      if (PROTECTED_PREFIXES.some((p) => lower.startsWith(p))) continue;

      const abs = join(repoRoot, rel);
      const relCheck = relative(repoRoot, abs);
      if (relCheck.startsWith("..") || isAbsolute(relCheck)) continue;

      // realpath containment — catches intermediate-dir-symlink escape that lstat misses.
      let rp: string;
      try {
        rp = realpathSync(abs);
      } catch {
        continue; // non-existent
      }
      const relReal = relative(repoReal, rp);
      if (relReal.startsWith("..") || isAbsolute(relReal)) continue;

      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(abs);
      } catch {
        continue;
      }
      if (!st.isFile()) continue; // reject symlink/dir/special final component

      // pre-read size guard: never load a file that can't fit the remaining budget
      if (st.size > budget - used) {
        if (omit(relCheck)) break;
        continue;
      }

      let content: string;
      try {
        content = readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      if (content.includes("\0")) continue; // required binary guard

      content = neutralizeFences(defangSentinels(neutralizeInjectionMarkers(content)));

      const block = `### ${relCheck}\n\`\`\`\n${content}\n\`\`\`\n`;
      if (used + block.length > budget) {
        if (omit(relCheck)) break;
        continue;
      }
      out += block;
      used += block.length;
      rendered += 1;
    }
    return out;
  } catch {
    return ""; // fail-safe: never throw
  }
}
