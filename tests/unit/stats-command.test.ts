// tests/unit/stats-command.test.ts
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStats } from "../../src/cli/commands/stats.ts";

function seedRepoWithRun(): string {
  const root = mkdtempSync(join(tmpdir(), "rg-stats-cmd-e2e-"));
  const now = new Date().toISOString();
  const d = new Date(now);
  const y = String(d.getUTCFullYear());
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const dir = join(root, ".reviewgate", "audit", y, m, day);
  mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({
    schema: "reviewgate.audit.v1",
    event: "run.complete",
    ts: now,
    run_id: "s1",
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
  return root;
}

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

it("surfaces precision from decision.applied events end-to-end", async () => {
  const root = seedRepoWithRun();
  // write a decision.applied event into the same day partition
  const ts = new Date().toISOString();
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
  writeFileSync(
    join(dir, "120600.jsonl"),
    `${JSON.stringify({ schema: "reviewgate.audit.v1", event: "decision.applied", ts, run_id: "s1", iter: 1, trigger: "stop-hook", decision_outcome: { finding_id: "F-1", severity: "CRITICAL", bucket: "tp", providers: ["codex"] } })}\n`,
  );
  const out = await runStats({ repoRoot: root });
  expect(out).toContain("Precision");
  // precision section should show 1 real / 0 FP (overall tp=1, precision=100%)
  expect(out).toContain("1 real");
});
