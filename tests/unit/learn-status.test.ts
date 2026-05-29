import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { __test, runLearnStatus } from "../../src/cli/commands/learn-status.ts";
import {
  brainCandidatesPath,
  brainDir,
  brainJsonPath,
  knownFpPath,
  learningsDir,
  proposalsPoolDir,
  proposalsPoolPath,
  reputationJsonPath,
  reviewgateDir,
} from "../../src/utils/paths.ts";

function repo(): string {
  return mkdtempSync(join(tmpdir(), "rg-lstatus-"));
}

function ensure(path: string): void {
  const d = dirname(path);
  if (!path) return;
  try {
    mkdirSync(d, { recursive: true });
  } catch {
    /* ignore */
  }
}

const NOW = "2026-05-28T20:00:00.000Z";

describe("learn status — empty repo", () => {
  it("buildReport returns zeroes for every section", async () => {
    const r = repo();
    const rep = await __test.buildReport({ repoRoot: r, now: NOW });
    expect(rep.brain.active).toBe(0);
    expect(rep.brain.candidate).toBe(0);
    expect(rep.brain.total).toBe(0);
    expect(rep.brain_candidates.total).toBe(0);
    expect(rep.proposal_pools.open_pools).toBe(0);
    expect(rep.proposal_pools.total_proposals).toBe(0);
    expect(rep.curator_decisions.in_window_count).toBe(0);
    expect(rep.fp_ledger.candidate).toBe(0);
    expect(rep.fp_ledger.active).toBe(0);
    expect(rep.fp_ledger.clusters.total).toBe(0);
    expect(rep.reputation).toEqual([]);
  });

  it("runLearnStatus writes a header even on an empty repo", async () => {
    const r = repo();
    let out = "";
    const code = await runLearnStatus({
      repoRoot: r,
      now: NOW,
      write: (s) => {
        out += s;
      },
    });
    expect(code).toBe(0);
    expect(out).toContain("Reviewgate · Learn Status");
    expect(out).toContain("(since 2026-04-28)"); // default 30-day window
  });

  it("--json emits parseable JSON", async () => {
    const r = repo();
    let out = "";
    await runLearnStatus({
      repoRoot: r,
      now: NOW,
      json: true,
      write: (s) => {
        out += s;
      },
    });
    const parsed = JSON.parse(out);
    expect(parsed.generated_at).toBe(NOW);
    expect(parsed.since).toBe("2026-04-28T20:00:00.000Z");
    expect(parsed.brain.total).toBe(0);
  });
});

describe("learn status — brain entries", () => {
  it("counts active / candidate / stale and surfaces recent promotions", async () => {
    const r = repo();
    ensure(brainJsonPath(r));
    writeFileSync(
      brainJsonPath(r),
      JSON.stringify({
        schema: "reviewgate.brain.v1",
        entries: [
          {
            id: "B-001",
            type: "convention",
            scope: "this-repo",
            title: "use prepared statements",
            body: "always parameterize",
            tags: [],
            file_globs: [],
            status: "active",
            referenced_count: 3,
            referencing_reviewers: ["a", "b"],
            confidence: 0.9,
            embedding: null,
            evidence: [{ kind: "reviewer-observation", run_id: "R", reviewer_id: "a" }],
            created_at: "2026-05-25T00:00:00.000Z",
            source_run_id: "R",
          },
          {
            id: "B-002",
            type: "convention",
            scope: "this-repo",
            title: "old-thing",
            body: "stale",
            tags: [],
            file_globs: [],
            status: "stale",
            referenced_count: 1,
            referencing_reviewers: ["a"],
            confidence: 0.5,
            embedding: null,
            evidence: [{ kind: "reviewer-observation", run_id: "R", reviewer_id: "a" }],
            created_at: "2025-01-01T00:00:00.000Z",
            source_run_id: "R",
          },
        ],
      }),
    );
    const rep = await __test.buildReport({ repoRoot: r, now: NOW });
    expect(rep.brain.active).toBe(1);
    expect(rep.brain.stale).toBe(1);
    expect(rep.brain.recent_promotions).toHaveLength(1);
    expect(rep.brain.recent_promotions[0]?.id).toBe("B-001");
  });
});

