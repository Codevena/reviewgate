// src/core/brain/lifecycle.ts
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { BrainEntry } from "../../schemas/brain.ts";
import { brainArchivePath } from "../../utils/paths.ts";
import type { BrainStore } from "./store.ts";

const DAY = 86_400_000;

export function promoteIfReferenced(e: BrainEntry): BrainEntry {
  // A candidate is promoted once it has been referenced ≥3 times by ≥2 DISTINCT
  // providers. The old ≥3-distinct-reviewer floor was structurally unreachable:
  // the default failover chain runs one reviewer per turn, and the curator's
  // merge path froze referencing_reviewers at the creation set. ≥2 (matching the
  // creation quorum) makes "two providers independently converged, sustained over
  // ≥3 references" promotable. Distinctness is computed defensively from the array.
  const distinctReviewers = new Set(e.referencing_reviewers).size;
  if (e.status === "candidate" && e.referenced_count >= 3 && distinctReviewers >= 2) {
    return { ...e, status: "active" };
  }
  return e;
}

export async function decayPass(
  store: BrainStore,
  repoRoot: string,
  nowIso: string,
): Promise<void> {
  const now = Date.parse(nowIso);
  await store.mutate((snap) => {
    const archived: BrainEntry[] = [];
    const kept: BrainEntry[] = [];
    for (const e of snap.entries) {
      const last = Date.parse(e.last_referenced_at ?? e.created_at);
      const ageDays = (now - last) / DAY;
      let next = promoteIfReferenced(e);
      if ((next.status === "active" || next.status === "candidate") && ageDays > 90)
        next = { ...next, status: "stale" };
      if (next.status === "stale" && ageDays > 270) {
        archived.push(next);
        continue;
      }
      kept.push(next);
    }
    if (archived.length > 0) {
      const p = brainArchivePath(repoRoot);
      if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true });
      appendFileSync(p, archived.map((e) => `- ${e.id} (${e.type}) ${e.title}\n`).join(""), {
        mode: 0o600,
      });
    }
    snap.entries = kept;
    return { next: snap, result: undefined };
  });
}
