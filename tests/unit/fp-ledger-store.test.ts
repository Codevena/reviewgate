import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FpLedgerStore } from "../../src/core/fp-ledger/store.ts";

const sig = "sig-1";
const meta = { rule_id: "magic-number", category: "quality" as const, file: "a.ts", symbol: "foo" };
const repo = () => mkdtempSync(join(tmpdir(), "rg-fp-"));

describe("FpLedgerStore lifecycle", () => {
  it("first reject creates a candidate (not applied)", async () => {
    const s = new FpLedgerStore(repo());
    await s.recordReject(
      sig,
      meta,
      { run_id: "r1", provider: "codex", reason: "x" },
      "2026-05-21T00:00:00Z",
    );
    const snap = await s.snapshot();
    expect(snap.entries).toHaveLength(1);
    expect(snap.entries[0]?.stage).toBe("candidate");
  });

  it("promotes to active at 3 rejects across ≥2 providers within 60d", async () => {
    const r = repo();
    const s = new FpLedgerStore(r);
    const t = "2026-05-21T00:00:00Z";
    await s.recordReject(sig, meta, { run_id: "r1", provider: "codex", reason: "x" }, t);
    await s.recordReject(sig, meta, { run_id: "r2", provider: "gemini", reason: "x" }, t);
    await s.recordReject(sig, meta, { run_id: "r3", provider: "codex", reason: "x" }, t);
    expect((await s.snapshot()).entries[0]?.stage).toBe("active");
  });

  it("does NOT promote with 3 rejects from a SINGLE provider (anti-poisoning)", async () => {
    const s = new FpLedgerStore(repo());
    const t = "2026-05-21T00:00:00Z";
    for (const run_id of ["r1", "r2", "r3"])
      await s.recordReject(sig, meta, { run_id, provider: "codex", reason: "x" }, t);
    expect((await s.snapshot()).entries[0]?.stage).toBe("candidate");
  });

  it("recordReject is idempotent on (run_id, provider) (no double-count on absorbPriorDecisions re-fire)", async () => {
    const s = new FpLedgerStore(repo());
    const t = "2026-05-21T00:00:00Z";
    // Simulate the shoal escalation re-fire: gate runs once, escalates, then a
    // re-stop processes the same iter's decisions again before any state reset.
    // The same (run_id, provider) reject must NOT be double-counted — that
    // would inflate counts and falsely promote a candidate to active on a
    // single rejection seen twice.
    await s.recordReject(sig, meta, { run_id: "r1", provider: "codex", reason: "x" }, t);
    await s.recordReject(sig, meta, { run_id: "r1", provider: "codex", reason: "x" }, t);
    await s.recordReject(sig, meta, { run_id: "r1", provider: "codex", reason: "x" }, t);
    const e = (await s.snapshot()).entries[0];
    expect(e?.rejects).toHaveLength(1);
    expect(e?.stage).toBe("candidate");
  });

  it("recordReject still records when run_id matches but provider differs", async () => {
    const s = new FpLedgerStore(repo());
    const t = "2026-05-21T00:00:00Z";
    // Different providers on the same finding-id are independent signals.
    await s.recordReject(sig, meta, { run_id: "r1", provider: "codex", reason: "x" }, t);
    await s.recordReject(sig, meta, { run_id: "r1", provider: "gemini", reason: "x" }, t);
    const e = (await s.snapshot()).entries[0];
    expect(e?.rejects).toHaveLength(2);
    expect(e?.distinct_providers.sort()).toEqual(["codex", "gemini"]);
  });

  it("pin makes an entry sticky; unpin reverts toward its earned stage", async () => {
    const s = new FpLedgerStore(repo());
    await s.recordReject(
      sig,
      meta,
      { run_id: "r1", provider: "codex", reason: "x" },
      "2026-05-21T00:00:00Z",
    );
    const id = (await s.snapshot()).entries[0]?.id as string;
    await s.pin(id, "markus");
    expect((await s.snapshot()).entries[0]?.stage).toBe("sticky");
    await s.unpin(id);
    expect((await s.snapshot()).entries[0]?.stage).toBe("candidate");
  });

  it("activeSnapshot returns only active + sticky entries keyed by signature", async () => {
    const s = new FpLedgerStore(repo());
    const t = "2026-05-21T00:00:00Z";
    await s.recordReject(sig, meta, { run_id: "r1", provider: "codex", reason: "x" }, t);
    await s.recordReject(sig, meta, { run_id: "r2", provider: "gemini", reason: "x" }, t);
    await s.recordReject(sig, meta, { run_id: "r3", provider: "claude-code", reason: "x" }, t);
    const active = await s.activeSnapshot();
    expect(active.has(sig)).toBe(true);
  });

  // Build a sticky entry (≥5 rejects, ≥2 providers within 90d) at a fixed time.
  async function makeSticky(s: FpLedgerStore, at: string): Promise<void> {
    await s.recordReject(sig, meta, { run_id: "r1", provider: "codex", reason: "x" }, at);
    await s.recordReject(sig, meta, { run_id: "r2", provider: "codex", reason: "x" }, at);
    await s.recordReject(sig, meta, { run_id: "r3", provider: "codex", reason: "x" }, at);
    await s.recordReject(sig, meta, { run_id: "r4", provider: "gemini", reason: "x" }, at);
    await s.recordReject(sig, meta, { run_id: "r5", provider: "gemini", reason: "x" }, at);
  }

  it("decayPass recomputes a sticky whose rejects all aged past the 90d window (F-017)", async () => {
    // A sticky that earned its stage long ago, whose qualifying rejects have ALL
    // aged out of the 90-day window, must NOT stay sticky forever — otherwise it
    // suppresses a genuinely-real finding at the same signature indefinitely.
    const s = new FpLedgerStore(repo());
    await makeSticky(s, "2026-01-01T00:00:00Z");
    expect((await s.snapshot()).entries[0]?.stage).toBe("sticky");
    // >365d later: every reject is far past STICKY_DAYS=90 → recompute → candidate →
    // dropped by the stale-candidate rule.
    await s.decayPass("2027-06-01T00:00:00Z");
    expect((await s.snapshot()).entries).toHaveLength(0);
  });

  it("activeSnapshot(now) does not serve a sticky whose window has expired (F-017)", async () => {
    // Read-time guarantee: even before decayPass runs, activeSnapshot must not
    // report a stale sticky as active when given the current time.
    const s = new FpLedgerStore(repo());
    await makeSticky(s, "2026-01-01T00:00:00Z");
    const expired = await s.activeSnapshot(new Date("2027-06-01T00:00:00Z"));
    expect(expired.has(sig)).toBe(false);
    // A pinned sticky stays sticky regardless of age (recompute honours pinned_by).
    await s.pin("FP-001", "human");
    const stillPinned = await s.activeSnapshot(new Date("2027-06-01T00:00:00Z"));
    expect(stillPinned.has(sig)).toBe(true);
  });

  it("decayPass removes a stale candidate (no new match for >90d)", async () => {
    const s = new FpLedgerStore(repo());
    await s.recordReject(
      "stale",
      meta,
      { run_id: "r1", provider: "codex", reason: "x" },
      "2025-01-01T00:00:00Z",
    );
    await s.decayPass("2026-05-21T00:00:00Z");
    expect((await s.snapshot()).entries).toHaveLength(0);
  });

  it("allocates monotonic ids — a removed candidate's id is NOT reused", async () => {
    const r = repo();
    const s = new FpLedgerStore(r);
    // FP-001 stale candidate, FP-002 fresh candidate.
    await s.recordReject(
      "sigOld",
      meta,
      { run_id: "r1", provider: "codex", reason: "x" },
      "2025-01-01T00:00:00Z",
    );
    await s.recordReject(
      "sigKeep",
      meta,
      { run_id: "r2", provider: "codex", reason: "x" },
      "2026-05-21T00:00:00Z",
    );
    await s.decayPass("2026-05-21T00:00:00Z"); // drops sigOld (FP-001), keeps FP-002
    await s.recordReject(
      "sigNew",
      meta,
      { run_id: "r3", provider: "codex", reason: "x" },
      "2026-05-21T00:00:00Z",
    );
    const ids = (await s.snapshot()).entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length); // no collision
    expect(ids).toContain("FP-003"); // new id is past the high-water mark, not reused
  });

  it("does NOT reuse a HIGHER id when it is decayed while a lower id survives (F-019)", () => {
    return (async () => {
      const s = new FpLedgerStore(repo());
      // FP-001 pinned → sticky, kept forever. FP-002 candidate, will decay.
      await s.recordReject(
        "sigKeep",
        meta,
        { run_id: "r1", provider: "codex", reason: "x" },
        "2026-01-01T00:00:00Z",
      );
      await s.pin("FP-001", "human");
      await s.recordReject(
        "sigOld",
        meta,
        { run_id: "r2", provider: "codex", reason: "x" },
        "2026-01-01T00:00:00Z",
      );
      await s.decayPass("2026-06-01T00:00:00Z"); // drops FP-002 (candidate, >90d), keeps FP-001
      await s.recordReject(
        "sigNew",
        meta,
        { run_id: "r3", provider: "codex", reason: "x" },
        "2026-06-01T00:00:00Z",
      );
      const ids = (await s.snapshot()).entries.map((e) => e.id).sort();
      // The new entry must NOT reuse the decayed FP-002 id (a stale pending.json
      // pattern_id / brain linked_fp_id could still reference it).
      expect(ids).toEqual(["FP-001", "FP-003"]);
    })();
  });

  it("recordReject does NOT demote an active entry just because old rejects aged out of the window (F-020)", async () => {
    // F-020: recompute() recalculates stage from scratch on every recordReject
    // using only in-window rejects. That created a SECOND, much faster
    // active->candidate demotion path that bypassed decayPass's documented
    // 180-day rule: as soon as old rejects age out of the 60d window, a fresh
    // lone reject would flip the entry back to candidate. recordReject must
    // never DEMOTE an already-earned stage — demotion belongs solely to
    // decayPass's 180d-since-last_seen rule. (Promotion is still allowed.)
    const s = new FpLedgerStore(repo());
    // Earn 'active': 3 rejects, 2 providers, within 60d.
    await s.recordReject(
      sig,
      meta,
      { run_id: "r1", provider: "codex", reason: "x" },
      "2026-01-01T00:00:00Z",
    );
    await s.recordReject(
      sig,
      meta,
      { run_id: "r2", provider: "gemini", reason: "x" },
      "2026-01-01T00:00:00Z",
    );
    await s.recordReject(
      sig,
      meta,
      { run_id: "r3", provider: "codex", reason: "x" },
      "2026-01-01T00:00:00Z",
    );
    expect((await s.snapshot()).entries[0]?.stage).toBe("active");
    // 61d later only 1 of those rejects is still in the 60d window; a NEW lone
    // reject from one provider arrives. Naive recompute would see win60.length < 3
    // and reset to candidate — but decayPass (180d rule) has NOT run.
    await s.recordReject(
      sig,
      meta,
      { run_id: "r4", provider: "codex", reason: "x" },
      "2026-03-03T00:00:00Z",
    );
    expect((await s.snapshot()).entries[0]?.stage).toBe("active");
  });

  it("decayPass recomputes a stale 'active' entry whose rejects aged past the 60d window (F-018)", async () => {
    const s = new FpLedgerStore(repo());
    // active = 3 rejects, 2 providers, within 60d.
    await s.recordReject(
      sig,
      meta,
      { run_id: "r1", provider: "codex", reason: "x" },
      "2026-01-01T00:00:00Z",
    );
    await s.recordReject(
      sig,
      meta,
      { run_id: "r2", provider: "gemini", reason: "x" },
      "2026-01-01T00:00:00Z",
    );
    await s.recordReject(
      sig,
      meta,
      { run_id: "r3", provider: "codex", reason: "x" },
      "2026-01-01T00:00:00Z",
    );
    expect((await s.snapshot()).entries[0]?.stage).toBe("active");
    // 70d later a DUPLICATE (run_id,provider) bumps last_seen_at without adding a
    // reject or recomputing — the entry stays 'active' on disk though its rejects
    // are now all >60d old.
    await s.recordReject(
      sig,
      meta,
      { run_id: "r1", provider: "codex", reason: "x" },
      "2026-03-12T00:00:00Z",
    );
    expect((await s.snapshot()).entries[0]?.stage).toBe("active"); // stale active
    // decayPass must recompute it back to candidate (no longer meets the 60d floor).
    await s.decayPass("2026-03-12T00:00:00Z");
    expect((await s.snapshot()).entries[0]?.stage).toBe("candidate");
  });
});
