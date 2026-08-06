// rig/scripts/lib/corpus.ts
//
// Shared read-only access to a rig run's archived artifacts, for the offline replay scripts.
//
// EXTRACTED from `anchor-replay.ts` when `critic-floor-replay.ts` needed the same cassette
// slicing and tree reconstruction. A second copy would have been a drift class with nothing
// guarding it — the same reason `normalizeLine`/`lineCount` became exports of `fact-check.ts`
// rather than being reimplemented here. The extraction is verified by anchor-replay's own four
// self-checks: they reproduce published numbers (ground truth, tiling, corpus size 44/24/27,
// agreement with attestEvidence) and abort the run otherwise, so a broken move cannot pass quietly.
//
// Everything here is READ-ONLY against `rig/results/` (gitignored, local to this machine) plus a
// caller-owned temp dir for reconstructed trees. No network, no quota, no rebuild.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import type { Finding } from "../../../src/schemas/finding.ts";

export interface TurnManifest {
  index: number;
  cassetteBytes: { before: number; after: number } | null;
  gateReviewed: boolean;
}

/** One raw reviewer finding, with the turn and panel run it came from. */
export interface Row {
  run: string;
  turn: number;
  reviewer: string;
  /** 0-based index of the panel run within the turn (the k-th call to THIS reviewer). */
  panelRun: number;
  finding: Finding;
}

/** `<run>/<turn>` → how many distinct reviewers RAN that turn (review entries in the cassette,
 *  whether or not they returned findings). This is the field's `reviewersTotal`, which
 *  `computeConsensus` divides by — counting only reviewers that produced findings would understate
 *  the panel and silently misreport how much power a consensus comparison had. */
export const reviewersRan = new Map<string, number>();

/** `<run>/<turn>/<panelRun>` → how many distinct reviewers RAN in that specific gate iteration.
 *  A turn can have several iterations with different panel sizes (a reviewer that returned nothing
 *  still ran), and `aggregate()` is called once per iteration — so a per-turn count is the wrong
 *  `reviewersTotal` whenever a turn re-reviewed. */
export const reviewersRanPerPanel = new Map<string, number>();

export function die(msg: string): never {
  console.error(`\nrig-replay: ABORT — ${msg}`);
  process.exit(1);
}

interface CassetteEntry {
  method: string;
  key: string;
  result?: { findings?: Finding[]; text?: string };
}

/**
 * Slice `cassette.jsonl` into per-turn entry lists using the driver's recorded byte offsets
 * (`driver.ts:331,361`).
 *
 * INTEGRITY 1 — the ranges must tile [0, filesize] with no gap and no overlap. A silent gap would
 * drop a turn's reviewers entirely and read downstream as "that turn found nothing".
 * INTEGRITY 2 — a torn line inside a range means the offsets are off by bytes. Skipping it would
 * quietly shrink the corpus, so it is fatal.
 */
export function sliceCassetteByTurn(run: string): { turn: number; entries: CassetteEntry[] }[] {
  const manifest = JSON.parse(readFileSync(`rig/results/${run}/manifest.json`, "utf8")) as {
    turns: TurnManifest[];
  };
  const buf = readFileSync(`rig/results/${run}/cassette.jsonl`);

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

  const out: { turn: number; entries: CassetteEntry[] }[] = [];
  for (const t of manifest.turns) {
    const cb = t.cassetteBytes;
    if (cb === null || cb.after <= cb.before) continue;
    const entries: CassetteEntry[] = [];
    for (const line of buf.subarray(cb.before, cb.after).toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as CassetteEntry);
      } catch {
        die(
          `${run} turn ${t.index}: a line inside the turn's byte range is not valid JSON — the slice boundaries are wrong.`,
        );
      }
    }
    out.push({ turn: t.index, entries });
  }
  return out;
}

export function readCorpus(run: string): { rows: Row[]; turnsWithFindings: Map<number, number> } {
  const rows: Row[] = [];
  const turnsWithFindings = new Map<number, number>();
  // IDEMPOTENCE. `reviewersRanPerPanel` ACCUMULATES (`+ 1` per review entry), so a second
  // readCorpus() for the same run would double every panel size. `aggregate()` divides by that to
  // label consensus, so the damage would be a silently wrong consensus everywhere — not a crash.
  // Dropping this run's keys first makes re-reading a no-op instead of a corruption. (`reviewersRan`
  // overwrites and is already idempotent; it is reset here too so both have one rule, not two.)
  for (const k of [...reviewersRan.keys()]) {
    if (k === run || k.startsWith(`${run}/`)) reviewersRan.delete(k);
  }
  for (const k of [...reviewersRanPerPanel.keys()]) {
    if (k === run || k.startsWith(`${run}/`)) reviewersRanPerPanel.delete(k);
  }
  for (const { turn, entries } of sliceCassetteByTurn(run)) {
    // Per-reviewer call counter: the k-th entry with a given key is that reviewer's k-th panel
    // run this turn. Keyed per reviewer because the panel runs CONCURRENTLY, so raw entry order
    // between the two reviewers is not stable and must not be read as sequence.
    const seen = new Map<string, number>();
    for (const entry of entries) {
      if (entry.method !== "review") continue;
      const k = seen.get(entry.key) ?? 0;
      seen.set(entry.key, k + 1);
      const panelKey = `${run}/${turn}/${k}`;
      reviewersRanPerPanel.set(panelKey, (reviewersRanPerPanel.get(panelKey) ?? 0) + 1);
      for (const finding of entry.result?.findings ?? []) {
        rows.push({ run, turn, reviewer: entry.key, panelRun: k, finding });
      }
    }
    if (seen.size > 0) {
      turnsWithFindings.set(turn, Math.max(...seen.values()));
      reviewersRan.set(`${run}/${turn}`, seen.size);
    }
  }
  return { rows, turnsWithFindings };
}

