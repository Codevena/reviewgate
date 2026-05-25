import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReputationStore } from "../../src/core/reputation/store.ts";

const repo = () => mkdtempSync(join(tmpdir(), "rg-rep-"));
const CFG = { enabled: true, minSamples: 8, trustFloor: 0.35, halfLifeDays: 45 };

describe("ReputationStore", () => {
  it("records correct/wrong events and dedups by eid", async () => {
    const r = repo();
    const s = new ReputationStore(r);
    await s.record([
      { reviewerKey: "codex:security", outcome: "wrong", eid: "e1", ts: "2026-05-25T00:00:00Z" },
      { reviewerKey: "codex:security", outcome: "wrong", eid: "e1", ts: "2026-05-25T00:00:00Z" },
      { reviewerKey: "codex:security", outcome: "correct", eid: "e2", ts: "2026-05-25T00:00:00Z" },
    ]);
    const snap = await s.snapshot();
    expect(snap.reviewers["codex:security"]?.wrong).toHaveLength(1);
    expect(snap.reviewers["codex:security"]?.correct).toHaveLength(1);
  });

  it("unreliableReviewers returns reviewers below floor with enough samples", async () => {
    const r = repo();
    const s = new ReputationStore(r);
    const now = new Date("2026-05-25T00:00:00Z");
    const events = (n: number, base: string) =>
      Array.from({ length: n }, (_, i) => ({
        reviewerKey: "gemini:security" as const,
        outcome: "wrong" as const,
        eid: `${base}${i}`,
        ts: now.toISOString(),
      }));
    await s.record(events(10, "w"));
    expect(await s.unreliableReviewers(CFG, now)).toContain("gemini:security");
    await s.record([
      { reviewerKey: "codex:security", outcome: "wrong", eid: "c1", ts: now.toISOString() },
    ]);
    expect(await s.unreliableReviewers(CFG, now)).not.toContain("codex:security");
  });

  it("prunes events older than 6x halfLifeDays on write, keeps recent ones", async () => {
    const r = repo();
    const s = new ReputationStore(r);
    const now = new Date("2026-05-25T00:00:00Z");
    const halfLifeDays = 45;
    const DAY = 86_400_000;
    const old = new Date(now.getTime() - 7 * halfLifeDays * DAY).toISOString(); // 315d > 270d horizon
    const recent = new Date(now.getTime() - 10 * DAY).toISOString();
    await s.record(
      [
        { reviewerKey: "codex:security", outcome: "wrong", eid: "old", ts: old },
        { reviewerKey: "codex:security", outcome: "wrong", eid: "recent", ts: recent },
      ],
      { now, halfLifeDays },
    );
    const eids = ((await s.snapshot()).reviewers["codex:security"]?.wrong ?? []).map((e) => e.eid);
    expect(eids).toContain("recent");
    expect(eids).not.toContain("old");
  });

  it("keeps future-dated and unparseable ts events (treated as fresh)", async () => {
    const r = repo();
    const s = new ReputationStore(r);
    const now = new Date("2026-05-25T00:00:00Z");
    const future = new Date(now.getTime() + 86_400_000).toISOString();
    await s.record(
      [
        { reviewerKey: "codex:security", outcome: "correct", eid: "future", ts: future },
        { reviewerKey: "codex:security", outcome: "correct", eid: "bad", ts: "not-a-date" },
      ],
      { now, halfLifeDays: 45 },
    );
    const eids = ((await s.snapshot()).reviewers["codex:security"]?.correct ?? []).map(
      (e) => e.eid,
    );
    expect(eids).toContain("future");
    expect(eids).toContain("bad");
  });

  it("pruning on a write does not drop another reviewer's recent events", async () => {
    const r = repo();
    const s = new ReputationStore(r);
    const now = new Date("2026-05-25T00:00:00Z");
    await s.record(
      [{ reviewerKey: "gemini:security", outcome: "wrong", eid: "g1", ts: now.toISOString() }],
      {
        now,
        halfLifeDays: 45,
      },
    );
    await s.record(
      [{ reviewerKey: "codex:security", outcome: "wrong", eid: "c1", ts: now.toISOString() }],
      {
        now,
        halfLifeDays: 45,
      },
    );
    expect((await s.snapshot()).reviewers["gemini:security"]?.wrong).toHaveLength(1);
  });

  it("keeps an event exactly at the 6x horizon (inclusive boundary)", async () => {
    const r = repo();
    const s = new ReputationStore(r);
    const now = new Date("2026-05-25T00:00:00Z");
    const halfLifeDays = 45;
    const atHorizon = new Date(now.getTime() - 6 * halfLifeDays * 86_400_000).toISOString();
    await s.record(
      [{ reviewerKey: "codex:security", outcome: "wrong", eid: "edge", ts: atHorizon }],
      {
        now,
        halfLifeDays,
      },
    );
    const eids = ((await s.snapshot()).reviewers["codex:security"]?.wrong ?? []).map((e) => e.eid);
    expect(eids).toContain("edge");
  });

  it("prunes a stale event of a non-touched reviewer when another reviewer triggers a write", async () => {
    const r = repo();
    const s = new ReputationStore(r);
    const halfLifeDays = 45;
    const seedNow = new Date("2025-01-01T00:00:00Z");
    // Seed a gemini event without pruning it (contemporaneous now).
    await s.record(
      [
        {
          reviewerKey: "gemini:security",
          outcome: "wrong",
          eid: "stale",
          ts: seedNow.toISOString(),
        },
      ],
      {
        now: seedNow,
        halfLifeDays,
      },
    );
    // A much later write for codex must prune gemini's now-stale event (>270d old).
    const laterNow = new Date(seedNow.getTime() + 7 * halfLifeDays * 86_400_000);
    await s.record(
      [{ reviewerKey: "codex:security", outcome: "wrong", eid: "c1", ts: laterNow.toISOString() }],
      {
        now: laterNow,
        halfLifeDays,
      },
    );
    expect((await s.snapshot()).reviewers["gemini:security"]?.wrong ?? []).toHaveLength(0);
  });

  it("quarantinedReviewers returns only reviewers below the quarantine floor", async () => {
    const r = repo();
    const s = new ReputationStore(r);
    const now = new Date("2026-05-25T00:00:00Z");
    await s.record(
      Array.from({ length: 10 }, (_, i) => ({
        reviewerKey: "gemini:security" as const,
        outcome: "wrong" as const,
        eid: `g${i}`,
        ts: now.toISOString(),
      })),
      { now, halfLifeDays: 45 },
    );
    await s.record(
      [
        ...Array.from({ length: 7 }, (_, i) => ({
          reviewerKey: "codex:security" as const,
          outcome: "wrong" as const,
          eid: `cw${i}`,
          ts: now.toISOString(),
        })),
        ...Array.from({ length: 3 }, (_, i) => ({
          reviewerKey: "codex:security" as const,
          outcome: "correct" as const,
          eid: `cc${i}`,
          ts: now.toISOString(),
        })),
      ],
      { now, halfLifeDays: 45 },
    );
    const cfg = { enabled: true, minSamples: 8, trustFloor: 0.35, halfLifeDays: 45 };
    const q = await s.quarantinedReviewers(
      { ...cfg, quarantine: { enabled: true, floor: 0.15 } },
      now,
    );
    expect(q).toContain("gemini:security");
    expect(q).not.toContain("codex:security"); // demote-range, not quarantine
    const u = await s.unreliableReviewers(cfg, now);
    expect(u).toContain("gemini:security");
    expect(u).toContain("codex:security");
  });

  it("quarantinedReviewers ignores legacy bare keys and respects minSamples", async () => {
    const r = repo();
    const s = new ReputationStore(r);
    const now = new Date("2026-05-25T00:00:00Z");
    await s.record(
      [{ reviewerKey: "codex" as const, outcome: "wrong", eid: "x", ts: now.toISOString() }],
      { now, halfLifeDays: 45 },
    );
    await s.record(
      Array.from({ length: 3 }, (_, i) => ({
        reviewerKey: "gemini:security" as const,
        outcome: "wrong" as const,
        eid: `s${i}`,
        ts: now.toISOString(),
      })),
      { now, halfLifeDays: 45 },
    );
    const q = await s.quarantinedReviewers(
      {
        enabled: true,
        minSamples: 8,
        trustFloor: 0.35,
        halfLifeDays: 45,
        quarantine: { enabled: true, floor: 0.15 },
      },
      now,
    );
    expect(q.has("codex")).toBe(false);
    expect(q.has("gemini:security")).toBe(false);
  });

  it("quarantinedReviewers returns empty when quarantine is disabled", async () => {
    const r = repo();
    const s = new ReputationStore(r);
    const now = new Date("2026-05-25T00:00:00Z");
    await s.record(
      Array.from({ length: 10 }, (_, i) => ({
        reviewerKey: "gemini:security" as const,
        outcome: "wrong" as const,
        eid: `g${i}`,
        ts: now.toISOString(),
      })),
      { now, halfLifeDays: 45 },
    );
    const q = await s.quarantinedReviewers(
      {
        enabled: true,
        minSamples: 8,
        trustFloor: 0.35,
        halfLifeDays: 45,
        quarantine: { enabled: false, floor: 0.15 },
      },
      now,
    );
    expect(q.size).toBe(0);
  });

  it("forDoctor marks quarantined reviewers when quarantine is enabled", async () => {
    const r = repo();
    const s = new ReputationStore(r);
    const now = new Date("2026-05-25T00:00:00Z");
    await s.record(
      Array.from({ length: 10 }, (_, i) => ({
        reviewerKey: "gemini:security" as const,
        outcome: "wrong" as const,
        eid: `g${i}`,
        ts: now.toISOString(),
      })),
      { now, halfLifeDays: 45 },
    );
    const base = { enabled: true, minSamples: 8, trustFloor: 0.35, halfLifeDays: 45 };
    const rowOn = (
      await s.forDoctor({ ...base, quarantine: { enabled: true, floor: 0.15 } }, now)
    ).find((x) => x.reviewer === "gemini:security");
    expect(rowOn?.quarantined).toBe(true);
    expect(rowOn?.demoting).toBe(true);
    const rowOff = (await s.forDoctor(base, now)).find((x) => x.reviewer === "gemini:security");
    expect(rowOff?.quarantined).toBe(false);
  });

  it("ignores legacy bare-provider keys (no colon) in unreliableReviewers and forDoctor", async () => {
    const r = repo();
    const s = new ReputationStore(r);
    const now = new Date("2026-05-25T00:00:00Z");
    // Seed a below-floor LEGACY bare key ("codex", no persona segment).
    await s.record(
      Array.from({ length: 10 }, (_, i) => ({
        reviewerKey: "codex" as const,
        outcome: "wrong" as const,
        eid: `legacy${i}`,
        ts: now.toISOString(),
      })),
      { now, halfLifeDays: 45 },
    );
    const cfg = { enabled: true, minSamples: 8, trustFloor: 0.35, halfLifeDays: 45 };
    expect(await s.unreliableReviewers(cfg, now)).not.toContain("codex");
    expect((await s.forDoctor(cfg, now)).some((row) => row.reviewer === "codex")).toBe(false);
  });
});
