import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeLargeDiff } from "../../src/cli/commands/gate.ts";
import { ReportWriter } from "../../src/core/report-writer.ts";

function diffWithFiles(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) {
    s += `diff --git a/f${i}.ts b/f${i}.ts\n@@ -1 +1 @@\n+x\n`;
  }
  return s;
}

describe("Slice 3: computeLargeDiff", () => {
  test("over byte threshold → returns counts", () => {
    const diff = `diff --git a/x.ts b/x.ts\n@@ -1 +1 @@\n+${"y".repeat(2000)}\n`;
    const r = computeLargeDiff(diff, 1000, 0);
    expect(r).not.toBeUndefined();
    expect(r?.bytes).toBeGreaterThan(1000);
    expect(r?.files).toBe(1);
  });

  test("over file threshold (under bytes) → returns counts via raw diff --git headers", () => {
    const diff = diffWithFiles(5);
    const r = computeLargeDiff(diff, 0, 3);
    expect(r?.files).toBe(5);
  });

  test("under both thresholds → undefined", () => {
    const r = computeLargeDiff(diffWithFiles(2), 1_000_000, 80);
    expect(r).toBeUndefined();
  });

  test("threshold 0 disables that check", () => {
    const r = computeLargeDiff(diffWithFiles(5), 1_000_000, 0);
    expect(r).toBeUndefined();
  });

  test("rename/binary entries still counted by raw header (not hunk-filtered)", () => {
    const diff =
      "diff --git a/old.ts b/new.ts\nrename from old.ts\nrename to new.ts\n" +
      "diff --git a/bin b/bin\nBinary files a/bin and b/bin differ\n";
    const r = computeLargeDiff(diff, 0, 1);
    expect(r?.files).toBe(2);
  });
});

test("renders the large-diff banner in pending.md when large_diff is present", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rg-large-diff-"));
  const writer = new ReportWriter(dir);
  await writer.write(
    {
      schema: "reviewgate.pending.v1",
      run_id: "r1",
      iter: 1,
      max_iter: 3,
      verdict: "PASS",
      counts: { critical: 0, warn: 0, info: 0 },
      reviewers: [
        {
          id: "codex",
          provider: "codex",
          model: "m",
          persona: "security",
          status: "ok",
          cost_usd: 0,
          duration_ms: 1,
        },
      ],
      findings: [],
      large_diff: { files: 170, bytes: 800_000 },
      cost_usd_total: 0,
      duration_ms_total: 1,
      generated_at: new Date().toISOString(),
      git: { sha: "0".repeat(40), branch: "main", dirty_files: [] },
    },
    { mode: "gate" },
  );
  const md = readFileSync(join(dir, ".reviewgate", "pending.md"), "utf8");
  expect(md).toContain("Large diff:");
  expect(md).toContain("170 files");
  expect(md).toContain("loop.runTimeoutMs");
});
