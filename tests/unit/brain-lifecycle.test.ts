// tests/unit/brain-lifecycle.test.ts
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decayPass, promoteIfReferenced } from "../../src/core/brain/lifecycle.ts";
import { BrainStore } from "../../src/core/brain/store.ts";
import type { BrainEntry } from "../../src/schemas/brain.ts";
import { brainArchivePath } from "../../src/utils/paths.ts";

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

describe("promoteIfReferenced", () => {
  it("promotes a candidate referenced ≥3 times by ≥2 distinct reviewers", () => {
    // The default failover chain usually runs ONE reviewer/turn, so the old
    // ≥3-DISTINCT-reviewer floor was structurally unreachable — ≥2 is reachable.
    const e = mk({
      status: "candidate",
      referenced_count: 3,
      referencing_reviewers: ["codex", "gemini"],
    });
    expect(promoteIfReferenced(e).status).toBe("active");
  });

  it("does NOT promote when only ONE distinct reviewer backs it (however many refs)", () => {
    const e = mk({ status: "candidate", referenced_count: 9, referencing_reviewers: ["codex"] });
    expect(promoteIfReferenced(e).status).toBe("candidate");
  });

  it("counts distinct PROVIDERS defensively (deduping a repeated entry)", () => {
    const e = mk({
      status: "candidate",
      referenced_count: 3,
      referencing_reviewers: ["codex", "codex"],
    });
    expect(promoteIfReferenced(e).status).toBe("candidate");
  });

  it("does NOT promote below 3 references", () => {
    const e = mk({
      status: "candidate",
      referenced_count: 2,
      referencing_reviewers: ["codex", "gemini"],
    });
    expect(promoteIfReferenced(e).status).toBe("candidate");
  });
});

describe("decayPass", () => {
  it("stales an entry untouched for >90 days and archives a stale one >180 more", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-life-"));
    const store = new BrainStore(repo);
    await store.add(
      mk({ id: "B-1", status: "active", last_referenced_at: "2026-01-01T00:00:00Z" }),
    );
    await store.add(mk({ id: "B-2", status: "stale", last_referenced_at: "2025-06-01T00:00:00Z" }));
    await decayPass(store, repo, "2026-05-21T00:00:00Z");
    const snap = await store.snapshot();
    expect(snap.entries.find((e) => e.id === "B-1")?.status).toBe("stale");
    expect(snap.entries.find((e) => e.id === "B-2")).toBeUndefined(); // archived out
    expect(
      existsSync(brainArchivePath(repo)) && readFileSync(brainArchivePath(repo), "utf8"),
    ).toContain("B-2");
  });
});
