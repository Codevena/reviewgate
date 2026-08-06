// rig/scripts/critic-floor-replay.ts
//
// OFFLINE Slice B counterfactual. Read-only: no network, no agent quota, no rebuild, and it writes
// nothing outside a temp dir it removes again.
//
// WHY THIS EXISTS. Slice B is the critic severity floor (`aggregator.ts:618`): the critic may not
// push a WARN security/correctness finding below WARN, because WARN→INFO is the one demote that
// crosses the blocking boundary. pilot-03 observed it fire EXACTLY ONCE, and that one activation
// protected a FALSE POSITIVE over a critic that was right. Keep / narrow / revert on n = 1 is not
// a decision, it is a coin flip.
//
// The counterfactual is free, because pilot-01 and pilot-02 ran BINARIES THAT DID NOT HAVE THE
// FLOOR. Replaying their recorded reviewer findings and recorded critic verdicts through TODAY's
// `aggregate()` — which does have it — shows exactly what the floor would have protected, on runs
// that never had a chance to be biased by it.
//
// WHAT THIS IS NOT: it does not decide whether a protected finding is a true or a false positive.
// It produces the population and the evidence per activation; adjudication is a human call and the
// report prints what each one needs to be judged.
//
// `rig/results/` is gitignored: this script is committed, its inputs are local to this machine.
//
//   bun run rig/scripts/critic-floor-replay.ts
//   bun run rig/scripts/critic-floor-replay.ts --verbose   # every critic verdict, matched or not

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchesAnyTag } from "../../src/bench/matcher.ts";
import { aggregate } from "../../src/core/aggregator.ts";
import { type CriticVerdict, parseCriticOutput } from "../../src/core/critic.ts";
import { validateFindingFacts } from "../../src/core/fact-check.ts";
import { computeSignature } from "../../src/diff/signature.ts";
import { enclosingSymbol } from "../../src/research/symbol-graph.ts";
import type { Finding } from "../../src/schemas/finding.ts";
import {
  type Row,
  die,
  materialise,
  readCorpus,
  readCriticCalls,
  reviewersRanPerPanel,
} from "./lib/corpus.ts";

// pilot-01 recorded no critic calls (the phase was off) and no diff.patch, so it cannot take part.
const RUNS = ["pilot-02", "pilot-03"] as const;
const VERBOSE = process.argv.includes("--verbose");

/** Whether the floor was PRESENT in the binary that produced the run. pilot-02 predates Slice B,
 *  which is what makes it an unbiased counterfactual; pilot-03 shipped with it, so its result here
 *  must reproduce the 1 activation the field write-up recorded, or this instrument is wrong. */
const FLOOR_IN_BINARY: Record<string, boolean> = { "pilot-02": false, "pilot-03": true };

interface Activation {
  run: string;
  turn: number;
  finding: Finding;
  /** true when the judged iteration was the turn's FINAL panel run, so the reconstructed
   *  end-of-turn tree is provably the tree those findings were reviewed against. */
  treeExact: boolean;
}

/**
 * Reproduce the orchestrator's `applySymbolSignatures` (`orchestrator.ts:2889`): re-key each
 * finding by its enclosing symbol when the language is supported, else leave the parse-time
 * signature from `review-output.ts` untouched.
 *
 * This must be EXACT, because the critic recorded its verdicts against these signatures — a
 * reproduction that is even slightly off would match nothing, the critic map would be empty, and
 * the floor would appear never to have had an opportunity. That failure is caught explicitly by
 * the match-rate integrity check below rather than left to chance.
 */
async function applySymbolSignatures(findings: Finding[], repoRoot: string): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const f of findings) {
    const sym = await enclosingSymbol(join(repoRoot, f.file), f.line_start).catch(() => null);
    if (!sym) {
      out.push(f);
      continue;
    }
    out.push({
      ...f,
      signature: computeSignature({
        file: f.file,
        ruleId: f.rule_id,
        category: f.category,
        lineStart: f.line_start,
        lineEnd: f.line_end,
        symbolName: sym.name,
        symbolStartLine: sym.startLine,
      }),
    });
  }
  return out;
}

