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
          {
            id: "F-001",
            severity: "CRITICAL",
            reviewer: { provider: "gemini", persona: "security" },
            confirmed_by: ["gemini:security"],
            members: [],
          },
          {
            id: "F-002",
            severity: "WARN",
            reviewer: { provider: "codex", persona: "quality" },
            confirmed_by: ["codex:quality"],
            members: [],
          },
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
    expect(snap.reviewers["gemini:security"]?.wrong).toHaveLength(1);
    expect(snap.reviewers["codex:quality"]?.correct).toHaveLength(1);
    expect(snap.reviewers["F-999"]).toBeUndefined();
  });

  it("is idempotent across re-application (same iter/cycle → eid dedup)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-replearn2-"));
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
    expect((await store.snapshot()).reviewers["gemini:security"]?.wrong).toHaveLength(1);
  });

  it("forwards halfLifeDays to record so stale events are pruned", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-replearn3-"));
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
      [
        {
          reviewerKey: "gemini:security",
          outcome: "wrong",
          eid: "stale",
          ts: "2000-01-01T00:00:00Z",
        },
      ],
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
    const wrong = (await store.snapshot()).reviewers["gemini:security"]?.wrong ?? [];
    expect(wrong.map((e) => e.eid)).not.toContain("stale"); // pruned via forwarded halfLifeDays
    expect(wrong).toHaveLength(1); // only the freshly-learned event remains
  });

  it("credits a 'correct' event for accepted-but-not-fixed actions (recovery path, F-023)", async () => {
    // F-023: a demoted reviewer's findings are mostly demoted to advisory INFO and
    // never get an accepted+fixed decision, so the only recovery used to be old-event
    // time-decay. An `accepted` verdict means the reviewer was RIGHT regardless of how
    // the agent resolved it (fixed / addressed-elsewhere / deferred-with-followup), so
    // every accepted action must mint a `correct` event to widen the recovery path.
    const repo = mkdtempSync(join(tmpdir(), "rg-replearn-recover-"));
    mkdirSync(join(repo, ".reviewgate"), { recursive: true });
    writeFileSync(
      pendingJsonPath(repo),
      JSON.stringify({
        findings: [
          {
            id: "F-001",
            severity: "WARN",
            reviewer: { provider: "codex", persona: "quality" },
            confirmed_by: ["codex:quality"],
            members: [],
          },
          {
            id: "F-002",
            severity: "WARN",
            reviewer: { provider: "gemini", persona: "quality" },
            confirmed_by: ["gemini:quality"],
            members: [],
          },
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
          verdict: "accepted",
          action: "addressed-elsewhere",
        }),
        JSON.stringify({
          schema: "reviewgate.decision.v1",
          finding_id: "F-002",
          verdict: "accepted",
          action: "deferred-with-followup",
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
    expect(snap.reviewers["codex:quality"]?.correct).toHaveLength(1);
    expect(snap.reviewers["gemini:quality"]?.correct).toHaveLength(1);
    expect(snap.reviewers["codex:quality"]?.wrong ?? []).toHaveLength(0);
    expect(snap.reviewers["gemini:quality"]?.wrong ?? []).toHaveLength(0);
  });

  it("does NOT credit a reviewer for an acknowledged-low-value off-ramp (neutral, N2)", async () => {
    // The off-ramp means "noted, not worth fixing" — the agent did NOT validate the
    // finding as correct, so it must be reputation-neutral (no `correct`, no `wrong`).
    const repo = mkdtempSync(join(tmpdir(), "rg-replearn-ack-"));
    mkdirSync(join(repo, ".reviewgate"), { recursive: true });
    writeFileSync(
      pendingJsonPath(repo),
      JSON.stringify({
        findings: [
          {
            id: "F-001",
            severity: "WARN",
            reviewer: { provider: "codex", persona: "quality" },
            confirmed_by: ["codex:quality"],
            members: [],
          },
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
        verdict: "accepted",
        action: "acknowledged-low-value",
      })}\n`,
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
    expect(snap.reviewers["codex:quality"]).toBeUndefined(); // no reputation event at all
  });

  it("does NOT credit a reviewer for a verified-not-applicable disposition (neutral, P6)", async () => {
    // The reviewer raised a legitimate concern the agent VERIFIED does not apply here —
    // neither validated-correct (no defect confirmed) nor wrong → reputation-NEUTRAL.
    const repo = mkdtempSync(join(tmpdir(), "rg-replearn-vna-"));
    mkdirSync(join(repo, ".reviewgate"), { recursive: true });
    writeFileSync(
      pendingJsonPath(repo),
      JSON.stringify({
        findings: [
          {
            id: "F-001",
            severity: "CRITICAL",
            reviewer: { provider: "codex", persona: "security" },
            confirmed_by: ["codex:security"],
            members: [],
          },
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
        verdict: "accepted",
        action: "verified-not-applicable",
        reason: "Verified against prod DB: the override row is true/100, so the finding is moot",
      })}\n`,
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
    expect((await store.snapshot()).reviewers["codex:security"]).toBeUndefined(); // no event
  });

  it("does NOT credit a reviewer for an out-of-scope disposition (neutral, P2/M6)", async () => {
    // The finding is on a file this session did not author; the reviewer may be right, but the
    // agent neither confirmed a defect in its own work nor rejected it → reputation-NEUTRAL.
    // (Crediting would let an agent inflate a noisy reviewer's trust by out-of-scoping foreign
    // findings — reputation poisoning.)
    const repo = mkdtempSync(join(tmpdir(), "rg-replearn-oos-"));
    mkdirSync(join(repo, ".reviewgate"), { recursive: true });
    writeFileSync(
      pendingJsonPath(repo),
      JSON.stringify({
        findings: [
          {
            id: "F-001",
            severity: "CRITICAL",
            reviewer: { provider: "codex", persona: "security" },
            confirmed_by: ["codex:security"],
            members: [],
          },
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
        verdict: "accepted",
        action: "out-of-scope",
        reason: "This file belongs to the parallel sitemap agent; not my change to touch here.",
      })}\n`,
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
    expect((await store.snapshot()).reviewers["codex:security"]).toBeUndefined(); // no event
  });

  it("does NOT mint a 'wrong' event for a plain rejection (reviewer_was_wrong unset)", async () => {
    // A rejection without reviewer_was_wrong:true is a non-signal (e.g. won't-fix /
    // disagree-but-not-a-hallucination) and must not debit the reviewer — debiting it
    // would deepen the recovery trap that F-023 is about.
    const repo = mkdtempSync(join(tmpdir(), "rg-replearn-plainreject-"));
    mkdirSync(join(repo, ".reviewgate"), { recursive: true });
    writeFileSync(
      pendingJsonPath(repo),
      JSON.stringify({
        findings: [
          {
            id: "F-001",
            severity: "WARN",
            reviewer: { provider: "codex", persona: "quality" },
            confirmed_by: ["codex:quality"],
            members: [],
          },
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
        reason: "valid concern but out of scope for this change",
      })}\n`,
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
    expect(snap.reviewers["codex:quality"]).toBeUndefined();
  });

  it("credits each distinct provider:persona in confirmed_by separately", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-replearn4-"));
    mkdirSync(join(repo, ".reviewgate"), { recursive: true });
    writeFileSync(
      pendingJsonPath(repo),
      JSON.stringify({
        findings: [
          {
            id: "F-001",
            severity: "CRITICAL",
            reviewer: { provider: "codex", persona: "security" },
            confirmed_by: ["codex:security", "codex:architecture"],
            members: [],
          },
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
        reason: "false positive confirmed by reading the code",
        reviewer_was_wrong: true,
      })}\n`,
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
    expect(snap.reviewers["codex:security"]?.wrong).toHaveLength(1);
    expect(snap.reviewers["codex:architecture"]?.wrong).toHaveLength(1);
  });

  it("books only the FINAL disposition for a superseded decision — never both 'wrong' and 'correct' (F-20)", async () => {
    // The append-only decisions file may carry a superseding disposition for a
    // finding within one iteration (rejected → later accepted). The eid includes
    // the verdict, so dedup alone does NOT collapse the contradictory pair; the
    // learner must fold to last-wins so the agent's retracted rejection never
    // permanently debits the reviewer it ultimately validated.
    const repo = mkdtempSync(join(tmpdir(), "rg-replearn-supersede-"));
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
    writeFileSync(
      dp,
      `${[
        JSON.stringify({
          schema: "reviewgate.decision.v1",
          finding_id: "F-001",
          verdict: "rejected",
          reason: "false positive verified by grep xx",
          reviewer_was_wrong: true,
        }),
        JSON.stringify({
          schema: "reviewgate.decision.v1",
          finding_id: "F-001",
          verdict: "accepted",
          action: "fixed",
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
    const entry = (await store.snapshot()).reviewers["gemini:security"];
    expect(entry?.wrong ?? []).toHaveLength(0); // retracted rejection never debits
    expect(entry?.correct).toHaveLength(1); // only the final (accepted) disposition books
  });
});
