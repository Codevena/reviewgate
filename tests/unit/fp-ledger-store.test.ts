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
});
