// tests/unit/reputation-prune-invalid-ts.test.ts
//
// Finding 7: pruneBucket previously KEPT future-dated and unparseable-timestamp
// events forever (mirroring decayedCount's weight-1 treatment), defeating the
// bounded-file guarantee — a clock-skewed or corrupt timestamp could never age
// out, so such events would grow reputation.json without bound. Prune now drops
// them as invalid.
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReputationStore } from "../../src/core/reputation/store.ts";

const repo = () => mkdtempSync(join(tmpdir(), "rg-rep-prune-"));

describe("ReputationStore.record — pruning drops invalid timestamps (Finding 7)", () => {
  it("drops future-dated and unparseable-timestamp events on write, keeps valid recent ones", async () => {
    const s = new ReputationStore(repo());
    const now = new Date("2026-05-25T00:00:00Z");
    const DAY = 86_400_000;
    const recent = new Date(now.getTime() - 10 * DAY).toISOString();
    const future = new Date(now.getTime() + 30 * DAY).toISOString(); // clock-skew / future
    await s.record(
      [
        { reviewerKey: "codex:security", outcome: "wrong", eid: "recent", ts: recent },
        { reviewerKey: "codex:security", outcome: "wrong", eid: "future", ts: future },
        { reviewerKey: "codex:security", outcome: "wrong", eid: "garbage", ts: "not-a-date" },
      ],
      { now, halfLifeDays: 45 },
    );
    const eids = ((await s.snapshot()).reviewers["codex:security"]?.wrong ?? []).map((e) => e.eid);
    expect(eids).toContain("recent"); // valid → kept
    expect(eids).not.toContain("future"); // future-dated → dropped as invalid
    expect(eids).not.toContain("garbage"); // unparseable → dropped as invalid
    expect(eids).toHaveLength(1);
  });
});
