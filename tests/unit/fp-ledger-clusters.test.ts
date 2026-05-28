import { describe, expect, it } from "bun:test";
import {
  computeFpClusters,
  isNearActive,
  ruleIdToken0,
} from "../../src/core/fp-ledger/clusters.ts";
import type { FpLedgerEntry } from "../../src/schemas/fp-ledger.ts";

function mkEntry(over: Partial<FpLedgerEntry> = {}): FpLedgerEntry {
  return {
    id: "FP-001",
    signature: "sig1",
    rule_id: "prisma-attribute-corruption",
    category: "correctness",
    file: "prisma/schema.prisma",
    symbol: "",
    stage: "candidate",
    rejects: [
      {
        run_id: "R1",
        provider: "gemini",
        ts: "2026-05-25T03:00:00.000Z",
        reason: "hallucinated",
      },
    ],
    distinct_providers: ["gemini"],
    first_seen_at: "2026-05-25T03:00:00.000Z",
    last_seen_at: "2026-05-25T03:00:00.000Z",
    created_at: "2026-05-25T03:00:00.000Z",
    ...over,
  };
}

const NOW = "2026-05-28T20:00:00.000Z";

describe("ruleIdToken0", () => {
  it("returns the prefix before the first hyphen", () => {
    expect(ruleIdToken0("prisma-attribute-corruption")).toBe("prisma");
    expect(ruleIdToken0("prisma-primary-key")).toBe("prisma");
  });
  it("returns the whole id when there's no hyphen", () => {
    expect(ruleIdToken0("hardcoded")).toBe("hardcoded");
  });
  it("returns empty string for empty input", () => {
    expect(ruleIdToken0("")).toBe("");
  });
});

describe("computeFpClusters — grouping", () => {
  it("returns nothing for a single ledger entry (singletons don't cluster)", () => {
    const out = computeFpClusters([mkEntry()], NOW);
    expect(out).toEqual([]);
  });

  it("groups 2+ entries sharing rule_id_token0 + file", () => {
    const out = computeFpClusters(
      [
        mkEntry({ id: "FP-001", signature: "s1", rule_id: "prisma-attribute-corruption" }),
        mkEntry({ id: "FP-002", signature: "s2", rule_id: "prisma-corrupted-attribute" }),
      ],
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.key).toBe("prisma@prisma/schema.prisma");
    expect(out[0]?.member_ids.sort()).toEqual(["FP-001", "FP-002"]);
    expect(out[0]?.member_signatures.sort()).toEqual(["s1", "s2"]);
  });

  it("different files → different clusters", () => {
    const out = computeFpClusters(
      [
        mkEntry({ id: "FP-001", signature: "s1", file: "a.ts" }),
        mkEntry({ id: "FP-002", signature: "s2", file: "b.ts" }),
      ],
      NOW,
    );
    expect(out).toEqual([]); // each cluster is a singleton, skipped
  });

  it("different rule_id_token0 → different clusters even on same file", () => {
    const out = computeFpClusters(
      [
        mkEntry({ id: "FP-001", signature: "s1", rule_id: "prisma-foo" }),
        mkEntry({ id: "FP-002", signature: "s2", rule_id: "next-bar" }),
      ],
      NOW,
    );
    expect(out).toEqual([]); // both singletons
  });
});

describe("computeFpClusters — the shoal motivating case", () => {
  // The exact data shape from shoal 2026-05-25: gemini's prisma hallucination
  // burst produced 4 FP entries with slightly different rule_ids on the same
  // schema.prisma, each with 1 reject. Per-signature they ALL stay candidates
  // forever. The point of F3: this conceptual cluster should advance further.
  it("4× same-provider rule_id_token0 burst yields a 4-reject SINGLE-provider cluster", () => {
    const out = computeFpClusters(
      [
        mkEntry({ id: "FP-001", signature: "s1", rule_id: "prisma-attribute-corruption" }),
        mkEntry({ id: "FP-002", signature: "s2", rule_id: "prisma-corrupted-attribute" }),
        mkEntry({ id: "FP-003", signature: "s3", rule_id: "prisma-invalid-attribute" }),
        mkEntry({ id: "FP-004", signature: "s4", rule_id: "prisma-primary-key" }),
      ],
      NOW,
    );
    expect(out).toHaveLength(1);
    const c = out[0];
    expect(c?.reject_count_total).toBe(4);
    expect(c?.reject_count_active_window).toBe(4);
    expect(c?.distinct_providers).toEqual(["gemini"]);
    // Still stuck at candidate — the cluster surfaces the BURST (4 rejects
    // visible in one place), but ≥2-provider quorum is still required. So a
    // cluster view alone doesn't suppress single-provider sprees — that's
    // intentional (anti-collusion), and matches the candidate→active rule.
    expect(c?.stage).toBe("candidate");
    expect(isNearActive(c as NonNullable<typeof c>)).toBe(true);
  });

  it("would-be active when a second provider's entry joins the cluster", () => {
    const out = computeFpClusters(
      [
        mkEntry({ id: "FP-001", signature: "s1", rule_id: "prisma-attribute-corruption" }),
        mkEntry({ id: "FP-002", signature: "s2", rule_id: "prisma-corrupted-attribute" }),
        mkEntry({
          id: "FP-005",
          signature: "s5",
          rule_id: "prisma-bad-key",
          rejects: [
            {
              run_id: "R5",
              provider: "claude-code",
              ts: "2026-05-28T18:00:00.000Z",
              reason: "hallucinated",
            },
          ],
          distinct_providers: ["claude-code"],
        }),
      ],
      NOW,
    );
    expect(out).toHaveLength(1);
    const c = out[0];
    expect(c?.distinct_providers).toEqual(["claude-code", "gemini"]);
    expect(c?.reject_count_total).toBe(3);
    expect(c?.stage).toBe("active");
  });
});

