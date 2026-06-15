// src/core/brain/select.ts
import { minimatch } from "minimatch";
import type { BrainEntry } from "../../schemas/brain.ts";

export interface SelectInput {
  tags: string[];
  changedFiles: string[];
  categories: string[];
  maxTokens: number;
}

const PRIORITY: Record<BrainEntry["type"], number> = {
  convention: 0,
  "anti-pattern": 1,
  "external-knowledge": 2,
  "research-cache": 3,
  disagreement: 4,
};

const approxTokens = (s: string): number => Math.ceil(s.length / 4);

// CPU-DoS / ReDoS bound for the glob-match hot path. `file_globs` are
// attacker-influenceable (they originate from reviewer-proposed brain entries),
// and minimatch compiles a pattern into a RegExp that can backtrack
// catastrophically on crafted inputs (e.g. long runs of `*`/`+(...)`/`?(...)`).
// We cap how many globs we consider per entry and the length of each glob, and
// wrap the match in try/catch so a pathological pattern is skipped rather than
// hanging the synchronous main review path.
const MAX_GLOB_LENGTH = 256;
const MAX_GLOBS_PER_ENTRY = 64;

// A pattern is "safe enough" to feed to minimatch when it is short and does not
// pile up the extglob/star constructs that drive minimatch's regex into
// exponential backtracking. We reject (skip) anything over the length cap or
// with an excessive number of `*` / extglob group openers.
function isSafeGlob(g: string): boolean {
  if (g.length > MAX_GLOB_LENGTH) return false;
  // Count the constructs that translate into greedy/backtracking regex pieces.
  // A handful is fine; a crafted pattern with dozens is the catastrophic case.
  let stars = 0;
  let extglobs = 0;
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") stars++;
    // extglob openers: ?( *( +( @( !(
    else if ((c === "?" || c === "+" || c === "@" || c === "!") && g[i + 1] === "(") extglobs++;
  }
  return stars <= 16 && extglobs <= 8;
}

function globMatches(file: string, glob: string): boolean {
  if (!isSafeGlob(glob)) return false;
  try {
    return minimatch(file, glob);
  } catch {
    // A malformed pattern (minimatch can throw on some inputs) is never a match.
    return false;
  }
}

function matches(e: BrainEntry, input: SelectInput): boolean {
  if (e.tags.some((t: string) => input.tags.includes(t))) return true;
  // Bound the number of globs we evaluate per entry so a single entry carrying
  // hundreds of globs can't dominate the synchronous review path.
  const globs = e.file_globs.slice(0, MAX_GLOBS_PER_ENTRY);
  if (globs.some((g: string) => input.changedFiles.some((f: string) => globMatches(f, g))))
    return true;
  if (input.categories.includes(e.type)) return true;
  return false;
}

export function selectBrainEntries(entries: BrainEntry[], input: SelectInput): BrainEntry[] {
  const eligible = entries
    .filter((e) => e.status === "active" || e.status === "candidate")
    .filter((e) => matches(e, input))
    .sort(
      (a, b) =>
        (PRIORITY[a.type] ?? 99) - (PRIORITY[b.type] ?? 99) ||
        b.referenced_count - a.referenced_count,
    );
  const out: BrainEntry[] = [];
  let used = 0;
  for (const e of eligible) {
    const cost = approxTokens(`${e.title}\n${e.body}`);
    if (used + cost > input.maxTokens) continue;
    used += cost;
    out.push(e);
  }
  return out;
}
