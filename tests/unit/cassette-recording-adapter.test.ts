// tests/unit/cassette-recording-adapter.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordingAdapter } from "../../src/cassette/recording-adapter.ts";
import { loadCassette } from "../../src/cassette/store.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";

function realAdapter(): ProviderAdapter & { embed: (t: string, o: unknown) => Promise<number[]> } {
  return {
    id: "openrouter",
    async preflight() {
      return { available: true, version: "x", authMode: "oauth", error: null };
    },
    async review(inp) {
      return {
        reviewerId: inp.reviewerId,
        verdict: "PASS",
        findings: [],
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
        durationMs: 1,
        exitCode: 0,
        rawEventsPath: "",
        status: "ok",
      } satisfies ReviewResult;
    },
    async complete() {
      return '{"accept":true}';
    },
    async embed() {
      return [0.1, 0.2];
    },
  };
}

describe("RecordingAdapter", () => {
  it("delegates review/complete/embed and records each (forwarding non-interface embed)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-rec-"));
    const p = join(dir, "c.jsonl");
    const prompt = join(dir, "prompt.txt");
    writeFileSync(prompt, "the prompt");
    const rec = new RecordingAdapter(realAdapter(), p) as RecordingAdapter & {
      embed?: (t: string, o: unknown) => Promise<number[]>;
    };
    await rec.review({
      promptFile: prompt,
      workingDir: dir,
      findingsPath: join(dir, "f"),
      persona: "security",
      diffPath: join(dir, "d"),
      cfg: { enabled: true, auth: "oauth", model: "m", timeoutMs: 1000 },
      reviewerId: "openrouter-security",
    });
    await rec.complete?.("judge prompt", { model: "m", apiKeyEnv: "X" });
    expect(typeof rec.embed).toBe("function");
    await rec.embed?.("embed text", {});
    const entries = loadCassette(p);
    expect(entries.map((e) => e.method).sort()).toEqual(["complete", "embed", "review"]);
    expect(entries.find((e) => e.method === "review")?.key).toBe("openrouter-security");
  });

  it("does NOT expose embed when the wrapped adapter has none", () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-rec2-"));
    const noEmbed: ProviderAdapter = {
      id: "codex",
      async preflight() {
        return { available: true, version: "x", authMode: "oauth", error: null };
      },
      async review(inp) {
        return {
          reviewerId: inp.reviewerId,
          verdict: "PASS",
          findings: [],
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
          durationMs: 1,
          exitCode: 0,
          rawEventsPath: "",
          status: "ok",
        };
      },
    };
    const rec = new RecordingAdapter(noEmbed, join(dir, "c.jsonl")) as RecordingAdapter & {
      embed?: unknown;
    };
    expect(typeof rec.embed).toBe("undefined");
  });
});
