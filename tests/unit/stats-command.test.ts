// tests/unit/stats-command.test.ts
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStats } from "../../src/cli/commands/stats.ts";

function seedRepo(): string {
  return mkdtempSync(join(tmpdir(), "rg-stats-cmd-"));
}

function writeRun(root: string, ts: string, runId: string): void {
  const d = new Date(ts);
  const y = String(d.getUTCFullYear());
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const dir = join(root, ".reviewgate", "audit", y, m, day);
  mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({
    schema: "reviewgate.audit.v1",
    event: "run.complete",
    ts,
    run_id: runId,
    iter: 1,
    trigger: "stop-hook",
    run_summary: {
      verdict: "PASS",
      source: "panel",
      counts: { critical: 0, warn: 0, info: 0 },
      cost_usd: 0.01,
      duration_ms: 50,
      demoted: 0,
      signatures: [],
      providers: [],
    },
  });
  writeFileSync(join(dir, "120000.jsonl"), `${line}\n`, { flag: "a" });
}

describe("runStats --since input handling", () => {
  it("rejects a non-ISO --since value instead of silently filtering everything out", async () => {
    const root = seedRepo();
    // A real run today so an honest window would include it.
    writeRun(root, new Date().toISOString(), "r1");

    // "yesterday" is non-ISO; lexically it sorts after every ISO ts (starts
    // with 'y' > '2'), so the old code silently excluded the real run and
    // returned "no review history yet". A correct stats command must surface
    // the bad input as an error rather than lie about an empty window.
    await expect(runStats({ repoRoot: root, since: "yesterday" })).rejects.toThrow(/since/i);
  });

  it("normalizes a parseable-but-non-ISO --since so the lexical window stays correct", async () => {
    const root = seedRepo();
    const now = new Date();
    writeRun(root, now.toISOString(), "r1");

    // A US-style date string parses via Date() yet, if forwarded raw, would
    // lexically mis-compare against ISO timestamps. After normalization the
    // run from "now" (which is >= start of an earlier day) must be counted.
    const earlier = new Date(now.getTime() - 2 * 86_400_000);
    const usStyle = `${String(earlier.getUTCMonth() + 1).padStart(2, "0")}/${String(earlier.getUTCDate()).padStart(2, "0")}/${earlier.getUTCFullYear()}`;

    const out = await runStats({ repoRoot: root, since: usStyle });
    expect(out).not.toMatch(/no review history yet/i);
  });

  it("still works for a plain ISO --since value", async () => {
    const root = seedRepo();
    const now = new Date();
    writeRun(root, now.toISOString(), "r1");
    const sinceIso = new Date(now.getTime() - 86_400_000).toISOString();
    const out = await runStats({ repoRoot: root, since: sinceIso });
    expect(out).not.toMatch(/no review history yet/i);
  });
});
