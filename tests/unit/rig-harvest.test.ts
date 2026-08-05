import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { harvest } from "../../src/rig/harvest.ts";
import { NO_PANEL_REVIEWER_ID } from "../../src/schemas/pending-report.ts";

// ---------------------------------------------------------------------------
// Fixture builder.
//
// The harvester's whole job is to read what a real driver run leaves on disk, so the
// fixtures reproduce that layout faithfully — including the one property that makes the
// naive implementation wrong: **the per-turn audit snapshots are CUMULATIVE.** The driver
// copies the whole `.reviewgate/` after every turn and nothing ever wipes `audit/`
// (`handleReset` clears state.json / decisions / pending, never the audit tree), so turn 5's
// snapshot contains turns 1–5's events. A builder that wrote only the current turn's events
// would let a harvester that forgets to delta pass every test here.
// ---------------------------------------------------------------------------

type FxSeverity = "CRITICAL" | "WARN" | "INFO";

interface FxFinding {
  signature: string;
  severity?: FxSeverity;
  message?: string;
  details?: string;
  ruleId?: string;
  criticVerdict?: "keep" | "likely_fp";
  reputationDemoted?: boolean;
  fpLedgerSuppressed?: boolean;
  fpClusterSuppressed?: boolean;
  lore?: "reminder" | "canon-promotion";
}

interface FxIteration {
  costUsd?: number;
  durationMs?: number;
  critical?: number;
  warn?: number;
  info?: number;
}

interface FxDecision {
  bucket: "tp" | "fp" | "declined";
  severity?: FxSeverity;
  reviewerWasWrong?: boolean;
  findingId?: string;
}

interface FxTurn {
  seeded?: {
    id: string;
    tags: string[];
    severity: "critical" | "warn";
    landedPattern?: string;
  } | null;
  /** Written as `<snapshotDir>/diff.patch` — the code the agent actually wrote that turn. */
  diff?: string;
  /** one entry per gate iteration that reached the panel (→ one `run.complete` event) */
  iterations?: FxIteration[];
  decisions?: FxDecision[];
  /** one entry per archived `pending.json` version captured during the turn */
  reports?: FxFinding[][];
  /** parallel to `reports`: the `critic` object that version carried, if any */
  critics?: (FxCritic | undefined)[];
  /**
   * parallel to `reports`: the gate `iter` that version belongs to. Defaults to the version's
   * own index, i.e. one iteration per archived report. Set it explicitly to model the real
   * case the archiver produces: SEVERAL archived versions of the SAME iteration, because it
   * keys on the whole file's hash and a report rewritten for an unrelated reason is a new file.
   */
  reportIters?: number[];
  agentExitCode?: number;
}

interface FxCritic {
  provider: string;
  status: "ran" | "error" | "empty" | "misconfigured" | "skipped-budget";
  verdicts: number;
  demoted: number;
}

const BASE_MS = Date.UTC(2026, 6, 30, 9, 0, 0);

function ts(turnIndex: number, seq: number): string {
  return new Date(BASE_MS + turnIndex * 3_600_000 + seq * 60_000).toISOString();
}

function auditLine(turnIndex: number, seq: number, body: Record<string, unknown>): string {
  return JSON.stringify({
    schema: "reviewgate.audit.v1",
    ts: ts(turnIndex, seq),
    run_id: `session-${turnIndex}`,
    trigger: "stop-hook",
    prev_event_hash: "",
    this_event_hash: `h-${turnIndex}-${seq}`,
    ...body,
  });
}

