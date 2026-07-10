import { existsSync, readFileSync } from "node:fs";
import type { Finding } from "../../schemas/finding.ts";
import { decisionsPath, pendingJsonPath } from "../../utils/paths.ts";
import { foldLastDecisions } from "./decision-fold.ts";
import type { FpLedgerStore } from "./store.ts";

export async function learnFromDecisions(input: {
  repoRoot: string;
  prevIter: number;
  // Monotonic cycle identity (mirrors reputation's eid): `iteration` RESETS to 0
  // on every clean-PASS re-arm, so iter alone collides across cycles. session_id
  // + reputation_cycle_seq (a general per-cycle counter, incremented on re-arm
  // regardless of whether reputation is enabled) make the reject run_id unique
  // per (session, cycle, iter) — so a recurring FP accumulates across cycles.
  sessionId: string;
  cycleSeq: number;
  store: FpLedgerStore;
  nowIso: string;
}): Promise<void> {
  const { repoRoot, prevIter, sessionId, cycleSeq, store, nowIso } = input;
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

  // F-19: fold to the LAST valid decision per finding_id first. The append-only
  // file may carry a superseding disposition (rejected → later accepted within
  // the same iteration); learning from the retracted rejection would march the
  // signature toward active/sticky and eventually demote a finding the agent's
  // FINAL intent accepted as real.
  for (const d of foldLastDecisions(readFileSync(dp, "utf8")).values()) {
    if (d.verdict !== "rejected" || d.reviewer_was_wrong !== true) continue;
    const f = byId.get(d.finding_id);
    if (!f) continue;
    // Lore v1 WARN-1 fix (2026-07-10): the two synthetic lore findings
    // (`f.lore` set) are deterministic — reviewer.provider:"lore", no real
    // reviewer/model behind them. A rejected lore reminder ("still accurate")
    // is a documented normal flow, not a confirmed reviewer false positive;
    // recording it here would create a bogus "lore" provider FP signature in
    // the ledger. Excluded before the member/provider fan-out below.
    if (f.lore !== undefined) continue;

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
    // De-dup by (signature, provider): the aggregator can cluster MULTIPLE
    // reports from the same provider into one finding (e.g. two personas at the
    // same location → identical signature). Booking a reject per raw member would
    // let a SINGLE decision contribute several rejects for one (signature,
    // provider) pair and inflate the ≥3-reject / ≥2-provider quorum from one
    // rejection — so one decision counts at most once per provider per signature.
    const seen = new Set<string>();
    for (const m of members) {
      const key = JSON.stringify([m.signature, m.provider]);
      if (seen.has(key)) continue;
      seen.add(key);
      await store.recordReject(
        m.signature,
        { rule_id: m.rule_id, category: m.category, file: f.file, symbol: "" },
        // run_id keys the (run_id, provider) reject-idempotency. It MUST be unique
        // per absorb-invocation but STABLE on re-absorb of the same one. NOT
        // `d.finding_id` (the POSITIONAL "F-001", reused every iter) and NOT iter
        // alone (`iteration` RESETS to 0 on every clean-PASS re-arm, so iter 1 of
        // cycle N collides with iter 1 of cycle N+1). session_id + cycleSeq +
        // prevIter is unique per (session, cycle, iter) — mirrors reputation's eid
        // — so a recurring false-positive accumulates across cycles toward
        // active/sticky, while re-absorbing the SAME (session, cycle, iter) stays
        // idempotent.
        {
          run_id: `${sessionId}:${cycleSeq}:${prevIter}`,
          provider: m.provider,
          reason: d.reason ?? "",
        },
        nowIso,
      );
    }
  }
}
