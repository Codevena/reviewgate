import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brainMemoryCheck } from "../../src/cli/commands/doctor.ts";
import type { ReviewgateConfig } from "../../src/config/define-config.ts";
import { brainDir, brainJsonPath } from "../../src/utils/paths.ts";

// brainMemoryCheck only reads cfg.phases.brain?.enabled — a minimal typed stub keeps
// the test focused (building a full validated config here adds nothing).
const brainOnConfig = () =>
  ({ phases: { brain: { enabled: true } } }) as unknown as ReviewgateConfig;
const brainOffConfig = () => ({ phases: {} }) as unknown as ReviewgateConfig;

function seedBrain(repo: string, entries: Array<{ id: string; status: string }>) {
  mkdirSync(brainDir(repo), { recursive: true });
  writeFileSync(
    brainJsonPath(repo),
    JSON.stringify({
      schema: "reviewgate.brain.v1",
      entries: entries.map((e) => ({
        id: e.id,
        type: "convention",
        scope: "repo",
        title: "t",
        body: "b",
        tags: [],
        file_globs: [],
        status: e.status,
        referenced_count: 1,
        referencing_reviewers: [],
        confidence: 1,
        embedding: null,
        evidence: [],
        created_at: new Date().toISOString(),
        source_run_id: "r1",
      })),
    }),
  );
}

describe("brainMemoryCheck", () => {
  it("returns null when the brain is disabled", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-brain-off-"));
    expect(await brainMemoryCheck(repo, brainOffConfig())).toBeNull();
  });

  it("reports 'nothing learned yet' when enabled but no brain.json exists", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-brain-empty-"));
    const c = await brainMemoryCheck(repo, brainOnConfig());
    expect(c).not.toBeNull();
    expect(c?.status).toBe("ok");
    expect(c?.detail).toMatch(/no memories|nothing learned/i);
  });

  it("reports per-status counts when memories exist", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-brain-full-"));
    seedBrain(repo, [
      { id: "M-001", status: "active" },
      { id: "M-002", status: "active" },
      { id: "M-003", status: "candidate" },
    ]);
    const c = await brainMemoryCheck(repo, brainOnConfig());
    expect(c?.status).toBe("ok");
    expect(c?.detail).toContain("3");
    expect(c?.detail).toContain("2 active");
    expect(c?.detail).toContain("1 candidate");
  });
});
