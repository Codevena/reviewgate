import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { learnFromDecisions } from "../../src/core/fp-ledger/learn.ts";
import { FpLedgerStore } from "../../src/core/fp-ledger/store.ts";
import { decisionsPath, pendingJsonPath } from "../../src/utils/paths.ts";

describe("learnFromDecisions", () => {
  it("records a reject per member-signature for a rejected reviewer_was_wrong finding", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-fpl-"));
    mkdirSync(dirname(pendingJsonPath(repo)), { recursive: true });
    writeFileSync(
      pendingJsonPath(repo),
      JSON.stringify({
        findings: [
          {
            id: "F-001",
            signature: "rep-sig",
            rule_id: "r",
            category: "quality",
            file: "a.ts",
            line_start: 1,
            line_end: 1,
            message: "m",
            details: "d",
            reviewer: { provider: "codex", model: "x", persona: "security" },
            confidence: 0.5,
            consensus: "majority",
            members: [
              { signature: "sigA", provider: "codex", rule_id: "r", category: "quality" },
              { signature: "sigB", provider: "gemini", rule_id: "r", category: "quality" },
            ],
          },
        ],
      }),
    );
    const dp = decisionsPath(repo, 1);
    mkdirSync(dirname(dp), { recursive: true });
    writeFileSync(
      dp,
      `${JSON.stringify({ schema: "reviewgate.decision.v1", finding_id: "F-001", verdict: "rejected", reason: "false positive on unchanged code", reviewer_was_wrong: true })}\n`,
    );
    const store = new FpLedgerStore(repo);
    await learnFromDecisions({
      repoRoot: repo,
      prevIter: 1,
      sessionId: "S",
      cycleSeq: 0,
      store,
      nowIso: "2026-05-21T00:00:00Z",
    });
    const snap = await store.snapshot();
    const sigs = snap.entries.map((e) => e.signature).sort();
    expect(sigs).toEqual(["sigA", "sigB"]);
    expect(snap.entries.find((e) => e.signature === "sigA")?.distinct_providers).toEqual(["codex"]);
  });

  it("ignores accepted decisions and rejections without reviewer_was_wrong", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-fpl2-"));
    mkdirSync(dirname(pendingJsonPath(repo)), { recursive: true });
    writeFileSync(pendingJsonPath(repo), JSON.stringify({ findings: [] }));
    const dp = decisionsPath(repo, 1);
    mkdirSync(dirname(dp), { recursive: true });
    writeFileSync(
      dp,
      `${JSON.stringify({ schema: "reviewgate.decision.v1", finding_id: "F-001", verdict: "accepted", action: "fixed" })}\n`,
    );
    const store = new FpLedgerStore(repo);
    await learnFromDecisions({
      repoRoot: repo,
      prevIter: 1,
      sessionId: "S",
      cycleSeq: 0,
      store,
      nowIso: "t",
    });
    expect((await store.snapshot()).entries).toHaveLength(0);
  });

  it("accumulates a reject EACH cycle a recurring false-positive is rejected", async () => {
    // A reviewer that hallucinates the SAME false-positive (same signature) every
    // cycle must accumulate one reject PER cycle so the entry can reach
    // active/sticky. The reject idempotency key is (run_id, provider): keying
    // run_id on the POSITIONAL finding_id ("F-001", reused every iteration)
    // collapses every recurrence into one reject — the ledger never learns.
    const repo = mkdtempSync(join(tmpdir(), "rg-fpl-recur-"));
    const pj = pendingJsonPath(repo);
    mkdirSync(dirname(pj), { recursive: true });
    const pendingFor = () =>
      JSON.stringify({
        findings: [
          {
            id: "F-001",
            signature: "sig-X",
            rule_id: "r",
            category: "correctness",
            file: "a.ts",
            line_start: 1,
            line_end: 1,
            message: "m",
            details: "d",
            reviewer: { provider: "codex", model: "x", persona: "security" },
            confidence: 0.5,
            consensus: "singleton",
          },
        ],
      });
    const decisionFor = () =>
      `${JSON.stringify({ schema: "reviewgate.decision.v1", finding_id: "F-001", verdict: "rejected", reason: "false positive, the symbol exists at a.ts:1", reviewer_was_wrong: true })}\n`;
    const store = new FpLedgerStore(repo);

    // Cycle 1
    writeFileSync(pj, pendingFor());
    const dp1 = decisionsPath(repo, 1);
    mkdirSync(dirname(dp1), { recursive: true });
    writeFileSync(dp1, decisionFor());
    await learnFromDecisions({
      repoRoot: repo,
      prevIter: 1,
      sessionId: "S",
      cycleSeq: 0,
      store,
      nowIso: "2026-06-02T00:00:00Z",
    });

    // Cycle 2 — same signature rejected again
    writeFileSync(pj, pendingFor());
    const dp2 = decisionsPath(repo, 2);
    mkdirSync(dirname(dp2), { recursive: true });
    writeFileSync(dp2, decisionFor());
    await learnFromDecisions({
      repoRoot: repo,
      prevIter: 2,
      sessionId: "S",
      cycleSeq: 0,
      store,
      nowIso: "2026-06-02T01:00:00Z",
    });

    const entry = (await store.snapshot()).entries.find((e) => e.signature === "sig-X");
    expect(entry?.rejects).toHaveLength(2);
  });

  it("accumulates ACROSS cycles when iteration resets (clean-PASS re-arm → iter back to 1)", async () => {
    // After a clean PASS the loop resets `iteration` to 0 but bumps
    // reputation_cycle_seq, and the per-repo FP ledger persists. A recurring FP
    // rejected at iter 1 of cycle 0 and again at iter 1 of cycle 1 must count as
    // TWO rejects — keying run_id on iter alone ("iter-1" both) would dedupe them.
    const repo = mkdtempSync(join(tmpdir(), "rg-fpl-xcycle-"));
    const pj = pendingJsonPath(repo);
    mkdirSync(dirname(pj), { recursive: true });
    const pending = JSON.stringify({
      findings: [
        {
          id: "F-001",
          signature: "sig-Z",
          rule_id: "r",
          category: "correctness",
          file: "a.ts",
          line_start: 1,
          line_end: 1,
          message: "m",
          details: "d",
          reviewer: { provider: "codex", model: "x", persona: "security" },
          confidence: 0.5,
          consensus: "singleton",
        },
      ],
    });
    const decision = `${JSON.stringify({ schema: "reviewgate.decision.v1", finding_id: "F-001", verdict: "rejected", reason: "false positive, the symbol exists at a.ts:1", reviewer_was_wrong: true })}\n`;
    const store = new FpLedgerStore(repo);

    // Cycle 0, iter 1
    writeFileSync(pj, pending);
    const dp1 = decisionsPath(repo, 1);
    mkdirSync(dirname(dp1), { recursive: true });
    writeFileSync(dp1, decision);
    await learnFromDecisions({
      repoRoot: repo,
      prevIter: 1,
      sessionId: "S",
      cycleSeq: 0,
      store,
      nowIso: "2026-06-02T00:00:00Z",
    });

    // Clean PASS happened → iteration reset to 1 again, but cycleSeq advanced to 1.
    writeFileSync(pj, pending);
    await learnFromDecisions({
      repoRoot: repo,
      prevIter: 1,
      sessionId: "S",
      cycleSeq: 1,
      store,
      nowIso: "2026-06-02T02:00:00Z",
    });

    const entry = (await store.snapshot()).entries.find((e) => e.signature === "sig-Z");
    expect(entry?.rejects).toHaveLength(2);
  });

  it("is idempotent when the SAME cycle is re-absorbed (no double-count)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-fpl-idem-"));
    const pj = pendingJsonPath(repo);
    mkdirSync(dirname(pj), { recursive: true });
    writeFileSync(
      pj,
      JSON.stringify({
        findings: [
          {
            id: "F-001",
            signature: "sig-Y",
            rule_id: "r",
            category: "correctness",
            file: "a.ts",
            line_start: 1,
            line_end: 1,
            message: "m",
            details: "d",
            reviewer: { provider: "codex", model: "x", persona: "security" },
            confidence: 0.5,
            consensus: "singleton",
          },
        ],
      }),
    );
    const dp = decisionsPath(repo, 1);
    mkdirSync(dirname(dp), { recursive: true });
    writeFileSync(
      dp,
      `${JSON.stringify({ schema: "reviewgate.decision.v1", finding_id: "F-001", verdict: "rejected", reason: "false positive, the symbol exists", reviewer_was_wrong: true })}\n`,
    );
    const store = new FpLedgerStore(repo);
    await learnFromDecisions({
      repoRoot: repo,
      prevIter: 1,
      sessionId: "S",
      cycleSeq: 0,
      store,
      nowIso: "2026-06-02T00:00:00Z",
    });
    await learnFromDecisions({
      repoRoot: repo,
      prevIter: 1,
      sessionId: "S",
      cycleSeq: 0,
      store,
      nowIso: "2026-06-02T00:00:00Z",
    });
    const entry = (await store.snapshot()).entries.find((e) => e.signature === "sig-Y");
    expect(entry?.rejects).toHaveLength(1);
  });

  it("does NOT learn from a superseded (retracted) rejection — last decision per finding_id wins (F-19)", async () => {
    // The append-only decisions file may carry a superseding disposition for a
    // finding within one iteration (rejected → later accepted after a re-block).
    // Booking the retracted rejection would march the signature toward
    // active/sticky and eventually demote a finding the agent ACCEPTED as real.
    const repo = mkdtempSync(join(tmpdir(), "rg-fpl-supersede-"));
    mkdirSync(dirname(pendingJsonPath(repo)), { recursive: true });
    writeFileSync(
      pendingJsonPath(repo),
      JSON.stringify({
        findings: [
          {
            id: "F-001",
            signature: "sig-S",
            rule_id: "r",
            category: "correctness",
            file: "a.ts",
            line_start: 1,
            line_end: 1,
            message: "m",
            details: "d",
            reviewer: { provider: "codex", model: "x", persona: "security" },
            confidence: 0.5,
            consensus: "singleton",
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
          reason: "false positive on unchanged code xx",
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
    const store = new FpLedgerStore(repo);
    await learnFromDecisions({
      repoRoot: repo,
      prevIter: 1,
      sessionId: "S",
      cycleSeq: 0,
      store,
      nowIso: "2026-06-10T00:00:00Z",
    });
    expect((await store.snapshot()).entries).toHaveLength(0);
  });

  it("DOES learn when a rejection supersedes an earlier accept (last line wins)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-fpl-supersede2-"));
    mkdirSync(dirname(pendingJsonPath(repo)), { recursive: true });
    writeFileSync(
      pendingJsonPath(repo),
      JSON.stringify({
        findings: [
          {
            id: "F-001",
            signature: "sig-T",
            rule_id: "r",
            category: "correctness",
            file: "a.ts",
            line_start: 1,
            line_end: 1,
            message: "m",
            details: "d",
            reviewer: { provider: "codex", model: "x", persona: "security" },
            confidence: 0.5,
            consensus: "singleton",
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
          action: "fixed",
        }),
        JSON.stringify({
          schema: "reviewgate.decision.v1",
          finding_id: "F-001",
          verdict: "rejected",
          reason: "false positive on unchanged code xx",
          reviewer_was_wrong: true,
        }),
      ].join("\n")}\n`,
    );
    const store = new FpLedgerStore(repo);
    await learnFromDecisions({
      repoRoot: repo,
      prevIter: 1,
      sessionId: "S",
      cycleSeq: 0,
      store,
      nowIso: "2026-06-10T00:00:00Z",
    });
    const entry = (await store.snapshot()).entries.find((e) => e.signature === "sig-T");
    expect(entry?.rejects).toHaveLength(1);
  });

  it("is a no-op for prevIter < 1", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-fpl3-"));
    const store = new FpLedgerStore(repo);
    await learnFromDecisions({
      repoRoot: repo,
      prevIter: 0,
      sessionId: "S",
      cycleSeq: 0,
      store,
      nowIso: "t",
    });
    expect((await store.snapshot()).entries).toHaveLength(0);
  });

  it("WARN-1 fix (2026-07-10): does NOT learn from a rejected lore finding (synthetic, no real reviewer)", async () => {
    // Lore v1's two synthetic findings (`lore` set) carry reviewer.provider:"lore"
    // — a deterministic gate check, not a real reviewer. Rejecting a stale
    // reminder as "still accurate" (with reviewer_was_wrong:true, a normal
    // spec-documented disposition) must not create a bogus "lore" provider FP
    // signature in the ledger.
    const repo = mkdtempSync(join(tmpdir(), "rg-fpl-lore-"));
    mkdirSync(dirname(pendingJsonPath(repo)), { recursive: true });
    writeFileSync(
      pendingJsonPath(repo),
      JSON.stringify({
        findings: [
          {
            id: "F-L01",
            signature: "lore:reminder:stale-entry",
            severity: "INFO",
            category: "quality",
            rule_id: "lore.reminder",
            file: ".reviewgate/lore/stale-entry.md",
            line_start: 1,
            line_end: 1,
            message: "m",
            details: "d",
            reviewer: { provider: "lore", model: "deterministic", persona: "lore" },
            confidence: 1,
            consensus: "singleton",
            lore: "reminder",
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
        finding_id: "F-L01",
        verdict: "rejected",
        reason: "still accurate, no change needed right now",
        reviewer_was_wrong: true,
      })}\n`,
    );
    const store = new FpLedgerStore(repo);
    await learnFromDecisions({
      repoRoot: repo,
      prevIter: 1,
      sessionId: "S",
      cycleSeq: 0,
      store,
      nowIso: "2026-07-10T00:00:00Z",
    });
    expect((await store.snapshot()).entries).toHaveLength(0);
  });

  it("dedups members by (signature, provider) so one decision cannot inflate the quorum", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-fpl4-"));
    mkdirSync(dirname(pendingJsonPath(repo)), { recursive: true });
    writeFileSync(
      pendingJsonPath(repo),
      JSON.stringify({
        findings: [
          {
            id: "F-001",
            signature: "rep",
            rule_id: "r",
            category: "quality",
            file: "a.ts",
            line_start: 1,
            line_end: 1,
            message: "m",
            details: "d",
            reviewer: { provider: "codex", model: "x", persona: "security" },
            confidence: 0.5,
            consensus: "majority",
            // codex clustered TWICE (e.g. two personas at the same location → same
            // signature) plus gemini once. Without dedup this single decision would
            // book 3 rejects across 2 providers → instant `active`.
            members: [
              { signature: "sigA", provider: "codex", rule_id: "r", category: "quality" },
              { signature: "sigA", provider: "codex", rule_id: "r", category: "quality" },
              { signature: "sigA", provider: "gemini", rule_id: "r", category: "quality" },
            ],
          },
        ],
      }),
    );
    const dp = decisionsPath(repo, 1);
    mkdirSync(dirname(dp), { recursive: true });
    writeFileSync(
      dp,
      `${JSON.stringify({ schema: "reviewgate.decision.v1", finding_id: "F-001", verdict: "rejected", reason: "false positive on unchanged code", reviewer_was_wrong: true })}\n`,
    );
    const store = new FpLedgerStore(repo);
    await learnFromDecisions({
      repoRoot: repo,
      prevIter: 1,
      sessionId: "S",
      cycleSeq: 0,
      store,
      nowIso: "2026-05-21T00:00:00Z",
    });
    const e = (await store.snapshot()).entries.find((x) => x.signature === "sigA");
    expect(e?.rejects).toHaveLength(2); // codex once + gemini once, not 3
    expect(e?.distinct_providers.sort()).toEqual(["codex", "gemini"]);
    expect(e?.stage).toBe("candidate"); // 2 rejects < 3 → NOT active from one decision
  });
});
