import { existsSync, readFileSync } from "node:fs";
import type { Finding } from "../../schemas/finding.ts";
import { decisionsPath, pendingJsonPath } from "../../utils/paths.ts";
import { foldLastDecisions } from "../fp-ledger/decision-fold.ts";
import type { RecordInput, ReputationStore } from "./store.ts";

export async function learnReputationFromDecisions(input: {
  repoRoot: string;
  iter: number;
  sessionId: string;
  cycleSeq: number;
  store: ReputationStore;
  nowIso: string;
  halfLifeDays?: number;
}): Promise<void> {
  const { repoRoot, iter, sessionId, cycleSeq, store, nowIso, halfLifeDays } = input;
  if (iter < 1) return;
  const dp = decisionsPath(repoRoot, iter);
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
  const events: RecordInput[] = [];
  // F-20: fold to the LAST valid decision per finding_id first. A superseded
  // rejected→accepted pair would otherwise book BOTH a 'wrong' and a 'correct'
  // event for the same reviewer — permanently debiting trust for a rejection the
  // agent retracted. Last-wins emits exactly one outcome per (finding,
  // reviewerKey, iter) within a single absorb: the agent's final intent.
  //
  // Re-stops within the SAME iteration are separate absorbs reading the same
  // (growing) decisions file. Absorb #1 might book 'wrong'; absorb #2, after the
  // agent retracts to 'accepted', would book 'correct'. The eid therefore OMITS
  // the verdict — its identity is (session, cycle, iter, finding, reviewerKey).
  // The store reconciles by eid across BOTH buckets: a later opposite-outcome
  // event for the same eid supersedes the earlier one, so a single iteration can
  // never end up holding both a 'wrong' AND a 'correct' for one reviewer.
  for (const d of foldLastDecisions(readFileSync(dp, "utf8")).values()) {
    const f = byId.get(d.finding_id);
    if (!f) continue;
    let outcome: "correct" | "wrong" | null = null;
    // An `accepted` verdict means the reviewer was RIGHT regardless of how the agent
    // resolved it (fixed / addressed-elsewhere / deferred-with-followup). Crediting only
    // action:"fixed" used to starve a demoted reviewer of `correct` events — its findings
    // are mostly softened to advisory INFO and never fixed, so the only recovery was old
    // `wrong`-event time-decay (a near-absorbing low-trust trap, F-023). Crediting every
    // accepted action widens the legitimate recovery path without crediting rejections.
    // N2 off-ramp: "acknowledged-low-value" is reputation-NEUTRAL — the agent did not
    // validate the finding as correct, only chose not to fix a cosmetic nit. Crediting it
    // would inflate a reviewer's trust for findings nobody acted on. (It is also not a
    // rejection, so it never debits.)
    // P6: "verified-not-applicable" is likewise NEUTRAL — the reviewer raised a legitimate
    // concern that the agent VERIFIED does not apply here, so no defect was confirmed
    // (crediting "correct" would over-credit a non-issue) and the reviewer wasn't wrong
    // (debiting is impossible — it's not a rejection).
    // P2: "out-of-scope" is also NEUTRAL — the finding is on a file this session did not
    // author; the reviewer may be perfectly right, but the agent neither confirmed a defect in
    // its OWN work nor rejected the finding. Crediting "correct" would let an agent inflate a
    // noisy reviewer's trust by out-of-scoping foreign findings (reputation poisoning, M6).
    // S2: "out-of-session" is NEUTRAL for the same reason — the finding is on a parallel agent's
    // committed work the session disowned; no defect in its OWN code was confirmed or rejected.
    // Every OTHER accepted action credits (F-023).
    if (
      d.verdict === "accepted" &&
      d.action !== "acknowledged-low-value" &&
      d.action !== "verified-not-applicable" &&
      d.action !== "out-of-scope" &&
      d.action !== "out-of-session"
    )
      outcome = "correct";
    else if (d.verdict === "rejected" && d.reviewer_was_wrong === true) outcome = "wrong";
    if (!outcome) continue;
    const fallbackKey =
      f.reviewer?.provider && f.reviewer?.persona
        ? `${f.reviewer.provider}:${f.reviewer.persona}`
        : null;
    const keys =
      f.confirmed_by && f.confirmed_by.length > 0
        ? f.confirmed_by
        : fallbackKey
          ? [fallbackKey]
          : [];
    for (const reviewerKey of new Set(keys)) {
      events.push({
        reviewerKey,
        outcome,
        eid: `${sessionId}:${cycleSeq}:${iter}:${d.finding_id}:${reviewerKey}`,
        ts: nowIso,
      });
    }
  }
  await store.record(events, {
    now: new Date(nowIso),
    ...(halfLifeDays !== undefined ? { halfLifeDays } : {}),
  });
}
