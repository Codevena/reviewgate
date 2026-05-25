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
      { provider: "codex", outcome: "wrong", eid: "e1", ts: "2026-05-25T00:00:00Z" },
      { provider: "codex", outcome: "wrong", eid: "e1", ts: "2026-05-25T00:00:00Z" },
      { provider: "codex", outcome: "correct", eid: "e2", ts: "2026-05-25T00:00:00Z" },
    ]);
    const snap = await s.snapshot();
    expect(snap.reviewers.codex?.wrong).toHaveLength(1);
    expect(snap.reviewers.codex?.correct).toHaveLength(1);
  });

  it("unreliableProviders returns providers below floor with enough samples", async () => {
    const r = repo();
    const s = new ReputationStore(r);
    const now = new Date("2026-05-25T00:00:00Z");
    const events = (n: number, base: string) =>
      Array.from({ length: n }, (_, i) => ({
        provider: "gemini" as const,
        outcome: "wrong" as const,
        eid: `${base}${i}`,
        ts: now.toISOString(),
      }));
    await s.record(events(10, "w"));
    expect(await s.unreliableProviders(CFG, now)).toContain("gemini");
    await s.record([{ provider: "codex", outcome: "wrong", eid: "c1", ts: now.toISOString() }]);
    expect(await s.unreliableProviders(CFG, now)).not.toContain("codex");
  });
});
