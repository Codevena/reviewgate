import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeMetric, summarizeSpread } from "../../src/bench/metrics.ts";
import { RigLayerSelectorError, runRigAblate } from "../../src/cli/commands/rig.ts";
import { POLICY_CATALOG_VERSION, POLICY_PASS_IDS } from "../../src/core/policy/catalog.ts";
import { ablate, renderAblationMatrix } from "../../src/rig/ablate.ts";
import { renderPolicyAblationRows } from "../../src/rig/replay.ts";
import type { Finding } from "../../src/schemas/finding.ts";
import type { RigResult, RigTurnRecord } from "../../src/schemas/rig-result.ts";

const ZERO = { critic: 0, reputation: 0, fp_ledger: 0, lore: 0 };

function finding(over: Partial<Finding> & { signature: string }): Finding {
  return {
    id: "F-001",
    severity: "CRITICAL",
    category: "security",
    rule_id: "r",
    file: "src/store.ts",
    line_start: 10,
    line_end: 12,
    message: "something",
    details: "details",
    reviewer: { provider: "openrouter", model: "m", persona: "security" },
    confidence: 0.9,
    consensus: "singleton",
    ...over,
  } as Finding;
}

function turn(over: Partial<RigTurnRecord> & { index: number }): RigTurnRecord {
  const findings = over.findings ?? [];
  const blocking = findings.filter((f) => f.severity !== "INFO").length;
  return {
    seededId: null,
    iterations: 1,
    findingsTotal: findings.length,
    blockingTotal: blocking,
    rejectedAsFp: 0,
    fpBurden: findings.length === 0 ? null : 0,
    caught: null,
    escaped: null,
    costUsd: 0.02,
    durationMs: 1000,
    agentExitCode: 0,
    wallMs: 1000,
    suppressed: ZERO,
    ...over,
    // After the spread, so a caller's partial override cannot desynchronise the counts from
    // the findings they are counts OF.
    findings,
  };
}

function result(turns: RigTurnRecord[], over: Partial<RigResult> = {}): RigResult {
  const seeded = turns.filter((t) => t.seededId !== null);
  return {
    schema: "reviewgate.rig.result.v1",
    runId: "r",
    provenance: {
      reviewgate_version: "0.1.0-alpha.15",
      harvested_at: "2026-07-30T10:00:00.000Z",
      run_id: "r",
      script_id: "s",
      script_path: "s.json",
      manifest_path: "m.json",
      turn_count: {
        harvested: turns.length,
        seeded: seeded.length,
        clean: turns.length - seeded.length,
        script_total: Math.max(1, turns.length),
      },
      panel: [{ provider: "openrouter", model: "m", persona: "security" }],
      host_os: "darwin",
    },
    turns,
    metrics: {
      iterations: { median: 1, spread: summarizeSpread(turns.map(() => 1)) },
      fpBurdenSlope: { slope: null, n: 0 },
      recall: makeMetric(seeded.filter((t) => t.caught === true).length, seeded.length),
      escapeRate: makeMetric(seeded.filter((t) => t.escaped === true).length, seeded.length),
      cost: { totalUsd: 0.02, totalDurationMs: 1000, perTurnUsd: summarizeSpread([0.02]) },
      suppression: ZERO,
    },
    warnings: [],
    ...over,
  };
}

const NO_TAGS = new Map<number, string[]>();