/** One recorded critic call, as RAW text. Parsing is left to the shipped `parseCriticOutput`
 *  (`src/core/critic.ts`) so the replay cannot disagree with the binary about what a critic
 *  response means — the same "import it, never reimplement it" rule the rest of this rig follows. */
export interface CriticCall {
  turn: number;
  /** 0-based index of this critic call within the turn (one per gate iteration that ran it). */
  callIndex: number;
  text: string;
}

/**
 * The critic's recorded completions, per turn. The critic is an `adapter.complete()` call (a judge
 * must be free-form — `review()` would force the review schema), so it lands in the cassette as
 * `method:"complete"`.
 *
 * A `complete` entry carrying no text is FATAL, not skipped: silently dropping a critic call would
 * understate how often the floor had an opportunity to fire, which is the quantity being measured.
 */
export function readCriticCalls(run: string): CriticCall[] {
  const out: CriticCall[] = [];
  for (const { turn, entries } of sliceCassetteByTurn(run)) {
    let callIndex = 0;
    for (const entry of entries) {
      if (entry.method !== "complete") continue;
      const text = entry.result?.text;
      if (typeof text !== "string") {
        die(`${run} turn ${turn}: a complete entry has no text — the critic record is unreadable.`);
      }
      out.push({ turn, callIndex, text });
      callIndex++;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Per-turn working tree. `turns/<T>/diff.patch` is the CUMULATIVE tree against the base commit
// (driver.ts:290), so applying it to an EMPTY repo reproduces it — no dependency on the
// /private/tmp sandboxes, which the handoff lists for reaping.
// ---------------------------------------------------------------------------------------------

/** Returns the paths DELETED in the reviewed diff, or null when the run recorded no diff.patch
 *  (pilot-01's line-count mode). Aborts if the patch exists but will not apply. */
export async function materialise(
  run: string,
  turn: number,
  root: string,
): Promise<Set<string> | null> {
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
// `diff.patch` is the tree at END of turn. A rig turn ends when the gate allows the stop, so the
// LAST iteration's tree IS the end-of-turn tree. If that last iteration ran the panel, then the
// last panel run saw exactly the reconstructed tree.
//
// The audit tree records every iteration: `run.complete` carries `iter` and `run_summary.source`,
// which is "panel" when reviewers ran and "skipped" when triage skipped them. It is APPEND-ONLY
// and each turn's snapshot is cumulative, so a turn's own events are the ones whose event hash is
// new against the previous turn's snapshot — the same multiset-delta discipline `harvest()`
// already applies to this tree.
// ---------------------------------------------------------------------------------------------

export interface TurnIterations {
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
        let j: {
          event?: string;
          iter?: number;
          run_id?: string;
          this_event_hash?: string;
          run_summary?: { source?: string };
        };
        try {
          j = JSON.parse(line);
        } catch {
          // Fatal, matching sliceCassetteByTurn's guard. A corrupt/truncated audit line silently
          // skipped would drop a `run.complete` event, which is what the panel-run cross-check and
          // every exactness label are computed from — the failure would surface as a quietly wrong
          // exactness count, not as an error. An unhandled throw here would instead surface as a raw
          // stack trace with no indication which file was bad.
          die(
            `audit log ${p} contains a line that is not valid JSON — iteration data is unusable.`,
          );
        }
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

export function turnIterations(run: string, turn: number): TurnIterations {
  const here = auditEvents(`rig/results/${run}/turns/${turn}/.reviewgate/audit`);
  const before = auditEvents(`rig/results/${run}/turns/${turn - 1}/.reviewgate/audit`);
  const mine = [...here].filter(([h]) => !before.has(h)).map(([, v]) => v);
  mine.sort((a, b) => a.runId.localeCompare(b.runId) || a.iter - b.iter);
  const sources = mine.map((m) => m.source);
  return { sources, lastRanPanel: sources.length > 0 && sources[sources.length - 1] === "panel" };
}

/** pilot-01 recorded no diff.patch. Per-turn line counts survive in research.md's changed-file
 *  rows; `+N/-0` IS the line count for a file created after the review base. Validated 26/26
 *  against reconstructed trees on pilots 02/03. */
export async function researchLineCounts(run: string, turn: number): Promise<Map<string, number>> {
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