describe("computeFpClusters — windowing", () => {
  it("rejects outside the 60-day window don't count toward active promotion", () => {
    // Two entries both pre-window. Each has 1 reject from a different provider.
    // Within-window rejects = 0 → no quorum.
    const old1 = "2025-01-01T00:00:00.000Z";
    const old2 = "2025-01-02T00:00:00.000Z";
    const out = computeFpClusters(
      [
        mkEntry({
          id: "FP-001",
          signature: "s1",
          rule_id: "x-a",
          rejects: [
            {
              run_id: "R1",
              provider: "gemini",
              ts: old1,
              reason: "old",
            },
          ],
          distinct_providers: ["gemini"],
          first_seen_at: old1,
          last_seen_at: old1,
        }),
        mkEntry({
          id: "FP-002",
          signature: "s2",
          rule_id: "x-b",
          rejects: [
            {
              run_id: "R2",
              provider: "codex",
              ts: old2,
              reason: "old",
            },
          ],
          distinct_providers: ["codex"],
          first_seen_at: old2,
          last_seen_at: old2,
        }),
      ],
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.reject_count_total).toBe(2);
    expect(out[0]?.reject_count_active_window).toBe(0);
    expect(out[0]?.stage).toBe("candidate");
  });
});

describe("computeFpClusters — deterministic ordering", () => {
  it("orders by stage, then by reject count desc, then key", () => {
    // x-cluster: 3 rejects from 2 distinct providers → active.
    // y-cluster: 2 rejects from 2 distinct providers → candidate (3-reject
    // floor unmet). Active sorts ahead of candidate, so x comes first via
    // stage rank — the reject-count tiebreaker only matters within a stage.
    const out = computeFpClusters(
      [
        mkEntry({
          id: "FP-001",
          signature: "a1",
          rule_id: "x-a",
          file: "x.ts",
          rejects: [
            { run_id: "R", provider: "p1", ts: NOW, reason: "" },
            { run_id: "R", provider: "p2", ts: NOW, reason: "" },
          ],
          distinct_providers: ["p1", "p2"],
        }),
        mkEntry({
          id: "FP-002",
          signature: "a2",
          rule_id: "x-b",
          file: "x.ts",
          rejects: [{ run_id: "R", provider: "p1", ts: NOW, reason: "" }],
          distinct_providers: ["p1"],
        }),
        mkEntry({
          id: "FP-003",
          signature: "b1",
          rule_id: "y-a",
          file: "y.ts",
          rejects: [{ run_id: "R", provider: "q1", ts: NOW, reason: "" }],
          distinct_providers: ["q1"],
        }),
        mkEntry({
          id: "FP-004",
          signature: "b2",
          rule_id: "y-b",
          file: "y.ts",
          rejects: [{ run_id: "R", provider: "q2", ts: NOW, reason: "" }],
          distinct_providers: ["q2"],
        }),
      ],
      NOW,
    );
    expect(out).toHaveLength(2);
    // x-cluster has 3 rejects (active); y-cluster has 2 rejects (active).
    // x comes first by reject count.
    expect(out[0]?.key).toBe("x@x.ts");
    expect(out[1]?.key).toBe("y@y.ts");
  });
});

