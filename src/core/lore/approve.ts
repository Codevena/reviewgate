// src/core/lore/approve.ts — the HUMAN half of the canon trust boundary:
// `reviewgate lore approve <id>` writes the `.reviewgate/lore/approvals.jsonl`
// line that makes a canon entry injectable. The agent half (the gate's
// canon-promotion finding, orchestrator.ts + loop-driver.ts) exists because the
// gate has no channel to the human except the agent's turn; this command is the
// direct channel, so a maintainer never has to hand-write the JSON line.
//
// Two rules carry the security weight:
//   1. Only `status: canon` is approvable. Approval is ID-PERMANENT in v1
//      (approvals.ts) — approving a DRAFT would pre-authorize a later flip to
//      canon that the guard would then never report.
//   2. The challenge is bound to the entry's raw bytes, mirroring
//      `reviewgate config approve` (control-plane.ts: `APPROVE <fp12>`), so text
//      swapped in between "human reads it" and "human hits enter" invalidates
//      the approval instead of riding along on it.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appendApproval, readApprovals } from "./approvals.ts";
import { classifyEntry } from "./staleness.ts";
import { type LoreEntryParsed, loreDir, parseLoreFile } from "./store.ts";

// Same shape as LoreEntrySchema's `id` — see verify.ts for why this is checked
// BEFORE the slug is joined into a path (defense in depth against traversal).
const LORE_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

// decision_ref for a human CLI approval. The agent path writes the gate finding
// id (`F-L01`) instead, so the ledger stays greppable by provenance.
export const LORE_APPROVE_DECISION_REF = "cli:lore-approve";

export interface LoreApprovePreflight {
  slug: string;
  /** True only when an approval line can be written right now. */
  eligible: boolean;
  /** Already in the ledger — a no-op, not an error. */
  alreadyApproved: boolean;
  /** Why it is not eligible (absent when it is). */
  reason?: string;
  entry?: LoreEntryParsed;
  state?: ReturnType<typeof classifyEntry>["state"];
  anchorFileCount?: number;
  /** Content-bound string the human must type back. Absent unless eligible. */
  challenge?: string;
  /** Non-blocking notes (stale / inert). */
  warnings: string[];
}

function challengeFor(raw: string): string {
  return `APPROVE ${createHash("sha256").update(raw).digest("hex").slice(0, 12)}`;
}

function refuse(slug: string, reason: string, alreadyApproved = false): LoreApprovePreflight {
  return { slug, eligible: false, alreadyApproved, reason, warnings: [] };
}

export function loreApprovePreflight(repoRoot: string, slug: string): LoreApprovePreflight {
  if (!LORE_SLUG_RE.test(slug)) {
    return refuse(slug, "invalid slug (a lore id is lowercase alphanumerics + hyphens)");
  }
  if (readApprovals(repoRoot).has(slug)) {
    return refuse(slug, "already approved — nothing to do", true);
  }

  let raw: string;
  try {
    raw = readFileSync(join(loreDir(repoRoot), `${slug}.md`), "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return refuse(slug, `not found: .reviewgate/lore/${slug}.md`);
    return refuse(slug, `unreadable: ${(err as Error).message}`);
  }

  const parsed = parseLoreFile(raw, slug);
  if ("error" in parsed) {
    // Deliberately not approvable: an unparseable entry is never injected
    // anyway, so blessing it would only silence the guard on a file whose
    // eventual content nobody has read. Repair it, then approve.
    return refuse(slug, `entry does not parse (${parsed.error}) — fix the file, then approve it`);
  }
  const entry = parsed.entry;

  if (entry.status !== "canon") {
    return refuse(
      slug,
      `entry is \`status: ${entry.status}\` — set \`status: canon\` first (approval is permanent for this id, so a draft must never be pre-authorized)`,
    );
  }

  const cls = classifyEntry(repoRoot, entry);
  const warnings: string[] = [];
  if (cls.state === "stale") {
    warnings.push(
      `stale: anchored files changed since verified_tree — approving is fine, but run \`reviewgate lore verify ${slug}\` to refresh it`,
    );
  } else if (cls.state === "zero-match") {
    warnings.push("inert: anchors match zero files — it is never injected until they are fixed");
  } else if (cls.state === "broad") {
    warnings.push(
      "inert: anchors match more than 200 files — it is never injected until they are narrowed",
    );
  }

  return {
    slug,
    eligible: true,
    alreadyApproved: false,
    entry,
    state: cls.state,
    anchorFileCount: cls.files.length,
    challenge: challengeFor(raw),
    warnings,
  };
}

export interface LoreApproveResult {
  ok: boolean;
  alreadyApproved?: boolean;
  error?: string;
}

export function approveLoreEntry(
  repoRoot: string,
  slug: string,
  confirmation: string,
  opts: { now: Date },
): LoreApproveResult {
  // Re-run the preflight rather than trusting anything the caller read earlier:
  // this is the write path, and the file may have moved under it.
  const pre = loreApprovePreflight(repoRoot, slug);
  if (pre.alreadyApproved) return { ok: false, alreadyApproved: true };
  if (!pre.eligible || !pre.challenge) return { ok: false, error: pre.reason ?? "not approvable" };

  if (confirmation.trim() !== pre.challenge) {
    // One message for both causes on purpose — a mistyped challenge and a
    // rewritten entry are indistinguishable from here, and the human needs the
    // same next step either way. No line is written in either case.
    //
    // The expected challenge is deliberately NOT echoed. When the mismatch is
    // caused by the entry having CHANGED, the current challenge belongs to text
    // the human has not read in this session — printing it invites approving
    // exactly the swapped-in content this check just caught. Re-running reprints
    // the body first, which is the only order that keeps "type it back" a
    // proof that the human read what is on disk.
    return {
      ok: false,
      error: `Confirmation did not match — nothing was approved. If you did copy it exactly, the entry changed after the challenge was issued (what you read is no longer what is on disk). Re-run \`reviewgate lore approve ${slug}\` to see the current entry and a fresh challenge.`,
    };
  }

  // Single short O_APPEND write; readApprovals dedups by id, so a concurrent
  // gate-side write of the same id is idempotent in effect (no lock needed).
  appendApproval(repoRoot, slug, LORE_APPROVE_DECISION_REF, opts.now);
  return { ok: true };
}
