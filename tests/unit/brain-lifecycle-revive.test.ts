// tests/unit/brain-lifecycle-revive.test.ts
//
// Finding 4: a stale brain entry could NEVER be resurrected even when reviewers
// kept re-confirming it (the curator's dedup-merge bumps last_referenced_at, but
// decayPass left status="stale" until it marched on to archive). decayPass now
// revives a recently-re-referenced (young-aged) stale entry back to active.
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decayPass } from "../../src/core/brain/lifecycle.ts";
import { BrainStore } from "../../src/core/brain/store.ts";
import type { BrainEntry } from "../../src/schemas/brain.ts";

const mk = (o: Partial<BrainEntry>): BrainEntry => ({
  id: "B-1",
  type: "convention",
  scope: "this-repo",
  title: "t",
  body: "b",
  tags: [],
  file_globs: [],
  status: "candidate",
  referenced_count: 1,
  referencing_reviewers: [],
  confidence: 0.9,
  embedding: null,
  evidence: [{ kind: "reviewer-finding", run_id: "r", reviewer_id: "codex" }],
  created_at: "2026-01-01T00:00:00Z",
  source_run_id: "r",
  ...o,
});

describe("decayPass — revives a re-confirmed stale entry (Finding 4)", () => {
  it("revives a stale entry whose last_referenced_at is now fresh (re-confirmed)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-life-revive-"));
    const store = new BrainStore(repo);
    // Stale entry that the curator just re-confirmed: last_referenced_at is recent.
    await store.add(mk({ id: "B-1", status: "stale", last_referenced_at: "2026-05-20T00:00:00Z" }));
    await decayPass(store, repo, "2026-05-21T00:00:00Z");
    const snap = await store.snapshot();
    expect(snap.entries.find((e) => e.id === "B-1")?.status).toBe("active");
  });

  it("does NOT revive a stale entry that is still aged-out (>90d since last ref)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-life-norevive-"));
    const store = new BrainStore(repo);
    // Stale, last referenced ~150d ago → not re-confirmed → stays stale (not revived).
    await store.add(mk({ id: "B-2", status: "stale", last_referenced_at: "2025-12-22T00:00:00Z" }));
    await decayPass(store, repo, "2026-05-21T00:00:00Z");
    const snap = await store.snapshot();
    expect(snap.entries.find((e) => e.id === "B-2")?.status).toBe("stale");
  });
});
