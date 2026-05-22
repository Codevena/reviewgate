// tests/unit/cassette-store.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEntry, cassetteFromEnv, loadCassette } from "../../src/cassette/store.ts";
import type { CassetteEntry } from "../../src/schemas/cassette.ts";

function entry(key: string): CassetteEntry {
  return {
    schema: "reviewgate.cassette.entry.v1",
    provider: "codex",
    key,
    method: "review",
    promptSha256: "a".repeat(64),
    result: {
      reviewerId: key,
      verdict: "PASS",
      findings: [],
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
      durationMs: 1,
      exitCode: 0,
      rawEventsPath: "",
      status: "ok",
    },
  };
}

describe("cassette store (JSONL)", () => {
  it("appends entries one-per-line and loads them back in order", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-cas-"));
    const p = join(dir, "c.jsonl");
    await appendEntry(p, entry("a"));
    await appendEntry(p, entry("b"));
    expect(readFileSync(p, "utf8").trim().split("\n")).toHaveLength(2);
    const loaded = loadCassette(p);
    expect(loaded.map((e) => e.key)).toEqual(["a", "b"]);
  });

  it("skips a malformed line without aborting", () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-cas2-"));
    const p = join(dir, "c.jsonl");
    writeFileSync(p, `${JSON.stringify(entry("a"))}\n{not json}\n${JSON.stringify(entry("b"))}\n`);
    expect(loadCassette(p).map((e) => e.key)).toEqual(["a", "b"]);
  });

  it("skips a line whose result shape does not match its method", () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-cas3-"));
    const p = join(dir, "c.jsonl");
    // method:"embed" but a {text} result → must be rejected by the schema refine
    const bad = {
      schema: "reviewgate.cassette.entry.v1",
      provider: "openrouter",
      key: `openrouter:embed:${"a".repeat(64)}`,
      method: "embed",
      promptSha256: "a".repeat(64),
      result: { text: "not a vector" },
    };
    writeFileSync(p, `${JSON.stringify(bad)}\n${JSON.stringify(entry("good"))}\n`);
    expect(loadCassette(p).map((e) => e.key)).toEqual(["good"]);
  });

  it("parses REVIEWGATE_CASSETTE record/replay forms", () => {
    expect(cassetteFromEnv("record:/tmp/x.jsonl")).toEqual({
      mode: "record",
      path: "/tmp/x.jsonl",
    });
    expect(cassetteFromEnv("replay:/tmp/y.jsonl")).toEqual({
      mode: "replay",
      path: "/tmp/y.jsonl",
    });
    expect(cassetteFromEnv("garbage")).toBeNull();
    expect(cassetteFromEnv(undefined)).toBeNull();
  });
});
