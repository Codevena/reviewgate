// src/schemas/lore.ts — source of truth for a Lore entry's frontmatter.
// See docs/superpowers/specs/2026-07-09-lore-design.md. The hash ALGORITHM
// (SHA-256 over sorted <path>\0<sha256(raw bytes)> pairs) is part of this
// schema version: changing it requires a version bump + re-verify.
import { z } from "zod";

export const LORE_SCHEMA_VERSION = "reviewgate.lore.v1";
export const LORE_MIN_BODY_CHARS = 40;
export const LORE_BROAD_ANCHOR_FILE_CAP = 200;

export const LoreEntrySchema = z.object({
  schema: z.literal(LORE_SCHEMA_VERSION),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  status: z.enum(["draft", "canon"]),
  anchors: z.array(z.string().min(1)).min(1),
  verified_at: z.string().min(4),
  verified_tree: z.string().min(1),
  tags: z.array(z.string()).optional(),
});
export type LoreEntry = z.infer<typeof LoreEntrySchema>;

// One line of the committed, append-only canon-promotion approvals ledger
// (`.reviewgate/lore/approvals.jsonl`). See "Canon guard" in the lore design
// spec: approval is ID-PERMANENT in v1 — an id present here already got a human
// OK and must not re-fire the guard finding (a committed canon→draft→canon
// round-trip reuses the original approval; per-epoch re-approval is a v2 follow-up).
export const LORE_APPROVAL_SCHEMA_VERSION = "reviewgate.lore-approval.v1";
export const LoreApprovalSchema = z.object({
  schema: z.literal(LORE_APPROVAL_SCHEMA_VERSION),
  id: z.string().min(1),
  approved_at: z.string().min(1),
  decision_ref: z.string(),
});
export type LoreApproval = z.infer<typeof LoreApprovalSchema>;