describe("rig ablate", () => {
  test("keeps exact catalog selectors and legacy aliases in their own result modes", async () => {
    const root = mkdtempSync(join(tmpdir(), "rg-layer-selector-"));
    const scriptPath = join(root, "script.json");
    writeFileSync(
      scriptPath,
      JSON.stringify({
        schema: "reviewgate.rig.turn-script.v1",
        id: "selector-script",
        turns: [{ index: 1, prompt: "safe", seeded: null }],
      }),
    );
    const legacyPath = join(root, "legacy.json");
    writeFileSync(legacyPath, JSON.stringify(result([turn({ index: 1 })])));
    await expect(
      runRigAblate({
        resultPath: legacyPath,
        scriptPath,
        layer: "judgment.confidence",
      }),
    ).rejects.toBeInstanceOf(RigLayerSelectorError);

    const exactPath = join(root, "exact.json");
    writeFileSync(
      exactPath,
      JSON.stringify(
        result([turn({ index: 1 })], {
          policyReplay: {
            authoritative: true,
            catalogVersion: POLICY_CATALOG_VERSION,
            sourceCommit: "a".repeat(40),
            passIds: [...POLICY_PASS_IDS],
            reason: null,
          },
        }),
      ),
    );
    await expect(
      runRigAblate({ resultPath: exactPath, scriptPath, layer: "critic" }),
    ).rejects.toBeInstanceOf(RigLayerSelectorError);
  });

  test("maps an invalid mode-specific CLI selector to exact exit 2", async () => {
    const root = mkdtempSync(join(tmpdir(), "rg-layer-selector-cli-"));
    const resultPath = join(root, "legacy.json");
    const scriptPath = join(root, "script.json");
    writeFileSync(resultPath, JSON.stringify(result([turn({ index: 1 })])));
    writeFileSync(
      scriptPath,
      JSON.stringify({
        schema: "reviewgate.rig.turn-script.v1",
        id: "selector-cli",
        turns: [{ index: 1, prompt: "safe", seeded: null }],
      }),
    );
    const child = Bun.spawn(
      [
        "bun",
        "run",
        "src/cli/index.ts",
        "rig",
        "ablate",
        "--result",
        resultPath,
        "--script",
        scriptPath,
        "--layer",
        "judgment.confidence",
      ],
      { cwd: join(import.meta.dir, "..", ".."), stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("legacy --layer");
  });

  test("exact rows use every closed catalog ID and keep Lore separate", () => {
    const rendered = renderPolicyAblationRows(
      POLICY_PASS_IDS.map((passId) => ({
        passId,
        authoritative: true,
        reason: null,
        envelopes: 1,
        opportunities: 1,
        applied: 1,
        wouldApplyWithoutMutation: 1,
        baselineBlocking: 0,
        counterfactualBlocking: 1,
      })),
    );
    for (const passId of POLICY_PASS_IDS) expect(rendered).toContain(passId);
    expect(rendered).toContain("Lore is excluded");
    expect(rendered).not.toMatch(/^\s+lore\s/m);
  });

  test("the four historical layers identify themselves as legacy and non-authoritative", () => {
    const base = result([turn({ index: 1, findings: [] })]);
    const legacy = ablate(base, "critic", NO_TAGS);
    expect(legacy.authoritative).toBe(false);
    expect(renderAblationMatrix(base, [legacy])).toContain("NON-AUTHORITATIVE LEGACY");
  });

  // The smallest assertion that proves the toggle is wired to something real rather than to
  // nothing: one critic-demoted finding, one more blocking finding when the critic is off.
  test("ablating the critic raises the blocking count by exactly one", () => {
    const base = result([
      turn({
        index: 1,
        findings: [
          finding({ signature: "a", severity: "INFO", critic_verdict: "likely_fp" }),
          finding({ signature: "b", severity: "CRITICAL" }),
        ],
        suppressed: { ...ZERO, critic: 1 },
      }),
    ]);
    expect(base.turns[0]?.blockingTotal).toBe(1);

    const a = ablate(base, "critic", NO_TAGS);
    expect(a.exact).toBe(true);
    expect(a.lower.turns[0]?.blockingTotal).toBe(2);
    expect(a.upper.turns[0]?.blockingTotal).toBe(2);
    expect(a.counts).toEqual({ touched: 1, recovered: 1, unrecoverable: 0 });
  });

  test("a critic 'keep' verdict is not a demotion and changes nothing", () => {
    const base = result([
      turn({ index: 1, findings: [finding({ signature: "a", critic_verdict: "keep" })] }),
    ]);
    const a = ablate(base, "critic", NO_TAGS);
    expect(a.counts.touched).toBe(0);
    expect(a.lower.turns[0]?.blockingTotal).toBe(1);
  });

  test("an already-blocking critic demote does not double-count", () => {
    // WARN + demoted_from_critical: was either CRITICAL or an unchanged WARN. Both are
    // blocking, so blocking status is unambiguous even though the label is not.
    const base = result([
      turn({
        index: 1,
        findings: [
          finding({
            signature: "a",
            severity: "WARN",
            critic_verdict: "likely_fp",
            demoted_from_critical: true,
          }),
        ],
      }),
    ]);
    const a = ablate(base, "critic", NO_TAGS);
    expect(a.exact).toBe(true);
    expect(a.lower.turns[0]?.blockingTotal).toBe(1);
  });

  test("fp-ledger is an INTERVAL, never a point — the original severity is unrecoverable", () => {
    const base = result([
      turn({
        index: 1,
        findings: [
          finding({
            signature: "a",
            severity: "INFO",
            fp_ledger_match: { pattern_id: "p", matched_count: 3, suppressed: true },
          }),
        ],
      }),
    ]);
    const a = ablate(base, "fp-ledger", NO_TAGS);

    expect(a.exact).toBe(false);
    expect(a.counts).toEqual({ touched: 1, recovered: 0, unrecoverable: 1 });
    expect(a.lower.turns[0]?.blockingTotal).toBe(0); // conservative: it may have been INFO
    expect(a.upper.turns[0]?.blockingTotal).toBe(1); // generous: it may have been blocking
    expect(a.notes.join(" ")).toMatch(/unrecoverable|interval/i);
  });

  test("a badge-only fp-ledger match (suppressed: false) is not an ablation target", () => {
    const base = result([
      turn({
        index: 1,
        findings: [
          finding({
            signature: "a",
            fp_ledger_match: { pattern_id: "p", matched_count: 3, suppressed: false },
          }),
        ],
      }),
    ]);
    expect(ablate(base, "fp-ledger", NO_TAGS).counts.touched).toBe(0);
  });

  test("lore removes its synthetic findings and never changes blocking counts", () => {
    const base = result([
      turn({
        index: 1,
        findings: [
          finding({ signature: "a", severity: "INFO", lore: "reminder" }),
          finding({ signature: "b", severity: "CRITICAL" }),
        ],
        suppressed: { ...ZERO, lore: 1 },
      }),
    ]);
    const a = ablate(base, "lore", NO_TAGS);

    expect(a.exact).toBe(true);
    expect(a.lower.turns[0]?.findingsTotal).toBe(1); // the lore finding is gone
    expect(a.lower.turns[0]?.blockingTotal).toBe(1); // blocking is untouched by construction
    expect(a.notes.join(" ")).toMatch(/decision load/i);
  });

  test("a finding carrying a SECOND suppressor widens the interval instead of being guessed", () => {
    // critic + fp-ledger on the same finding: switching the critic off alone may change
    // nothing, because fp-ledger runs later and would have pinned it to INFO anyway.
    const base = result([
      turn({
        index: 1,
        findings: [
          finding({
            signature: "a",
            severity: "INFO",
            critic_verdict: "likely_fp",
            fp_ledger_match: { pattern_id: "p", matched_count: 2, suppressed: true },
          }),
        ],
      }),
    ]);
    const a = ablate(base, "critic", NO_TAGS);

    expect(a.exact).toBe(false);
    expect(a.counts.unrecoverable).toBe(1);
    expect(a.lower.turns[0]?.blockingTotal).toBe(0);
    expect(a.upper.turns[0]?.blockingTotal).toBe(1);
  });

  test("a restored finding can newly catch its turn's seeded defect — recall moves", () => {
    const base = result([
      turn({
        index: 1,
        seededId: "sql-injection",
        caught: false,
        escaped: true,
        findings: [
          finding({
            signature: "a",
            severity: "INFO",
            critic_verdict: "likely_fp",
            message: "sql injection via string concatenation",
          }),
        ],
      }),
    ]);
    expect(base.metrics.recall.num).toBe(0);

    const a = ablate(base, "critic", new Map([[1, ["sql injection"]]]));
    expect(a.lower.metrics.recall.num).toBe(1);
    expect(a.lower.metrics.recall.den).toBe(1);
    expect(a.lower.turns[0]?.caught).toBe(true);
    expect(a.lower.turns[0]?.escaped).toBe(false);
  });

  // pilot-02 (2026-08-05) printed `recall +1/3` for −reputation, −fp-ledger and −lore — three
  // layers whose blocking delta was +0. A layer that suppressed nothing cannot change recall.
  // The cause was that this file counted ALL seeded turns while harvest.ts counts only the
  // LANDED ones, so a seed the agent never wrote (a spurious catch) inflated the ablated
  // numerator but not the harvested baseline it is subtracted from.
  test("recall denominator excludes seeds that never landed, matching harvest", () => {
    const base = result(
      [
        // Never landed, yet the panel raised a matching finding anyway — the spurious catch
        // that pilot-01 and pilot-02 both recorded on turn 4.
        turn({
          index: 1,
          seededId: "sql-injection",
          seedLanded: false,
          caught: true,
          escaped: false,
          findings: [
            finding({ signature: "a", message: "sql injection via string concatenation" }),
          ],
        }),
        // Landed, and its only detection was demoted by the critic.
        turn({
          index: 2,
          seededId: "path-traversal",
          seedLanded: true,
          caught: false,
          escaped: true,
          findings: [
            finding({
              signature: "b",
              severity: "INFO",
              critic_verdict: "likely_fp",
              message: "path traversal via unvalidated name",
            }),
          ],
        }),
      ],
      {},
    );
    // Harvest semantics: the landed seed is the only denominator, and it was not caught.
    // Baseline as `rig harvest` would have written it: 0/1, NOT 1/2.
    base.metrics.recall = makeMetric(0, 1);
    base.metrics.escapeRate = makeMetric(1, 1);

    const tags = new Map([
      [1, ["sql injection"]],
      [2, ["path traversal"]],
    ]);
    const a = ablate(base, "critic", tags);

    // WITHOUT the fix this is 2/2 — turn 1's unlanded seed enters the denominator and its
    // spurious catch the numerator, so the matrix prints a +2 delta over a denominator of 1.
    expect(a.lower.metrics.recall.den).toBe(1);
    expect(a.lower.metrics.recall.num).toBe(1);
    expect(a.lower.metrics.escapeRate.den).toBe(1);
  });

  test("a layer that suppressed nothing produces a recall delta of exactly zero", () => {
    const base = result(
      [
        turn({
          index: 1,
          seededId: "sql-injection",
          seedLanded: false,
          caught: true,
          escaped: false,
          findings: [
            finding({ signature: "a", message: "sql injection via string concatenation" }),
          ],
        }),
        turn({
          index: 2,
          seededId: "path-traversal",
          seedLanded: true,
          caught: true,
          escaped: false,
          // Blocking and never touched by any layer.
          findings: [finding({ signature: "b", message: "path traversal via unvalidated name" })],
        }),
      ],
      {},
    );
    base.metrics.recall = makeMetric(1, 1);
    base.metrics.escapeRate = makeMetric(0, 1);

    const tags = new Map([
      [1, ["sql injection"]],
      [2, ["path traversal"]],
    ]);
    // fp-ledger suppressed nothing here, so the counterfactual must be identical to baseline.
    const a = ablate(base, "fp-ledger", tags);
    expect(a.counts.touched).toBe(0);
    // WITHOUT the fix: num 2, den 2 → the renderer prints `+1` for a no-op layer.
    expect(a.lower.metrics.recall.num - base.metrics.recall.num).toBe(0);
    expect(a.lower.metrics.recall.den).toBe(base.metrics.recall.den);
  });

  test("iterations, cost and FP burden are NOT rewritten — it is not a behavioural A/B", () => {
    const base = result([
      turn({
        index: 1,
        iterations: 3,
        costUsd: 0.5,
        rejectedAsFp: 1,
        findings: [finding({ signature: "a", severity: "INFO", critic_verdict: "likely_fp" })],
      }),
    ]);
    const a = ablate(base, "critic", NO_TAGS);

    expect(a.lower.turns[0]?.iterations).toBe(3);
    expect(a.lower.turns[0]?.costUsd).toBe(0.5);
    expect(a.lower.metrics.cost.totalUsd).toBe(base.metrics.cost.totalUsd);
    expect(a.lower.warnings.join(" ")).toMatch(/not a behavioural A\/B/i);
  });

  test("the ablated layer's M6 count is zeroed, the others are untouched", () => {
    const base = result(
      [
        turn({
          index: 1,
          findings: [finding({ signature: "a", severity: "INFO", critic_verdict: "likely_fp" })],
          suppressed: { critic: 1, reputation: 2, fp_ledger: 3, lore: 4 },
        }),
      ],
      {},
    );
    const withSuppression = {
      ...base,
      metrics: {
        ...base.metrics,
        suppression: { critic: 1, reputation: 2, fp_ledger: 3, lore: 4 },
      },
    };
    const a = ablate(withSuppression, "critic", NO_TAGS);
    expect(a.lower.metrics.suppression).toEqual({
      critic: 0,
      reputation: 2,
      fp_ledger: 3,
      lore: 4,
    });
  });

  test("the ablated result still validates against RigResultSchema", async () => {
    const { RigResultSchema } = await import("../../src/schemas/rig-result.ts");
    const base = result([
      turn({
        index: 1,
        findings: [finding({ signature: "a", severity: "INFO", lore: "reminder" })],
      }),
    ]);
    const a = ablate(base, "lore", NO_TAGS);
    // Removing the only finding must re-honour the "null, never 0" FP-burden contract.
    expect(a.lower.turns[0]?.fpBurden).toBeNull();
    expect(() => RigResultSchema.parse(a.lower)).not.toThrow();
  });

  test("the matrix prints an interval as an interval and marks exact rows exact", () => {
    const base = result([
      turn({
        index: 1,
        findings: [
          finding({ signature: "a", severity: "INFO", critic_verdict: "likely_fp" }),
          finding({
            signature: "b",
            severity: "INFO",
            fp_ledger_match: { pattern_id: "p", matched_count: 1, suppressed: true },
          }),
        ],
      }),
    ]);
    const out = renderAblationMatrix(base, [
      ablate(base, "critic", NO_TAGS),
      ablate(base, "fp-ledger", NO_TAGS),
    ]);

    expect(out).toContain("baseline");
    expect(out).toMatch(/critic.*\+1.*\(exact\)/);
    expect(out).toMatch(/fp-ledger.*\+0…\+1/);
    expect(out).toContain("interval");
  });
});