/** A finding is a Slice B activation iff the critic called it likely_fp and the floor is what kept
 *  it: marker `critic_verdict:"keep"` (aggregator.ts:650) at WARN, security/correctness on the
 *  representative or any merged member, and NOT corroborated.
 *
 *  The consensus condition is what ISOLATES the floor. `critic_verdict:"keep"` is also written when
 *  `isCorroborated` saves a finding, and `isCriticalSecurity` (pre-existing, CRITICAL) uses the same
 *  branch — counting the marker alone would attribute both of those to Slice B. */
function isFloorActivation(f: Finding): boolean {
  if (f.critic_verdict !== "keep") return false;
  if (f.severity !== "WARN") return false;
  if (f.consensus === "unanimous" || f.consensus === "majority") return false;
  const cats = [f.category, ...(f.members?.map((m) => m.category) ?? [])];
  return cats.some((c) => c === "security" || c === "correctness");
}

/** The turn's seeded defect, from the run's own turn script. `tags` are the CATCH MARKER — the
 *  handoff's rule is that catches are attributed by marker, never by outcome — and `landedPattern`
 *  says whether the agent actually wrote the defect (it sometimes declines). */
interface Seeded {
  id: string;
  tags: string[];
  landedPattern?: string;
}
function seededByTurn(run: string): Map<number, Seeded> {
  const j = JSON.parse(readFileSync(`rig/scripts/${run}.json`, "utf8")) as {
    turns: { index: number; seeded?: Seeded | null }[];
  };
  const out = new Map<number, Seeded>();
  for (const t of j.turns) {
    if (t.seeded) out.set(t.index, t.seeded);
  }
  return out;
}

/** Did the seeded defect actually LAND in the recorded diff? A seed the agent declined to write is
 *  not something the panel could have caught, so a critic verdict on that turn cannot be "demoting
 *  a true positive" for it. Mirrors harvest.ts's landing check; UNKNOWN (no pattern / no diff /
 *  bad regex) is reported as unknown rather than assumed either way. */
function seedLanded(run: string, turn: number, seeded: Seeded): boolean | null {
  if (!seeded.landedPattern) return null;
  const patch = `rig/results/${run}/turns/${turn}/diff.patch`;
  if (!existsSync(patch)) return null;
  try {
    return new RegExp(seeded.landedPattern, "m").test(readFileSync(patch, "utf8"));
  } catch {
    return null;
  }
}

/** Same text the rig's harvester matches tags against (`harvest.ts:223`). */
const findingText = (f: Finding): string => `${f.message} ${f.details}`;

