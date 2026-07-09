// src/core/lore/staleness.ts — anchor resolution against the live repo tree +
// SHA-256 verified_tree staleness hashing. See
// docs/superpowers/specs/2026-07-09-lore-design.md ("Retrieval + injection",
// "Staleness + reminder"). All exports are SYNCHRONOUS by contract — Tasks 3
// (retrieval/injection) and 6 (staleness reminder) consume them inline in the
// gate's synchronous decision path, so none of these may ever return a Promise.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LORE_BROAD_ANCHOR_FILE_CAP } from "../../schemas/lore.ts";
import type { LoreEntryParsed } from "./store.ts";

const EXCLUDED_PREFIXES = [".git/", "node_modules/", ".reviewgate/"];

function isExcluded(relPath: string): boolean {
  return EXCLUDED_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

// Resolves an entry's anchors (exact repo-relative paths or globs) against the
// live repo tree into a sorted, deduped, repo-relative file list.
//
// Mirrors matchesAnyGlob (src/triage/matrix.ts): an invalid glob pattern (e.g.
// an unterminated character class) is skipped via `continue`, never thrown —
// matching fails open to fewer matches so one malformed anchor can't crash the
// gate or take down every other anchor on the same entry.
export function resolveAnchors(repoRoot: string, anchors: string[]): string[] {
  const matched = new Set<string>();
  for (const anchor of anchors) {
    let glob: InstanceType<typeof Bun.Glob>;
    try {
      glob = new Bun.Glob(anchor);
    } catch {
      continue;
    }
    try {
      for (const rel of glob.scanSync({ cwd: repoRoot, dot: false })) {
        if (isExcluded(rel)) continue;
        matched.add(rel);
      }
    } catch {
      // A glob that constructs fine but fails to scan (unexpected, but not
      // provably impossible) — same fail-open posture as the constructor catch.
    }
  }
  return [...matched].sort();
}

// verified_tree = SHA-256 over the newline-joined, path-sorted
// `<path>\0<sha256(raw file bytes)>` pairs (part of the reviewgate.lore.v1
// schema — see src/schemas/lore.ts header comment; changing this algorithm
// needs a schema version bump + re-verify, no silent migration).
//
// RAW BYTES, never a utf8-decoded string: readFileSync() without an encoding
// argument returns a Buffer, and that Buffer is hashed directly. Decoding to
// utf8 first would let two byte-distinct files (e.g. differing only in an
// invalid/replaced byte sequence) collide on the same string and therefore
// the same hash — the repo's established "utf8-collision lesson".
export function computeVerifiedTree(repoRoot: string, files: string[]): string {
  const sorted = [...files].sort();
  const pairs = sorted.map((rel) => {
    const bytes = readFileSync(join(repoRoot, rel));
    const fileHash = createHash("sha256").update(bytes).digest("hex");
    return `${rel}\0${fileHash}`;
  });
  return createHash("sha256").update(pairs.join("\n")).digest("hex");
}

export function classifyEntry(
  repoRoot: string,
  entry: LoreEntryParsed,
): { state: "ok" | "stale" | "broad" | "zero-match"; files: string[] } {
  const files = resolveAnchors(repoRoot, entry.anchors);
  if (files.length === 0) return { state: "zero-match", files: [] };
  // A >200-file anchor is excluded from BOTH hashing AND injection (spec,
  // "Staleness + reminder"): never-stale-because-never-hashed would be a
  // durable freshness bypass for an entry with a lazily broad anchor, so we
  // short-circuit before computeVerifiedTree ever runs.
  if (files.length > LORE_BROAD_ANCHOR_FILE_CAP) return { state: "broad", files };
  try {
    const tree = computeVerifiedTree(repoRoot, files);
    return { state: tree === entry.verified_tree ? "ok" : "stale", files };
  } catch {
    // FAIL-SAFE, asymmetric by design (spec, "Failure behavior"): context
    // features (injection, staleness reminder) fail OPEN toward "review
    // without lore" / "treated fresh, still injected" — a mid-read error here
    // (file vanished/permission changed between resolveAnchors and the hash
    // read) must never manufacture a stale reminder or a block. Only the
    // TRUST boundary (canon approval) fails CLOSED; staleness detection is
    // not that boundary, so an infra hiccup degrades to "ok", not "stale".
    return { state: "ok", files };
  }
}
