import { existsSync, statSync } from "node:fs";
import type { SandboxProfile } from "./profile-builder.ts";

const stripTrailingSlash = (p: string): string => (p.endsWith("/") ? p.slice(0, -1) : p);

const isUnder = (child: string, parent: string): boolean => {
  const c = stripTrailingSlash(child);
  const p = stripTrailingSlash(parent);
  return c === p || c.startsWith(`${p}/`);
};

// Reject a profile where a writeAllow path and a readDeny path are nested in EITHER
// direction (write-under-deny = write-only; deny-under-write = unmasked+writable).
// Exported so callers can validate BEFORE any host-side mutation (e.g. spawnSafely's
// ensureWriteTargets), not only at argv-build time.
export function assertNoSandboxOverlap(writeAllow: string[], readDeny: string[]): void {
  for (const w of writeAllow) {
    for (const d of readDeny) {
      if (isUnder(w, d) || isUnder(d, w)) {
        throw new Error(
          `bwrap conflict: writeAllow ${w} and readDeny ${d} are nested (write-only/un-mask)`,
        );
      }
    }
  }
}

// Build the bubblewrap argv (up to and including the `--` terminator) that
// filesystem-isolates a reviewer on Linux. Deny-mirror: expose / read-only, bind
// the writable working area, then mask secrets LAST so no writable bind can shadow
// a mask. fs-reading (statSync/existsSync to classify file vs dir) but NON-mutating:
// every writeAllow target must already exist (caller created them) and every path
// must already be absolute + realpath'd.
export function buildBwrapArgs(profile: SandboxProfile): string[] {
  // Bidirectional overlap guard (parity with the macOS write-only guard): a write
  // path under a deny path is write-only; a deny path under a write path would be
  // un-masked AND writable. Either nesting -> throw.
  assertNoSandboxOverlap(profile.fs.writeAllow, profile.fs.readDeny);
  const args: string[] = [
    "--die-with-parent",
    "--unshare-user",
    "--unshare-pid",
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
  ];
  // Writable binds first, each at its OWN location (file->file, dir->dir). Skip any
  // that don't exist (an absent own-cred candidate the caller left alone) -- bwrap
  // can't bind a non-existent source.
  for (const p of profile.fs.writeAllow) {
    if (!existsSync(p)) continue;
    args.push("--bind", p, p);
  }
  // Secret masks LAST. A directory -> empty tmpfs; a file -> /dev/null (tmpfs can't
  // mount onto a regular file). Skip non-existent. readDenyGlobs are NOT enforced.
  for (const p of profile.fs.readDeny) {
    if (!existsSync(p)) continue;
    if (statSync(p).isDirectory()) {
      args.push("--tmpfs", p);
    } else {
      args.push("--ro-bind", "/dev/null", p);
    }
  }
  args.push("--");
  return args;
}