describe("isNearActive", () => {
  it("is true only when exactly one promotion dimension is missing (windowed)", () => {
    // Active: not near-active.
    expect(
      isNearActive({
        stage: "active",
        distinct_providers: ["a", "b"],
        distinct_providers_active_window: 2,
        reject_count_active_window: 3,
      } as Parameters<typeof isNearActive>[0]),
    ).toBe(false);
    // Sticky: not near-active.
    expect(
      isNearActive({
        stage: "sticky",
        distinct_providers: ["a", "b"],
        distinct_providers_active_window: 2,
        reject_count_active_window: 5,
      } as Parameters<typeof isNearActive>[0]),
    ).toBe(false);
    // Candidate with enough rejects but only 1 windowed provider → near.
    expect(
      isNearActive({
        stage: "candidate",
        distinct_providers: ["a"],
        distinct_providers_active_window: 1,
        reject_count_active_window: 4,
      } as Parameters<typeof isNearActive>[0]),
    ).toBe(true);
    // Candidate with 2 windowed providers but only 2 rejects → near.
    expect(
      isNearActive({
        stage: "candidate",
        distinct_providers: ["a", "b"],
        distinct_providers_active_window: 2,
        reject_count_active_window: 2,
      } as Parameters<typeof isNearActive>[0]),
    ).toBe(true);
    // Candidate failing BOTH dimensions → not near (too far).
    expect(
      isNearActive({
        stage: "candidate",
        distinct_providers: ["a"],
        distinct_providers_active_window: 1,
        reject_count_active_window: 1,
      } as Parameters<typeof isNearActive>[0]),
    ).toBe(false);
  });

  it("Claude WARN regression: stale all-time provider must NOT inflate near-active", () => {
    // 2 all-time providers but only 1 INSIDE the 60-day window. Reject count
    // also short. Pre-fix `haveProvs` used `c.distinct_providers.length >= 2`
    // (all-time) → haveProvs=true while haveCount=false → wrongly "near".
    // Post-fix `haveProvs` uses the windowed count → false, haveCount → false,
    // both dimensions short → NOT near.
    expect(
      isNearActive({
        stage: "candidate",
        distinct_providers: ["a", "b"],
        distinct_providers_active_window: 1,
        reject_count_active_window: 2,
      } as Parameters<typeof isNearActive>[0]),
    ).toBe(false);
  });
});

describe("computeFpClusters — empty rule_id_token0 (Claude/Gemini INFO regression)", () => {
  it("drops entries with empty rule_id rather than clustering them under '@<file>'", () => {
    const out = computeFpClusters(
      [
        mkEntry({ id: "FP-100", signature: "z1", rule_id: "", file: "x.ts" }),
        mkEntry({ id: "FP-101", signature: "z2", rule_id: "", file: "x.ts" }),
      ],
      NOW,
    );
    expect(out).toEqual([]);
  });

  it("non-empty + empty mix: empty is dropped, non-empty remains a singleton (not clustered)", () => {
    const out = computeFpClusters(
      [
        mkEntry({ id: "FP-100", signature: "z1", rule_id: "", file: "x.ts" }),
        mkEntry({ id: "FP-101", signature: "z2", rule_id: "prisma-foo", file: "x.ts" }),
      ],
      NOW,
    );
    expect(out).toEqual([]);
  });
});

describe("computeFpClusters — windowed-providers field (Claude WARN fix)", () => {
  it("exposes distinct_providers_active_window separately from all-time providers", () => {
    const old = "2025-01-01T00:00:00.000Z";
    const recent = "2026-05-28T00:00:00.000Z";
    const out = computeFpClusters(
      [
        mkEntry({
          id: "FP-001",
          signature: "s1",
          rule_id: "prisma-a",
          rejects: [{ run_id: "R", provider: "gemini", ts: old, reason: "" }],
          distinct_providers: ["gemini"],
          first_seen_at: old,
          last_seen_at: old,
        }),
        mkEntry({
          id: "FP-002",
          signature: "s2",
          rule_id: "prisma-b",
          rejects: [{ run_id: "R", provider: "codex", ts: recent, reason: "" }],
          distinct_providers: ["codex"],
          first_seen_at: recent,
          last_seen_at: recent,
        }),
      ],
      NOW,
    );
    expect(out).toHaveLength(1);
    const c = out[0];
    expect(c?.distinct_providers).toEqual(["codex", "gemini"]);
    // Only `codex` is inside the 60-day active window — `gemini` is in 2025.
    expect(c?.distinct_providers_active_window).toBe(1);
    expect(c?.stage).toBe("candidate");
    // isNearActive must reflect the windowed count, so NOT near (1 provider
    // + 1 reject in window → both dimensions short).
    expect(isNearActive(c as NonNullable<typeof c>)).toBe(false);
  });
});
