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
  // The output is a Seatbelt RAW regex literal `#"…"` (backslashes pass verbatim to
  // the regex engine — see the design spec's `#"…\.env$"`, single-backslash form —
  // so this is NOT a string-escape context and we must NOT double `\`). The one
  // injection vector is a character that can break out of the `#"…"` literal: a
  // double-quote terminates it early (and could neutralize trailing deny rules),
  // and a control char (newline/CR/NUL) can corrupt the lexer. A real secret-file
  // glob never contains these, so strip them from config-supplied input before
  // embedding — fail-safe (the deny still binds to the sanitized pattern; it can no
  // longer escape the literal).
  const sanitized = glob.replace(/["\n\r\0]/g, "");
  const escaped = sanitized.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  // (^|/) — start of string or a path separator — then the pattern, then end.
  const body = `(^|/)${escaped}$`;
  return `#"${body}"`;
}

export function buildMacosSbpl(profile: SandboxProfile): string {
  for (const w of profile.fs.writeAllow) {
    for (const d of profile.fs.readDeny) {
      // Bidirectional (mirror bwrap's assertNoSandboxOverlap): reject BOTH
      // isUnder(w, d) — writeAllow nested under readDeny (write-only) — AND
      // isUnder(d, w) — readDeny nested under a broad writeAllow, which would
      // leave a writable-but-unreadable secret (integrity hole).
      if (isUnder(w, d) || isUnder(d, w))
        throw new Error(
          `SBPL conflict: writeAllow ${w} and readDeny ${d} are nested (write-only/un-mask)`,
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
