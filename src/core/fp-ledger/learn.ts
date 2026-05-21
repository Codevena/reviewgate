import { existsSync, readFileSync } from "node:fs";
import { DecisionEntrySchema } from "../../schemas/decision.ts";
import type { Finding } from "../../schemas/finding.ts";
import { decisionsPath, pendingJsonPath } from "../../utils/paths.ts";
import type { FpLedgerStore } from "./store.ts";

export async function learnFromDecisions(input: {
  repoRoot: string;
  prevIter: number;
  store: FpLedgerStore;
  nowIso: string;
}): Promise<void> {
  const { repoRoot, prevIter, store, nowIso } = input;
  if (prevIter < 1) return;

  const dp = decisionsPath(repoRoot, prevIter);
  const pp = pendingJsonPath(repoRoot);
  if (!existsSync(dp) || !existsSync(pp)) return;

  // Map finding id → Finding from the (previous) pending report.
  let findings: Finding[] = [];
  try {
    const r = JSON.parse(readFileSync(pp, "utf8")) as { findings?: Finding[] };
    findings = Array.isArray(r.findings) ? r.findings : [];
  } catch {
    return;
  }
  const byId = new Map(findings.map((f) => [f.id, f]));

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
    if (d.verdict !== "rejected" || d.reviewer_was_wrong !== true) continue;
    const f = byId.get(d.finding_id);
    if (!f) continue;

    // Record per member-signature, crediting only that member's base provider.
    // Fall back to the finding's own signature/provider if members is absent.
    const members =
      f.members && f.members.length > 0
        ? f.members
        : [
            {
              signature: f.signature,
              provider: f.reviewer.provider,
              rule_id: f.rule_id,
              category: f.category,
            },
          ];
    for (const m of members) {
      await store.recordReject(
        m.signature,
        { rule_id: m.rule_id, category: m.category, file: f.file, symbol: "" },
        { run_id: d.finding_id, provider: m.provider, reason: d.reason ?? "" },
        nowIso,
      );
    }
  }
}
