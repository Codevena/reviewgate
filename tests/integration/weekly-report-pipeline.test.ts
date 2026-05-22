// tests/integration/weekly-report-pipeline.test.ts
import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReport } from "../../src/cli/commands/report.ts";

function seedRepo(): string {
  const root = join(tmpdir(), `rg-wpipe-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
  return root;
}

function writeRun(
  root: string,
  ts: string,
  verdict: string,
  cost: number,
  signatures: string[],
): void {
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
      verdict,
      source: "panel",
      counts: { critical: 0, warn: 0, info: 0 },
      cost_usd: cost,
      duration_ms: 10,
      demoted: 0,
      signatures,
      providers: [
        {
          provider: "codex",
          personas: [],
          runs: 1,
          errors: 0,
          findings: signatures.length,
          demoted: 0,
          cost_usd: cost,
          duration_ms: 10,
        },
      ],
    },
  });
  writeFileSync(join(dir, `${d.getUTCHours()}0000.jsonl`), `${line}\n`, { flag: "a" });
}

describe("weekly report pipeline (seeded 2-week audit log)", () => {
  it("renders a markdown report with correct week-over-week deltas", async () => {
    const root = seedRepo();
    writeRun(root, "2026-05-05T10:00:00.000Z", "PASS", 0.1, ["sig-old"]); // W19: 1 run
    writeRun(root, "2026-05-12T10:00:00.000Z", "PASS", 0.1, ["sig-old"]); // W20: 3 runs
    writeRun(root, "2026-05-13T10:00:00.000Z", "FAIL", 0.1, ["sig-new"]);
    writeRun(root, "2026-05-14T10:00:00.000Z", "PASS", 0.1, ["sig-old"]);

    const md = await runReport({
      repoRoot: root,
      week: "2026-W20",
      now: new Date("2026-05-25T00:00:00.000Z"),
    });
    expect(md).toContain("# Reviewgate Weekly Report — 2026-W20");
    expect(md).toContain("vs 2026-W19");
    expect(md).toContain("▲"); // runs up (3 vs 1)
    expect(md).toContain("sig-new"); // new-signature highlight
    expect(existsSync(join(root, ".reviewgate", "reports", "2026-W20.md"))).toBe(true);
    expect(readFileSync(join(root, ".reviewgate", "reports", "2026-W20.md"), "utf8")).toBe(md);
  });
});
