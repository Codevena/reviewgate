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

function matches(e: BrainEntry, input: SelectInput): boolean {
  if (e.tags.some((t: string) => input.tags.includes(t))) return true;
  if (e.file_globs.some((g: string) => input.changedFiles.some((f: string) => minimatch(f, g))))
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