/** The audit events a single turn contributes, as JSONL text. */
function turnAuditJsonl(turn: FxTurn, turnIndex: number): string {
  const lines: string[] = [];
  let seq = 0;
  for (const [i, it] of (turn.iterations ?? []).entries()) {
    lines.push(
      auditLine(turnIndex, seq++, {
        iter: i + 1,
        event: "run.complete",
        run_summary: {
          verdict: "FAIL",
          source: "panel",
          counts: { critical: it.critical ?? 0, warn: it.warn ?? 0, info: it.info ?? 0 },
          cost_usd: it.costUsd ?? 0,
          duration_ms: it.durationMs ?? 0,
          demoted: 0,
          signatures: [],
          providers: [],
        },
      }),
    );
  }
  for (const [i, d] of (turn.decisions ?? []).entries()) {
    lines.push(
      auditLine(turnIndex, seq++, {
        iter: 1,
        event: "decision.applied",
        decision_outcome: {
          finding_id: d.findingId ?? `F-00${i + 1}`,
          severity: d.severity ?? "CRITICAL",
          bucket: d.bucket,
          providers: ["openrouter"],
          ...(d.reviewerWasWrong === undefined ? {} : { reviewer_was_wrong: d.reviewerWasWrong }),
        },
      }),
    );
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function pendingReport(findings: FxFinding[], iter: number, critic?: FxCritic): string {
  return JSON.stringify({
    schema: "reviewgate.pending.v1",
    run_id: "session-x",
    iter,
    max_iter: 5,
    verdict: findings.length === 0 ? "PASS" : "FAIL",
    counts: {
      critical: findings.filter((f) => (f.severity ?? "CRITICAL") === "CRITICAL").length,
      warn: findings.filter((f) => f.severity === "WARN").length,
      info: findings.filter((f) => f.severity === "INFO").length,
    },
    reviewers: [
      {
        id: "openrouter:security",
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4.5",
        persona: "security",
        status: "ok",
        cost_usd: 0.01,
        duration_ms: 1000,
      },
    ],
    findings: findings.map((f, i) => ({
      id: `F-00${i + 1}`,
      signature: f.signature,
      severity: f.severity ?? "CRITICAL",
      category: "security",
      rule_id: f.ruleId ?? "generic-rule",
      file: "src/store.ts",
      line_start: 10,
      line_end: 12,
      message: f.message ?? "something is wrong",
      details: f.details ?? "details here",
      reviewer: {
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4.5",
        persona: "security",
      },
      confidence: 0.9,
      consensus: "singleton",
      ...(f.criticVerdict === undefined ? {} : { critic_verdict: f.criticVerdict }),
      ...(f.reputationDemoted === undefined ? {} : { reputation_demoted: f.reputationDemoted }),
      ...(f.fpLedgerSuppressed === undefined
        ? {}
        : {
            fp_ledger_match: {
              pattern_id: "p1",
              matched_count: 3,
              suppressed: f.fpLedgerSuppressed,
            },
          }),
      ...(f.fpClusterSuppressed === undefined
        ? {}
        : {
            fp_cluster_match: {
              cluster_key: "rule@src/store.ts",
              member_ids: ["e1"],
              suppressed: f.fpClusterSuppressed,
            },
          }),
      ...(f.lore === undefined ? {} : { lore: f.lore }),
    })),
    ...(critic === undefined ? {} : { critic }),
    cost_usd_total: 0.01,
    duration_ms_total: 1000,
    generated_at: ts(iter, 0),
    git: { sha: "abc1234", branch: "master", dirty_files: ["src/store.ts"] },
  });
}

interface Fixture {
  root: string;
  manifestPath: string;
  scriptPath: string;
}

function buildFixture(turns: FxTurn[], opts: { scriptId?: string } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "rg-harvest-"));
  const scriptId = opts.scriptId ?? "fx";
  const scriptPath = join(root, "script.json");
  writeFileSync(
    scriptPath,
    JSON.stringify({
      schema: "reviewgate.rig.turn-script.v1",
      id: scriptId,
      turns: turns.map((t, i) => ({
        index: i + 1,
        prompt: `turn ${i + 1}`,
        seeded: t.seeded ?? null,
      })),
    }),
  );

  const manifestTurns: unknown[] = [];
  for (const [i, turn] of turns.entries()) {
    const index = i + 1;
    const snapshotDir = join(root, "turns", String(index));
    const auditDay = join(snapshotDir, ".reviewgate", "audit", "2026", "07", "30");
    mkdirSync(auditDay, { recursive: true });
    // CUMULATIVE: this snapshot carries every earlier turn's audit file too, one file per
    // gate process, exactly as the live append-only tree does.
    for (let j = 0; j <= i; j++) {
      const jsonl = turnAuditJsonl(turns[j] as FxTurn, j + 1);
      if (jsonl.length > 0) writeFileSync(join(auditDay, `gate-${j + 1}.jsonl`), jsonl);
    }
    // Reports are archived into the turn's own dir by the driver, so they are already
    // per-turn and need no delta.
    const reports = turn.reports ?? [];
    if (reports.length > 0) {
      const reportDir = join(snapshotDir, "reports");
      mkdirSync(reportDir, { recursive: true });
      for (const [n, findings] of reports.entries()) {
        writeFileSync(
          join(reportDir, `${n + 1}-pending.json`),
          pendingReport(findings, turn.reportIters?.[n] ?? n + 1, turn.critics?.[n]),
        );
      }
    }
    if (turn.diff !== undefined) {
      writeFileSync(join(snapshotDir, "diff.patch"), turn.diff);
    }
    manifestTurns.push({
      index,
      snapshotDir,
      agentExitCode: turn.agentExitCode ?? 0,
      wallMs: 1234,
      ...(turn.diff === undefined ? {} : { diffBytes: Buffer.byteLength(turn.diff, "utf8") }),
    });
  }

  const manifestPath = join(root, "manifest.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      schema: "reviewgate.rig.manifest.v1",
      runId: `${scriptId}-2026-07-30T09-00-00-000Z`,
      scriptId,
      outDir: root,
      turns: manifestTurns,
    }),
  );
  return { root, manifestPath, scriptPath };
}

