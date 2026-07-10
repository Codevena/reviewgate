// src/core/lore/guard.ts — deterministic, no-LLM canon-promotion guard. See
// "Canon guard (deterministic, no LLM)" in
// docs/superpowers/specs/2026-07-09-lore-design.md. `.reviewgate/` is
// excluded from the reviewer diff, so this guard diffs lore files ITSELF:
// `draft → canon` transitions and entries BORN as canon both count as a
// promotion (otherwise the obvious loophole). Detection runs on RAW file
// text (a loose `status:` line scan) — independent of schema validity, so a
// malformed file declaring `status: canon` still trips the guard.
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { spawnCapture } from "../../utils/spawn-capture.ts";
import { readApprovals } from "./approvals.ts";
import { loreDir } from "./store.ts";

export interface LorePromotion {
  id: string;
  kind: "transition" | "born-canon";
}

// Raw-text scan for the `status:` line — no frontmatter/schema parsing, so a
// malformed file still trips the guard (spec F-009).
const STATUS_LINE_RE = /^status:\s*(\S+)/m;

function extractStatus(raw: string): string | undefined {
  return raw.match(STATUS_LINE_RE)?.[1];
}

export async function detectPromotions(
  repoRoot: string,
  baseSha: string | null,
): Promise<LorePromotion[]> {
  try {
    const dir = loreDir(repoRoot);
    const base = baseSha ?? "HEAD";

    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((n) => n.endsWith(".md"));
    } catch {
      names = []; // missing/unreadable dir → nothing to detect
    }

    const promotions: LorePromotion[] = [];
    for (const name of names) {
      const id = basename(name, ".md");

      let currentRaw: string;
      try {
        currentRaw = readFileSync(join(dir, name), "utf8");
      } catch {
        continue; // unreadable file — skip, don't fail the whole guard
      }
      const currentStatus = extractStatus(currentRaw);

      // A non-zero `git show` status here is EXPECTED (the file didn't exist
      // at `base` → born candidate) — spawnCapture never throws, so this is
      // NOT the fail-safe catch below; it's a normal branch.
      const result = await spawnCapture("git", ["show", `${base}:.reviewgate/lore/${name}`], {
        cwd: repoRoot,
      });
      const bornAtBase = result.status !== 0;
      const baseStatus = bornAtBase ? undefined : extractStatus(result.stdout);

      const isPromotion =
        currentStatus === "canon" &&
        (bornAtBase || baseStatus === "draft" || baseStatus === undefined);
      if (isPromotion) {
        promotions.push({ id, kind: bornAtBase ? "born-canon" : "transition" });
      }
    }

    // Approval is ID-PERMANENT in v1 (spec amended 2026-07-09, "Canon guard"):
    // once an id is approved, EVERY subsequent promotion of that id — including a
    // committed canon → draft → canon ROUND-TRIP — is filtered here too, reusing
    // the original approval line. This is a deliberate, accepted v1 limitation
    // (per-epoch / per-transition re-approval, so a round-trip would re-guard, is
    // a v2 follow-up); do not read the filter below as "still canon since
    // approval" — it has no such continuity check.
    const approved = readApprovals(repoRoot);
    return promotions.filter((p) => !approved.has(p.id));
  } catch {
    // A guard that crashes must never break the gate (unapproved-canon is
    // never injected regardless — that's Task 3's approval gate).
    return [];
  }
}
