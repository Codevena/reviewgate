// rig/scripts/anchor-replay.ts
//
// OFFLINE Slice A corpus replay. Read-only: no network, no agent quota, no rebuild, and it
// writes nothing outside a temp dir it removes again. Plan:
// docs/superpowers/plans/2026-08-06-slice-a-corpus-replay.md
//
// WHY THIS EXISTS. Slice A (`reanchorByEvidence`, src/core/fact-check.ts) fired 0 times across
// three pilots, and pilot-03 reported its OPPORTUNITY denominator as 0/12 turns and 1/36 across
// all pilots. At that base rate no 12-turn pilot has power. But that denominator was counted
// over `rig/results/*/turns/*/reports/*-pending.json` — POST-AGGREGATION SURVIVORS. A finding
// the critic dropped, or one folded into a merge, never appears there. The pass itself runs
// PRE-aggregation (orchestrator.ts:2226), so the survivors are the wrong population.
//
// The right population is the reviewers' RAW output, recorded at the provider boundary in
// `cassette.jsonl` before any gate pass touches it. This script replays that through the REAL,
// IMPORTED `validateFindingFacts` — never a reimplementation, so the numbers cannot drift from
// what the binary does.
//
// WHAT THIS IS NOT: it measures Slice A's BASE RATE and its repair/demote split. It says nothing
// about whether a repair is CORRECT — that rests on tests/unit/fact-check-reanchor.test.ts.
//
// `rig/results/` is gitignored: this script is committed, its inputs are local to this machine.
//
//   bun run rig/scripts/anchor-replay.ts            # full replay
//   bun run rig/scripts/anchor-replay.ts --verbose  # one line per finding

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { REGION_WINDOW, aggregate } from "../../src/core/aggregator.ts";
import {
  attestEvidence,
  lineCount,
  normalizeLine,
  validateFindingFacts,
} from "../../src/core/fact-check.ts";
import { computeSignature } from "../../src/diff/signature.ts";
import { enclosingSymbol } from "../../src/research/symbol-graph.ts";
import type { Finding } from "../../src/schemas/finding.ts";

const RUNS = ["pilot-01", "pilot-02", "pilot-03"] as const;
const VERBOSE = process.argv.includes("--verbose");

interface TurnManifest {
  index: number;
  cassetteBytes: { before: number; after: number } | null;
  gateReviewed: boolean;
}

/** One raw reviewer finding, with the turn and panel run it came from. */
interface Row {
  run: string;
  turn: number;
  reviewer: string;
  /** 0-based index of the panel run within the turn (the k-th call to THIS reviewer). */
  panelRun: number;
  finding: Finding;
}

type Outcome =
  | "in-range"
  | "repaired"
  | "demoted"
  /** Out of range, but pilot-01 line-count mode: the pass never ran, so repair-vs-demote is
   *  unknowable from the archives. Counts as an OPPORTUNITY, never as a demote. */
  | "out-of-range-unsplit"
  | "file-absent";

interface Scored extends Row {
  outcome: Outcome;
  /** File line count at the reconstructed turn state; null when the file was not materialised. */
  fileLines: number | null;
  repairedTo: number | null;
  /** false when the finding came from a non-final panel run — see EXACTNESS below. */
  exact: boolean;
  /** The finding AFTER the shipped `validateFindingFacts` — i.e. exactly what the field run fed
   *  to `aggregate()`. In line-count mode the pass never ran, so this is the raw finding. */
  checked: Finding;
  /** Reconstructed working tree for this row's turn (kept until the run's `finally`). */
  root: string;
  /** Every 1-based line of the cited file whose content equals this finding's own quote, after
   *  `normalizeLine`. Empty when the finding carries no usable quote or the file was absent.
   *  Length > 1 is the TIE-BREAK EXPOSURE an in-range repair would have to decide (see IMPACT). */
  matchLines: number[];
}

/** The three outcomes that mean "the citation was out of range" — the Slice A denominator.
 *  `out-of-range-unsplit` is an opportunity whose repair/demote split is unknowable (pilot-01). */
const OPPORTUNITY = ["repaired", "demoted", "out-of-range-unsplit"] as const;

/** `<run>/<turn>` → how many distinct reviewers RAN that turn (review entries in the cassette,
 *  whether or not they returned findings). This is the field's `reviewersTotal`, which
 *  `computeConsensus` divides by — counting only reviewers that produced findings would understate
 *  the panel and silently misreport how much power a consensus comparison had. */
const reviewersRan = new Map<string, number>();

