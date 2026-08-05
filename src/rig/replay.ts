// src/rig/replay.ts
// `reviewgate rig replay` — a self-check of the HARNESS, never a counterfactual.
//
// WHAT THIS IS NOT, and why the plan's original shape could not be built.
//
// Task 5 Step 4 specified re-running the gate pipeline under `REVIEWGATE_CASSETTE=replay:…`
// with `ReplayAdapter` in strict mode, then asserting two RigResults match. That is not
// implementable against any run recorded so far, and the reason is worth writing down so
// nobody re-attempts it and concludes the cassette is broken:
//
//   * a pipeline re-run has to BUILD each reviewer prompt, which needs the diff the gate
//     reviewed at that iteration;
//   * the run recorded `.reviewgate/` snapshots and the cassette, and the cassette stores
//     only `promptSha256`, never the prompt text (deliberately — it is already a
//     secret-leak-at-rest surface);
//   * so the prompts strict mode compares against cannot be reconstructed, and strict mode
//     would report drift on every entry: a loud failure that means nothing.
//
// Per-turn `diff.patch` recording (driver, 2026-08-05) is the first half of closing that gap;
// a future run that also records per-ITERATION prompts could implement the literal spec.
//
// WHAT THIS IS: the acceptance test the aggregator refactor actually needs. That refactor
// must be behaviour-neutral, and "behaviour" here means the numbers a recorded run yields.
// Both paths this checks are PURE functions of on-disk artifacts — `harvest()` over the
// snapshots and `ablate()` over the harvested findings — so any difference across two runs
// is nondeterminism in our own code (Map/readdir ordering, a stray Date, a mutated input),
// which is exactly what would make a refactor's "no change" claim unfalsifiable.
import { existsSync, readFileSync } from "node:fs";
import { CassetteEntrySchema } from "../schemas/cassette.ts";
import type { RigResult } from "../schemas/rig-result.ts";
import { type RigAblation, SUPPRESSION_LAYERS, ablate, seededTagsFromScript } from "./ablate.ts";
import { harvest } from "./harvest.ts";

export interface CassetteIntegrity {
  entries: number;
  malformedLines: number;
  /** Recorded review/complete calls per reviewer key, in FIFO order of first appearance. */
  byKey: Record<string, number>;
  /** Recorded REVIEW calls that carried at least one finding. Not an integrity signal —
   *  a reviewer legitimately returns none — but it separates "40 calls recorded" from
   *  "40 calls recorded and every one of them was empty", which look identical in a count. */
  reviewsWithFindings: number;
}

export interface ReplayReport {
  deterministic: boolean;
  /** Human-readable differences; empty when deterministic. */
  differences: string[];
  cassette: CassetteIntegrity | null;
  turns: number;
}

/**
 * Fields that legitimately differ between two harvests of the same run. Everything else
 * differing is a defect. Kept as an explicit list rather than a "strip timestamps" regex so
 * that a NEW volatile field has to be added here consciously — a regex would silently
 * absorb a genuinely nondeterministic value that happens to look like a date.
 */
function stripVolatile(result: RigResult): unknown {
  const { provenance, ...rest } = result;
  const { harvested_at, ...provRest } = provenance;
  void harvested_at;
  return { ...rest, provenance: provRest };
}

/**
 * An ablation embeds two full RigResults (`lower`/`upper`), so it inherits their volatile
 * `harvested_at`. Comparing two ablations without stripping it reports NON-DETERMINISTIC
 * unconditionally — a check that always fails is exactly as worthless as one that always
 * passes, and this one did fail that way on first contact with the real pilot.
 */
function stripAblationVolatile(a: RigAblation): unknown {
  return { ...a, lower: stripVolatile(a.lower), upper: stripVolatile(a.upper) };
}

/** Stable-key JSON so key ORDER cannot masquerade as a value difference (or hide one). */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort());
    }
    return v;
  });
}

