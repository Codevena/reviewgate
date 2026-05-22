// tests/integration/cassette-roundtrip.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordingAdapter } from "../../src/cassette/recording-adapter.ts";
import { ReplayAdapter } from "../../src/cassette/replay-adapter.ts";
import { loadCassette } from "../../src/cassette/store.ts";
import type { ProviderAdapter } from "../../src/providers/adapter-base.ts";

describe("cassette round-trip", () => {
  it("record then replay yields the same review result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-rt-"));
    const p = join(dir, "c.jsonl");
    const prompt = join(dir, "prompt.txt");
    writeFileSync(prompt, "prompt body");
    const real: ProviderAdapter = {
      id: "codex",
      async preflight() {
        return { available: true, version: "x", authMode: "oauth", error: null };
      },
      async review(inp) {
        return {
          reviewerId: inp.reviewerId,
          verdict: "FAIL",
          findings: [],
          usage: { inputTokens: 2, outputTokens: 3, costUsd: 0.01, quotaUsedPct: null },
          durationMs: 5,
          exitCode: 0,
          rawEventsPath: "",
          status: "ok",
        };
      },
    };
    const input = {
      promptFile: prompt,
      workingDir: dir,
      findingsPath: join(dir, "f"),
      persona: "security",
      diffPath: join(dir, "d"),
      cfg: { enabled: true, auth: "oauth" as const, model: "m", timeoutMs: 1000 },
      reviewerId: "codex-security",
    };
    const recorded = await new RecordingAdapter(real, p).review(input);
    const replayed = await new ReplayAdapter(loadCassette(p), "codex").review(input);
    expect(replayed).toEqual(recorded);
  });
});
