import { describe, expect, it } from "bun:test";
// tests/unit/report-cli.test.ts
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReport } from "../../src/cli/commands/report.ts";

function seedRepo(): string {
  const root = join(tmpdir(), `rg-rep-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
  return root;
}
function writeRun(root: string, ts: string): void {
  const d = new Date(ts);
  const dir = join(
    root,
    ".reviewgate",
    "audit",
    String(d.getUTCFullYear()),
    String(d.getUTCMonth() + 1).padStart(2, "0"),
    String(d.getUTCDate()).padStart(2, "0"),
  );
  mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({
    schema: "reviewgate.audit.v1",
    event: "run.complete",
    ts,
    run_id: ts,
    iter: 1,
    trigger: "stop-hook",
    run_summary: {
      verdict: "PASS",
      source: "panel",
      counts: { critical: 0, warn: 0, info: 0 },
      cost_usd: 0.01,
      duration_ms: 10,
      demoted: 0,
      signatures: [],
      providers: [],
    },
  });
  writeFileSync(join(dir, "100000.jsonl"), `${line}\n`, { flag: "a" });
}

describe("runReport", () => {
  it("writes a markdown file for an explicit complete week and returns markdown", async () => {
    const root = seedRepo();
    writeRun(root, "2026-05-12T10:00:00.000Z");
    const out = await runReport({
      repoRoot: root,
      week: "2026-W20",
      now: new Date("2026-05-25T00:00:00.000Z"),
    });
    expect(out).toContain("# Reviewgate Weekly Report — 2026-W20");
    expect(existsSync(join(root, ".reviewgate", "reports", "2026-W20.md"))).toBe(true);
  });

  it("--json returns JSON and writes NO file", async () => {
    const root = seedRepo();
    writeRun(root, "2026-05-12T10:00:00.000Z");
    const out = await runReport({
      repoRoot: root,
      week: "2026-W20",
      json: true,
      now: new Date("2026-05-25T00:00:00.000Z"),
    });
    expect(JSON.parse(out).week.iso).toBe("2026-W20");
    expect(existsSync(join(root, ".reviewgate", "reports", "2026-W20.md"))).toBe(false);
  });

  it("a current in-progress week renders the partial banner", async () => {
    const root = seedRepo();
    writeRun(root, "2026-05-12T10:00:00.000Z");
    const out = await runReport({
      repoRoot: root,
      week: "2026-W20",
      now: new Date("2026-05-13T12:00:00.000Z"),
    });
    expect(out).toContain("in progress");
  });

  it("rejects a malformed week string", async () => {
    const root = seedRepo();
    await expect(runReport({ repoRoot: root, week: "garbage", now: new Date() })).rejects.toThrow();
  });
});
