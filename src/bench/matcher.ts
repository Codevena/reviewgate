// reviewgate bench — finding ↔ expected-label classifier (spec §4).
//
// Pure and fully offline: given a case's expected/allowed labels, the diff's
// changed-hunk ranges, and the panel's findings, decide per finding whether it is
// a TP / FP / NEUTRAL and per label whether it is an FN. No I/O, no reviewers —
// this is the only genuinely novel logic in bench and the number that every
// headline metric depends on, so it lives behind its own test suite.

export type BenchSeverity = "CRITICAL" | "WARN" | "INFO";

/** The subset of a `Finding` the matcher needs; the runner (P1) adapts real Findings. */
export interface MatcherFinding {
  id: string;
  file: string;
  lineStart: number;
  lineEnd: number;
  severity: BenchSeverity;
  /** message + details, matched case-insensitively against label tags. */
  text: string;
}

export interface ExpectedLabel {
  /** One acceptable phrasing, or several (any-of): the finding matches the label's
   * tag test if it satisfies ANY alternative — reviewers phrase the same bug many
   * ways ("SQL injection" / "unsanitized query" / "string concatenation into SQL"). */
  tag: string | string[];
  file: string;
  line: number;
  minSeverity: BenchSeverity;
}

export interface AllowedEntry {
  tag: string | string[];
  file: string;
  line: number;
}

export interface HunkRange {
  file: string;
  start: number;
  end: number;
}

export interface MatchInput {
  kind: "seeded-bug" | "clean";
  expected: ExpectedLabel[];
  allowed: AllowedEntry[];
  strictRegion: boolean;
  changedHunks: HunkRange[];
  window: number;
  findings: MatcherFinding[];
  /** default false → only blocking (CRITICAL/WARN) findings are scored. */
  includeAdvisory?: boolean;
}

export type FindingOutcome = "TP" | "FP" | "NEUTRAL";

export interface FindingClassification {
  findingId: string;
  outcome: FindingOutcome;
  /** the expected-label index this finding was credited to (TP only), else null. */
  labelIndex: number | null;
  /** location XOR tag overlap with some label but not a full match — badged, not voided. */
  nearMiss: boolean;
  /** TP whose severity exceeds the label's min_severity. */
  severityOvershoot: boolean;
  /** human-readable rationale for `bench report --explain`. */
  reason: string;
}

export interface MatchResult {
  tp: number;
  fp: number;
  fn: number;
  neutral: number;
  /** indices of expected labels with no assigned finding. */
  fnLabels: number[];
  /** one entry per SCORED finding (advisory findings are excluded unless includeAdvisory). */
  findings: FindingClassification[];
}

const SEV_RANK: Record<BenchSeverity, number> = { CRITICAL: 2, WARN: 1, INFO: 0 };

function isBlocking(sev: BenchSeverity): boolean {
  return SEV_RANK[sev] >= SEV_RANK.WARN;
}

