// src/rig/harvest.ts
// Per-turn snapshots → one `reviewgate.rig.result.v1`. This is where the rig stops
// collecting and starts measuring, so every definition it applies is written down next to
// the code that applies it.
//
// THREE PROPERTIES OF THE INPUT DRIVE THE WHOLE DESIGN. Each one has a way of producing a
// plausible-looking wrong number, which is worse than an error:
//
//  1. **The audit tree is CUMULATIVE across turns.** The driver copies the whole
//     `.reviewgate/` after each turn, and nothing wipes `audit/` — `handleReset` clears
//     state.json, decisions/ and pending.*, never the audit log. So turn 5's snapshot holds
//     turns 1–5's events. Counting a snapshot whole would make "iterations per turn" and
//     "cost per turn" rise monotonically with the turn index — a beautiful curve that is
//     purely an artifact of the snapshot layout. Every per-iteration fact here is therefore a
//     DELTA against the previous snapshot, computed as a multiset difference.
//
//  2. **`state.json` and `decisions/` are WIPED by the clean-PASS re-arm.** After a green
//     turn they read `iteration: 0`, empty stats and no decisions dir at all. Harvesting them
//     would report zero for exactly the turns that worked. The durable record is the
//     hash-chained audit log, read through the EXISTING validated loader (`loadAuditWindow`) —
//     never hand-parsed, so the −1-day partition guard for processes crossing UTC midnight is
//     not re-derived (and not re-derived wrongly).
//
//  3. **A finding signature is a SHA-256 and the audit log carries no finding text.** The
//     signature hashes [file, ruleId, category, symbol, offset], so neither the rule id nor
//     the message is recoverable from it, and recall (M3) cannot be computed from the audit
//     log at all. It is computed from the reports the driver archived DURING each turn
//     (`<turn>/reports/*-pending.json`), which is why that archiver is load-bearing rather
//     than redundant with the final `pending.json` (a turn that ends green overwrites the
//     report that caught the defect).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { platform, release } from "node:os";
import { dirname, join } from "node:path";
import { matchesAnyTag } from "../bench/matcher.ts";
import { makeMetric, summarizeSpread } from "../bench/metrics.ts";
import type { DecisionOutcome } from "../schemas/audit-event.ts";
import type { Metric } from "../schemas/bench-result.ts";
import type { Finding } from "../schemas/finding.ts";
import { NO_PANEL_REVIEWER_ID, PendingReportSchema } from "../schemas/pending-report.ts";
import { type RigManifest, RigManifestSchema } from "../schemas/rig-manifest.ts";
import {
  type RigResult,
  RigResultSchema,
  type RigSlope,
  type RigSuppressionCounts,
  type RigTurnRecord,
} from "../schemas/rig-result.ts";
import type { RigTurn } from "../schemas/rig-turn-script.ts";
import type { LoadedRun } from "../stats/load.ts";
import { loadAuditWindow } from "../stats/load.ts";
import { RG_VERSION } from "../version.ts";
import { loadTurnScript } from "./turn-script.ts";

/** Below this many defined FP-burden points the slope is not reported at all. */
const SLOPE_MIN_POINTS = 5;

interface PanelSlot {
  provider: string;
  model: string;
  persona: string;
}

/** Stable, order-independent serialization — the identity used for multiset deltas. */
function stableKey(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableKey).join(",")}]`;
  const rec = value as Record<string, unknown>;
  return `{${Object.keys(rec)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableKey(rec[k])}`)
    .join(",")}}`;
}

