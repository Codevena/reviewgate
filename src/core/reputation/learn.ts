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
}): Promise<void> {
  const { repoRoot, iter, sessionId, cycleSeq, store, nowIso } = input;
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
    if (d.verdict === "accepted" && d.action === "fixed") outcome = "correct";
    else if (d.verdict === "rejected" && d.reviewer_was_wrong === true) outcome = "wrong";
    if (!outcome) continue;
    const providers = [f.reviewer?.provider, ...(f.members ?? []).map((m) => m.provider)].filter(
      (p): p is string => typeof p === "string" && p.length > 0,
    );
    for (const provider of new Set(providers)) {
      events.push({
        provider,
        outcome,
        eid: `${sessionId}:${cycleSeq}:${iter}:${d.finding_id}:${d.verdict}:${provider}`,
        ts: nowIso,
      });
    }
  }
  await store.record(events);
}