function die(msg: string): never {
  console.error(`\nanchor-replay: ABORT — ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------------------------
// Corpus: slice cassette.jsonl by the driver's per-turn byte offsets (driver.ts:331,361).
// ---------------------------------------------------------------------------------------------

function readCorpus(run: string): { rows: Row[]; turnsWithFindings: Map<number, number> } {
  const manifest = JSON.parse(readFileSync(`rig/results/${run}/manifest.json`, "utf8")) as {
    turns: TurnManifest[];
  };
  const buf = readFileSync(`rig/results/${run}/cassette.jsonl`);

  // INTEGRITY 1 — the ranges must tile [0, filesize] with no gap and no overlap. A silent gap
  // would drop a turn's reviewers entirely and read downstream as "that turn found nothing".
  let cursor = 0;
  for (const t of manifest.turns) {
    if (t.cassetteBytes === null) continue;
    if (t.cassetteBytes.before !== cursor) {
      die(
        `${run} turn ${t.index}: cassette range starts at ${t.cassetteBytes.before}, expected ${cursor} — the offsets do not tile the file, so per-turn attribution is unsound.`,
      );
    }
    cursor = t.cassetteBytes.after;
  }
  if (cursor !== buf.length) {
    die(`${run}: cassette ranges end at ${cursor} but the file is ${buf.length} bytes.`);
  }

  const rows: Row[] = [];
  const turnsWithFindings = new Map<number, number>();
  for (const t of manifest.turns) {
    const cb = t.cassetteBytes;
    if (cb === null || cb.after <= cb.before) continue;
    const slice = buf.subarray(cb.before, cb.after).toString("utf8");
    // Per-reviewer call counter: the k-th entry with a given key is that reviewer's k-th panel
    // run this turn. Keyed per reviewer because the panel runs CONCURRENTLY, so raw entry order
    // between the two reviewers is not stable and must not be read as sequence.
    const seen = new Map<string, number>();
    for (const line of slice.split("\n")) {
      if (!line.trim()) continue;
      let entry: { method: string; key: string; result?: { findings?: Finding[] } };
      try {
        entry = JSON.parse(line);
      } catch {
        // INTEGRITY 2 — a torn line at a slice boundary means the offsets are off by bytes.
        // Skipping it would quietly shrink the corpus, so it is fatal.
        die(
          `${run} turn ${t.index}: a line inside the turn's byte range is not valid JSON — the slice boundaries are wrong.`,
        );
      }
      if (entry.method !== "review") continue;
      const k = seen.get(entry.key) ?? 0;
      seen.set(entry.key, k + 1);
      for (const finding of entry.result?.findings ?? []) {
        rows.push({ run, turn: t.index, reviewer: entry.key, panelRun: k, finding });
      }
    }
    if (seen.size > 0) {
      turnsWithFindings.set(t.index, Math.max(...seen.values()));
      reviewersRan.set(`${run}/${t.index}`, seen.size);
    }
  }
  return { rows, turnsWithFindings };
}

// ---------------------------------------------------------------------------------------------
// Per-turn working tree. `turns/<T>/diff.patch` is the CUMULATIVE tree against the base commit
// (driver.ts:290), so applying it to an EMPTY repo reproduces it — no dependency on the
// /private/tmp sandboxes, which the handoff lists for reaping.
// ---------------------------------------------------------------------------------------------

async function materialise(run: string, turn: number, root: string): Promise<Set<string> | null> {
  const patch = `${process.cwd()}/rig/results/${run}/turns/${turn}/diff.patch`;
  if (!existsSync(patch)) return null;
  await $`git init -q .`.cwd(root).quiet();
  const applied = await $`git apply --whitespace=nowarn ${patch}`.cwd(root).nothrow().quiet();
  if (applied.exitCode !== 0) {
    // An unapplied patch leaves an EMPTY tree, in which every finding's file is absent and the
    // pass fails safe — which reads exactly like "no opportunities". Fatal, never skipped.
    die(
      `${run} turn ${turn}: git apply failed (${applied.stderr.toString().trim()}). An empty tree would masquerade as zero opportunities.`,
    );
  }
  const text = await Bun.file(patch).text();
  const deleted = new Set<string>();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]?.startsWith("deleted file mode")) {
      const header = lines
        .slice(0, i)
        .reverse()
        .find((l) => l.startsWith("diff --git "));
      const m = header?.match(/ b\/(.+)$/);
      if (m?.[1]) deleted.add(m[1]);
    }
  }
  return deleted;
}

// ---------------------------------------------------------------------------------------------
// Did the turn's LAST gate iteration run the panel?
//
// This is the load-bearing question for the whole replay, and it is MEASURED here rather than
// argued. `diff.patch` is the tree at END of turn. A rig turn ends when the gate allows the stop,
// so the LAST iteration's tree IS the end-of-turn tree. If that last iteration ran the panel,
// then the last panel run saw exactly the reconstructed tree.
//
// The audit tree records every iteration: `run.complete` carries `iter` and
// `run_summary.source`, which is "panel" when reviewers ran and "skipped" when triage skipped
// them. It is APPEND-ONLY and each turn's snapshot is cumulative, so a turn's own events are the
// ones whose event hash is new against the previous turn's snapshot — the same multiset-delta
// discipline `harvest()` already applies to this tree.
//
// A first version of this script asserted instead that "a later iteration served from the review
// cache proves the diff did not change". A reviewer pointed out that the script never checked
// that such an iteration existed, and was right: the condition was necessary, not sufficient.
// This replaces the argument with the record.
interface TurnIterations {
  /** run.complete events for THIS turn, in iteration order. */
  sources: string[];
  /** true when the turn's final gate iteration actually ran the reviewer panel. */
  lastRanPanel: boolean;
}

