import { existsSync, readFileSync } from "node:fs";
import { DecisionEntrySchema } from "../../schemas/decision.ts";
import type { Finding } from "../../schemas/finding.ts";
import { decisionsPath, pendingJsonPath } from "../../utils/paths.ts";
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
  for (const line of readFileSync(dp, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const res = DecisionEntrySchema.safeParse(parsed);
    if (!res.success) continue;
    const d = res.data;
    const f = byId.get(d.finding_id);
    if (!f) continue;
    let outcome: "correct" | "wrong" | null = null;
    // An `accepted` verdict means the reviewer was RIGHT regardless of how the agent
    // resolved it (fixed / addressed-elsewhere / deferred-with-followup). Crediting only
    // action:"fixed" used to starve a demoted reviewer of `correct` events — its findings
    // are mostly softened to advisory INFO and never fixed, so the only recovery was old
    // `wrong`-event time-decay (a near-absorbing low-trust trap, F-023). Crediting every
    // accepted action widens the legitimate recovery path without crediting rejections.
    if (d.verdict === "accepted") outcome = "correct";
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
        eid: `${sessionId}:${cycleSeq}:${iter}:${d.finding_id}:${d.verdict}:${reviewerKey}`,
        ts: nowIso,
      });
    }
  }
  await store.record(events, {
    now: new Date(nowIso),
    ...(halfLifeDays !== undefined ? { halfLifeDays } : {}),
  });
}
