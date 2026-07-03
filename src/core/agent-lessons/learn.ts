import { existsSync, readFileSync } from "node:fs";
import { neutralizeFences, neutralizeInjectionMarkers } from "../../diff/sanitizer.ts";
import { normalizeRuleId } from "../../diff/signature.ts";
import type { Finding } from "../../schemas/finding.ts";
import { decisionsPath, pendingJsonPath } from "../../utils/paths.ts";
import { foldLastDecisions } from "../fp-ledger/decision-fold.ts";
import type { AgentLessonsStore } from "./store.ts";

// The accepted+fixed twin of learnFromDecisions (which folds reviewer FALSE-positives).
// The high-value signal here is the opposite: a finding the agent ACCEPTED and FIXED —
// a verified, categorized, located, REAL mistake. Non-blocking; the caller .catch()es.
export async function learnLessonsFromDecisions(input: {
  repoRoot: string;
  prevIter: number;
  sessionId: string;
  cycleSeq: number;
  store: AgentLessonsStore;
  nowIso: string;
}): Promise<void> {
  const { repoRoot, prevIter, sessionId, cycleSeq, store, nowIso } = input;
  if (prevIter < 1) return;

  const dp = decisionsPath(repoRoot, prevIter);
  const pp = pendingJsonPath(repoRoot);
  if (!existsSync(dp) || !existsSync(pp)) return;

  let findings: Finding[] = [];
  try {
    const r = JSON.parse(readFileSync(pp, "utf8")) as { findings?: Finding[] };
    findings = Array.isArray(r.findings) ? r.findings : [];
  } catch {
    return;
  }
  const byId = new Map(findings.map((f) => [f.id, f]));

  // Fold to the LAST valid decision per finding_id (same contract as the FP-ledger
  // learn path): a rejected→later-accepted retraction must reflect the agent's FINAL intent.
  for (const d of foldLastDecisions(readFileSync(dp, "utf8")).values()) {
    if (d.verdict !== "accepted" || d.action !== "fixed") continue;
    const f = byId.get(d.finding_id);
    if (!f) continue;
    // Skip rule-less findings — raw-empty/whitespace OR anything whose NORMALIZED rule_id
    // is empty (spec wording). Either would collapse into a coarse category-only bucket
    // (`category|`) instead of a specific, actionable lesson. The store keys on
    // normalizeRuleId(rule_id), so this guard matches the actual bucket key.
    if (f.rule_id.trim() === "" || normalizeRuleId(f.rule_id) === "") continue;
    // Sanitize reviewer-authored text into trusted context (same pattern as report-writer/
    // research-writer), and clamp — Finding.message is already ≤200 but be defensive.
    const message = neutralizeFences(neutralizeInjectionMarkers(f.message)).slice(0, 200);
    // run_id keys the (run_id, signature) idempotency; unique per (session, cycle, iter),
    // stable on re-absorb of the same one. Mirrors reputation/fp-ledger eid construction.
    await store.recordOccurrence(
      { category: f.category, rule_id: f.rule_id, message, file: f.file },
      {
        run_id: `${sessionId}:${cycleSeq}:${prevIter}`,
        session_id: sessionId,
        signature: f.signature,
      },
      nowIso,
    );
  }
}