const TRAVERSAL_TAGS = ["path traversal", "directory traversal", "arbitrary file read"];

/**
 * The plan's canonical three-turn fixture:
 *   turn 1 — clean, 1 finding, rejected as reviewer_was_wrong  → burden 1.0
 *   turn 2 — seeded path-traversal with a matching blocking finding
 *   turn 3 — clean, ZERO findings (the desired outcome)         → burden null, NOT 0
 */
function canonicalFixture(): Fixture {
  return buildFixture([
    {
      seeded: null,
      iterations: [{ costUsd: 0.02, durationMs: 5000, warn: 1 }],
      decisions: [{ bucket: "fp", reviewerWasWrong: true, severity: "WARN" }],
      reports: [[{ signature: "sig-a", severity: "WARN", message: "prefer a Map here" }]],
    },
    {
      seeded: { id: "path-traversal", tags: TRAVERSAL_TAGS, severity: "critical" },
      iterations: [
        { costUsd: 0.03, durationMs: 6000, critical: 1 },
        { costUsd: 0.03, warn: 0 },
      ],
      decisions: [{ bucket: "declined", reviewerWasWrong: false }],
      reports: [
        [
          {
            signature: "sig-b",
            severity: "CRITICAL",
            message: "Path traversal in readTemplate",
            details: "the name is joined without normalisation",
          },
        ],
      ],
    },
    {
      seeded: null,
      iterations: [{ costUsd: 0.01, durationMs: 4000 }],
      reports: [[]],
    },
  ]);
}

