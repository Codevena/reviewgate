// src/research/conventions.ts
import { safeReadContained } from "../utils/safe-read.ts";

export interface Conventions {
  summary: string;
}

// These project files are read as trusted reviewer context, so use the symlink-safe,
// realpath-contained, size-capped read: an agent-under-review can plant CLAUDE.md /
// README.md / package.json as symlinks pointing outside the repo to leak their bytes.
const CONVENTIONS_FILE_CAP = 64 * 1024;

export function loadConventions(repoRoot: string): Conventions {
  const parts: string[] = [];
  for (const f of ["CLAUDE.md", "README.md"]) {
    const raw = safeReadContained(repoRoot, f, CONVENTIONS_FILE_CAP);
    if (raw !== null) parts.push(`${f}: ${raw.slice(0, 600).replace(/\n+/g, " ")}`);
  }
  const pkgRaw = safeReadContained(repoRoot, "package.json", CONVENTIONS_FILE_CAP);
  if (pkgRaw !== null) {
    try {
      const j = JSON.parse(pkgRaw) as { scripts?: Record<string, string> };
      if (j.scripts) parts.push(`scripts: ${Object.keys(j.scripts).join(", ")}`);
    } catch {
      // ignore
    }
  }
  return { summary: parts.join(" | ").slice(0, 1500) || "No project conventions found." };
}
