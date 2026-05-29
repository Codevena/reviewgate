// src/sandbox/sbpl.ts
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { SandboxProfile } from "./profile-builder.ts";

export function resolveForSandbox(p: string, homeDir: string): string {
  const expanded = p === "~" ? homeDir : p.startsWith("~/") ? join(homeDir, p.slice(2)) : p;
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

// Translate a basename/extension glob (".env", "*.pem", ".env.local") into a
// Seatbelt regex literal `#"…"`. Escapes regex metacharacters, turns `*` into
// `[^/]*`, and anchors to a full path SEGMENT ending at the path end — so it
// matches the file ANYWHERE in the tree (e.g. "*.pem" → any "…/foo.pem"; ".env" →
// any "…/.env") without matching a literal "*"/segment substring. Used for the
// readDenyGlobs path; a glob has no single location so it can't be a subpath.
export function globToSbplRegex(glob: string): string {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  // (^|/) — start of string or a path separator — then the pattern, then end.
  const body = `(^|/)${escaped}$`;
  return `#"${body}"`;
}

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
  const readDenyTargets: string[] = [
    ...profile.fs.readDeny.map((p) => `(subpath "${sbplString(p)}")`),
    ...profile.fs.readDenyGlobs.map((g) => `(regex ${globToSbplRegex(g)})`),
  ];
  if (readDenyTargets.length > 0) {
    lines.push(`(deny file-read* ${readDenyTargets.join(" ")})`);
  }
  return `${lines.join("\n")}\n`;
}