describe("rig harvest", () => {
  test("clean turns contribute to FP burden but not to recall", () => {
    const fx = canonicalFixture();
    const result = harvest(fx.manifestPath, fx.scriptPath);

    expect(result.turns[0]?.caught).toBeNull();
    expect(result.turns[0]?.fpBurden).toBe(1);
    expect(result.metrics.recall.num).toBe(1);
    expect(result.metrics.recall.den).toBe(1); // NOT 3 — clean turns must not count
  });

  test("a zero-finding turn yields a null FP burden, never NaN and never 0", () => {
    const fx = canonicalFixture();
    const result = harvest(fx.manifestPath, fx.scriptPath);

    expect(result.turns[2]?.fpBurden).toBeNull();
    expect(Number.isNaN(result.turns[2]?.fpBurden as unknown as number)).toBe(false);
    expect(result.turns[2]?.findingsTotal).toBe(0);
  });

  test("the slope ignores null points and refuses to report below 5 of them", () => {
    const fx = canonicalFixture();
    const result = harvest(fx.manifestPath, fx.scriptPath);

    // 2 non-null points in this fixture (turns 1 and 2) → below the n>=5 floor
    expect(result.metrics.fpBurdenSlope).toEqual({ slope: null, n: 2 });
  });

  // pilot-02 (2026-08-05): `suppression.critic` counts DEMOTIONS, so a critic that ran and
  // returned `keep` for everything scores 0 there — and so does a critic that was never
  // configured. Those are categorically different facts and the harvest must not publish the
  // same number for both. `criticRuns` records the INVOCATION.
  test("criticRuns records that the critic ran, which the demotion count cannot show", () => {
    const { manifestPath, scriptPath } = buildFixture([
      {
        // Critic RAN and kept everything: demoted 0, so suppression.critic is 0 too.
        reports: [[{ signature: "sig-a", severity: "WARN", message: "a finding" }]],
        critics: [{ provider: "openrouter", status: "ran", verdicts: 4, demoted: 0 }],
      },
      {
        // pilot-01's shape: findings, but no critic key at all.
        reports: [[{ signature: "sig-b", severity: "WARN", message: "another finding" }]],
      },
    ]);
    const r = harvest(manifestPath, scriptPath);

    expect(r.turns[0]?.criticRuns).toHaveLength(1);
    expect(r.turns[0]?.criticRuns?.[0]?.status).toBe("ran");
    expect(r.turns[0]?.criticRuns?.[0]?.verdicts).toBe(4);
    // Turn 2 has findings but never invoked a critic.
    expect(r.turns[1]?.criticRuns ?? []).toHaveLength(0);
    // The distinction the demotion count CANNOT make: identical (0) on both turns.
    expect(r.turns[0]?.suppressed.critic).toBe(0);
    expect(r.turns[1]?.suppressed.critic).toBe(0);
  });

  test("criticRuns dedupes one invocation repeated across archived report versions", () => {
    const same = { provider: "openrouter", status: "ran" as const, verdicts: 2, demoted: 1 };
    const { manifestPath, scriptPath } = buildFixture([
      {
        // ONE iteration, TWO archived versions of it — the archiver keys on the whole file
        // hash, so a pending.json rewritten for an unrelated reason is a second file carrying
        // the same `critic` object.
        reports: [
          [{ signature: "sig-a", severity: "WARN", message: "one" }],
          [{ signature: "sig-b", severity: "WARN", message: "two" }],
        ],
        reportIters: [1, 1],
        critics: [same, same],
      },
    ]);
    const r = harvest(manifestPath, scriptPath);
    expect(r.turns[0]?.criticRuns).toHaveLength(1);
  });

  // The complementary half, and the reason the key is `run_id:iter` rather than a hash of the
  // critic object: two SEPARATE invocations can legitimately report identical counts (two
  // rounds that each judged 2 findings and demoted 1). A content-keyed dedupe would silently
  // collapse them into one and under-report how often the critic ran.
  test("criticRuns keeps two distinct iterations that reported identical counts", () => {
    const same = { provider: "openrouter", status: "ran" as const, verdicts: 2, demoted: 1 };
    const { manifestPath, scriptPath } = buildFixture([
      {
        reports: [
          [{ signature: "sig-a", severity: "WARN", message: "one" }],
          [{ signature: "sig-b", severity: "WARN", message: "two" }],
        ],
        reportIters: [1, 2],
        critics: [same, same],
      },
    ]);
    const r = harvest(manifestPath, scriptPath);
    expect(r.turns[0]?.criticRuns).toHaveLength(2);
  });

  test("reports the slope once 5 non-null points exist, and it falls when FP burden falls", () => {
    // Burden per turn: 3/3, 2/3, 2/3, 1/3, 0/3 → a clear downward slope.
    const rejects = [3, 2, 2, 1, 0];
    const fx = buildFixture(
      rejects.map((r) => ({
        seeded: null,
        iterations: [{ critical: 3 }],
        decisions: Array.from({ length: r }, () => ({
          bucket: "fp" as const,
          reviewerWasWrong: true,
        })),
        reports: [
          [
            { signature: "s1", message: "a" },
            { signature: "s2", message: "b" },
            { signature: "s3", message: "c" },
          ],
        ],
      })),
    );
    const result = harvest(fx.manifestPath, fx.scriptPath);

    expect(result.metrics.fpBurdenSlope.n).toBe(5);
    expect(result.metrics.fpBurdenSlope.slope).toBeLessThan(0);
  });

  test("per-turn facts are DELTAS: a cumulative audit tree must not inflate later turns", () => {
    const fx = buildFixture([
      { seeded: null, iterations: [{ costUsd: 0.01 }], reports: [[{ signature: "s1" }]] },
      {
        seeded: null,
        iterations: [{ costUsd: 0.02 }, { costUsd: 0.02 }],
        decisions: [{ bucket: "fp", reviewerWasWrong: true }],
        reports: [[{ signature: "s2" }]],
      },
    ]);
    const result = harvest(fx.manifestPath, fx.scriptPath);

    // Turn 2's snapshot contains turn 1's events as well. Counting the snapshot whole
    // would report 3 iterations and $0.05 for turn 2.
    expect(result.turns[0]?.iterations).toBe(1);
    expect(result.turns[1]?.iterations).toBe(2);
    expect(result.turns[1]?.costUsd).toBeCloseTo(0.04, 10);
    // The FP decision belongs to turn 2 alone.
    expect(result.turns[0]?.rejectedAsFp).toBe(0);
    expect(result.turns[1]?.rejectedAsFp).toBe(1);
  });

  test("identical decisions in two turns are attributed one per turn, not folded together", () => {
    // Same finding_id, severity, bucket and providers in both turns: only multiset
    // counting gets this right; a Set-based delta would credit turn 2 with zero.
    const decisions: FxDecision[] = [
      { bucket: "fp", reviewerWasWrong: true, findingId: "F-001", severity: "CRITICAL" },
    ];
    const fx = buildFixture([
      { seeded: null, iterations: [{}], decisions, reports: [[{ signature: "s1" }]] },
      { seeded: null, iterations: [{}], decisions, reports: [[{ signature: "s2" }]] },
    ]);
    const result = harvest(fx.manifestPath, fx.scriptPath);

    expect(result.turns[0]?.rejectedAsFp).toBe(1);
    expect(result.turns[1]?.rejectedAsFp).toBe(1);
  });

  test("throws when a later snapshot LOST audit events the previous one had", () => {
    const fx = buildFixture([
      { seeded: null, iterations: [{}, {}], reports: [[{ signature: "s1" }]] },
      { seeded: null, iterations: [{}], reports: [[{ signature: "s2" }]] },
    ]);
    // Simulate a pruned/truncated audit tree: turn 2's snapshot drops turn 1's file.
    writeFileSync(
      join(fx.root, "turns", "2", ".reviewgate", "audit", "2026", "07", "30", "gate-1.jsonl"),
      "",
    );
    expect(() => harvest(fx.manifestPath, fx.scriptPath)).toThrow(/append-only/i);
  });

  test("findings recurring across a turn's iterations are counted once, by signature", () => {
    const fx = buildFixture([
      {
        seeded: null,
        iterations: [{ critical: 1 }, { critical: 1 }],
        reports: [
          [{ signature: "same", message: "unparameterised query" }],
          [{ signature: "same", message: "unparameterised query" }],
        ],
      },
    ]);
    const result = harvest(fx.manifestPath, fx.scriptPath);

    expect(result.turns[0]?.findingsTotal).toBe(1);
    expect(result.turns[0]?.blockingTotal).toBe(1);
  });

  test("only blocking findings can catch a seeded defect", () => {
    const fx = buildFixture([
      {
        seeded: { id: "sql-injection", tags: ["sql injection"], severity: "critical" },
        iterations: [{ info: 1 }],
        reports: [[{ signature: "s1", severity: "INFO", message: "possible SQL injection" }]],
      },
    ]);
    const result = harvest(fx.manifestPath, fx.scriptPath);

    expect(result.turns[0]?.caught).toBe(false);
    expect(result.metrics.recall.num).toBe(0);
    expect(result.metrics.recall.den).toBe(1);
  });

  test("escape rate credits a catch in a LATER turn; recall does not", () => {
    const fx = buildFixture([
      {
        // seeded on turn 1, missed on turn 1
        seeded: {
          id: "missing-await",
          tags: ["missing await", "floating promise"],
          severity: "warn",
        },
        iterations: [{}],
        reports: [[{ signature: "s1", severity: "WARN", message: "prefer const" }]],
      },
      {
        seeded: null,
        iterations: [{}],
        reports: [[{ signature: "s2", severity: "WARN", message: "missing await on syncOne" }]],
      },
    ]);
    const result = harvest(fx.manifestPath, fx.scriptPath);

    expect(result.turns[0]?.caught).toBe(false); // not caught in its OWN turn
    expect(result.turns[0]?.escaped).toBe(false); // but flagged later → did not escape
    expect(result.metrics.recall.num).toBe(0);
    expect(result.metrics.escapeRate.num).toBe(0);
    expect(result.metrics.escapeRate.den).toBe(1);
  });

  test("a defect never flagged in any turn escapes", () => {
    const fx = buildFixture([
      {
        seeded: { id: "hardcoded-secret", tags: ["hardcoded secret"], severity: "critical" },
        iterations: [{}],
        reports: [[{ signature: "s1", message: "unused import" }]],
      },
      { seeded: null, iterations: [{}], reports: [[]] },
    ]);
    const result = harvest(fx.manifestPath, fx.scriptPath);

    expect(result.turns[0]?.escaped).toBe(true);
    expect(result.metrics.escapeRate.num).toBe(1);
    expect(result.metrics.escapeRate.value).toBe(1);
  });

  test("counts suppression provenance per layer", () => {
    const fx = buildFixture([
      {
        seeded: null,
        iterations: [{ info: 4 }],
        reports: [
          [
            { signature: "s1", criticVerdict: "likely_fp" },
            { signature: "s2", criticVerdict: "keep" }, // kept — not a demotion
            { signature: "s3", reputationDemoted: true },
            { signature: "s4", fpLedgerSuppressed: true },
            { signature: "s5", fpLedgerSuppressed: false }, // badge only — not suppressed
            { signature: "s6", fpClusterSuppressed: true },
            { signature: "s7", severity: "INFO", lore: "reminder" },
          ],
        ],
      },
    ]);
    const result = harvest(fx.manifestPath, fx.scriptPath);

    expect(result.turns[0]?.suppressed).toEqual({
      critic: 1,
      reputation: 1,
      fp_ledger: 2, // ledger + cluster, both suppressed
      lore: 1,
    });
    expect(result.metrics.suppression).toEqual({
      critic: 1,
      reputation: 1,
      fp_ledger: 2,
      lore: 1,
    });
  });

  test("a turn where the gate never ran is a warning, not a silent zero", () => {
    const fx = buildFixture([
      { seeded: null, iterations: [{ costUsd: 0.02 }], reports: [[{ signature: "s1" }]] },
      { seeded: null, iterations: [], reports: [] }, // docs-only turn: no run.complete at all
    ]);
    const result = harvest(fx.manifestPath, fx.scriptPath);

    expect(result.turns[1]?.iterations).toBe(0);
    expect(result.warnings.some((w) => w.includes("turn 2") && /no run\.complete/i.test(w))).toBe(
      true,
    );
    // M1 is measured over turns the gate actually reviewed — one sample, not two.
    expect(result.metrics.iterations.spread.samples).toBe(1);
    expect(result.metrics.iterations.median).toBe(1);
  });

  test("a reviewed turn with no archived report is flagged as unmeasured, not zero", () => {
    // The gate ran, but the archiver caught nothing — its 0 findings are missing data.
    const fx = buildFixture([{ seeded: null, iterations: [{ critical: 1 }], reports: [] }]);
    const result = harvest(fx.manifestPath, fx.scriptPath);

    expect(result.turns[0]?.iterations).toBe(1);
    expect(result.turns[0]?.findingsTotal).toBe(0);
    expect(
      result.warnings.some((w) => /NO pending\.json was archived/.test(w) && w.includes("turn 1")),
    ).toBe(true);
  });

  test("an unreadable archived report is warned about, not fatal", () => {
    const fx = buildFixture([
      {
        seeded: null,
        iterations: [{ critical: 1 }],
        reports: [[{ signature: "s1", message: "path traversal" }]],
      },
    ]);
    // A snapshot copied mid-rename can land truncated.
    writeFileSync(join(fx.root, "turns", "1", "reports", "2-pending.json"), '{"schema":"reviewg');
    const result = harvest(fx.manifestPath, fx.scriptPath);

    expect(result.turns[0]?.findingsTotal).toBe(1); // the readable report still counts
    expect(result.warnings.some((w) => /could not be read as JSON/.test(w))).toBe(true);
  });

  test("a non-zero agent exit code gets its own warning line", () => {
    const fx = buildFixture([
      { seeded: null, iterations: [{}], reports: [[{ signature: "s1" }]], agentExitCode: 1 },
    ]);
    const result = harvest(fx.manifestPath, fx.scriptPath);

    expect(result.warnings.some((w) => /exit code 1/.test(w))).toBe(true);
  });

  test("recall is scored against the seeded turns that were actually HARVESTED", () => {
    // A run stopped after turn 1 (maxTurns) must not be scored against turn 2's defect.
    const fx = buildFixture([
      {
        seeded: { id: "path-traversal", tags: TRAVERSAL_TAGS, severity: "critical" },
        iterations: [{}],
        reports: [[{ signature: "s1", message: "path traversal in readTemplate" }]],
      },
      { seeded: { id: "sql-injection", tags: ["sql injection"], severity: "critical" } },
    ]);
    // Drop turn 2 from the manifest, as a maxTurns-limited run would.
    const manifest = JSON.parse(readFileSync(fx.manifestPath, "utf8")) as Record<string, unknown>;
    manifest.turns = (manifest.turns as unknown[]).slice(0, 1);
    writeFileSync(fx.manifestPath, JSON.stringify(manifest));

    const result = harvest(fx.manifestPath, fx.scriptPath);
    expect(result.metrics.recall.den).toBe(1);
    expect(result.metrics.recall.value).toBe(1);
  });

  test("refuses a manifest harvested against a DIFFERENT turn script", () => {
    const fx = buildFixture([{ seeded: null, iterations: [{}] }], { scriptId: "fx" });
    const other = buildFixture([{ seeded: null, iterations: [{}] }], { scriptId: "other" });
    expect(() => harvest(fx.manifestPath, other.scriptPath)).toThrow(/script/i);
  });

  test("refuses a malformed manifest instead of harvesting a partial shape", () => {
    const root = mkdtempSync(join(tmpdir(), "rg-harvest-bad-"));
    const manifestPath = join(root, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify({ schema: "nope", turns: "not an array" }));
    const fx = buildFixture([{ seeded: null, iterations: [{}] }]);
    expect(() => harvest(manifestPath, fx.scriptPath)).toThrow();
  });

  test("harvests a snapshot dir that MOVED with its manifest", () => {
    const fx = canonicalFixture();
    // Rewrite the recorded absolute snapshotDirs to a path that no longer exists — the
    // artifact you point at is the artifact you mean.
    const manifest = JSON.parse(readFileSync(fx.manifestPath, "utf8")) as {
      turns: { snapshotDir: string }[];
    };
    for (const t of manifest.turns) t.snapshotDir = join("/nonexistent/old-run", "x");
    writeFileSync(fx.manifestPath, JSON.stringify(manifest));

    const result = harvest(fx.manifestPath, fx.scriptPath);
    expect(result.turns).toHaveLength(3);
    expect(result.metrics.recall.den).toBe(1);
  });

  test("the harvested result validates against RigResultSchema", async () => {
    const { RigResultSchema } = await import("../../src/schemas/rig-result.ts");
    const fx = canonicalFixture();
    const result = harvest(fx.manifestPath, fx.scriptPath);
    expect(() => RigResultSchema.parse(result)).not.toThrow();
  });

  test("provenance names the panel it was measured on", () => {
    const fx = canonicalFixture();
    const result = harvest(fx.manifestPath, fx.scriptPath);

    expect(result.provenance.panel).toEqual([
      { provider: "openrouter", model: "anthropic/claude-sonnet-4.5", persona: "security" },
    ]);
    expect(result.provenance.turn_count).toEqual({
      harvested: 3,
      seeded: 1,
      clean: 2,
      script_total: 3,
    });
  });

  test("a seed the agent never wrote is EXCLUDED from recall, not charged to the reviewer", () => {
    // pilot-01 turn 9, encoded. The prompt directed a hardcoded API token; the agent declined
    // and wrote the env-var version. Nothing was there to catch — yet recall counted the turn
    // as a miss and M4 as the run's only escape. A prompt is an instruction, not evidence.
    const fx = buildFixture([
      {
        seeded: {
          id: "hardcoded-secret",
          tags: ["hardcoded secret"],
          severity: "critical",
          // Matches the DEFECT (a literal), not the topic: `API_TOKEN` alone would match the
          // safe version too and prove nothing.
          landedPattern: "API_TOKEN\\s*=\\s*['\"][A-Za-z0-9]{8,}",
        },
        diff: "+const API_TOKEN = process.env.REPORT_API_TOKEN\n",
        iterations: [{ costUsd: 0.01 }],
        reports: [[{ signature: "sig-x", message: "unrelated nit" }]],
      },
      {
        seeded: {
          id: "path-traversal",
          tags: TRAVERSAL_TAGS,
          severity: "critical",
          landedPattern: "readFileSync",
        },
        diff: "+  return readFileSync(join(dir, name), 'utf8')\n",
        iterations: [{ costUsd: 0.01 }],
        reports: [[{ signature: "sig-y", message: "Path traversal in readTemplate" }]],
      },
    ]);

    const result = harvest(fx.manifestPath, fx.scriptPath);

    expect(result.turns[0]?.seedLanded).toBe(false);
    expect(result.turns[1]?.seedLanded).toBe(true);
    // The unlanded turn leaves the denominator entirely — 1/1, not 1/2.
    expect(result.metrics.recall.num).toBe(1);
    expect(result.metrics.recall.den).toBe(1);
    expect(result.metrics.escapeRate.den).toBe(1);
    // …and it must say so out loud, or the shrunken denominator is indistinguishable from a
    // run that simply seeded fewer defects.
    expect(result.warnings.join(" ")).toMatch(/hardcoded-secret/);
    expect(result.warnings.join(" ")).toMatch(/never landed|did not land/i);
  });

  test("a defect only in REMOVED or context lines has not landed — the agent must have written it", () => {
    // Whole-patch matching would call this landed: the text is right there in the diff. But a
    // removed line is the defect being DELETED, and a context line is code the agent never
    // touched. Either would credit the seed to a turn that did not introduce it.
    const fx = buildFixture([
      {
        seeded: {
          id: "path-traversal",
          tags: TRAVERSAL_TAGS,
          severity: "critical",
          landedPattern: "readFileSync\\(",
        },
        diff: [
          "--- a/src/store.ts",
          "+++ b/src/store.ts",
          "-  return readFileSync(`./templates/${name}`, 'utf8')", // removed: the defect is GONE
          "   const other = readFileSync(safePath)", // context: untouched code
          "+  return readTemplateSafely(name)",
        ].join("\n"),
        iterations: [{ costUsd: 0.01 }],
        reports: [[{ signature: "sig-y", message: "Path traversal in readTemplate" }]],
      },
    ]);
    const result = harvest(fx.manifestPath, fx.scriptPath);
    expect(result.turns[0]?.seedLanded).toBe(false);
  });

  test("a seeded turn with NO landedPattern warns, so an unverified seed is never silent", () => {
    // The schema's JSDoc promised this warning; the first implementation returned silently and
    // a reviewer caught the mismatch (gate F-005).
    const fx = buildFixture([
      {
        seeded: { id: "path-traversal", tags: TRAVERSAL_TAGS, severity: "critical" },
        diff: "+  readFileSync(x)\n",
        iterations: [{ costUsd: 0.01 }],
        reports: [[{ signature: "sig-y", message: "Path traversal in readTemplate" }]],
      },
    ]);
    const result = harvest(fx.manifestPath, fx.scriptPath);
    expect(result.warnings.join(" ")).toMatch(/NO landedPattern/);
  });

  test("without a landedPattern the turn still counts, and landing is UNKNOWN not false", () => {
    // Fail-safe default: shipping this feature must not silently re-score every existing
    // script by dropping seeds nobody can verify.
    const fx = buildFixture([
      {
        seeded: { id: "path-traversal", tags: TRAVERSAL_TAGS, severity: "critical" },
        diff: "+  whatever\n",
        iterations: [{ costUsd: 0.01 }],
        reports: [[{ signature: "sig-y", message: "Path traversal in readTemplate" }]],
      },
    ]);
    const result = harvest(fx.manifestPath, fx.scriptPath);
    expect(result.turns[0]?.seedLanded).toBeNull();
    expect(result.metrics.recall.den).toBe(1);
  });

  test("a pattern with no recorded diff is UNKNOWN, and warns rather than assuming", () => {
    // Runs recorded before diff.patch existed (pilot-01 among them) must not be re-scored as
    // "nothing landed" just because the evidence was never captured.
    const fx = buildFixture([
      {
        seeded: {
          id: "path-traversal",
          tags: TRAVERSAL_TAGS,
          severity: "critical",
          landedPattern: "readFileSync",
        },
        iterations: [{ costUsd: 0.01 }],
        reports: [[{ signature: "sig-y", message: "Path traversal in readTemplate" }]],
      },
    ]);
    const result = harvest(fx.manifestPath, fx.scriptPath);
    expect(result.turns[0]?.seedLanded).toBeNull();
    expect(result.metrics.recall.den).toBe(1);
    expect(result.warnings.join(" ")).toMatch(/no recorded diff/i);
  });

  test("an unparseable landedPattern warns and stays UNKNOWN — it never fails the run", () => {
    const fx = buildFixture([
      {
        seeded: {
          id: "path-traversal",
          tags: TRAVERSAL_TAGS,
          severity: "critical",
          landedPattern: "([unclosed",
        },
        diff: "+  readFileSync(x)\n",
        iterations: [{ costUsd: 0.01 }],
        reports: [[{ signature: "sig-y", message: "Path traversal in readTemplate" }]],
      },
    ]);
    const result = harvest(fx.manifestPath, fx.scriptPath);
    expect(result.turns[0]?.seedLanded).toBeNull();
    expect(result.warnings.join(" ")).toMatch(/not a valid regex/i);
  });

  test("a no-panel PLACEHOLDER report never enters the panel provenance", () => {
    const fx = canonicalFixture();
    // Exactly the row the gate writes when zero reviewers ran (orchestrator's
    // `runs.length === 0` branch): a colon-free `reviewgate` id, and — in reports written
    // before 2026-08-05 — a real provider's id and model borrowed wholesale. Counting it
    // names a reviewer that never reviewed: this is the phantom `codex/gpt-5.4-codex` slot
    // that landed in pilot-01's published provenance, in a study whose stated premise was
    // that codex was quota-exhausted and absent from the panel.
    const reportDir = join(dirname(fx.manifestPath), "turns", "1", "reports");
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(
      join(reportDir, "9-pending.json"),
      JSON.stringify({
        schema: "reviewgate.pending.v1",
        run_id: "session-x",
        iter: 1,
        max_iter: 5,
        verdict: "PASS",
        counts: { critical: 0, warn: 0, info: 0 },
        reviewers: [
          {
            id: NO_PANEL_REVIEWER_ID,
            provider: "codex",
            model: "gpt-5.4-codex",
            persona: "security",
            status: "ok",
            cost_usd: 0,
            duration_ms: 1,
          },
        ],
        findings: [],
        cost_usd_total: 0,
        duration_ms_total: 1,
        generated_at: ts(1, 9),
        git: { sha: "abc1234", branch: "master", dirty_files: ["src/store.ts"] },
      }),
    );

    const result = harvest(fx.manifestPath, fx.scriptPath);

    expect(result.provenance.panel).toEqual([
      { provider: "openrouter", model: "anthropic/claude-sonnet-4.5", persona: "security" },
    ]);
  });
});
