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
    await learnFromDecisions({ repoRoot: repo, prevIter: 1, store, nowIso: "t" });
    expect((await store.snapshot()).entries).toHaveLength(0);
  });

  it("is a no-op for prevIter < 1", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-fpl3-"));
    const store = new FpLedgerStore(repo);
    await learnFromDecisions({ repoRoot: repo, prevIter: 0, store, nowIso: "t" });
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
      store,
      nowIso: "2026-05-21T00:00:00Z",
    });
    const e = (await store.snapshot()).entries.find((x) => x.signature === "sigA");
    expect(e?.rejects).toHaveLength(2); // codex once + gemini once, not 3
    expect(e?.distinct_providers.sort()).toEqual(["codex", "gemini"]);
    expect(e?.stage).toBe("candidate"); // 2 rejects < 3 → NOT active from one decision
  });
});
