// rig/scripts/anchor-markers.ts
//
// STOPGAP, read-only. Counts the two markers task (b) introduced — `anchor_repaired`
// (Slice A) and `critic_verdict: "keep"` (Slice B) — which the harvester in the binary
// pinned by rig/preregistrations/pilot-03.json does NOT surface. It produced every Slice A
// and Slice B number in docs/dev/2026-08-06-pilot-03-result.md.
//
// DELETE THIS when `rig harvest` surfaces the markers itself, exactly as
// rig/scripts/critic-activity.ts was deleted once RigTurnRecord gained `criticRuns` —
// two sources of truth for one number is how pilot-02's bug 3 happened.
//
// VALIDATED BEFORE USE against both prior pilots, where it reproduces three independently
// recorded numbers from the design spec: 47+21 = 68 finding rows, 36+19 = 55 carrying
// `evidence_line`, and 1 distinct `fact_invalid` (pilot-02 turn 2). Run it on pilot-01/02
// before trusting it on anything new.
//
//   bun run rig/scripts/anchor-markers.ts pilot-03
//
// Slice B attribution uses the signature registered IN ADVANCE in the preregistration:
// WARN + security/correctness + singleton is reachable through the new floor and nothing
// else (isCriticalSecurity needs CRITICAL, isCorroborated needs unanimous|majority).
const run = process.argv[2] ?? "pilot-03";
const g = new Bun.Glob(`rig/results/${run}/turns/*/reports/*-pending.json`);

interface Rec {
  turn: number;
  rule: string;
  sev: string;
  cat: string;
  cons: string;
  line: number;
  secOrCorr: boolean;
}
let rows = 0;
let withEvidence = 0;
const distinct = new Map<string, Rec>();
const repaired = new Map<string, Rec>();
const factInvalid = new Map<string, Rec>();
const criticKeep = new Map<string, Rec>();

/** Keep the record with the LOWEST turn index — order-independent. */
const put = (m: Map<string, Rec>, key: string, rec: Rec) => {
  const prev = m.get(key);
  if (prev === undefined || rec.turn < prev.turn) m.set(key, rec);
};

for await (const p of g.scan(".")) {
  const j = JSON.parse(await Bun.file(p).text());
  const turn = Number(p.split("/turns/")[1].split("/")[0]);
  for (const f of j.findings ?? []) {
    rows++;
    if (f.evidence_line) withEvidence++;
    const key = f.signature ?? `${f.file}:${f.line_start}:${f.rule_id}`;
    // touchesSecurityOrCorrectness (aggregator.ts:255): representative category OR ANY member's
    const cats = [f.category, ...(f.members ?? []).map((m: { category: string }) => m.category)];
    const rec: Rec = {
      turn,
      rule: f.rule_id,
      sev: f.severity,
      cat: f.category,
      cons: f.consensus,
      line: f.line_start,
      secOrCorr: cats.some((c) => c === "security" || c === "correctness"),
    };
    put(distinct, key, rec);
    if (f.anchor_repaired === true) put(repaired, key, rec);
    if (f.fact_invalid === true) put(factInvalid, key, rec);
    if (f.critic_verdict === "keep") put(criticKeep, key, rec);
  }
}

const byTurn = (m: Map<string, Rec>) => [...m.values()].sort((a, b) => a.turn - b.turn);

console.log(`=== ${run} ===`);
console.log(`finding rows across archived reports  : ${rows}`);
console.log(`distinct signatures                   : ${distinct.size}`);
console.log(`rows carrying evidence_line           : ${withEvidence}`);

const opportunities = repaired.size + factInvalid.size;
console.log(`\n-- Slice A (observable, NOT ablatable) --`);
console.log(`anchor_repaired (distinct)            : ${repaired.size}`);
console.log(`fact_invalid    (distinct)            : ${factInvalid.size}`);
console.log(`OPPORTUNITY denominator (repaired+fi) : ${opportunities}`);
console.log(
  opportunities === 0
    ? `  -> NOT EXERCISED: no out-of-range citation occurred at all, so Slice A had zero opportunities. Uninformative BY CONSTRUCTION — not a null result.`
    : repaired.size === 0
      ? `  -> EXERCISED, DID NOT FIRE: ${opportunities} out-of-range citation(s), none carried a repairable quote. This IS an informative negative.`
      : `  -> FIRED on ${repaired.size} of ${opportunities} out-of-range citation(s).`,
);
for (const v of byTurn(repaired))
  console.log(`     repaired  turn ${v.turn}  ${v.rule}  line ${v.line}  ${v.sev}/${v.cat}`);
for (const v of byTurn(factInvalid))
  console.log(`     demoted   turn ${v.turn}  ${v.rule}  line ${v.line}  ${v.sev}/${v.cat}`);

console.log(`\n-- Slice B (ablatable via -critic) --`);
console.log(`critic_verdict "keep" (distinct)      : ${criticKeep.size}`);
let attributable = 0;
for (const v of byTurn(criticKeep)) {
  // The exact registered signature: reachable through the new WARN floor and nothing else.
  const isSliceB = v.sev === "WARN" && v.secOrCorr && v.cons === "singleton";
  if (isSliceB) attributable++;
  console.log(
    `     turn ${v.turn}  ${v.rule}  ${v.sev}/${v.cat}  consensus=${v.cons}  ${isSliceB ? "<== SLICE B ATTRIBUTABLE" : "(corroborated or CRITICAL — protected before this change too)"}`,
  );
}
console.log(`SLICE-B-ATTRIBUTABLE activations      : ${attributable}`);
console.log(
  attributable === 0
    ? `  -> UNEXERCISED: the critic proposed no likely_fp against a WARN security/correctness singleton.`
    : `  -> Slice B was the operative protection ${attributable} time(s).`,
);