describe("learn status — F2 proposal pools", () => {
  it("counts open pools + per-pool providers + total proposals", async () => {
    const r = repo();
    const runId = "01KSTESTABCDEFGHIJKLMNOPQR";
    ensure(proposalsPoolPath(r, runId));
    const line = (iter: number, reviewer: string) =>
      JSON.stringify({
        iter,
        appended_at: NOW,
        signature: `sig${iter}${reviewer}`,
        proposal: {
          type: "convention",
          scope: "this-repo",
          title: `t${iter}-${reviewer}`,
          body: "b",
          confidence: 0.7,
          tags: [],
          evidence: [{ kind: "reviewer-observation", run_id: runId, reviewer_id: reviewer }],
        },
      });
    writeFileSync(
      proposalsPoolPath(r, runId),
      [
        line(1, "claude-code:security"),
        line(1, "claude-code:security"), // would dedup at append, but here we test the read
        line(2, "opencode:security"),
      ].join("\n"),
    );
    const rep = await __test.buildReport({ repoRoot: r, now: NOW });
    expect(rep.proposal_pools.open_pools).toBe(1);
    expect(rep.proposal_pools.per_pool[0]?.iters).toEqual([1, 2]);
    expect(rep.proposal_pools.per_pool[0]?.providers.sort()).toEqual([
      "claude-code:security",
      "opencode:security",
    ]);
    expect(rep.proposal_pools.total_proposals).toBe(3);
  });

  it("ignores errors.jsonl when listing pools", async () => {
    const r = repo();
    mkdirSync(proposalsPoolDir(r), { recursive: true });
    writeFileSync(join(proposalsPoolDir(r), "errors.jsonl"), '{"ts":"x"}\n');
    const rep = await __test.buildReport({ repoRoot: r, now: NOW });
    expect(rep.proposal_pools.open_pools).toBe(0);
  });
});

describe("learn status — curator decisions robustness (Gemini WARN regression)", () => {
  it("skips a JSONL line that parses to null instead of crashing", async () => {
    const r = repo();
    const dir = join(brainDir(r), "proposals", "curator-decisions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "RUN.jsonl"),
      ["null", JSON.stringify({ decision: "rejected", rule_failed: "quorum", ts: NOW })].join("\n"),
    );
    const rep = await __test.buildReport({ repoRoot: r, now: NOW });
    expect(rep.curator_decisions.in_window_count).toBe(1); // null skipped
  });

  it("skips an entry with a malformed timestamp instead of counting NaN as in-window", async () => {
    const r = repo();
    const dir = join(brainDir(r), "proposals", "curator-decisions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "RUN.jsonl"),
      [
        JSON.stringify({ decision: "rejected", rule_failed: "quorum", ts: "not-a-date" }),
        JSON.stringify({ decision: "rejected", rule_failed: "quorum", ts: NOW }),
      ].join("\n"),
    );
    const rep = await __test.buildReport({ repoRoot: r, now: NOW });
    // Pre-fix: NaN < sinceMs is false → invalid-ts entries silently counted.
    // Post-fix: explicit Number.isFinite guard drops them.
    expect(rep.curator_decisions.in_window_count).toBe(1);
  });
});

describe("learn status — curator decisions windowing", () => {
  it("counts in-window decisions and bucketizes by verdict:rule_failed", async () => {
    const r = repo();
    const dir = join(brainDir(r), "proposals", "curator-decisions");
    mkdirSync(dir, { recursive: true });
    const old = "2025-01-01T00:00:00.000Z";
    const recent = "2026-05-28T10:00:00.000Z";
    writeFileSync(
      join(dir, "RUN_A.jsonl"),
      [
        JSON.stringify({ decision: "rejected", rule_failed: "quorum", ts: old }),
        JSON.stringify({ decision: "rejected", rule_failed: "quorum", ts: recent }),
        JSON.stringify({ decision: "rejected", rule_failed: "diff-quorum", ts: recent }),
        JSON.stringify({ decision: "promoted", ts: recent }),
      ].join("\n"),
    );
    const rep = await __test.buildReport({ repoRoot: r, now: NOW });
    expect(rep.curator_decisions.in_window_count).toBe(3); // old is filtered out
    expect(rep.curator_decisions.decisions["rejected:quorum"]).toBe(1);
    expect(rep.curator_decisions.decisions["rejected:diff-quorum"]).toBe(1);
    expect(rep.curator_decisions.decisions["promoted:-"]).toBe(1);
  });

  it("aggregates the quorum-fail provider distribution (why-no-promote instrumentation)", async () => {
    const r = repo();
    const dir = join(brainDir(r), "proposals", "curator-decisions");
    mkdirSync(dir, { recursive: true });
    const recent = "2026-05-28T10:00:00.000Z";
    writeFileSync(
      join(dir, "RUN.jsonl"),
      [
        // two stuck at 1/2 (one provider short), one reached 2/3 (diff, one short)
        JSON.stringify({
          decision: "rejected",
          rule_failed: "quorum",
          providers: 1,
          provider_need: 2,
          ts: recent,
        }),
        JSON.stringify({
          decision: "rejected",
          rule_failed: "quorum",
          providers: 1,
          provider_need: 2,
          ts: recent,
        }),
        JSON.stringify({
          decision: "rejected",
          rule_failed: "diff-quorum",
          providers: 2,
          provider_need: 3,
          ts: recent,
        }),
      ].join("\n"),
    );
    const qs = (await __test.buildReport({ repoRoot: r, now: NOW })).curator_decisions.quorum_stuck;
    expect(qs.total_quorum_fails).toBe(3);
    expect(qs.by_providers["1/2"]).toBe(2);
    expect(qs.by_providers["2/3"]).toBe(1);
    expect(qs.one_short).toBe(3); // all three were exactly one provider short
  });
});

