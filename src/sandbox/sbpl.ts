// src/sandbox/sbpl.ts
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

export function resolveForSandbox(p: string, homeDir: string): string {
  const expanded =
    p === "~" ? homeDir : p.startsWith("~/") ? join(homeDir, p.slice(2)) : p;
  const abs = isAbsolute(expanded) ? expanded : join(homeDir, expanded);
  try {
    return realpathSync(abs);
  } catch {
    const tail: string[] = [];
    let cur = abs;
    for (;;) {
      const parent = dirname(cur);
      if (parent === cur) return abs;
      tail.unshift(basename(cur));
      cur = parent;
      try {
        return join(realpathSync(cur), ...tail);
      } catch {
        /* keep walking up */
      }
    }
  }
}
