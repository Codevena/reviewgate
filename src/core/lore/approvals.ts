// src/core/lore/approvals.ts — committed, append-only canon-promotion
// approvals ledger (`.reviewgate/lore/approvals.jsonl`). See "Canon guard" in
// docs/superpowers/specs/2026-07-09-lore-design.md. One JSON line per human
// approval; an id present here (while continuously canon) does not re-fire
// the guard finding. Fail-safe contract: readApprovals NEVER throws —
// malformed/invalid lines are skipped, a missing file yields an empty set.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LORE_APPROVAL_SCHEMA_VERSION, LoreApprovalSchema } from "../../schemas/lore.ts";
import { loreDir } from "./store.ts";

function approvalsPath(repoRoot: string): string {
  return join(loreDir(repoRoot), "approvals.jsonl");
}

export function readApprovals(repoRoot: string): Set<string> {
  const ids = new Set<string>();
  try {
    const path = approvalsPath(repoRoot);
    if (!existsSync(path)) return ids;
    const raw = readFileSync(path, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = LoreApprovalSchema.safeParse(JSON.parse(trimmed));
        if (parsed.success) ids.add(parsed.data.id);
      } catch {
        // Malformed JSON on this line — skip it, never throw.
      }
    }
  } catch {
    // Unreadable file/dir etc. — never throw, empty (or partial) set is safe.
  }
  return ids;
}

export function appendApproval(repoRoot: string, id: string, decisionRef: string, now: Date): void {
  const dir = loreDir(repoRoot);
  mkdirSync(dir, { recursive: true });
  const line = JSON.stringify(
    LoreApprovalSchema.parse({
      schema: LORE_APPROVAL_SCHEMA_VERSION,
      id,
      approved_at: now.toISOString(),
      decision_ref: decisionRef,
    }),
  );
  appendFileSync(approvalsPath(repoRoot), `${line}\n`);
}
