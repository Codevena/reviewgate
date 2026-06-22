// src/schemas/session-manifest.ts
//
// Slice A (P1, field report 2026-06-22): per-session ownership manifest for the
// multi-agent shared-checkout case. Reviewgate has no per-agent attribution for
// uncommitted changes, so in a shared checkout one session's Stop hook reviews (and
// blocks on) a parallel session's uncommitted work. This manifest records, per
// Claude Code session_id:
//   - `baseline`: the working-tree-dirty files (path -> sha256 of content) captured at
//     SessionStart, i.e. BEFORE this session edited anything. A diff file is FOREIGN to
//     this session only if it is in the baseline AND its content is UNCHANGED since then
//     AND this session did not tool-edit it — i.e. provably not authored by this session.
//     Anything this session changed (Edit OR Bash) alters the content hash → not foreign
//     → reviewed (closes the Bash-edit fail-open without classifying shell commands).
//   - `owned`: repo-relative paths this session edited via a captured tool
//     (Edit/Write/MultiEdit/NotebookEdit), accumulated across PostToolUse triggers.
//
// The gate fails CLOSED (full review, today's behavior) when no manifest exists for the
// current session_id, so a missing/late SessionStart never silently narrows a review.
import { z } from "zod";

export const SessionManifestSchema = z.object({
  schema: z.literal("reviewgate.session-manifest.v1"),
  session_id: z.string(),
  // repo-relative path -> sha256 hex of file content at session start (working-tree dirty).
  baseline: z.record(z.string(), z.string()).default({}),
  // repo-relative paths edited by this session via a captured edit tool.
  owned: z.array(z.string()).default([]),
  created_at: z.string(),
});

export type SessionManifest = z.infer<typeof SessionManifestSchema>;