export function checkCassette(cassettePath: string): CassetteIntegrity {
  const raw = readFileSync(cassettePath, "utf8");
  const byKey: Record<string, number> = {};
  let entries = 0;
  let malformedLines = 0;
  let reviewsWithFindings = 0;
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let parsed: unknown;
    try {
      parsed = CassetteEntrySchema.parse(JSON.parse(t));
    } catch {
      malformedLines++;
      continue;
    }
    const e = parsed as { key: string; result?: unknown };
    entries++;
    byKey[e.key] = (byKey[e.key] ?? 0) + 1;
    // A malformed/empty body cannot reach here: the schema's result union has no member
    // that accepts `{}`, so such a line is counted as malformed above.
    const findings = (e.result as { findings?: unknown[] } | undefined)?.findings;
    if (Array.isArray(findings) && findings.length > 0) reviewsWithFindings++;
  }
  return { entries, malformedLines, byKey, reviewsWithFindings };
}

/**
 * Harvest the run twice and re-aggregate every suppression layer twice, then compare.
 *
 * Two harvests rather than one compared against a stored result.json: the stored file may
 * have been produced by a different binary, so a mismatch there would confuse "the harvester
 * changed" with "the harvester is nondeterministic". This asks only the second question.
 */
export function checkDeterminism(manifestPath: string, scriptPath: string): ReplayReport {
  const first = harvest(manifestPath, scriptPath);
  const second = harvest(manifestPath, scriptPath);
  const differences: string[] = [];

  if (canonical(stripVolatile(first)) !== canonical(stripVolatile(second))) {
    differences.push(
      "harvest(): two harvests of the same run produced different RigResults. The metrics are " +
        "not reproducible from the recorded artifacts, so no refactor can be shown to be " +
        "behaviour-neutral against them.",
    );
  }

  const seededTags = seededTagsFromScript(scriptPath);
  for (const layer of SUPPRESSION_LAYERS) {
    const a = stripAblationVolatile(ablate(first, layer, seededTags));
    const b = stripAblationVolatile(ablate(second, layer, seededTags));
    if (canonical(a) !== canonical(b)) {
      differences.push(
        `ablate(--layer ${layer}): re-aggregating the same findings twice produced different output. The counterfactual is a pure function of (result, layer) by contract; it is not.`,
      );
    }
  }

  return {
    deterministic: differences.length === 0,
    differences,
    cassette: null,
    turns: first.turns.length,
  };
}

export function renderReplayReport(r: ReplayReport): string {
  const lines: string[] = ["Reviewgate rig — replay self-check", ""];
  lines.push(`  turns harvested        : ${r.turns}`);
  lines.push(
    `  harvest + ablate       : ${r.deterministic ? "DETERMINISTIC (2 runs identical)" : "NON-DETERMINISTIC"}`,
  );
  if (r.cassette) {
    const c = r.cassette;
    const keys = Object.entries(c.byKey)
      .map(([k, n]) => `${k}×${n}`)
      .join(", ");
    lines.push(`  cassette entries       : ${c.entries} (${keys})`);
    lines.push(`  reviews carrying findings: ${c.reviewsWithFindings}`);
    if (c.malformedLines > 0) {
      lines.push(`  ⚠ malformed lines      : ${c.malformedLines} — the recording is incomplete`);
    }
  }
  if (!r.deterministic) {
    lines.push("", "Differences:");
    for (const d of r.differences) lines.push(`  · ${d}`);
  }
  lines.push(
    "",
    "This checks the HARNESS, not the gate: it re-derives the metrics from recorded artifacts",
    "twice and asserts they match. It is NOT a counterfactual and never re-drives the agent.",
    "A true pipeline replay additionally needs per-iteration reviewer prompts, which no run has",
    "recorded yet (the cassette stores only their SHA-256).",
  );
  return lines.join("\n");
}

export function replay(input: {
  manifestPath: string;
  scriptPath: string;
  cassettePath?: string | undefined;
}): ReplayReport {
  const report = checkDeterminism(input.manifestPath, input.scriptPath);
  if (input.cassettePath !== undefined) {
    if (!existsSync(input.cassettePath)) {
      throw new Error(
        `rig replay: no cassette at ${input.cassettePath}. A run recorded without one cannot be re-examined; omit --cassette to check determinism only.`,
      );
    }
    report.cassette = checkCassette(input.cassettePath);
  }
  return report;
}