function auditEvents(dir: string): Map<string, { iter: number; source: string; runId: string }> {
  const out = new Map<string, { iter: number; source: string; runId: string }>();
  const stack = [dir];
  while (stack.length > 0) {
    const d = stack.pop();
    if (d === undefined || !existsSync(d)) continue;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        stack.push(p);
        continue;
      }
      for (const line of readFileSync(p, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const j = JSON.parse(line) as {
          event?: string;
          iter?: number;
          run_id?: string;
          this_event_hash?: string;
          run_summary?: { source?: string };
        };
        if (j.event !== "run.complete" || typeof j.this_event_hash !== "string") continue;
        out.set(j.this_event_hash, {
          iter: j.iter ?? 0,
          source: j.run_summary?.source ?? "(none)",
          runId: j.run_id ?? "",
        });
      }
    }
  }
  return out;
}

function turnIterations(run: string, turn: number): TurnIterations {
  const here = auditEvents(`rig/results/${run}/turns/${turn}/.reviewgate/audit`);
  const before = auditEvents(`rig/results/${run}/turns/${turn - 1}/.reviewgate/audit`);
  const mine = [...here].filter(([h]) => !before.has(h)).map(([, v]) => v);
  mine.sort((a, b) => a.runId.localeCompare(b.runId) || a.iter - b.iter);
  const sources = mine.map((m) => m.source);
  return { sources, lastRanPanel: sources.length > 0 && sources[sources.length - 1] === "panel" };
}

/** pilot-01 recorded no diff.patch. Per-turn line counts survive in research.md's changed-file
 *  rows; `+N/-0` IS the line count for a file created after the review base. Validated 26/26
 *  against reconstructed trees on pilots 02/03 (plan, fact 4). */
