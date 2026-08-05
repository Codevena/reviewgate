import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCassette, checkDeterminism, replay } from "../../src/rig/replay.ts";

/** Smallest run that harvests: one turn, one snapshot laid out as a repo root. */
function miniRun(): { manifestPath: string; scriptPath: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "rg-replay-"));
  const snapshotDir = join(root, "turns", "1");
  mkdirSync(join(snapshotDir, ".reviewgate", "audit", "2026", "08", "05"), { recursive: true });
  writeFileSync(
    join(snapshotDir, ".reviewgate", "audit", "2026", "08", "05", "gate.jsonl"),
    `${JSON.stringify({
      schema: "reviewgate.audit.v1",
      ts: "2026-08-05T09:00:00.000Z",
      run_id: "r1",
      iter: 1,
      event: "run.complete",
      trigger: "stop-hook",
      prev_event_hash: "",
      this_event_hash: "h1",
      run_summary: {
        verdict: "PASS",
        source: "panel",
        counts: { critical: 0, warn: 0, info: 0 },
        cost_usd: 0.01,
        duration_ms: 1000,
        demoted: 0,
        signatures: [],
        providers: [],
      },
    })}\n`,
  );
  const scriptPath = join(root, "script.json");
  writeFileSync(
    scriptPath,
    JSON.stringify({
      schema: "reviewgate.rig.turn-script.v1",
      id: "mini",
      turns: [{ index: 1, prompt: "t1", seeded: null }],
    }),
  );
  const manifestPath = join(root, "manifest.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      schema: "reviewgate.rig.manifest.v1",
      runId: "mini-1",
      scriptId: "mini",
      outDir: root,
      turns: [{ index: 1, snapshotDir, agentExitCode: 0, wallMs: 1000, gateReviewed: true }],
    }),
  );
  return { manifestPath, scriptPath, root };
}

function cassette(root: string, lines: string[]): string {
  const p = join(root, "cassette.jsonl");
  writeFileSync(p, `${lines.join("\n")}\n`);
  return p;
}

/** A schema-valid recorded review call. `findings` is the only part these tests vary. */
const entry = (key: string, result: Record<string, unknown> | "empty") =>
  JSON.stringify({
    schema: "reviewgate.cassette.entry.v1",
    provider: "openrouter",
    method: "review",
    key,
    promptSha256: "a".repeat(64),
    result:
      result === "empty"
        ? {}
        : {
            reviewerId: key,
            verdict: "PASS",
            findings: [],
            usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001, quotaUsedPct: null },
            durationMs: 100,
            exitCode: 0,
            rawEventsPath: "",
            status: "ok",
            ...result,
          },
  });

describe("rig replay — determinism self-check", () => {
  test("a run whose metrics re-derive identically is DETERMINISTIC", () => {
    const { manifestPath, scriptPath } = miniRun();
    const r = checkDeterminism(manifestPath, scriptPath);
    expect(r.deterministic).toBe(true);
    expect(r.differences).toEqual([]);
    expect(r.turns).toBe(1);
  });

  // NOTE on the negative case. There is deliberately no unit test that forces
  // `deterministic: false`, because faking it would mean stubbing `harvest`/`ablate` and the
  // test would then prove only that the stub differs from itself. The check's ability to FAIL
  // is not assumed, though — it was observed: on first contact with the real pilot it
  // reported NON-DETERMINISTIC for all four layers, because the ablation embeds two full
  // RigResults and inherited their `harvested_at`. That bug is why `stripAblationVolatile`
  // exists, and it is the evidence that the comparison is sensitive rather than vacuous.
});

describe("rig replay — cassette integrity", () => {
  test("counts recorded calls per reviewer key", () => {
    // The per-key counts are what make the recording addressable: a replay serves each key's
    // queue FIFO, so an uneven or short queue is how a replay silently misaligns.
    const { root } = miniRun();
    const p = cassette(root, [
      entry("openrouter-security", { findings: [] }),
      entry("openrouter-security", { findings: [] }),
      entry("ollama-correctness", { findings: [] }),
    ]);
    const c = checkCassette(p);
    expect(c.entries).toBe(3);
    expect(c.byKey).toEqual({ "openrouter-security": 2, "ollama-correctness": 1 });
    expect(c.malformedLines).toBe(0);
    // These three recorded clean reviews, so the counter must NOT over-report.
    expect(c.reviewsWithFindings).toBe(0);
  });

  test("a malformed line is COUNTED, never silently dropped", () => {
    // A recording that lost lines replays as a shorter FIFO: reviewers start being served
    // the next turn's answers. Skipping quietly (as loadCassette does, by design, so a live
    // replay degrades rather than dies) is wrong for an integrity CHECK.
    const { root } = miniRun();
    const p = cassette(root, [entry("openrouter-security", { findings: [] }), "{not json", "  "]);
    const c = checkCassette(p);
    expect(c.entries).toBe(1);
    expect(c.malformedLines).toBe(1); // the blank line is not an error
  });

  test("an entry whose result body is empty is MALFORMED, not a review that found nothing", () => {
    // The schema's result union has no member accepting `{}`. Worth pinning: an earlier
    // version of this check carried a `withResult` counter for exactly that case — a metric
    // the schema makes unreachable, so it always equalled `entries` and always read as a
    // passed check.
    const { root } = miniRun();
    const p = cassette(root, [
      entry("openrouter-security", { findings: [] }),
      entry("openrouter-security", "empty"),
    ]);
    const c = checkCassette(p);
    expect(c.entries).toBe(1);
    expect(c.malformedLines).toBe(1);
  });

  test("a --cassette path that does not exist fails loudly", () => {
    const { manifestPath, scriptPath, root } = miniRun();
    expect(() =>
      replay({ manifestPath, scriptPath, cassettePath: join(root, "nope.jsonl") }),
    ).toThrow(/no cassette at/);
  });
});
