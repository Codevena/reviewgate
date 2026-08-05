// tests/unit/fp-ledger-semantic-clusters.test.ts
//
// C4 — semantic FP-cluster view. ruleIdToken0 matches only the first hyphen
// segment, so `pipe-buffer-deadlock` and `pipe-deadlock` group while
// `piped-stdout-undrained-deadlock` — one character apart — does not. This
// replaces it with: same file, same category, >=2 shared canonical tokens,
// closed transitively.
//
// DIAGNOSIS ONLY. computeFpClusters still feeds the aggregator's suppression
// map; broadening a suppression key on single-run evidence is a fail-open.
import { describe, expect, it } from "bun:test";
import { computeFpSemanticClusters } from "../../src/core/fp-ledger/clusters.ts";
import { canonicalRuleTokens } from "../../src/diff/signature.ts";
import type { FpLedgerEntry } from "../../src/schemas/fp-ledger.ts";

const NOW = "2026-08-05T00:00:00.000Z";

function mk(id: string, rule_id: string, over: Partial<FpLedgerEntry> = {}): FpLedgerEntry {
  return {
    id,
    signature: `sig-${id}`,
    rule_id,
    category: "correctness",
    file: "src/rig/driver.ts",
    symbol: "",
    stage: "candidate",
    rejects: [
      { run_id: `R-${id}`, provider: "claude-code", ts: "2026-07-29T22:47:57.000Z", reason: "fp" },
    ],
    distinct_providers: ["claude-code"],
    first_seen_at: "2026-07-29T22:47:57.000Z",
    last_seen_at: "2026-07-29T22:47:57.000Z",
    created_at: "2026-07-29T22:47:57.000Z",
    ...over,
  };
}

describe("canonicalRuleTokens", () => {
  it("folds suffix variants so pipe and piped unify", () => {
    expect(canonicalRuleTokens("pipe")).toEqual(new Set(["pip"]));
    expect(canonicalRuleTokens("piped")).toEqual(new Set(["pip"]));
    expect(canonicalRuleTokens("defanged")).toEqual(new Set(["defang"]));
    expect(canonicalRuleTokens("defang")).toEqual(new Set(["defang"]));
    expect(canonicalRuleTokens("deleted")).toEqual(new Set(["delet"]));
    expect(canonicalRuleTokens("delete")).toEqual(new Set(["delet"]));
  });

  it("drops the shared RULE_ID_NOISE words", () => {
    // `via` and `unsafe` are both in RULE_ID_NOISE.
    expect(canonicalRuleTokens("path-traversal-via-unsafe-join")).toEqual(
      new Set(["path", "traversal", "join"]),
    );
  });
});

describe("computeFpSemanticClusters", () => {
  it("clusters the pipe/deadlock trio that ruleIdToken0 splits on pipe vs piped", () => {
    const out = computeFpSemanticClusters(
      [
        mk("FP-021", "pipe-buffer-deadlock"),
        mk("FP-022", "pipe-deadlock"),
        mk("FP-023", "piped-stdout-undrained-deadlock", {
          rejects: [
            {
              run_id: "R-FP-023",
              provider: "ollama",
              ts: "2026-07-29T22:47:57.000Z",
              reason: "fp",
            },
          ],
          distinct_providers: ["ollama"],
        }),
      ],
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.member_ids.sort()).toEqual(["FP-021", "FP-022", "FP-023"]);
  });

  it("does NOT merge semantically distinct rules in the same file (no false merge)", () => {
    // The four real src/core/lore/approve.ts entries. Only the TTY-guard pair is
    // one class; toctou-challenge and weak-challenge-entropy are separate concerns.
    const f = { file: "src/core/lore/approve.ts", category: "security" as const };
    const out = computeFpSemanticClusters(
      [
        mk("FP-026", "no-tty-guard-on-write-path", f),
        mk("FP-027", "core-approve-fn-no-tty-guard", f),
        mk("FP-028", "toctou-challenge-verify-to-write", f),
        mk("FP-029", "weak-challenge-entropy", f),
      ],
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.member_ids.sort()).toEqual(["FP-026", "FP-027"]);
  });

  it("never clusters across different files or categories", () => {
    expect(
      computeFpSemanticClusters(
        [
          mk("FP-A", "pipe-buffer-deadlock", { file: "a.ts" }),
          mk("FP-B", "pipe-buffer-deadlock", { file: "b.ts" }),
        ],
        NOW,
      ),
    ).toHaveLength(0);
    expect(
      computeFpSemanticClusters(
        [
          mk("FP-C", "pipe-buffer-deadlock", { category: "security" }),
          mk("FP-D", "pipe-buffer-deadlock", { category: "correctness" }),
        ],
        NOW,
      ),
    ).toHaveLength(0);
  });

  it("documents the accepted transitive-closure behaviour", () => {
    // A-B share {beta, guard}; B-C share {gamma} only -> the chain does NOT close.
    const open = computeFpSemanticClusters(
      [
        mk("FP-A", "alpha-beta-guard"),
        mk("FP-B", "beta-guard-gamma"),
        mk("FP-C", "gamma-delta-epsilon"),
      ],
      NOW,
    );
    expect(open).toHaveLength(1);
    expect(open[0]?.member_ids.sort()).toEqual(["FP-A", "FP-B"]);

    // Now B-C share {gamma, guard} -> all three merge, even though A and C share
    // only {guard}. This is transitive closure working as specified, not a bug.
    const closed = computeFpSemanticClusters(
      [
        mk("FP-A", "alpha-beta-guard"),
        mk("FP-B", "beta-guard-gamma"),
        mk("FP-C", "gamma-delta-guard"),
      ],
      NOW,
    );
    expect(closed).toHaveLength(1);
    expect(closed[0]?.member_ids.sort()).toEqual(["FP-A", "FP-B", "FP-C"]);
  });

  it("singletons do not form a cluster", () => {
    expect(computeFpSemanticClusters([mk("FP-001", "lonely-rule-here")], NOW)).toEqual([]);
  });

  it("carries the run-based evidence fields from C2", () => {
    // Two members, two rejects, but ONE gate run -> candidate, never active.
    const out = computeFpSemanticClusters(
      [
        mk("FP-021", "pipe-buffer-deadlock", {
          rejects: [
            { run_id: "R1", provider: "claude-code", ts: "2026-07-29T22:47:57.000Z", reason: "fp" },
          ],
        }),
        mk("FP-022", "pipe-deadlock", {
          rejects: [
            { run_id: "R1", provider: "ollama", ts: "2026-07-29T22:47:57.000Z", reason: "fp" },
          ],
          distinct_providers: ["ollama"],
        }),
      ],
      NOW,
    );
    expect(out[0]?.reject_count_active_window).toBe(2);
    expect(out[0]?.distinct_runs_active_window).toBe(1);
    expect(out[0]?.stage).toBe("candidate");
  });
});