describe("learn status — FP ledger + cluster view", () => {
  it("surfaces cluster from gemini-prisma scenario as near-active", async () => {
    const r = repo();
    mkdirSync(learningsDir(r), { recursive: true });
    writeFileSync(
      knownFpPath(r),
      JSON.stringify({
        schema: "reviewgate.fpledger.v1",
        entries: [
          {
            id: "FP-001",
            signature: "s1",
            rule_id: "prisma-attribute-corruption",
            category: "correctness",
            file: "prisma/schema.prisma",
            symbol: "",
            stage: "candidate",
            rejects: [{ run_id: "R", provider: "gemini", ts: NOW, reason: "" }],
            distinct_providers: ["gemini"],
            first_seen_at: NOW,
            last_seen_at: NOW,
            created_at: NOW,
          },
          {
            id: "FP-002",
            signature: "s2",
            rule_id: "prisma-corrupted-attribute",
            category: "correctness",
            file: "prisma/schema.prisma",
            symbol: "",
            stage: "candidate",
            rejects: [{ run_id: "R", provider: "gemini", ts: NOW, reason: "" }],
            distinct_providers: ["gemini"],
            first_seen_at: NOW,
            last_seen_at: NOW,
            created_at: NOW,
          },
          {
            id: "FP-003",
            signature: "s3",
            rule_id: "prisma-invalid-attribute",
            category: "correctness",
            file: "prisma/schema.prisma",
            symbol: "",
            stage: "candidate",
            rejects: [{ run_id: "R", provider: "gemini", ts: NOW, reason: "" }],
            distinct_providers: ["gemini"],
            first_seen_at: NOW,
            last_seen_at: NOW,
            created_at: NOW,
          },
        ],
      }),
    );
    const rep = await __test.buildReport({ repoRoot: r, now: NOW });
    expect(rep.fp_ledger.candidate).toBe(3);
    expect(rep.fp_ledger.clusters.total).toBe(1);
    expect(rep.fp_ledger.clusters.near_active).toBe(1);
    expect(rep.fp_ledger.clusters.near_or_promoted[0]?.key).toBe("prisma@prisma/schema.prisma");
  });
});

describe("learn status — reputation", () => {
  it("orders reviewers worst-trust first and computes the windowed trust", async () => {
    const r = repo();
    mkdirSync(reviewgateDir(r), { recursive: true });
    writeFileSync(
      reputationJsonPath(r),
      JSON.stringify({
        schema: "reviewgate.reputation.v1",
        reviewers: {
          "good:p": {
            correct: [
              { eid: "1", ts: NOW },
              { eid: "2", ts: NOW },
              { eid: "3", ts: NOW },
            ],
            wrong: [],
          },
          "bad:p": { correct: [], wrong: [{ eid: "1", ts: NOW }] },
        },
      }),
    );
    const rep = await __test.buildReport({ repoRoot: r, now: NOW });
    expect(rep.reputation).toHaveLength(2);
    // worst first
    expect(rep.reputation[0]?.key).toBe("bad:p");
    expect(rep.reputation[1]?.key).toBe("good:p");
    expect(rep.reputation[0]?.trust).toBeLessThan(rep.reputation[1]?.trust as number);
  });
});

describe("learn status — text rendering smoke", () => {
  it("renders all section headers in default text mode", async () => {
    const r = repo();
    let out = "";
    await runLearnStatus({
      repoRoot: r,
      now: NOW,
      write: (s) => {
        out += s;
      },
    });
    expect(out).toContain("Brain ");
    expect(out).toContain("Cross-run candidates");
    expect(out).toContain("Proposal pools");
    expect(out).toContain("Curator decisions");
    expect(out).toContain("FP ledger");
    expect(out).toContain("Reputation");
  });
});

// Brand-unused-export guard — silences the linter if `brainCandidatesPath` is
// only referenced indirectly through the source module above.
void brainCandidatesPath;
