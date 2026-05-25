import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { learnReputationFromDecisions } from "../../src/core/reputation/learn.ts";
import { ReputationStore } from "../../src/core/reputation/store.ts";
import { decisionsPath, pendingJsonPath } from "../../src/utils/paths.ts";

describe("learnReputationFromDecisions", () => {
  it("credits/debits the finding's providers, anchored to real pending ids", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-replearn-"));
    mkdirSync(join(repo, ".reviewgate"), { recursive: true });
    writeFileSync(
      pendingJsonPath(repo),
      JSON.stringify({
        findings: [
          { id: "F-001", severity: "CRITICAL", reviewer: { provider: "gemini" }, members: [] },
          { id: "F-002", severity: "WARN", reviewer: { provider: "codex" }, members: [] },
        ],
      }),
    );
    const dp = decisionsPath(repo, 1);
    mkdirSync(dirname(dp), { recursive: true });
    writeFileSync(
      dp,
      `${[
        JSON.stringify({
          schema: "reviewgate.decision.v1",
          finding_id: "F-001",
          verdict: "rejected",
          reason: "false positive verified xx",
          reviewer_was_wrong: true,
        }),
        JSON.stringify({
          schema: "reviewgate.decision.v1",
          finding_id: "F-002",
          verdict: "accepted",
          action: "fixed",
        }),
        JSON.stringify({
          schema: "reviewgate.decision.v1",
          finding_id: "F-999",
          verdict: "rejected",
          reason: "not a real finding id here xx",
          reviewer_was_wrong: true,
        }),
      ].join("\n")}\n`,
    );
    const store = new ReputationStore(repo);
    await learnReputationFromDecisions({
      repoRoot: repo,
      iter: 1,
      sessionId: "S",
      cycleSeq: 0,
      store,
      nowIso: new Date().toISOString(),
    });
    const snap = await store.snapshot();
    expect(snap.reviewers.gemini?.wrong).toHaveLength(1);
    expect(snap.reviewers.codex?.correct).toHaveLength(1);
    expect(snap.reviewers["F-999"]).toBeUndefined();
  });

  it("is idempotent across re-application (same iter/cycle → eid dedup)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-replearn2-"));
    mkdirSync(join(repo, ".reviewgate"), { recursive: true });
    writeFileSync(
      pendingJsonPath(repo),
      JSON.stringify({
        findings: [
          { id: "F-001", severity: "CRITICAL", reviewer: { provider: "gemini" }, members: [] },
        ],
      }),
    );
    const dp = decisionsPath(repo, 1);
    mkdirSync(dirname(dp), { recursive: true });
    writeFileSync(
      dp,
      `${JSON.stringify({
        schema: "reviewgate.decision.v1",
        finding_id: "F-001",
        verdict: "rejected",
        reason: "fp verified, checked by grep",
        reviewer_was_wrong: true,
      })}\n`,
    );
    const store = new ReputationStore(repo);
    const args = {
      repoRoot: repo,
      iter: 1,
      sessionId: "S",
      cycleSeq: 0,
      store,
      nowIso: new Date().toISOString(),
    };
    await learnReputationFromDecisions(args);
    await learnReputationFromDecisions(args);
    expect((await store.snapshot()).reviewers.gemini?.wrong).toHaveLength(1);
  });

  it("forwards halfLifeDays to record so stale events are pruned", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-replearn3-"));
    mkdirSync(join(repo, ".reviewgate"), { recursive: true });
    writeFileSync(
      pendingJsonPath(repo),
      JSON.stringify({
        findings: [
          { id: "F-001", severity: "CRITICAL", reviewer: { provider: "gemini" }, members: [] },
        ],
      }),
    );
    const dp = decisionsPath(repo, 1);
    mkdirSync(dirname(dp), { recursive: true });
    writeFileSync(
      dp,
      `${JSON.stringify({
        schema: "reviewgate.decision.v1",
        finding_id: "F-001",
        verdict: "rejected",
        reason: "false positive verified by reading the diff",
        reviewer_was_wrong: true,
      })}\n`,
    );
    const store = new ReputationStore(repo);
    // Seed a 26-year-old gemini event WITHOUT pruning it (large halfLife, contemporaneous now).
    await store.record(
      [{ provider: "gemini", outcome: "wrong", eid: "stale", ts: "2000-01-01T00:00:00Z" }],
      { now: new Date("2000-01-02T00:00:00Z"), halfLifeDays: 45 },
    );
    // learn records a fresh event NOW with a tiny halfLifeDays → the stale event must be pruned.
    await learnReputationFromDecisions({
      repoRoot: repo,
      iter: 1,
      sessionId: "S",
      cycleSeq: 0,
      store,
      nowIso: new Date().toISOString(),
      halfLifeDays: 1,
    });
    const wrong = (await store.snapshot()).reviewers.gemini?.wrong ?? [];
    expect(wrong.map((e) => e.eid)).not.toContain("stale"); // pruned via forwarded halfLifeDays
    expect(wrong).toHaveLength(1); // only the freshly-learned event remains
  });
});
