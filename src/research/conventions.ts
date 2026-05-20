// src/research/conventions.ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Conventions {
  summary: string;
}

export function loadConventions(repoRoot: string): Conventions {
  const parts: string[] = [];
  for (const f of ["CLAUDE.md", "README.md"]) {
    const p = join(repoRoot, f);
    if (existsSync(p))
      parts.push(`${f}: ${readFileSync(p, "utf8").slice(0, 600).replace(/\n+/g, " ")}`);
  }
  const pkg = join(repoRoot, "package.json");
  if (existsSync(pkg)) {
    try {
      const j = JSON.parse(readFileSync(pkg, "utf8")) as { scripts?: Record<string, string> };
      if (j.scripts) parts.push(`scripts: ${Object.keys(j.scripts).join(", ")}`);
    } catch {
      // ignore
    }
  }
  return { summary: parts.join(" | ").slice(0, 1500) || "No project conventions found." };
}
