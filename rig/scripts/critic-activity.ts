// rig/scripts/critic-activity.ts
//
// Report the critic's INVOCATION status per turn, which `rig harvest` does not carry.
//
// `RigTurnRecord.suppressed.critic` counts findings stamped `critic_verdict: "likely_fp"` —
// DEMOTIONS. A critic that ran, judged every finding and returned `keep` for all of them scores
// 0 there, and so does a critic that was never configured. pilot-01 and pilot-02 would then
// publish the same number for two categorically different facts, which is exactly the confusion
// pilot-02's preregistration splits into claims (A) "the critic ran" and (B) "it suppressed
// something". (A) lives only in `pending.json`'s `critic` object, so it is read from the
// per-turn archived reports the driver captured while the turn was running.
//
// READ-ONLY, and standalone rather than folded into src/rig/harvest.ts on purpose: harvesting
// runs through the compiled `dist/reviewgate`, whose sha256 the preregistration pins as the
// build under measurement. Rebuilding it mid-experiment to add a field would break that pin
// (and, via the ~/.local/bin symlink, deploy to every repo). Closing the gap in the harvester
// is a follow-up for after the run, not a change to make during it.
//
// Usage: bun run rig/scripts/critic-activity.ts <resultsDir>
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const out = (s: string): void => {
  process.stdout.write(`${s}\n`);
};

const root = process.argv[2];
if (root === undefined) {
  console.error("usage: bun run rig/scripts/critic-activity.ts <resultsDir>");
  process.exit(2);
}

interface CriticInfo {
  provider: string;
  status: string;
  verdicts: number;
  demoted?: number;
}

/**
 * Every distinct `critic` object this turn produced.
 *
 * The gate rewrites pending.json each iteration, so a turn that blocked, got a decision and
 * re-reviewed has several — and the LAST one is not representative: a turn ending in a
 * zero-finding PASS legitimately writes no `critic` key at all (orchestrator.ts:2302 runs the
 * critic only when the panel produced >= 1 finding). Reading only the final report would score
 * such a turn as "critic absent", which is the misreading this script exists to prevent.
 */
function criticVersions(turnDir: string): {
  infos: CriticInfo[];
  raw: number;
  reports: number;
} {
  const reportsDir = join(turnDir, "reports");
  const infos: CriticInfo[] = [];
  const seen = new Set<string>();
  let raw = 0;
  let reports = 0;
  if (!existsSync(reportsDir)) return { infos, raw, reports };
  const names = readdirSync(reportsDir)
    .filter((n) => n.endsWith("-pending.json"))
    // numeric, not lexicographic: "10-" sorts before "2-" as a string.
    .sort((a, b) => Number(a.split("-")[0]) - Number(b.split("-")[0]));
  for (const n of names) {
    reports++;
    try {
      const d = JSON.parse(readFileSync(join(reportsDir, n), "utf8")) as { critic?: CriticInfo };
      if (!d.critic) continue;
      raw++;
      // DEDUPED BY CONTENT, because one critic invocation can appear in SEVERAL archived
      // report versions: the archiver keys on the whole file's hash, so a pending.json
      // rewritten for an unrelated reason carries the same `critic` object again, and
      // summing raw would over-report. On pilot-02 this changed nothing (12 raw, 12 distinct),
      // so it is a guard rather than a correction there.
      //
      // Do NOT calibrate this against the cassette's `openrouter:complete:*` entry count
      // (7 on pilot-02, against 12 objects here). Those keys are CONTENT-ADDRESSED, so two
      // iterations issuing an identical critic prompt collapse to one key — the two numbers
      // measure different things and their difference is not evidence of double counting.
      // Deduping is simply the conservative direction, and both numbers are printed so
      // neither reading is hidden.
      const key = JSON.stringify(d.critic);
      if (seen.has(key)) continue;
      seen.add(key);
      infos.push(d.critic);
    } catch {
      /* a torn archived report is not a critic observation — skip it; the count still shows it */
    }
  }
  return { infos, raw, reports };
}

const turnsDir = join(root, "turns");
const indices = readdirSync(turnsDir)
  .map(Number)
  .filter((n) => Number.isInteger(n))
  .sort((a, b) => a - b);

let ranTurns = 0;
let eligibleTurns = 0;
let totalVerdicts = 0;
let totalDemoted = 0;
let rawTotal = 0;
const statuses = new Map<string, number>();

out("turn  reports  critic status(es)                                   verdicts  demoted");
for (const i of indices) {
  const { infos, raw, reports } = criticVersions(join(turnsDir, String(i)));
  rawTotal += raw;
  const v = infos.reduce((a, c) => a + (c.verdicts ?? 0), 0);
  const d = infos.reduce((a, c) => a + (c.demoted ?? 0), 0);
  totalVerdicts += v;
  totalDemoted += d;
  const seen = infos.map((c) => `${c.provider}:${c.status}`);
  for (const s of seen) statuses.set(s, (statuses.get(s) ?? 0) + 1);
  if (infos.length > 0) eligibleTurns++;
  if (infos.some((c) => c.status === "ran" && (c.verdicts ?? 0) >= 1)) ranTurns++;
  // "no critic key" states the OBSERVATION and deliberately does not name a cause. There are
  // two, and they are not distinguishable from this file: the critic was never configured
  // (pilot-01, phases.critic: null), or it was configured but the round produced zero findings
  // so it legitimately never ran. Naming one would have been wrong for pilot-01 turn 2, which
  // had a CRITICAL finding and still no critic key.
  const label = seen.length === 0 ? "— (no critic key)" : [...new Set(seen)].join(", ");
  const cells = [
    String(i).padStart(4),
    String(reports).padStart(7),
    label.padEnd(51),
    String(v).padStart(8),
    String(d).padStart(7),
  ];
  out(cells.join("  "));
}

const breakdown = [...statuses].map(([k, n]) => `${k}x${n}`).join(", ");
out("");
out(`turns with a critic key            : ${eligibleTurns} / ${indices.length}`);
out(
  `turns where it RAN with >=1 verdict: ${ranTurns} / ${eligibleTurns}   <- registered claim (A)`,
);
out(`total verdicts issued (deduped)    : ${totalVerdicts}`);
out(`total demotions (deduped)          : ${totalDemoted}`);
out(`raw critic objects across versions : ${rawTotal}  (>= deduped; see criticVersions)`);
out(`status breakdown                   : ${breakdown === "" ? "none" : breakdown}`);
out("");
out("Claim (B) — M6 critic, i.e. findings stamped critic_verdict:'likely_fp' — comes from");
out("`rig harvest` / `rig report`, NOT from this script. The two can legitimately disagree:");
out("`demoted` above is what the critic PHASE reported, while M6 counts the marker that");
out("SURVIVED aggregation, and the aggregator exempts CRITICAL+security/correctness,");
out("corroborated and protected-reviewer findings from the critic's demote.");