function countByKey(items: unknown[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const k = stableKey(item);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

/**
 * Multiset difference `current \ previous`, plus how many of `previous` are MISSING from
 * `current`.
 *
 * A multiset, not a set: two turns can legitimately produce byte-identical decision outcomes
 * (`finding_id` is iteration-local and explicitly "NOT a count/dedup key"), and a set-based
 * delta would credit the second occurrence to nobody. `missing > 0` means the append-only
 * assumption broke — a pruned day-partition, a truncated file, snapshots from two different
 * runs — and the caller refuses rather than reporting deltas that no longer mean "this turn".
 */
function multisetDelta<T>(current: T[], previous: T[]): { added: T[]; missing: number } {
  const prev = countByKey(previous);
  const added: T[] = [];
  for (const item of current) {
    const k = stableKey(item);
    const remaining = prev.get(k) ?? 0;
    if (remaining > 0) prev.set(k, remaining - 1);
    else added.push(item);
  }
  let missing = 0;
  for (const n of prev.values()) missing += n;
  return { added, missing };
}

/**
 * Where this turn's snapshot lives.
 *
 * The manifest-relative location wins over the absolute path recorded at run time: results
 * directories get moved and copied (that is what makes them citable artifacts), and the
 * artifact you point the harvester at is the artifact you mean. The recorded path is the
 * fallback, for a manifest read from somewhere other than its own run directory.
 */
function resolveSnapshotDir(manifestPath: string, recorded: string, index: number): string {
  const relative = join(dirname(manifestPath), "turns", String(index));
  if (existsSync(relative)) return relative;
  if (existsSync(recorded)) return recorded;
  throw new Error(
    `rig harvest: no snapshot directory for turn ${index} (tried ${relative} and the recorded ${recorded}). A missing snapshot reads downstream as "this turn had no iterations", so it is refused instead.`,
  );
}

/**
 * Every finding the gate showed the agent during a turn, deduped by SIGNATURE.
 *
 * The archiver captures each distinct version of `pending.json`, so a finding that survives
 * three iterations appears three times. Counting it three times would inflate the M2
 * denominator and M6, and would make "findings per turn" a function of how many rounds the
 * turn took. The signature is stable for the same finding across iterations, whereas the
 * `id` ("F-001") is iteration-local and collides across rounds — so signature is the key.
 *
 * A report that fails schema validation is WARNED about, not fatal: it may be an artifact
 * from an older release, and losing a whole (expensive) run's numbers to one unreadable file
 * is worse. The warning is what keeps a skipped report from silently understating recall.
 */
function collectTurnFindings(
  snapshotDir: string,
  turnIndex: number,
  warnings: string[],
): { findings: Finding[]; panel: PanelSlot[]; reportsRead: number } {
  const reportsDir = join(snapshotDir, "reports");
  const bySignature = new Map<string, Finding>();
  const panel = new Map<string, PanelSlot>();
  if (!existsSync(reportsDir)) return { findings: [], panel: [], reportsRead: 0 };

  const names = readdirSync(reportsDir)
    .filter((n) => n.endsWith("-pending.json"))
    // Numeric order (`2-` before `10-`), so a later iteration's copy of a finding wins.
    .sort((a, b) => (Number.parseInt(a, 10) || 0) - (Number.parseInt(b, 10) || 0));

  let reportsRead = 0;
  for (const name of names) {
    // JSON.parse inside the try, not just the schema check: the archiver writes atomically,
    // but a snapshot copied while a file was being renamed away can still land truncated, and
    // an unreadable byte in one report must not take down a whole run's numbers. Every skip
    // gets a warning — that is what stops a dropped report from quietly understating recall.
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(readFileSync(join(reportsDir, name), "utf8"));
    } catch (e) {
      warnings.push(
        `turn ${turnIndex}: archived report ${name} could not be read as JSON (${e instanceof Error ? e.message : String(e)}) and was SKIPPED — findings it carried are not counted, so recall and FP burden for this turn may be understated`,
      );
      continue;
    }
    const parsed = PendingReportSchema.safeParse(parsedJson);
    if (!parsed.success) {
      warnings.push(
        `turn ${turnIndex}: archived report ${name} did not validate against reviewgate.pending.v1 and was SKIPPED (findings it carried are not counted; recall may be understated)`,
      );
      continue;
    }
    reportsRead++;
    for (const f of parsed.data.findings) bySignature.set(f.signature, f);
    for (const r of parsed.data.reviewers) {
      // Skip the no-panel PLACEHOLDER row: it records that zero reviewers ran, not that one
      // did. Reports written before 2026-08-05 gave it a real provider id + model, so counting
      // it publishes a reviewer that never reviewed — pilot-01's provenance named codex on the
      // strength of one such row, in a study whose premise was that codex was absent. Filtered
      // on READ (not only fixed at the writer) so already-archived runs harvest honestly too.
      if (r.id === NO_PANEL_REVIEWER_ID) continue;
      panel.set(`${r.provider}|${r.model}|${r.persona}`, {
        provider: r.provider,
        model: r.model,
        persona: r.persona,
      });
    }
  }
  return { findings: [...bySignature.values()], panel: [...panel.values()], reportsRead };
}

function isBlocking(f: Finding): boolean {
  return f.severity === "CRITICAL" || f.severity === "WARN";
}

/**
 * The text a seeded label is matched against: `message + details`, exactly what
 * `bench/runner.ts` feeds its matcher. `rule_id` is deliberately NOT included — bench does
 * not include it, and a rig recall number that is measured on a wider haystack than bench's
 * is not comparable with bench's. Under-detecting is the conservative error here.
 */
function findingText(f: Finding): string {
  return `${f.message} ${f.details}`;
}

function countSuppression(findings: Finding[]): RigSuppressionCounts {
  let critic = 0;
  let reputation = 0;
  let fpLedger = 0;
  let lore = 0;
  for (const f of findings) {
    // "likely_fp" is the demote; a "keep" verdict means the critic looked and left it alone.
    if (f.critic_verdict === "likely_fp") critic++;
    if (f.reputation_demoted === true) reputation++;
    // `suppressed: false` on either match is badge-only (the finding stays blocking and the
    // agent is merely told a prior reject looked like this) — counting it would credit the
    // layer with a demotion it did not make.
    if (f.fp_ledger_match?.suppressed === true || f.fp_cluster_match?.suppressed === true) {
      fpLedger++;
    }
    // Additive, not a demote — see RigSuppressionCountsSchema.
    if (f.lore !== undefined) lore++;
  }
  return { critic, reputation, fp_ledger: fpLedger, lore };
}

/**
 * Ordinary least squares slope of y against x; null when x has no spread.
 *
 * `den === 0` is an EXACT test here, not a float-tolerance one (reviewer INFO, 2026-07-30):
 * x is always a set of distinct positive turn indices, so the denominator is an exact integer
 * sum of squares — it is 0 only in the degenerate single-point case, which the n < 2 guard has
 * already returned on. No epsilon is warranted; adding one would only hide a real degeneracy.
 */
function olsSlope(points: { x: number; y: number }[]): number | null {
  const n = points.length;
  if (n < 2) return null;
  const meanX = points.reduce((a, p) => a + p.x, 0) / n;
  const meanY = points.reduce((a, p) => a + p.y, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - meanX) * (p.y - meanY);
    den += (p.x - meanX) ** 2;
  }
  if (den === 0) return null;
  return num / den;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return (((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2) as number;
}

interface TurnHarvest {
  record: RigTurnRecord;
  /** blocking-finding texts, kept for the cross-turn escape-rate pass */
  blockingTexts: string[];
  seeded: RigTurn["seeded"];
}

/**
 * Did the seeded defect actually reach the code this turn?
 *
 * A turn script states an INTENTION. pilot-01 proved that is not the same as an outcome: turn
 * 9 directed a hardcoded API token, the agent declined and wrote `process.env.…`, and recall
 * — which only ever sees the gate's output — booked a reviewer miss plus the study's only
 * escape for a defect that never existed.
 *
 * Returns `null` for UNKNOWN in every case where the evidence is absent or unusable (clean
 * turn, no `landedPattern`, no recorded `diff.patch`, unparseable pattern), and warns for the
 * ones a script author can act on. Never guesses: an unverifiable seed keeps counting exactly
 * as it did before this check existed, because shipping a feature must not silently re-score
 * every run recorded before it.
 */
function checkSeedLanded(
  snapshotDir: string,
  index: number,
  seeded: RigTurn["seeded"],
  warnings: string[],
): boolean | null {
  if (seeded === null) return null;
  const pattern = seeded.landedPattern;
  if (pattern === undefined) return null;

  const patchPath = join(snapshotDir, "diff.patch");
  if (!existsSync(patchPath)) {
    warnings.push(
      `turn ${index}: seeded defect "${seeded.id}" declares a landedPattern but the turn has NO recorded diff (runs recorded before per-turn diff.patch capture, pilot-01 among them). Landing is UNKNOWN, and the turn stays in the recall/escape denominators — it is NOT assumed to have landed, nor assumed not to.`,
    );
    return null;
  }
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch {
    warnings.push(
      `turn ${index}: seeded defect "${seeded.id}" has a landedPattern that is not a valid regex (${pattern}). Landing is UNKNOWN and the turn stays in the denominators. Fix the script — a broken pattern must not silently drop a real seed.`,
    );
    return null;
  }
  let patch: string;
  try {
    patch = readFileSync(patchPath, "utf8");
  } catch {
    warnings.push(
      `turn ${index}: seeded defect "${seeded.id}" declares a landedPattern but diff.patch could not be read. Landing is UNKNOWN.`,
    );
    return null;
  }
  const landed = re.test(patch);
  if (!landed) {
    warnings.push(
      `turn ${index}: seeded defect "${seeded.id}" NEVER LANDED — the recorded diff does not match its landedPattern, so the agent did not write the defect the prompt directed (pilot-01 turn 9: it declined a hardcoded token and wrote the env-var version). EXCLUDED from the recall and escape denominators: there was nothing for the panel to catch, and counting it would charge the reviewer for the agent's judgment.`,
    );
  }
  return landed;
}

function harvestTurn(
  manifestPath: string,
  manifestTurn: RigManifest["turns"][number],
  scriptTurn: RigTurn,
  previousAudit: { runs: LoadedRun[]; decisions: DecisionOutcome[] },
  warnings: string[],
): {
  turn: TurnHarvest;
  cumulative: { runs: LoadedRun[]; decisions: DecisionOutcome[] };
  panel: PanelSlot[];
} {
  const index = manifestTurn.index;
  const snapshotDir = resolveSnapshotDir(manifestPath, manifestTurn.snapshotDir, index);

  // The shared loader, pointed at the snapshot: the driver lays each one out as a repo root
  // containing a literal `.reviewgate/` precisely so this works unchanged.
  const window = loadAuditWindow(snapshotDir, {});
  const cumulative = { runs: window.runs, decisions: window.decisions };

  const runDelta = multisetDelta(window.runs, previousAudit.runs);
  const decisionDelta = multisetDelta(window.decisions, previousAudit.decisions);
  if (runDelta.missing > 0 || decisionDelta.missing > 0) {
    throw new Error(
      `rig harvest: turn ${index}'s snapshot is MISSING ${runDelta.missing} run.complete and ${decisionDelta.missing} decision.applied event(s) that turn ${index - 1}'s snapshot contained. The audit log is append-only, so per-turn facts are deltas between consecutive snapshots; a shrinking log (pruned day-partition, truncated file, snapshots from two different runs) makes that attribution meaningless. Refusing to report numbers that cannot be traced to a turn.`,
    );
  }

  const { findings, panel, reportsRead } = collectTurnFindings(snapshotDir, index, warnings);
  const blocking = findings.filter(isBlocking);
  const iterations = runDelta.added.length;
  if (iterations === 0) {
    warnings.push(
      `turn ${index}: no run.complete audit events — the gate never reviewed this turn (an early allow-stop: clean probe, skipped triage, or a turn that made no reviewable change). Counted as 0 iterations and EXCLUDED from the M1/cost-per-turn samples, not averaged in as a zero.`,
    );
  }
  // The gate reviewed this turn but not one report survived: recall, M6 and the M2 denominator
  // for this turn are UNMEASURED, not zero. A PASS with genuinely no findings still archives a
  // report (with an empty findings array), so `reportsRead === 0` means the archiver caught
  // nothing at all — a 250ms poll that missed a short-lived file, or a lost snapshot — and a
  // turn that quietly contributes 0 findings to a denominator is the exact failure this rig is
  // built to avoid reporting.
  if (iterations > 0 && reportsRead === 0) {
    warnings.push(
      `turn ${index}: the gate ran ${iterations} iteration(s) but NO pending.json was archived — this turn's findings, recall and suppression counts are unmeasured, not zero. Treat its 0s as missing data.`,
    );
  }
  if (manifestTurn.agentExitCode !== 0) {
    warnings.push(
      `turn ${index}: the agent process exited with exit code ${manifestTurn.agentExitCode} — this turn's diff, and therefore every number derived from it, may be incomplete.`,
    );
  }

  // M2: `bucket === "fp"` IS "rejected with reviewer_was_wrong: true" — that is the literal
  // definition in `classifyDecision` (src/core/decision-outcome.ts): an accepted decision can
  // only bucket tp/declined, and a rejection buckets fp only when the flag is explicitly true.
  // Seeded turns end in a reject with the flag FALSE (the prompt directed the unsafe
  // construction, so the agent correctly declines to "fix" it), and those must not count as
  // FP burden — which is exactly what keying on the bucket gets right.
  const rejectedAsFp = decisionDelta.added.filter((d) => d.bucket === "fp").length;
  const findingsTotal = findings.length;
  const fpBurden = findingsTotal === 0 ? null : rejectedAsFp / findingsTotal;

  const seeded = scriptTurn.seeded;
  const blockingTexts = blocking.map(findingText);
  const caught = seeded === null ? null : blockingTexts.some((t) => matchesAnyTag(t, seeded.tags));
  const seedLanded = checkSeedLanded(snapshotDir, index, seeded, warnings);

  const record: RigTurnRecord = {
    index,
    seedLanded,
    seededId: seeded === null ? null : seeded.id,
    iterations,
    findingsTotal,
    blockingTotal: blocking.length,
    rejectedAsFp,
    fpBurden,
    caught,
    // Filled by the cross-turn pass below — it needs every turn's findings.
    escaped: seeded === null ? null : true,
    costUsd: runDelta.added.reduce((a, r) => a + r.summary.cost_usd, 0),
    durationMs: runDelta.added.reduce((a, r) => a + r.summary.duration_ms, 0),
    agentExitCode: manifestTurn.agentExitCode,
    wallMs: manifestTurn.wallMs,
    suppressed: countSuppression(findings),
    findings,
  };

  return { turn: { record, blockingTexts, seeded }, cumulative, panel };
}

export function harvest(manifestPath: string, scriptPath: string): RigResult {
  const manifest = RigManifestSchema.parse(
    JSON.parse(readFileSync(manifestPath, "utf8")) as unknown,
  );
  const script = loadTurnScript(scriptPath);
  if (manifest.scriptId !== script.id) {
    throw new Error(
      `rig harvest: the manifest was produced by turn script "${manifest.scriptId}" but "${scriptPath}" is "${script.id}". Ground truth (which turn seeded which defect) comes from the script, so harvesting one run against another script's labels would mislabel every seeded turn instead of failing.`,
    );
  }

  const warnings: string[] = [];
  const panelSlots: PanelSlot[] = [];
  const turns: TurnHarvest[] = [];
  let previous: { runs: LoadedRun[]; decisions: DecisionOutcome[] } = { runs: [], decisions: [] };

  // Ascending index: the delta chain is only meaningful in the order the turns ran.
  const ordered = [...manifest.turns].sort((a, b) => a.index - b.index);
  for (const manifestTurn of ordered) {
    const scriptTurn = script.turns.find((t) => t.index === manifestTurn.index);
    if (scriptTurn === undefined) {
      throw new Error(
        `rig harvest: the manifest has a turn ${manifestTurn.index} that "${scriptPath}" does not define. Without its label the turn has no ground truth, and silently dropping it would remove a seeded defect from the recall denominator.`,
      );
    }
    const { turn, cumulative, panel } = harvestTurn(
      manifestPath,
      manifestTurn,
      scriptTurn,
      previous,
      warnings,
    );
    turns.push(turn);
    panelSlots.push(...panel);
    previous = cumulative;
  }

  // M4 escape rate: a seeded defect escapes when it was never flagged in its own turn OR any
  // LATER harvested turn. Distinct from recall on purpose — a defect the gate catches two
  // turns late did not reach a commit unflagged, but it also was not caught when it was
  // introduced, and collapsing the two would hide a real latency in the loop.
  for (const [i, t] of turns.entries()) {
    if (t.seeded === null) continue;
    const tags = t.seeded.tags;
    const flaggedLater = turns
      .slice(i)
      .some((later) => later.blockingTexts.some((text) => matchesAnyTag(text, tags)));
    t.record.escaped = !flaggedLater;
  }

  // Seeds that provably never reached the code are excluded outright. A turn whose landing is
  // UNKNOWN (`null`) stays in — the pre-2026-08-05 behaviour — because "we could not check"
  // must not silently become "it did not happen".
  const seededTurns = turns.filter((t) => t.seeded !== null && t.record.seedLanded !== false);
  const recall: Metric = makeMetric(
    seededTurns.filter((t) => t.record.caught === true).length,
    // Denominator = seeded turns HARVESTED, never the script's total. A run capped at 3 turns
    // must not be scored against the defects it never got to.
    seededTurns.length,
  );
  const escapeRate: Metric = makeMetric(
    seededTurns.filter((t) => t.record.escaped === true).length,
    seededTurns.length,
  );

  const reviewed = turns.filter((t) => t.record.iterations > 0);
  const burdenPoints = turns
    .filter((t) => t.record.fpBurden !== null)
    .map((t) => ({ x: t.record.index, y: t.record.fpBurden as number }));
  const fpBurdenSlope: RigSlope = {
    slope: burdenPoints.length >= SLOPE_MIN_POINTS ? olsSlope(burdenPoints) : null,
    n: burdenPoints.length,
  };

  const suppression = turns.reduce<RigSuppressionCounts>(
    (acc, t) => ({
      critic: acc.critic + t.record.suppressed.critic,
      reputation: acc.reputation + t.record.suppressed.reputation,
      fp_ledger: acc.fp_ledger + t.record.suppressed.fp_ledger,
      lore: acc.lore + t.record.suppressed.lore,
    }),
    { critic: 0, reputation: 0, fp_ledger: 0, lore: 0 },
  );

  const panel = [...new Map(panelSlots.map((p) => [`${p.provider}|${p.model}|${p.persona}`, p]))]
    .map(([, p]) => p)
    .sort((a, b) =>
      `${a.provider}|${a.persona}` < `${b.provider}|${b.persona}`
        ? -1
        : `${a.provider}|${a.persona}` > `${b.provider}|${b.persona}`
          ? 1
          : 0,
    );
  if (panel.length < 2) {
    warnings.push(
      `panel had ${panel.length} distinct reviewer slot(s): with fewer than 2 providers, consensus, FP-ledger promotion and reputation-demote are INERT, so M6 and any ablation over those layers describe a system with half its suppression stack switched off.`,
    );
  }

  const result: RigResult = {
    schema: "reviewgate.rig.result.v1",
    runId: manifest.runId,
    provenance: {
      reviewgate_version: RG_VERSION,
      harvested_at: new Date().toISOString(),
      run_id: manifest.runId,
      script_id: script.id,
      script_path: scriptPath,
      manifest_path: manifestPath,
      turn_count: {
        harvested: turns.length,
        seeded: seededTurns.length,
        clean: turns.length - seededTurns.length,
        script_total: script.turns.length,
      },
      panel,
      host_os: `${platform()} ${release()}`,
    },
    turns: turns.map((t) => t.record),
    metrics: {
      iterations: {
        median: median(reviewed.map((t) => t.record.iterations)),
        // null for a turn the gate never reviewed, so `samples` reports how many turns the
        // median actually rests on (summarizeSpread drops nulls by design).
        spread: summarizeSpread(
          turns.map((t) => (t.record.iterations > 0 ? t.record.iterations : null)),
        ),
      },
      fpBurdenSlope,
      recall,
      escapeRate,
      cost: {
        totalUsd: turns.reduce((a, t) => a + t.record.costUsd, 0),
        totalDurationMs: turns.reduce((a, t) => a + t.record.durationMs, 0),
        perTurnUsd: summarizeSpread(
          turns.map((t) => (t.record.iterations > 0 ? t.record.costUsd : null)),
        ),
      },
      suppression,
    },
    warnings,
  };
  // Validate what we are about to hand out: the null contracts in RigTurnRecordSchema are the
  // measurement decisions, and an internally inconsistent result must never reach a write-up.
  return RigResultSchema.parse(result);
}
