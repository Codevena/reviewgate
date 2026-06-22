// src/core/session-manifest.ts
//
// Slice A (P1, field report 2026-06-22): per-session baseline-delta ownership. See
// src/schemas/session-manifest.ts for the model. The PRIMARY ownership signal is the
// content hash: a file is FOREIGN to this session only if it was working-tree-dirty at
// SessionStart AND is byte-identical to that baseline now (the session made no net change
// to it). Any change this session made — via the Edit tools OR via Bash/sed/scripts —
// alters the hash, so the file is never wrongly demoted. `owned` is a belt-and-suspenders
// signal (a file the session tool-edited then reverted to its baseline bytes stays reviewed).
//
// Single-agent / clean-start sessions have an EMPTY baseline → computeForeignFiles returns
// an empty set → the gate applies no scoping → behavior is identical to today. The feature
// only ever changes behavior when pre-existing dirty state exists at session start.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { normalizeRepoPath } from "../diff/repo-path.ts";
import { type SessionManifest, SessionManifestSchema } from "../schemas/session-manifest.ts";
import { isExcludedFromReview, workingTreeDirtyFiles } from "../utils/git.ts";
import { sessionManifestPath, sessionsDir } from "../utils/paths.ts";
import { safeReadContained } from "../utils/safe-read.ts";

// Caps so baseline hashing on a pathological dirty tree can't stall the SessionStart hook.
// A skipped (oversize/unreadable/binary) dirty file is simply omitted from the baseline →
// it is never classified foreign → it is reviewed (safe over-review, never a fail-open).
const MAX_BASELINE_FILES = 500;
const MAX_BASELINE_FILE_BYTES = 1_000_000;

