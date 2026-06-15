// tests/unit/reputation-restop-idempotency.test.ts
//
// Finding 6: the F-20 last-wins fold only protects a SINGLE absorb. Two re-stops
// within the same iteration are separate absorbs reading the same (growing)
// decisions file. Absorb #1 books 'wrong'; after the agent retracts to
// 'accepted', absorb #2 books 'correct'. Because the eid previously included the
// verdict, the two events landed in different buckets and BOTH survived — a
// single iteration ended up holding a contradictory wrong+correct pair for one
// reviewer. The eid is now verdict-free and the store reconciles across buckets,
// so a re-stop flip supersedes rather than accumulates.
import { describe, expect, it } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { learnReputationFromDecisions } from "../../src/core/reputation/learn.ts";
import { ReputationStore } from "../../src/core/reputation/store.ts";
import { decisionsPath, pendingJsonPath } from "../../src/utils/paths.ts";

describe("learnReputationFromDecisions — re-stop idempotency within one iteration (Finding 6)", () => {
  it("never books both 'wrong' and 'correct' for one reviewer across two re-stops in one iter", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-restop-"));
    mkdirSync(join(repo, ".reviewgate"), { recursive: true });
    writeFileSync(
      pendingJsonPath(repo),
      JSON.stringify({
        findings: [
          {
            id: "F-001",
            severity: "CRITICAL",
            reviewer: { provider: "gemini", persona: "security" },
            confirmed_by: ["gemini:security"],
            members: [],
          },
        ],
      }),
    );
    const dp = decisionsPath(repo, 1);
    mkdirSync(dirname(dp), { recursive: true });

    const store = new ReputationStore(repo);
    const args = {
      repoRoot: repo,
      iter: 1,
      sessionId: "S",
      cycleSeq: 0,
      store,
      nowIso: new Date().toISOString(),
    };

    // --- Re-stop #1: the agent first REJECTS the finding as a false positive. ---
    writeFileSync(
      dp,
      `${JSON.stringify({
        schema: "reviewgate.decision.v1",
        finding_id: "F-001",
        verdict: "rejected",
        reason: "looked like a false positive on first read xx",
        reviewer_was_wrong: true,
      })}\n`,
    );
    await learnReputationFromDecisions(args);
    {
      const e = (await store.snapshot()).reviewers["gemini:security"];
      expect(e?.wrong ?? []).toHaveLength(1);
      expect(e?.correct ?? []).toHaveLength(0);
    }

    // --- Re-stop #2: the agent RETRACTS and accepts/fixes it (appended line). ---
    appendFileSync(
      dp,
      `${JSON.stringify({
        schema: "reviewgate.decision.v1",
        finding_id: "F-001",
        verdict: "accepted",
        action: "fixed",
      })}\n`,
    );
    await learnReputationFromDecisions(args);

    const e = (await store.snapshot()).reviewers["gemini:security"];
    // The retracted rejection must be superseded — exactly one outcome, and it is
    // the final 'correct'. Never both.
    expect(e?.wrong ?? []).toHaveLength(0);
    expect(e?.correct ?? []).toHaveLength(1);
  });
});
