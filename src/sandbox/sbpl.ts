// src/sandbox/sbpl.ts
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { SandboxProfile } from "./profile-builder.ts";

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

const sbplString = (s: string): string => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const isUnder = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(`${parent}/`);

export function buildMacosSbpl(profile: SandboxProfile): string {
  for (const w of profile.fs.writeAllow) {
    for (const d of profile.fs.readDeny) {
      if (isUnder(w, d))
        throw new Error(
          `SBPL conflict: writeAllow ${w} is nested under readDeny ${d} (write-only)`,
        );
    }
  }
  const lines: string[] = ["(version 1)", "(allow default)"];
  if (profile.fs.writeAllow.length > 0) {
    lines.push("(deny file-write*)");
    const targets = profile.fs.writeAllow.map((p) => `(subpath "${sbplString(p)}")`).join(" ");
    lines.push(`(allow file-write* ${targets})`);
  }
  if (profile.fs.readDeny.length > 0) {
    const targets = profile.fs.readDeny.map((p) => `(subpath "${sbplString(p)}")`).join(" ");
    lines.push(`(deny file-read* ${targets})`);
  }
  return `${lines.join("\n")}\n`;
}