// Prune session manifests older than this so the dir can't grow unbounded across many
// sessions on one checkout. Bounded by created_at, not mtime (mtime is settable).
const MANIFEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function hashContent(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// Repo-relative + traversal-safe, or null to skip. Tool paths can be absolute; baseline
// paths come from git (already relative). Anything that can't be relativized into the repo
// is dropped (M10: never store an absolute path that would make every finding look foreign).
// An ABSOLUTE path is canonicalized against the realpath'd repo root first, so a symlinked
// root (macOS /tmp→/private/tmp, or a symlinked checkout) doesn't make an in-repo file look
// like it escapes — without this, an absolute tool file_path under such a root is wrongly
// dropped from `owned` (the content-hash baseline still covers it, so this is a belt fix).
function inRepo(rel: string): boolean {
  return rel.length > 0 && !isAbsolute(rel) && !rel.startsWith("/") && !rel.startsWith("..");
}
function safeRel(repoRoot: string, p: string): string | null {
  // Try the RAW form first: handles the common case where the caller's path and repoRoot share
  // the same symlink form (incl. a not-yet-existent file), and the relative side never wrongly
  // escapes. Only realpath-canonicalize when the raw form escapes — that is the symlinked-root
  // mismatch (macOS /tmp→/private/tmp, a symlinked checkout) where one side differs.
  const raw = normalizeRepoPath(p, repoRoot);
  if (inRepo(raw)) return raw;
  if (isAbsolute(p)) {
    try {
      const root = realpathSync(repoRoot);
      let abs = p;
      try {
        abs = realpathSync(p); // file exists (trigger time) → canonicalize symlinks
      } catch {
        // File gone/not-yet-created → canonicalize its existing parent dir + re-append basename.
        try {
          abs = join(realpathSync(dirname(p)), basename(p));
        } catch {
          abs = p;
        }
      }
      const rel = normalizeRepoPath(abs, root);
      if (inRepo(rel)) return rel;
    } catch {
      /* unresolvable root → fall through to null */
    }
  }
  return null;
}

export function readSessionManifest(repoRoot: string, sessionId: string): SessionManifest | null {
  if (!sessionId) return null;
  const p = sessionManifestPath(repoRoot, sessionId);
  if (!existsSync(p)) return null;
  try {
    const parsed = SessionManifestSchema.safeParse(JSON.parse(readFileSync(p, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function writeManifest(repoRoot: string, m: SessionManifest): void {
  const dir = sessionsDir(repoRoot);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const p = sessionManifestPath(repoRoot, m.session_id);
  // Unique temp + atomic rename — parallel async PostToolUse triggers of the same session
  // must not clobber each other's in-flight write before the rename completes.
  const tmp = `${p}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, JSON.stringify(m), { mode: 0o600 });
  renameSync(tmp, p);
}

// SessionStart: capture the working-tree-dirty baseline (path -> content hash) for this
// session, BEFORE it edits anything. Idempotent — if a manifest already exists for this
// session_id (a resume, or a second SessionStart), the original baseline is PRESERVED so a
// resume never folds this session's own prior edits into the baseline. No session_id → no-op
// (the gate then fail-closes to a full review). Best-effort: never throws into the hook.
export async function captureSessionBaseline(
  repoRoot: string,
  sessionId: string,
  nowIso: string,
): Promise<void> {
  if (!sessionId) return;
  if (readSessionManifest(repoRoot, sessionId)) return; // preserve an existing baseline (resume)
  let dirty: string[] = [];
  try {
    dirty = await workingTreeDirtyFiles(repoRoot);
  } catch {
    dirty = [];
  }
  const baseline: Record<string, string> = {};
  let count = 0;
  for (const f of dirty) {
    if (count >= MAX_BASELINE_FILES) break;
    const rel = safeRel(repoRoot, f);
    if (!rel) continue;
    // Reviewgate's own managed files (.reviewgate/, incl. the transient gate.lock the reset
    // itself just created) and .review/.antigravitycli scratch are excluded from review
    // entirely, so they can never produce a finding to demote — keep them out of the baseline
    // too (no point hashing churning state files; mirrors the reviewed-diff exclusion).
    if (isExcludedFromReview(rel)) continue;
    const content = safeReadContained(repoRoot, rel, MAX_BASELINE_FILE_BYTES);
    if (content === null) continue; // unreadable/oversize/binary → omit → reviewed (safe)
    baseline[rel] = hashContent(content);
    count++;
  }
  try {
    writeManifest(repoRoot, {
      schema: "reviewgate.session-manifest.v1",
      session_id: sessionId,
      baseline,
      owned: [],
      created_at: nowIso,
    });
  } catch {
    /* best-effort: a manifest write failure just means full review (fail-closed) */
  }
}

// PostToolUse: record files this session edited via a captured tool. Belt-and-suspenders
// over the content hash (the primary signal); a lost entry under a write race is benign
// because an edited file's hash already differs from its baseline → not foreign. No
// session_id / no files → no-op. Best-effort: never throws into the hook.
export function recordSessionOwned(repoRoot: string, sessionId: string, files: string[]): void {
  if (!sessionId || files.length === 0) return;
  const rels = files.map((f) => safeRel(repoRoot, f)).filter((r): r is string => r !== null);
  if (rels.length === 0) return;
  const existing = readSessionManifest(repoRoot, sessionId);
  const base: SessionManifest = existing ?? {
    schema: "reviewgate.session-manifest.v1",
    session_id: sessionId,
    baseline: {},
    owned: [],
    created_at: new Date().toISOString(),
  };
  const owned = new Set(base.owned);
  for (const r of rels) owned.add(r);
  if (owned.size === base.owned.length) return; // nothing new
  try {
    writeManifest(repoRoot, { ...base, owned: [...owned] });
  } catch {
    /* best-effort */
  }
}

// Stop: the set of diff files FOREIGN to this session — in the baseline, unchanged since it
// (byte-identical), and not tool-owned. Empty when there is no manifest or an empty baseline
// (→ the gate applies no scoping = full review, today's behavior). A baseline file that is
// now missing/unreadable/changed is NOT foreign (someone changed it → reviewed = safe).
export function computeForeignFiles(repoRoot: string, sessionId: string): Set<string> {
  const m = readSessionManifest(repoRoot, sessionId);
  const foreign = new Set<string>();
  if (!m) return foreign;
  const owned = new Set(m.owned);
  for (const [rel, baseHash] of Object.entries(m.baseline)) {
    if (owned.has(rel)) continue;
    const content = safeReadContained(repoRoot, rel, MAX_BASELINE_FILE_BYTES);
    if (content === null) continue; // gone/oversize/binary → treat as changed → reviewed (safe)
    if (hashContent(content) === baseHash) foreign.add(rel);
  }
  return foreign;
}

// Remove session manifests older than the TTL (best-effort, by created_at). Called from
// SessionStart so the dir self-trims; never touches another session's still-fresh manifest.
export function pruneOldSessionManifests(repoRoot: string, nowMs: number): void {
  const dir = sessionsDir(repoRoot);
  if (!existsSync(dir)) return;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const full = join(dir, name);
    try {
      const m = SessionManifestSchema.safeParse(JSON.parse(readFileSync(full, "utf8")));
      const created = m.success ? Date.parse(m.data.created_at) : Number.NaN;
      // Unparseable/old → drop; a malformed leftover shouldn't linger either. Fall back to
      // statSync mtime only when created_at is unreadable.
      let ageMs = Number.isNaN(created) ? Number.NaN : nowMs - created;
      if (Number.isNaN(ageMs)) {
        try {
          ageMs = nowMs - statSync(full).mtimeMs;
        } catch {
          ageMs = Number.NaN;
        }
      }
      if (!Number.isNaN(ageMs) && ageMs > MANIFEST_TTL_MS) unlinkSync(full);
    } catch {
      /* best-effort prune */
    }
  }
}
