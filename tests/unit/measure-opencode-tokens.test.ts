// tests/unit/measure-opencode-tokens.test.ts
// The token oracle for Qwen cost measurements: reads per-call token usage out of
// opencode's own session DB, so a cost claim is never a guess. Seeded temp DB —
// never touches the real ~/.local/share/opencode/opencode.db.
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { creditsFor, readLatestUsage } from "../../scripts/measure-opencode-tokens.ts";

function seedDb(messages: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-octok-"));
  const path = join(dir, "opencode.db");
  const db = new Database(path);
  db.run(
    "create table message (id text, session_id text, time_created integer, time_updated integer, data text)",
  );
  for (const m of messages) db.run("insert into message (data) values (?)", [JSON.stringify(m)]);
  db.close();
  return path;
}

// The two real calls measured on 2026-08-07 (design spec §5, Phase 0a).
const REAL_CALL_2 = {
  modelID: "qwen3.8-max",
  tokens: { total: 23414, input: 23238, output: 13, reasoning: 163, cache: { read: 0, write: 0 } },
};
const REAL_CALL_1 = {
  modelID: "qwen3.8-max",
  tokens: {
    total: 25629,
    input: 23544,
    output: 15,
    reasoning: 22,
    cache: { read: 2048, write: 0 },
  },
};

describe("readLatestUsage", () => {
  it("returns the most recent usage for the requested model", () => {
    const path = seedDb([REAL_CALL_2, REAL_CALL_1]);
    expect(readLatestUsage("qwen3.8-max", 50, path)).toEqual({
      total: 25629,
      input: 23544,
      output: 15,
      reasoning: 22,
      cacheRead: 2048,
      cacheWrite: 0,
    });
  });

  it("skips messages from other models", () => {
    const path = seedDb([
      REAL_CALL_1,
      { modelID: "glm-5.2:cloud", tokens: { total: 999, input: 999, output: 0 } },
    ]);
    expect(readLatestUsage("qwen3.8-max", 50, path)?.total).toBe(25629);
  });

  it("returns null when the model never ran", () => {
    expect(readLatestUsage("qwen3.8-max", 50, seedDb([]))).toBeNull();
  });

  it("tolerates rows whose data is not valid JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-octok-bad-"));
    const path = join(dir, "opencode.db");
    const db = new Database(path);
    db.run("create table message (id text, data text)");
    db.run("insert into message (data) values (?)", ["{not json"]);
    db.run("insert into message (data) values (?)", [JSON.stringify(REAL_CALL_1)]);
    db.close();
    expect(readLatestUsage("qwen3.8-max", 50, path)?.total).toBe(25629);
  });
});

describe("creditsFor", () => {
  it("converts tokens at the measured 1.21 credits/1K coefficient", () => {
    const usage = readLatestUsage("qwen3.8-max", 50, seedDb([REAL_CALL_1]));
    expect(usage).not.toBeNull();
    // 25629 tokens / 1000 * 1.21 = 31.01 credits
    expect(creditsFor(usage as NonNullable<typeof usage>)).toBeCloseTo(31.01, 2);
  });

  it("crosses the two real calls against the console reading that produced the coefficient", () => {
    // Console: 2.38% of the 2500-credit weekly window = 59.5 credits for both calls.
    const a = readLatestUsage("qwen3.8-max", 50, seedDb([REAL_CALL_1]));
    const b = readLatestUsage("qwen3.8-max", 50, seedDb([REAL_CALL_2]));
    const total = creditsFor(a as NonNullable<typeof a>) + creditsFor(b as NonNullable<typeof b>);
    expect(total).toBeCloseTo(59.5, 0);
  });
});