/** Tokenise a tag into lowercase alphanumeric words ("sql-injection" → ["sql","injection"]). */
function tokenizeTag(tag: string): string[] {
  return tag
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** One alternative matches when EVERY one of its tokens appears in the finding text. */
function oneTagMatch(hay: string, tag: string): { matched: boolean; overlap: number } {
  const tokens = tokenizeTag(tag);
  if (tokens.length === 0) return { matched: false, overlap: 0 };
  let overlap = 0;
  for (const t of tokens) if (hay.includes(t)) overlap++;
  return { matched: overlap === tokens.length, overlap };
}

/**
 * Any-of tag match: the label's `tag` may be one phrasing or several. The finding
 * matches if ANY alternative fully matches. `overlap` is the best token-overlap
 * across all alternatives (for the cost tie-break and near-miss detection), so a
 * partial overlap still surfaces even when no alternative fully matches.
 */
function tagMatch(text: string, tag: string | string[]): { matched: boolean; overlap: number } {
  const hay = text.toLowerCase();
  const alts = Array.isArray(tag) ? tag : [tag];
  let matched = false;
  let overlap = 0;
  for (const alt of alts) {
    const r = oneTagMatch(hay, alt);
    if (r.matched) matched = true;
    if (r.overlap > overlap) overlap = r.overlap;
  }
  return { matched, overlap };
}

/** Two closed intervals intersect. */
function intervalsIntersect(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

/** Finding's line range overlaps [line ± window] on the same file. */
function locationMatch(f: MatcherFinding, file: string, line: number, window: number): boolean {
  if (f.file !== file) return false;
  return intervalsIntersect(f.lineStart, f.lineEnd, line - window, line + window);
}

/** Distance from a finding's range to a target line (0 if the line is inside the range). */
function lineDistance(f: MatcherFinding, line: number): number {
  if (line >= f.lineStart && line <= f.lineEnd) return 0;
  return Math.min(Math.abs(f.lineStart - line), Math.abs(f.lineEnd - line));
}

/** Finding's line range intersects any changed hunk on its file. */
function inChangedRegion(f: MatcherFinding, hunks: HunkRange[]): boolean {
  return hunks.some(
    (h) => h.file === f.file && intervalsIntersect(f.lineStart, f.lineEnd, h.start, h.end),
  );
}

// A candidate (finding, label) pair satisfies all three tests; its cost tuple drives
// the tie-break among maximum-cardinality matchings.
type CostTuple = [lineDist: number, negOverlap: number, findingId: string];

function compareCost(a: CostTuple, b: CostTuple): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0;
}

function compareCostArrays(a: CostTuple[], b: CostTuple[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const ai = a[i];
    const bi = b[i];
    if (ai === undefined || bi === undefined) break;
    const c = compareCost(ai, bi);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

interface Pair {
  labelIndex: number;
  findingId: string;
  cost: CostTuple;
}

interface Solution {
  count: number;
  cost: CostTuple[]; // sorted ascending
  pairs: Pair[];
}

function sortedCost(pairs: Pair[]): CostTuple[] {
  return pairs.map((p) => p.cost).sort(compareCost);
}

/** Better = more labels matched; ties broken by lexicographically smaller sorted cost. */
function better(x: Solution, y: Solution): boolean {
  if (x.count !== y.count) return x.count > y.count;
  return compareCostArrays(x.cost, y.cost) < 0;
}

// Exhaustive recursion is O(F^L). At the 1–3 labels the spec targets this is
// nothing, but a malformed/hostile corpus case with many labels each matching many
// findings would blow up and hang. Above this many leaf paths we fall back to a
// bounded greedy assignment (min-cost-first) instead of enumerating.
const EXHAUSTIVE_SEARCH_CAP = 100_000;

function searchSpaceExceeds(candByLabel: Pair[][], cap: number): boolean {
  let product = 1;
  for (const cands of candByLabel) {
    product *= cands.length + 1; // +1 for the "leave this label unmatched" branch
    if (product > cap) return true;
  }
  return false;
}

/**
 * Bounded fallback that GUARANTEES a maximum-cardinality matching (Kuhn's
 * augmenting-path algorithm, O(L·E) — polynomial). Cardinality is what the metrics
 * depend on (TP/FP/FN counts are invariant to which max-cardinality matching is
 * chosen); the cost tie-break only reorders equivalent assignments, so we merely
 * bias it by processing each label's candidates cheapest-first for a deterministic
 * result. A plain min-cost-first greedy is NOT max-cardinality and would undercount
 * TPs (plan-gate iteration-4 finding) — do not reintroduce it.
 */
function maxCardinalityMatching(candByLabel: Pair[][]): Pair[] {
  const L = candByLabel.length;
  const adj = candByLabel.map((cands) => [...cands].sort((a, b) => compareCost(a.cost, b.cost)));
  const pairIndex = new Map<string, Pair>();
  for (const cands of candByLabel) {
    for (const p of cands) pairIndex.set(`${p.labelIndex}|${p.findingId}`, p);
  }

  const findingToLabel = new Map<string, number>();

  function augment(labelIdx: number, visited: Set<string>): boolean {
    for (const cand of adj[labelIdx] ?? []) {
      if (visited.has(cand.findingId)) continue;
      visited.add(cand.findingId);
      const owner = findingToLabel.get(cand.findingId);
      if (owner === undefined || augment(owner, visited)) {
        findingToLabel.set(cand.findingId, labelIdx);
        return true;
      }
    }
    return false;
  }

  // Deterministic label order: by cheapest available candidate, then index.
  const order = Array.from({ length: L }, (_, j) => j).sort((a, b) => {
    const ca = adj[a]?.[0]?.cost;
    const cb = adj[b]?.[0]?.cost;
    if (ca === undefined && cb === undefined) return a - b;
    if (ca === undefined) return 1;
    if (cb === undefined) return -1;
    const c = compareCost(ca, cb);
    return c !== 0 ? c : a - b;
  });
  for (const labelIdx of order) augment(labelIdx, new Set());

  const out: Pair[] = [];
  for (const [findingId, labelIdx] of findingToLabel) {
    const p = pairIndex.get(`${labelIdx}|${findingId}`);
    if (p) out.push(p);
  }
  return out;
}

/**
 * Lexicographically-optimal 1:1 assignment (spec §4): maximise cardinality first,
 * then minimise the sorted cost tuple. At the tiny per-case label counts this
 * targets, exhaustive recursion over labels is cheap and obviously correct; a
 * pathological input falls back to a bounded greedy assignment (never hangs).
 */
function optimalMatching(candByLabel: Pair[][]): Pair[] {
  if (searchSpaceExceeds(candByLabel, EXHAUSTIVE_SEARCH_CAP)) {
    return maxCardinalityMatching(candByLabel);
  }

  const L = candByLabel.length;
  let best: Solution = { count: 0, cost: [], pairs: [] };

  const used = new Set<string>();
  const chosen: Pair[] = [];

  function recurse(labelIdx: number): void {
    if (labelIdx === L) {
      const sol: Solution = { count: chosen.length, cost: sortedCost(chosen), pairs: [...chosen] };
      if (better(sol, best)) best = sol;
      return;
    }
    // Option 1: assign one of this label's still-available candidates.
    for (const cand of candByLabel[labelIdx] ?? []) {
      if (used.has(cand.findingId)) continue;
      used.add(cand.findingId);
      chosen.push(cand);
      recurse(labelIdx + 1);
      chosen.pop();
      used.delete(cand.findingId);
    }
    // Option 2: leave this label unmatched.
    recurse(labelIdx + 1);
  }

  recurse(0);
  return best.pairs;
}

export function matchCase(input: MatchInput): MatchResult {
  const { expected, allowed, strictRegion, changedHunks, window } = input;
  const includeAdvisory = input.includeAdvisory ?? false;

  const scored = input.findings.filter((f) => includeAdvisory || isBlocking(f.severity));

  // Build candidate pairs (all three tests) grouped by label.
  const candByLabel: Pair[][] = expected.map((label, j) => {
    const out: Pair[] = [];
    for (const f of scored) {
      const loc = locationMatch(f, label.file, label.line, window);
      if (!loc) continue;
      const tag = tagMatch(f.text, label.tag);
      if (!tag.matched) continue;
      if (SEV_RANK[f.severity] < SEV_RANK[label.minSeverity]) continue;
      out.push({
        labelIndex: j,
        findingId: f.id,
        cost: [lineDistance(f, label.line), -tag.overlap, f.id],
      });
    }
    return out;
  });

  const matching = optimalMatching(candByLabel);
  const findingToLabel = new Map<string, number>();
  const matchedLabels = new Set<number>();
  for (const p of matching) {
    findingToLabel.set(p.findingId, p.labelIndex);
    matchedLabels.add(p.labelIndex);
  }

  const classifications: FindingClassification[] = [];
  let tp = 0;
  let fp = 0;
  let neutral = 0;

  for (const f of scored) {
    // Does this finding have a partial (location OR tag) overlap with any label?
    const near = expected.some(
      (label) =>
        locationMatch(f, label.file, label.line, window) || tagMatch(f.text, label.tag).matched,
    );

    const labelIndex = findingToLabel.get(f.id);
    const matchedLabel = labelIndex !== undefined ? expected[labelIndex] : undefined;
    if (labelIndex !== undefined && matchedLabel !== undefined) {
      const label = matchedLabel;
      const overshoot = SEV_RANK[f.severity] > SEV_RANK[label.minSeverity];
      tp++;
      classifications.push({
        findingId: f.id,
        outcome: "TP",
        labelIndex,
        nearMiss: false,
        severityOvershoot: overshoot,
        reason: `matched label #${labelIndex} (${label.tag}) on location+tag+severity`,
      });
      continue;
    }

    // Not a TP. Known-incidental (allowed) → NEUTRAL.
    const isAllowed = allowed.some(
      (a) => locationMatch(f, a.file, a.line, window) && tagMatch(f.text, a.tag).matched,
    );
    if (isAllowed) {
      neutral++;
      classifications.push({
        findingId: f.id,
        outcome: "NEUTRAL",
        labelIndex: null,
        nearMiss: near,
        severityOvershoot: false,
        reason: "matched an `allowed` incidental — neutral",
      });
      continue;
    }

    // Region rules: under strict_region an out-of-region finding is NEUTRAL, not FP.
    const region = inChangedRegion(f, changedHunks);
    if (strictRegion && !region) {
      neutral++;
      classifications.push({
        findingId: f.id,
        outcome: "NEUTRAL",
        labelIndex: null,
        nearMiss: near,
        severityOvershoot: false,
        reason: "outside the changed hunks (strict_region) — neutral, not scored",
      });
      continue;
    }

    fp++;
    classifications.push({
      findingId: f.id,
      outcome: "FP",
      labelIndex: null,
      nearMiss: near,
      severityOvershoot: false,
      reason: near
        ? "unmatched blocking finding in-region with partial label overlap — FP (near_miss)"
        : "unmatched blocking finding in-region — FP",
    });
  }

  const fnLabels: number[] = [];
  for (let j = 0; j < expected.length; j++) if (!matchedLabels.has(j)) fnLabels.push(j);

  return {
    tp,
    fp,
    fn: fnLabels.length,
    neutral,
    fnLabels,
    findings: classifications,
  };
}