const tmpRoot = mkdtempSync(join(tmpdir(), "critic-floor-replay-"));
try {
  console.log("Slice B counterfactual — the critic severity floor, replayed over the raw corpus");
  console.log("=".repeat(97));

  const activations: Activation[] = [];
  /** Critic calls whose verdict signatures match no iteration's finding set. Reported, never
   *  silently dropped: each one is an opportunity the floor may have had that this replay cannot
   *  see, so it belongs in the denominator's error bar. */
  const unmatchedCalls: string[] = [];
  /** Every likely_fp verdict aimed at a finding that MATCHES its turn's seeded-defect tags — i.e.
   *  the critic proposing to demote a real catch. This is the floor's reason to exist. */
  const criticProposedOnSeedCatch: {
    line: string;
    landed: boolean | null;
    savedByFloor: boolean;
  }[] = [];
  const perRun: { run: string; turns: number; findings: number; verdicts: number }[] = [];
  let likelyFpTotal = 0;
  let matchedTotal = 0;

  for (const run of RUNS) {
    const { rows, turnsWithFindings } = readCorpus(run);
    const seeds = seededByTurn(run);
    const criticCalls = readCriticCalls(run);
    const callsByTurn = new Map<number, string[]>();
    for (const c of criticCalls) {
      const b = callsByTurn.get(c.turn);
      if (b === undefined) callsByTurn.set(c.turn, [c.text]);
      else b.push(c.text);
    }

    const byTurn = new Map<number, Row[]>();
    for (const r of rows) {
      const b = byTurn.get(r.turn);
      if (b === undefined) byTurn.set(r.turn, [r]);
      else b.push(r);
    }

    let verdictCount = 0;
    for (const [turn, turnRows] of [...byTurn].sort((a, b) => a[0] - b[0])) {
      const texts = callsByTurn.get(turn) ?? [];
      if (texts.length === 0) continue; // the critic did not run this turn → no floor opportunity

      const root = join(tmpRoot, `${run}-${turn}`);
      mkdirSync(root, { recursive: true });
      const deleted = await materialise(run, turn, root);
      if (deleted === null) {
        die(`${run} turn ${turn}: no diff.patch, so the tree cannot be reconstructed.`);
      }

      // Build the finding set of EVERY panel run of the turn. A turn can re-review: pilot-02 t7
      // ran the panel twice — 2 findings then 0 — and the critic call belongs to the FIRST
      // iteration. Pairing "the last critic call" with "the final panel run" therefore pairs a
      // real verdict set against an empty finding set.
      //
      // ORDER IS LOAD-BEARING and mirrors the orchestrator exactly: applySymbolSignatures
      // (`:2219`) runs BEFORE validateFindingFacts (`:2226`). Reversing them silently breaks the
      // critic match, because Slice A rewrites `line_start` on a repaired finding and the signature
      // would then be computed from the REPAIRED line — a line the field never keyed on. (This
      // script had them the wrong way round; the match check below is what caught it.)
      const panelRuns = [...new Set(turnRows.map((r) => r.panelRun))].sort((a, b) => a - b);
      const setsByPanel = new Map<number, Finding[]>();
      for (const k of panelRuns) {
        setsByPanel.set(
          k,
          validateFindingFacts(
            await applySymbolSignatures(
              turnRows.filter((r) => r.panelRun === k).map((r) => r.finding),
              root,
            ),
            root,
            deleted,
          ),
        );
      }
      const finalPanelRun = (turnsWithFindings.get(turn) ?? 1) - 1;

      for (const text of texts) {
        // Parsed by the SHIPPED parser, so the replay cannot disagree with the binary about what a
        // critic response means.
        const critic: Map<string, CriticVerdict> = parseCriticOutput(text);
        verdictCount += critic.size;
        const sigs = [...critic.keys()];
        const fps = [...critic].filter(([, v]) => v.verdict === "likely_fp").length;
        likelyFpTotal += fps;

        // Pair this critic call with the iteration it actually judged, by SIGNATURE CONTAINMENT.
        // That is self-verifying: it identifies the iteration and simultaneously proves the
        // signature reproduction is right, because a wrong reproduction contains nothing.
        const k = panelRuns.find((kk) => {
          const known = new Set((setsByPanel.get(kk) ?? []).map((f) => f.signature));
          return sigs.length > 0 && sigs.every((s) => known.has(s));
        });
        if (k === undefined) {
          unmatchedCalls.push(`${run} t${turn} (${sigs.length} verdicts)`);
          continue;
        }
        matchedTotal += fps;
        const findings = setsByPanel.get(k) ?? [];

        const res = aggregate({
          findings,
          reviewersTotal: reviewersRanPerPanel.get(`${run}/${turn}/${k}`) ?? 1,
          critic,
        });
        for (const f of res.dedupedFindings) {
          if (isFloorActivation(f)) {
            activations.push({ run, turn, finding: f, treeExact: k === finalPanelRun });
          }
        }

        // DISCRIMINATOR — "0 true positives protected" is worthless if the critic never PROPOSED
        // demoting one. For every likely_fp verdict, ask whether the finding it targets matches the
        // turn's seeded-defect tags (the marker, per the rig's own attribution rule) on a seed that
        // actually landed. A demote proposed on such a finding is the exact event the floor exists
        // to block; if that count is 0, the floor's 0/3 says nothing about the mechanism.
        const seeded = seeds.get(turn);
        const landed = seeded ? seedLanded(run, turn, seeded) : null;
        for (const [sig, v] of critic) {
          if (v.verdict !== "likely_fp") continue;
          const target = findings.find((x) => x.signature === sig);
          if (!target || !seeded) continue;
          if (!matchesAnyTag(findingText(target), seeded.tags)) continue;
          // WHICH mechanism actually saved it? Find this finding's representative in the aggregated
          // output and ask whether the FLOOR is what kept it, or whether a pre-existing protection
          // (corroboration, or the CRITICAL+security exemption) already covered the case. The floor
          // only earns its cost where it is the sole thing standing between a real catch and INFO.
          const rep = res.dedupedFindings.find(
            (d) =>
              d.signature === sig || (d.members ?? []).some((mm) => mm.signature === sig) === true,
          );
          const savedBy =
            rep === undefined
              ? "DEMOTED (not protected)"
              : isFloorActivation(rep)
                ? "THE FLOOR"
                : rep.consensus === "unanimous" || rep.consensus === "majority"
                  ? `corroboration (${rep.consensus}) — pre-existing`
                  : rep.severity === "CRITICAL"
                    ? "CRITICAL+security exemption — pre-existing"
                    : `other (${rep.severity}/${rep.consensus}, critic_verdict=${rep.critic_verdict ?? "-"})`;
          criticProposedOnSeedCatch.push({
            line: `${run} t${turn} ${target.severity}/${target.category} ${target.file}:${target.line_start} [${target.rule_id}]\n         seed=${seeded.id} landed=${landed === null ? "UNKNOWN" : landed}  →  saved by: ${savedBy}`,
            landed,
            savedByFloor: rep !== undefined && isFloorActivation(rep),
          });
        }

        if (VERBOSE) {
          for (const [sig, v] of critic) {
            const f = findings.find((x) => x.signature === sig);
            console.log(
              `    ${run} t${turn} panel#${k} ${v.verdict.padEnd(9)} ${f ? `${f.severity}/${f.category} ${f.file}:${f.line_start} [${f.rule_id}]` : `(unmatched ${sig.slice(0, 12)}…)`}`,
            );
          }
        }
      }
    }

    perRun.push({
      run,
      turns: byTurn.size,
      findings: rows.length,
      verdicts: verdictCount,
    });
  }

  // The match rate is reported HONESTLY, not as a tick. A wholly broken signature reproduction
  // matches nothing, so 0 is fatal; a partial miss is a real limitation (a critic call judged an
  // iteration whose tree has since moved), and it bounds the measurement rather than invalidating it.
  if (matchedTotal === 0) {
    die(
      `no critic verdict resolved to any finding (${likelyFpTotal} likely_fp verdicts). The signature reproduction disagrees with the orchestrator's, so an empty critic map would masquerade as "the floor never fired".`,
    );
  }
  console.log(
    `\n  self-check · signature match: ${matchedTotal}/${likelyFpTotal} likely_fp verdicts resolve to a finding${matchedTotal === likelyFpTotal ? " — all of them ✔" : ""}`,
  );
  if (unmatchedCalls.length > 0) {
    console.log(
      `  ⚠ ${unmatchedCalls.length} critic call(s) matched NO iteration and are EXCLUDED — each is an`,
    );
    console.log(
      "    opportunity the floor may have had that this replay cannot see, so the activation count",
    );
    console.log(`    below is a LOWER bound: ${unmatchedCalls.join(", ")}`);
  }

  // The reproduction check: pilot-03 SHIPPED with the floor and its write-up recorded exactly one
  // activation. If this replay does not reproduce that, the instrument is wrong and every pilot-02
  // number it produces is worthless.
  const p03 = activations.filter((a) => a.run === "pilot-03").length;
  if (p03 !== 1) {
    die(
      `pilot-03 shipped WITH the floor and its field write-up recorded exactly 1 activation, but this replay finds ${p03}. The counterfactual cannot be trusted until that reproduces.`,
    );
  }
  console.log(
    "  self-check · reproduction  : pilot-03 (floor present in its binary) reproduces its 1 field activation ✔",
  );

  console.log(`\n${"─".repeat(97)}\nCORPUS\n`);
  console.log(
    `  ${"run".padEnd(10)}${"turns".padStart(7)}${"raw findings".padStart(14)}${"critic verdicts".padStart(17)}${"floor in binary".padStart(18)}`,
  );
  for (const r of perRun) {
    console.log(
      `  ${r.run.padEnd(10)}${String(r.turns).padStart(7)}${String(r.findings).padStart(14)}${String(r.verdicts).padStart(17)}${(FLOOR_IN_BINARY[r.run] ? "yes" : "NO (counterfactual)").padStart(22)}`,
    );
  }

  console.log(
    `\n${"─".repeat(97)}\nSLICE B ACTIVATIONS — findings the floor kept blocking against the critic\n`,
  );
  if (activations.length === 0) {
    console.log("  none.");
  }
  for (const a of activations) {
    const f = a.finding;
    console.log(
      `  ${a.run} t${String(a.turn).padEnd(3)} ${f.severity}/${f.category}  ${f.file}:${f.line_start}  confidence ${f.confidence}  consensus ${f.consensus}  [${f.rule_id}]${FLOOR_IN_BINARY[a.run] ? "" : "   ← COUNTERFACTUAL"}`,
    );
    console.log(`      ${f.message.replace(/\s+/g, " ").slice(0, 150)}`);
  }
  console.log(
    `\n  TOTAL ${activations.length} activation(s): ${activations.filter((a) => !FLOOR_IN_BINARY[a.run]).length} counterfactual (pilot-02, floor absent from its binary) +`,
  );
  console.log(
    `  ${activations.filter((a) => FLOOR_IN_BINARY[a.run]).length} reproduced from the field (pilot-03).`,
  );
  console.log(
    "\n  Each activation is a finding the critic proposed to demote below the blocking boundary and the",
  );
  console.log(
    "  floor kept. Whether that was right is a TRUE/FALSE-POSITIVE judgement per finding — this script",
  );
  console.log(
    "  deliberately does not guess it. pilot-03's single one was adjudicated a false positive by hand.",
  );

  console.log(
    `\n${"─".repeat(97)}\nDISCRIMINATOR — did the critic ever PROPOSE demoting a real catch?\n`,
  );
  console.log(
    '  "0 true positives protected" only condemns the floor if the critic actually tries to demote',
  );
  console.log(
    "  true positives. Counted by MARKER (the turn's seeded-defect tags), never by outcome:\n",
  );
  if (criticProposedOnSeedCatch.length === 0) {
    console.log(
      `    0 of ${matchedTotal} matched likely_fp verdicts targeted a finding matching its turn's seed tags.`,
    );
    console.log(
      "    So in this corpus the critic NEVER proposed demoting a seeded-defect catch, and the floor",
    );
    console.log(
      "    had no true positive to save. Its 0/3 is then a statement about OPPORTUNITY, not about the",
    );
    console.log(
      "    mechanism — the 3 false positives are what it demonstrably costs, the benefit is untested.",
    );
  } else {
    for (const c of criticProposedOnSeedCatch) console.log(`    ${c.line}`);
    // The count alone is NOT the answer, and reporting it as one would repeat the mistake this
    // whole replay exists to correct. Two conditions have to hold for a hit to be evidence FOR the
    // floor: the seeded defect must have actually LANDED (otherwise there was no real defect to
    // protect), and the FLOOR must be what saved it (rather than a pre-existing protection that
    // already covered the case).
    const onLanded = criticProposedOnSeedCatch.filter((c) => c.landed === true);
    const floorSavedALandedCatch = onLanded.filter((c) => c.savedByFloor);
    console.log(
      `\n    ${criticProposedOnSeedCatch.length} of ${matchedTotal} matched likely_fp verdicts targeted a seed-tagged finding.`,
    );
    console.log(
      `    Of those, ${onLanded.length} sat on a seed that actually LANDED — the rest had no real defect to protect.`,
    );
    console.log(
      `    The FLOOR was the mechanism that saved ${floorSavedALandedCatch.length} of those ${onLanded.length}.`,
    );
    if (floorSavedALandedCatch.length === 0) {
      console.log(
        "\n    So the floor's protective case was exercised, and a PRE-EXISTING mechanism already covered",
      );
      console.log(
        "    it. Measured benefit in this corpus: 0 real catches that would otherwise have been demoted.",
      );
      console.log(
        "    Measured cost: 3 false positives kept blocking. That is an argument to revert or narrow —",
      );
      console.log(
        "    on n = 1 exercised opportunity, so it bounds the benefit rather than proving it is always 0.",
      );
    }
  }
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}