async function researchLineCounts(run: string, turn: number): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const f = Bun.file(`rig/results/${run}/turns/${turn}/.reviewgate/research.md`);
  if (!(await f.exists())) return out;
  const block = (await f.text()).match(/## Changed files\n([\s\S]*?)\n\n/);
  if (!block?.[1]) return out;
  for (const line of block[1].split("\n")) {
    const m = line.match(/^- (\S+) \(\w+, \+(\d+)\/-(\d+)\)/);
    // Only `-0` is an exact line count: with deletions the numbers are a delta against the
    // review base, not a size. Anything else is left unknown rather than approximated.
    if (m?.[1] && m[3] === "0") out.set(m[1], Number(m[2]));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------------------------

/** Secondary measurement + the normalize cross-check, both over IN-RANGE findings only. */
interface EvidenceSplit {
  matchesCited: Scored[];
  /** Cited line is real but the quote is a DIFFERENT real line — the in-range mis-anchor. */
  inRangeMisAnchor: Scored[];
  /** Quote matches no line at all — `attestEvidence` badges these `evidence_mismatch`. */
  matchesNothing: Scored[];
}

async function replayRun(
  run: string,
  tmpRoot: string,
): Promise<{
  rows: Row[];
  scored: Scored[];
  evidence: EvidenceSplit;
  lineCountMode: boolean;
  crossChecked: number;
}> {
  const { rows, turnsWithFindings } = readCorpus(run);
  const scored: Scored[] = [];
  const evidence: EvidenceSplit = {
    matchesCited: [],
    inRangeMisAnchor: [],
    matchesNothing: [],
  };
  let lineCountMode = false;
  let crossChecked = 0;

  const byTurn = new Map<number, Row[]>();
  for (const r of rows) {
    const bucket = byTurn.get(r.turn);
    if (bucket === undefined) byTurn.set(r.turn, [r]);
    else bucket.push(r);
  }

  for (const [turn, turnRows] of [...byTurn].sort((a, b) => a[0] - b[0])) {
    const root = join(tmpRoot, `${run}-${turn}`);
    mkdirSync(root, { recursive: true });
    const deleted = await materialise(run, turn, root);

    // EXACTNESS, measured on two independent records (see turnIterations above):
    //   1. the finding came from the turn's FINAL panel run  (cassette), AND
    //   2. the turn's FINAL gate iteration ran the panel     (audit tree).
    // Together those establish that the reconstructed end-of-turn tree IS the tree that panel
    // run reviewed. Either alone is not enough.
    //
    // A finding failing them is UNVERIFIABLE, and deliberately not called a "lower bound": the
    // agent's fix between panel runs can lengthen the file (a cited line that was out of range
    // now reads in range — a MISSED opportunity) or shorten it (an INVENTED one). The error has
    // no sign, so those findings are reported separately, never folded into a headline.
    const finalPanelRun = (turnsWithFindings.get(turn) ?? 1) - 1;
    const iters = turnIterations(run, turn);
    // The two records must agree on how many panel runs the turn had. They are produced by
    // different subsystems (the provider recorder vs the audit log), so a disagreement means the
    // cassette slicing or the audit delta is wrong, and every exactness label would be noise.
    const panelIterations = iters.sources.filter((s) => s === "panel").length;
    if (panelIterations !== finalPanelRun + 1) {
      die(
        `${run} turn ${turn}: the cassette shows ${finalPanelRun + 1} panel run(s) but the audit log shows ${panelIterations} panel iteration(s) (sources: ${iters.sources.join(",") || "none"}). Two independent records disagree, so no exactness label can be trusted.`,
      );
    }
    const turnExact = iters.lastRanPanel;

    if (deleted === null) {
      // ---- line-count mode (pilot-01): in/out classification only, never a repair split.
      lineCountMode = true;
      const counts = await researchLineCounts(run, turn);
      for (const r of turnRows) {
        const lines = counts.get(r.finding.file);
        // NOT "demoted": the pass never ran here, so calling it demoted would report an outcome
        // that was never produced. It is an opportunity whose repair/demote split is unknowable
        // from the archives, and it says so.
        const outcome: Outcome =
          lines === undefined
            ? "file-absent"
            : r.finding.line_start <= lines
              ? "in-range"
              : "out-of-range-unsplit";
        scored.push({
          ...r,
          outcome,
          fileLines: lines ?? null,
          repairedTo: null,
          exact: turnExact && r.panelRun === finalPanelRun,
          // The pass never ran in this mode and there is no file content, so there is nothing to
          // check against and no quote to locate. The IMPACT section skips these by construction.
          checked: r.finding,
          root,
          matchLines: [],
        });
      }
      continue;
    }

    // ---- full mode: run the REAL pass against the reconstructed tree.
    const findings = turnRows.map((r) => r.finding);
    const checked = validateFindingFacts(findings, root, deleted);
    const attested = attestEvidence(checked, root);

    for (let i = 0; i < turnRows.length; i++) {
      const before = turnRows[i];
      const after = checked[i];
      // validateFindingFacts is a .map(), so it returns one output per input in order. Scoring a
      // finding against another finding's verdict is the worst failure this script could have, so
      // the correspondence is CHECKED per row rather than assumed: a length check alone would not
      // catch a reordering. `rule_id` and `file` are untouched by the pass, so they are a valid
      // identity for this purpose.
      if (before === undefined || after === undefined) {
        die(
          `${run} turn ${turn}: validateFindingFacts returned ${checked.length} findings for ${turnRows.length} inputs — the 1:1 index correspondence this replay relies on is broken.`,
        );
      }
      if (after.rule_id !== before.finding.rule_id || after.file !== before.finding.file) {
        die(
          `${run} turn ${turn} index ${i}: validateFindingFacts returned ${after.rule_id}@${after.file} where ${before.finding.rule_id}@${before.finding.file} went in — the output is reordered, so every outcome label would be attached to the wrong finding.`,
        );
      }
      const file = join(root, before.finding.file);
      const present = existsSync(file);
      const fileLines = present ? lineCount(await Bun.file(file).text()) : null;

      let outcome: Outcome;
      if (after.anchor_repaired === true) outcome = "repaired";
      else if (after.fact_invalid === true) outcome = "demoted";
      else if (!present) outcome = "file-absent";
      else outcome = "in-range";

      const row: Scored = {
        ...before,
        outcome,
        fileLines,
        repairedTo: after.anchor_repaired === true ? after.line_start : null,
        exact: turnExact && before.panelRun === finalPanelRun,
        checked: after,
        root,
        matchLines: [],
      };
      scored.push(row);

      // ---- secondary measurement: in-range findings whose quote names a different real line.
      if (outcome !== "in-range" || present === false) continue;
      const ev =
        typeof before.finding.evidence_line === "string" ? before.finding.evidence_line : "";
      if (ev.length === 0) continue;
      const evN = normalizeLine(ev);
      if (evN.length === 0) continue;
      const lines = (await Bun.file(file).text()).split("\n");
      const cited = lines[before.finding.line_start - 1];
      const matchesCited = cited !== undefined && normalizeLine(cited) === evN;
      // Collect EVERY matching line rather than `lines.some(...)`. Identical as a boolean (asserted
      // against attestEvidence by GUARD 6 below), but it also records how many lines the quote
      // matches — which is exactly the ambiguity an in-range repair would have to resolve and an
      // out-of-range one never can (past EOF every match is below the cited line).
      const matchLines: number[] = [];
      for (let li = 0; li < lines.length; li++) {
        if (normalizeLine(lines[li] ?? "") === evN) matchLines.push(li + 1);
      }
      row.matchLines = matchLines;
      const matchesSomewhere = matchLines.length > 0;
      if (matchesCited) evidence.matchesCited.push(row);
      else if (matchesSomewhere) evidence.inRangeMisAnchor.push(row);
      else evidence.matchesNothing.push(row);

      // ---- GUARD 6: agree with the shipped pass on where the boundary sits. `normalizeLine` is
      // now IMPORTED, so the two cannot drift textually; this checks the remaining risk, which is
      // that this loop reads the file differently than `attestEvidence` does (line splitting,
      // 1-based indexing, the out-of-range early return). attestEvidence badges
      // `evidence_mismatch` on exactly "quote matches NO line of the file", so the third bucket
      // here must coincide with the badge, finding for finding.
      const badged = attested[i]?.evidence_mismatch === true;
      if (badged !== (!matchesCited && !matchesSomewhere)) {
        die(
          `${run} turn ${turn} ${before.finding.rule_id}: this replay's quote classification disagrees with attestEvidence (badge=${badged}). One of the two reads the file differently.`,
        );
      }
      crossChecked++;
    }
  }
  return { rows, scored, evidence, lineCountMode, crossChecked };
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

const EXPECTED_RAW: Record<string, number> = { "pilot-01": 44, "pilot-02": 24, "pilot-03": 27 };

const tmpRoot = mkdtempSync(join(tmpdir(), "anchor-replay-"));
try {
  const all: Scored[] = [];
  const evidenceAll: EvidenceSplit = {
    matchesCited: [],
    inRangeMisAnchor: [],
    matchesNothing: [],
  };
  let crossCheckedAll = 0;
  const perRun: { run: string; scored: Scored[]; lineCountMode: boolean; turns: number }[] = [];

  console.log("Slice A corpus replay — RAW reviewer output through the real validateFindingFacts");
  console.log("=".repeat(95));

  for (const run of RUNS) {
    const { rows, scored, evidence, lineCountMode, crossChecked } = await replayRun(run, tmpRoot);
    // INTEGRITY 3 — the corpus size is a published number; reproduce it or stop.
    if (rows.length !== EXPECTED_RAW[run]) {
      die(
        `${run}: sliced ${rows.length} raw findings, expected ${EXPECTED_RAW[run]}. The corpus changed or the slicing is wrong.`,
      );
    }
    all.push(...scored);
    evidenceAll.matchesCited.push(...evidence.matchesCited);
    evidenceAll.matchesNothing.push(...evidence.matchesNothing);
    evidenceAll.inRangeMisAnchor.push(...evidence.inRangeMisAnchor);
    crossCheckedAll += crossChecked;
    perRun.push({
      run,
      scored,
      lineCountMode,
      turns: new Set(scored.map((s) => s.turn)).size,
    });
  }

  // ---- GUARD 1: the one field event with a published ground truth. pilot-02 turn 2's CRITICAL
  // path-traversal cites src/store.ts:67 in a 27-line file and quotes line 26 verbatim. WITHOUT
  // Slice A it is demoted with line_start 67; WITH it, repaired to 26.
  const truth = all.find(
    (s) => s.run === "pilot-02" && s.turn === 2 && s.finding.rule_id === "path-traversal",
  );
  if (!truth) die("ground truth absent: pilot-02 turn 2 `path-traversal` is not in the corpus.");
  if (truth.outcome !== "repaired" || truth.repairedTo !== 26 || truth.fileLines !== 27) {
    die(
      `ground truth NOT reproduced: expected repaired→26 in a 27-line file, got ${truth.outcome}→${truth.repairedTo} in ${truth.fileLines} lines.`,
    );
  }
  console.log(
    `\n  self-check · ground truth   : pilot-02 turn 2 path-traversal cited 67 in a 27-line file → REPAIRED to ${truth.repairedTo} ✔`,
  );
  console.log(
    "  self-check · cassette tiling: contiguous, covers every byte in all 3 runs ✔\n  self-check · corpus size    : 44 / 24 / 27 raw findings reproduced ✔",
  );
  console.log(
    `  self-check · quote reading  : agrees with attestEvidence on all ${crossCheckedAll} in-range quoted findings ✔`,
  );

  const count = (rows: Scored[], o: Outcome) => rows.filter((r) => r.outcome === o).length;

  console.log(
    `\n${"─".repeat(95)}\nSLICE A — opportunities (out-of-range citations) and what the pass did with them\n`,
  );
  console.log(
    `  ${"run".padEnd(10)}${"turns".padStart(6)}${"raw".padStart(6)}${"in-range".padStart(10)}${"absent".padStart(8)}${"OPPORTUNITY".padStart(13)}${"repaired".padStart(10)}${"demoted".padStart(9)}`,
  );
  for (const { run, scored, lineCountMode } of perRun) {
    const opp = OPPORTUNITY.reduce((n, o) => n + count(scored, o), 0);
    const turns = new Set(scored.map((s) => s.turn)).size;
    console.log(
      `  ${run.padEnd(10)}${String(turns).padStart(6)}${String(scored.length).padStart(6)}${String(count(scored, "in-range")).padStart(10)}${String(count(scored, "file-absent")).padStart(8)}${String(opp).padStart(13)}${(lineCountMode ? "n/a" : String(count(scored, "repaired"))).padStart(10)}${(lineCountMode ? "n/a" : String(count(scored, "demoted"))).padStart(9)}${lineCountMode ? "   ← line-count mode: no content, split not computable" : ""}`,
    );
  }
  const oppAll = OPPORTUNITY.reduce((n, o) => n + count(all, o), 0);
  console.log(
    `  ${"TOTAL".padEnd(10)}${String(new Set(all.map((s) => `${s.run}/${s.turn}`)).size).padStart(6)}${String(all.length).padStart(6)}${String(count(all, "in-range")).padStart(10)}${String(count(all, "file-absent")).padStart(8)}${String(oppAll).padStart(13)}${String(count(all, "repaired")).padStart(10)}${String(count(all, "demoted")).padStart(9)}`,
  );

  const exact = all.filter((s) => s.exact).length;
  const opps = all.filter((s) => (OPPORTUNITY as readonly Outcome[]).includes(s.outcome));
  const oppsExact = opps.filter((s) => s.exact).length;
  console.log(
    `\n  Reconstruction: ${exact}/${all.length} findings satisfy BOTH conditions for the reconstructed tree`,
  );
  console.log(
    "  to be the one the reviewer saw — the finding came from its turn's final panel run (cassette),",
  );
  console.log(
    "  AND that turn's final gate iteration ran the panel (audit log). A rig turn ends when the gate",
  );
  console.log("  allows the stop, so the final iteration's tree IS the end-of-turn tree.");
  console.log(
    "  The two records were also checked against each other per turn: they agree everywhere on how",
  );
  console.log("  many panel runs a turn had, or this run would have aborted.");
  console.log(
    `  Of the ${opps.length} opportunit${opps.length === 1 ? "y" : "ies"} above, ${oppsExact} sit on such a tree${oppsExact === opps.length ? " — ALL of them." : "."}`,
  );
  console.log(
    `  The remaining findings are UNVERIFIABLE, not a bound: the agent's fix between panel runs can`,
  );
  console.log(
    "  lengthen the file (a real opportunity disappears) or shorten it (a phantom one appears).",
  );

  if (opps.length > 0) {
    console.log("\n  Every opportunity, individually:");
    for (const o of opps.sort((a, b) => a.run.localeCompare(b.run) || a.turn - b.turn)) {
      const what =
        o.outcome === "repaired"
          ? `REPAIRED  ${o.finding.line_start} → ${o.repairedTo}`
          : `demoted   (line ${o.finding.line_start}, no usable quote)`;
      console.log(
        `    ${o.run} t${String(o.turn).padEnd(2)} ${o.finding.file}:${String(o.finding.line_start).padEnd(4)} of ${String(o.fileLines ?? "?").padEnd(4)} lines  ${o.finding.severity.padEnd(8)} ${what}  ${o.exact ? "[exact]" : "[UNVERIFIABLE tree]"}  [${o.finding.rule_id}]`,
      );
    }
  }

  console.log(
    `\n${"─".repeat(95)}\nSECONDARY — in-range mis-anchors (a DIFFERENT population; never add these to Slice A's)\n`,
  );
  console.log(
    "  Findings whose cited line EXISTS but whose own quote is a different real line of the file.",
  );
  console.log("  validateFindingFacts never inspects these — it only ever runs past EOF.\n");
  // Reported on the EXACT subset first. This measurement's bias runs OPPOSITE to Slice A's: on a
  // tree the reviewer never saw, a correctly-anchored finding looks mis-anchored, so the full-set
  // number is an upper bound and only the exact subset is a measurement.
  const ex = <T extends Scored>(rows: T[]) => rows.filter((r) => r.exact);
  const table = (label: string, c: Scored[], m: Scored[], n: Scored[]) => {
    const t = c.length + m.length + n.length;
    console.log(`  ${label} (${t} in-range findings carrying a quote)`);
    console.log(`    quote matches the cited line            : ${c.length}`);
    console.log(`    quote matches a DIFFERENT line          : ${m.length}  ← in-range mis-anchor`);
    console.log(`    quote matches no line (evidence_mismatch): ${n.length}`);
  };
  table(
    "ON TREES THE REVIEWER PROVABLY SAW — the measurement:",
    ex(evidenceAll.matchesCited),
    ex(evidenceAll.inRangeMisAnchor),
    ex(evidenceAll.matchesNothing),
  );
  for (const m of ex(evidenceAll.inRangeMisAnchor)) {
    console.log(
      `      ${m.run} t${String(m.turn).padEnd(2)} ${m.finding.file}:${m.finding.line_start}  ${m.finding.severity}/${m.finding.category}  [${m.finding.rule_id}]`,
    );
  }
  console.log("");
  table(
    "ALL in-range findings, including unverifiable trees — an UPPER bound:",
    evidenceAll.matchesCited,
    evidenceAll.inRangeMisAnchor,
    evidenceAll.matchesNothing,
  );

  // -------------------------------------------------------------------------------------------
  // IMPACT — what an in-range mis-anchor actually COSTS
  //
  // The SECONDARY table sizes the population; it does NOT show that the population matters. An
  // in-range mis-anchor keeps its severity, its file and its (correct) quote — unlike a Slice A
  // victim, which was demoted to INFO and told it was "almost certainly hallucinated". So before
  // anything is specced, the question is whether being off by a few lines COSTS anything. Two
  // shipped mechanisms read line_start at a granularity comparable to the observed offsets:
  //
  //   (1) MERGE / CONSENSUS. aggregate() clusters two same-file findings whose line_start differs
  //       by <= REGION_WINDOW, or whose wording is highly similar within a bounded distance. Two
  //       reviewers describing ONE defect at two mis-anchored lines can fail to merge — and on a
  //       2-reviewer panel that is precisely the difference between singleton and majority.
  //   (2) SIGNATURE IDENTITY. computeSignature buckets line_start (or its offset within the
  //       enclosing symbol). That signature keys the FP-ledger, per-cycle rejection suppression,
  //       the fix-verification pin and location-recurrence.
  //
  // Both are measured with the REAL shipped functions over each turn's ACTUAL panel output — never
  // a reimplementation and never a hand-built fixture. The only substitution is the finding's
  // `signature` field, replaced by a stable per-row id so a finding can be tracked across two arms
  // that differ in line; GUARD 7 measures that this substitution does not change the clustering.
  // -------------------------------------------------------------------------------------------
  console.log(
    `\n${"─".repeat(95)}\nIMPACT — does an in-range mis-anchor COST anything? (real aggregate + real computeSignature)\n`,
  );

  // Repair target chosen exactly as reanchorByEvidence would: nearest match to the cited line,
  // ties to the EARLIER line (its strict `<` over an ascending scan). Past EOF that rule is forced
  // by the range; in range it is a real choice, which is why the tie count is reported first.
  const chooseRepair = (cited: number, matches: number[]): number => {
    let best = matches[0] ?? cited;
    for (const m of matches) if (Math.abs(m - cited) < Math.abs(best - cited)) best = m;
    return best;
  };
  const misExact = ex(evidenceAll.inRangeMisAnchor);
  const repairTarget = new Map<Scored, number>();
  for (const m of misExact) repairTarget.set(m, chooseRepair(m.finding.line_start, m.matchLines));

  const ties = misExact.filter((m) => m.matchLines.length > 1);
  console.log(
    `  TIE-BREAK EXPOSURE: ${ties.length} of ${misExact.length} mis-anchored quotes match more than one line.`,
  );
  console.log(
    "  reanchorByEvidence's determinism argument holds only because it is unreachable in range: past",
  );
  console.log(
    "  EOF every match lies below the cited line, so nearest == last and no tie can arise. In range,",
  );
  console.log("  matches straddle the cited line and the tie-break becomes a decision.\n");
  for (const m of misExact) {
    const to = repairTarget.get(m) ?? 0;
    console.log(
      `    ${m.run} t${String(m.turn).padEnd(2)} ${`${m.finding.file}:${m.finding.line_start}`.padEnd(20)} → ${String(to).padEnd(4)} Δ${String(Math.abs(to - m.finding.line_start)).padEnd(3)} ${m.matchLines.length === 1 ? "unique match" : `${m.matchLines.length} MATCHES (${m.matchLines.join(",")})`}  [${m.finding.rule_id}]`,
    );
  }

  console.log(
    `\n  (1) MERGE / CONSENSUS — real aggregate() over each turn's panel output, as-cited vs re-anchored.`,
  );
  console.log(
    `      Two same-file findings cluster when their line_start differs by <= ${REGION_WINDOW}.\n`,
  );
  const partition = (r: { dedupedFindings: Finding[] }) =>
    r.dedupedFindings
      .map((f) =>
        (f.members ?? [])
          .map((m) => m.signature)
          .sort()
          .join("+"),
      )
      .sort()
      .join(" | ");
  const shape = (r: { dedupedFindings: Finding[] }) =>
    r.dedupedFindings
      .map((f) => (f.members ?? []).length)
      .sort((a, b) => a - b)
      .join(",");
  const corroborated = (r: { dedupedFindings: Finding[] }) =>
    r.dedupedFindings.filter((f) => f.consensus !== "singleton").length;

  let turnsChanged = 0;
  let poweredTurns = 0;
  for (const key of [...new Set(misExact.map((m) => `${m.run}/${m.turn}`))].sort()) {
    const [runKey, turnStr] = key.split("/");
    const turn = Number(turnStr);
    // The turn's EXACT rows ARE its final panel run across all reviewers — i.e. exactly the set the
    // field run handed to aggregate(). (The field also ran symbol signatures and the self-refutation
    // demoter in between; neither changes cluster MEMBERSHIP, which is decided by file/line/wording.)
    const rows = all.filter((s) => s.run === runKey && s.turn === turn && s.exact);
    // Reviewers that RAN, not reviewers that returned findings — see `reviewersRan`. A turn where
    // only ONE reviewer ran cannot produce corroboration under ANY anchoring, so it carries no
    // power to show a lost merge; that is reported alongside the result rather than averaged into it.
    const reviewersTotal = reviewersRan.get(key) ?? new Set(rows.map((r) => r.reviewer)).size;
    const label = (r: Scored, i: number): Finding => ({ ...r.checked, signature: `IDX-${i}` });
    const armA = rows.map(label);
    const armB = rows.map((r, i) => {
      const to = repairTarget.get(r);
      const f = label(r, i);
      return to === undefined ? f : { ...f, line_start: to, line_end: to };
    });
    const resA = aggregate({ findings: armA, reviewersTotal });
    const resB = aggregate({ findings: armB, reviewersTotal });

    // GUARD 7 — the stable-id substitution must not itself change the clustering, or the A/B diff
    // below measures the substitution instead of the re-anchoring.
    const resAReal = aggregate({ findings: rows.map((r) => r.checked), reviewersTotal });
    if (shape(resA) !== shape(resAReal)) {
      die(
        `${key}: replacing the signature with a stable id changed the cluster shape (${shape(resA)} vs ${shape(resAReal)}) — clustering reads the signature after all, so this A/B comparison is invalid.`,
      );
    }

    const changed = partition(resA) !== partition(resB);
    if (changed) turnsChanged++;
    if (reviewersTotal >= 2) poweredTurns++;
    // DIAGNOSTIC — distinguish "the partition held because nothing crossed the region window" from
    // "it held because the merge was blocked for an unrelated reason". Counts same-file pairs that
    // are ELIGIBLE to region-merge (distance <= REGION_WINDOW). If this number moves while the
    // partition does not, some other rule (e.g. the high-stakes category guard) absorbed the move,
    // and the zero above must not be read as "the offsets are too small to matter".
    const eligiblePairs = (fs: Finding[]): string[] => {
      const out: string[] = [];
      for (let i = 0; i < fs.length; i++) {
        for (let j = i + 1; j < fs.length; j++) {
          const a = fs[i];
          const b = fs[j];
          if (a === undefined || b === undefined) continue;
          if (a.file === b.file && Math.abs(a.line_start - b.line_start) <= REGION_WINDOW) {
            out.push(`${a.file}:${a.line_start}(${a.category})↔${b.line_start}(${b.category})`);
          }
        }
      }
      return out;
    };
    const pairsA = eligiblePairs(armA);
    const pairsB = eligiblePairs(armB);
    console.log(
      `    ${key.padEnd(14)} findings ${String(rows.length).padStart(2)}  reviewers ${reviewersTotal}  clusters ${resA.dedupedFindings.length} → ${resB.dedupedFindings.length}  corroborated ${corroborated(resA)} → ${corroborated(resB)}  region-eligible pairs ${pairsA.length} → ${pairsB.length}  ${changed ? "◀ PARTITION CHANGED" : "partition unchanged"}`,
    );
    // When eligibility moved but the partition did not, print the pairs themselves: the reader can
    // then see WHICH rule absorbed it instead of taking the summary on trust. A pair that appears
    // only in arm B is a co-location the REPAIR created — the net-new-harm case for an in-range move.
    if (pairsA.join() !== pairsB.join()) {
      const onlyA = pairsA.filter((p) => !pairsB.includes(p));
      const onlyB = pairsB.filter((p) => !pairsA.includes(p));
      if (onlyA.length > 0) console.log(`                   as-cited only : ${onlyA.join("  ")}`);
      if (onlyB.length > 0)
        console.log(`                   REPAIR-CREATED: ${onlyB.join("  ")}  ← did not merge here`);
    }
  }
  const affectedTurns = new Set(misExact.map((m) => `${m.run}/${m.turn}`)).size;
  console.log(
    `\n      ${turnsChanged} of ${affectedTurns} affected turns change their cluster partition when the mis-anchors are repaired.`,
  );
  console.log(
    `      POWER: ${poweredTurns} of ${affectedTurns} affected turns ran 2+ reviewers, so a lost corroboration was`,
  );
  console.log(
    `      observable in ${poweredTurns === affectedTurns ? "all of them" : `only ${poweredTurns}`}. Read the region-eligible-pair column before concluding the`,
  );
  console.log(
    "      offsets are too small to matter: an unchanged pair count means they never crossed the",
  );
  console.log(
    "      window, while a changed one that leaves the partition intact means another rule absorbed it.",
  );

  console.log(
    "\n  (2) SIGNATURE IDENTITY — real computeSignature with the real enclosingSymbol, on the",
  );
  console.log("      reconstructed tree. A changed signature means the FP-ledger, the per-cycle");
  console.log(
    "      rejection suppression, the fix-verification pin and location-recurrence would",
  );
  console.log("      all see the repaired finding as a DIFFERENT finding.\n");
  let sigChanged = 0;
  for (const m of misExact) {
    const to = repairTarget.get(m) ?? m.finding.line_start;
    const abs = join(m.root, m.finding.file);
    const sigAt = async (line: number): Promise<string> => {
      const sym = await enclosingSymbol(abs, line).catch(() => null);
      return computeSignature({
        file: m.finding.file,
        ruleId: m.finding.rule_id,
        category: m.finding.category,
        lineStart: line,
        lineEnd: line,
        ...(sym ? { symbolName: sym.name, symbolStartLine: sym.startLine } : {}),
      });
    };
    const differs = (await sigAt(m.finding.line_start)) !== (await sigAt(to));
    if (differs) sigChanged++;
    console.log(
      `    ${m.run} t${String(m.turn).padEnd(2)} ${`${m.finding.file}:${m.finding.line_start}→${to}`.padEnd(26)} signature ${differs ? "CHANGES" : "unchanged"}  [${m.finding.rule_id}]`,
    );
  }
  console.log(
    `\n      ${sigChanged} of ${misExact.length} mis-anchors change signature when repaired.`,
  );

  if (VERBOSE) {
    console.log(`\n${"─".repeat(95)}\nEvery finding\n`);
    for (const s of all) {
      console.log(
        `  ${s.run} t${String(s.turn).padEnd(2)} ${s.reviewer.padEnd(20)} ${`${s.finding.file}:${s.finding.line_start}`.padEnd(26)} of ${String(s.fileLines ?? "?").padEnd(4)} ${s.outcome.padEnd(11)} ${s.exact ? "EXACT" : "UNVERIFIABLE"}`,
      );
    }
  }
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}
