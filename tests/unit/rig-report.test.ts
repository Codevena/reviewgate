import { describe, expect, test } from "bun:test";
import { makeMetric, summarizeSpread } from "../../src/bench/metrics.ts";
import { renderRigReport } from "../../src/rig/report.ts";
import type { RigResult, RigTurnRecord } from "../../src/schemas/rig-result.ts";

// A RigResult is built here by hand rather than harvested, so a reporting bug cannot be
// masked by a harvesting bug (and vice versa): these tests are about what reaches the reader.

const ZERO_SUPPRESSION = { critic: 0, reputation: 0, fp_ledger: 0, lore: 0 };

function turn(over: Partial<RigTurnRecord> & { index: number }): RigTurnRecord {
  return {
    seededId: null,
    iterations: 1,
    findingsTotal: 1,
    blockingTotal: 1,
    rejectedAsFp: 0,
    fpBurden: 0,
    caught: null,
    escaped: null,
    costUsd: 0.02,
    durationMs: 5000,
    agentExitCode: 0,
    wallMs: 60_000,
    suppressed: ZERO_SUPPRESSION,
    findings: [],
    ...over,
  };
}

function result(over: Partial<RigResult> = {}): RigResult {
  const turns = over.turns ?? [
    turn({ index: 1, fpBurden: 1, rejectedAsFp: 1 }),
    turn({
      index: 2,
      seededId: "path-traversal",
      caught: true,
      escaped: false,
      iterations: 2,
      costUsd: 0.06,
    }),
    turn({ index: 3, findingsTotal: 0, blockingTotal: 0, fpBurden: null }),
  ];
  return {
    schema: "reviewgate.rig.result.v1",
    runId: "pilot-01-2026-07-30T09-00-00-000Z",
    provenance: {
      reviewgate_version: "0.1.0-alpha.15",
      harvested_at: "2026-07-30T10:00:00.000Z",
      run_id: "pilot-01-2026-07-30T09-00-00-000Z",
      script_id: "pilot-01",
      script_path: "rig/scripts/pilot-01.json",
      manifest_path: "rig/results/pilot-01/manifest.json",
      turn_count: { harvested: 3, seeded: 1, clean: 2, script_total: 12 },
      panel: [
        { provider: "openrouter", model: "anthropic/claude-sonnet-4.5", persona: "security" },
        { provider: "ollama", model: "glm-5.2:cloud", persona: "correctness" },
      ],
      host_os: "darwin 25.4.0",
    },
    turns,
    metrics: {
      iterations: { median: 1, spread: summarizeSpread([1, 2, 1]) },
      fpBurdenSlope: { slope: null, n: 2 },
      recall: makeMetric(1, 1),
      escapeRate: makeMetric(0, 1),
      cost: { totalUsd: 0.1, totalDurationMs: 15000, perTurnUsd: summarizeSpread([0.02, 0.06]) },
      suppression: ZERO_SUPPRESSION,
    },
    warnings: [],
    ...over,
  };
}

describe("rig report", () => {
  test("every rate is printed with its raw denominator AND its CI", () => {
    const { table, markdown } = renderRigReport(result());
    for (const out of [table, markdown]) {
      // recall 1/1 and escape rate 0/1, each with a 95% CI — a bare rate is the failure
      // mode this project already guards against in bench.
      expect(out).toContain("(1/1, 95% CI");
      expect(out).toContain("(0/1, 95% CI");
    }
  });

  test("the M2 slope line always carries its n — both when withheld and when reported", () => {
    const withheld = renderRigReport(result());
    expect(withheld.table).toContain("insufficient data (n=2)");
    expect(withheld.markdown).toContain("insufficient data (n=2)");

    const reported = renderRigReport(
      result({
        metrics: { ...result().metrics, fpBurdenSlope: { slope: -0.0833, n: 7 } },
      }),
    );
    expect(reported.table).toMatch(/-0\.0833.*n=7/);
    expect(reported.markdown).toMatch(/-0\.0833.*n=7/);
  });

  test("states the sample size next to the headline, not in a footnote", () => {
    const { table, markdown } = renderRigReport(result());
    for (const out of [table, markdown]) {
      expect(out).toContain("3 turn(s) harvested");
      expect(out).toContain("1 seeded");
    }
  });

  test("names the panel — a different panel is a different system", () => {
    const { table, markdown } = renderRigReport(result());
    for (const out of [table, markdown]) {
      expect(out).toContain("openrouter");
      expect(out).toContain("anthropic/claude-sonnet-4.5");
      expect(out).toContain("ollama");
    }
  });

  test("renders warnings prominently, never silently dropped", () => {
    const r = result({
      warnings: [
        "turn 2: the agent process exited with exit code 1 — this turn's diff may be incomplete.",
        "turn 3: no run.complete audit events — the gate never reviewed this turn.",
      ],
    });
    const { table, markdown } = renderRigReport(r);
    for (const out of [table, markdown]) {
      expect(out).toContain("exit code 1");
      expect(out).toContain("never reviewed this turn");
    }
  });

  test("a clean turn's caught column reads n/a, never a miss", () => {
    const { table } = renderRigReport(result());
    const line3 = table.split("\n").find((l) => /^\s*3\s/.test(l.trim()));
    expect(line3).toBeDefined();
    // Turn 3 is clean: it must not render as "no" in the caught column, which a reader
    // would total up as a missed defect.
    expect(line3).not.toMatch(/\bno\b/);
  });

  test("a null FP burden renders as n/a, never as 0.00", () => {
    const { table } = renderRigReport(result());
    const line3 = (table.split("\n").find((l) => /^\s*3\s/.test(l.trim())) ?? "").trim();
    expect(line3).toContain("n/a");
  });

  test("carries the standing limitations so a number cannot be quoted without them", () => {
    const { markdown } = renderRigReport(result());
    expect(markdown.toLowerCase()).toContain("one run");
    expect(markdown).toMatch(/aggregation-layer counterfactual|not a behavioural A\/B/i);
  });

  test("reports M6 suppression provenance per layer", () => {
    const r = result({
      metrics: {
        ...result().metrics,
        suppression: { critic: 3, reputation: 1, fp_ledger: 2, lore: 4 },
      },
    });
    const { table, markdown } = renderRigReport(r);
    for (const out of [table, markdown]) {
      expect(out).toMatch(/critic\D+3/);
      expect(out).toMatch(/fp.ledger\D+2/);
      // lore is additive, not a demote — the report must not imply otherwise.
      expect(out).toMatch(/lore\D+4/);
    }
  });

  test("says outright when the run is a partial harvest of its script", () => {
    const { table, markdown } = renderRigReport(result());
    for (const out of [table, markdown]) {
      expect(out).toContain("of 12");
    }
  });
});
