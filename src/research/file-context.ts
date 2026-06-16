// src/research/file-context.ts
import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { Range } from "../diff/hunks.ts";
import { isExcludedFromReview } from "../utils/git.ts";
import { safeReadContained } from "../utils/safe-read.ts";
import { fileSymbols } from "./symbol-graph.ts";

const MAX_READ_BYTES = 2 * 1024 * 1024; // = symbol-graph PARSE_FILE_CAP, so a parseable file is sliceable

export interface FileContextOpts {
  repoRoot: string;
  changedRanges: Map<string, Range[]>;
  totalBudgetBytes: number;
  perFileBytes: number;
  windowLines: number;
  signal?: AbortSignal;
}

// Merge [startInclusive, endInclusive] line intervals (1-based) that touch/overlap.
function mergeIntervals(iv: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...iv].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: Array<[number, number]> = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

export async function collectFileContext(opts: FileContextOpts): Promise<string> {
  const { repoRoot, changedRanges, totalBudgetBytes, perFileBytes, windowLines, signal } = opts;
  let repoReal: string | undefined;
  try {
    repoReal = realpathSync(repoRoot);
  } catch {
    repoReal = undefined;
  }
  let out = "";
  let used = 0;
  // PRE-check the bound (mirrors collectChangedFileContents in git.ts): appending
  // first then checking lets the final block overflow by up to a whole block, so
  // refuse anything that would breach the hard bound. Guarantees out.length <=
  // totalBudgetBytes always.
  const emit = (s: string): boolean => {
    if (used + s.length > totalBudgetBytes) {
      // Would breach the hard bound — emit a tiny marker if even that fits, then stop.
      const marker = "### (further files omitted — context budget exceeded)\n";
      if (used + marker.length <= totalBudgetBytes) {
        out += marker;
        used += marker.length;
      }
      return true; // stop
    }
    out += s;
    used += s.length;
    return used >= totalBudgetBytes;
  };

  for (const file of [...changedRanges.keys()].sort()) {
    signal?.throwIfAborted();
    if (used >= totalBudgetBytes) break;
    if (isExcludedFromReview(file)) continue;
    const abs = join(repoRoot, file);
    let size: number;
    try {
      const st = lstatSync(abs);
      if (!st.isFile()) continue;
      size = st.size;
    } catch {
      continue;
    }

    if (size <= perFileBytes) {
      const content = safeReadContained(repoRoot, file, perFileBytes, repoReal);
      if (content === null) continue;
      if (emit(`### ${file}\n\`\`\`\n${content}\n\`\`\`\n`)) break;
      continue;
    }

    const content = safeReadContained(repoRoot, file, MAX_READ_BYTES, repoReal);
    if (content === null) {
      if (emit(`### ${file}\n(omitted — too large for context or unreadable)\n`)) break;
      continue;
    }
    const lines = content.split("\n");
    const ranges = changedRanges.get(file) ?? [];
    const syms = await fileSymbols(abs, repoRoot);

    const parts: string[] = [];
    const covered: Array<[number, number]> = [];

    if (syms && syms.length > 0) {
      parts.push(`// symbols: ${syms.map((s) => `${s.name}@L${s.startLine}`).join(", ")}`);
      let selected = syms.filter((s) =>
        ranges.some(([start, endEx]) => s.startLine <= endEx - 1 && s.endLine >= start),
      );
      selected = selected.filter(
        (s) =>
          !selected.some((o) => o !== s && o.startLine <= s.startLine && o.endLine >= s.endLine),
      );
      for (const s of selected.sort((a, b) => a.startLine - b.startLine)) {
        parts.push(lines.slice(s.startLine - 1, s.endLine).join("\n"));
        covered.push([s.startLine, s.endLine]);
      }
    }

    const windows: Array<[number, number]> = [];
    for (const [start, endEx] of ranges) {
      const rs = start;
      const re = endEx - 1;
      if (covered.some(([cs, ce]) => cs <= rs && ce >= re)) continue;
      windows.push([Math.max(1, rs - windowLines), Math.min(lines.length, re + windowLines)]);
    }
    for (const [ws, we] of mergeIntervals(windows)) {
      parts.push(lines.slice(ws - 1, we).join("\n"));
    }

    // Header tag reflects what's actually in `body`: empty ranges → outline only
    // (don't claim "enclosing functions of the changed lines" when there are none).
    const tag =
      ranges.length === 0
        ? "symbol outline; no changed lines in range"
        : syms && syms.length > 0
          ? "symbol outline + enclosing functions of the changed lines"
          : "line windows of the changed lines";
    let body = parts.join("\n…\n");
    if (body.length > perFileBytes) {
      body = `${body.slice(0, perFileBytes)}\n… (truncated — over per-file context budget)`;
    }
    if (emit(`### ${file} (scoped: ${tag})\n\`\`\`\n${body}\n\`\`\`\n`)) break;
  }
  return out;
}
