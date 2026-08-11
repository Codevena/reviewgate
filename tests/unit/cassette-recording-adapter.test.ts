// tests/unit/cassette-recording-adapter.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordingAdapter } from "../../src/cassette/recording-adapter.ts";
import { loadCassette } from "../../src/cassette/store.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";
import { policyReplayCallId } from "../../src/schemas/policy-replay.ts";

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

  it("binds recorded responses to strict caller identity without persisting prompt text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-rec-call-"));
    const path = join(dir, "c.jsonl");
    const promptFile = join(dir, "prompt.txt");
    writeFileSync(promptFile, "safe reviewer prompt");
    const rec = new RecordingAdapter(realAdapter(), path);
    const context = {
      runId: "rig-run",
      iter: 2,
      kind: "reviewer" as const,
      ordinal: 3,
      slot: 1,
      attempt: 2,
      occurrence: 1,
    };
    await rec.review({
      promptFile,
      workingDir: dir,
      findingsPath: join(dir, "findings.json"),
      persona: "security",
      diffPath: join(dir, "diff.patch"),
      cfg: { enabled: true, auth: "oauth", model: "m", timeoutMs: 1000 },
      reviewerId: "openrouter-security",
      policyReplayCall: context,
    } as Parameters<typeof rec.review>[0]);

    const [entry] = loadCassette(path);
    expect(entry?.policyReplayCall).toEqual({
      ...context,
      callId: policyReplayCallId({
        ...context,
        provider: "openrouter",
        method: "review",
        key: "openrouter-security",
        promptSha256: "c42b75d9fb013066a5f7d895a12bb880ff9b98a45b8abe849eb3401bc0706dcb",
      }),
    });
    expect(JSON.stringify(entry)).not.toContain("safe reviewer prompt");
  });

  it("preserves call identities when identical concurrent reviews complete in reverse order", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-rec-concurrent-"));
    const path = join(dir, "c.jsonl");
    const promptFile = join(dir, "prompt.txt");
    writeFileSync(promptFile, "shared safe prompt");
    const real = realAdapter();
    real.review = async (input) => {
      if (input.policyReplayCall?.slot === 0) await Bun.sleep(30);
      return {
        reviewerId: input.reviewerId,
        verdict: "PASS",
        findings: [],
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
        durationMs: 1,
        exitCode: 0,
        rawEventsPath: "",
        rawText: `safe slot ${input.policyReplayCall?.slot ?? -1}`,
        status: "ok",
      };
    };
    const rec = new RecordingAdapter(real, path);
    const common = {
      promptFile,
      workingDir: dir,
      findingsPath: join(dir, "findings.json"),
      persona: "security",
      diffPath: join(dir, "diff.patch"),
      cfg: { enabled: true, auth: "oauth" as const, model: "m", timeoutMs: 1000 },
      reviewerId: "openrouter-security",
    };
    await Promise.all([
      rec.review({
        ...common,
        policyReplayCall: {
          runId: "rig-run",
          iter: 1,
          kind: "reviewer",
          ordinal: 0,
          slot: 0,
          attempt: 1,
          occurrence: 0,
        },
      }),
      rec.review({
        ...common,
        policyReplayCall: {
          runId: "rig-run",
          iter: 1,
          kind: "reviewer",
          ordinal: 1,
          slot: 1,
          attempt: 1,
          occurrence: 0,
        },
      }),
    ]);

    const entries = loadCassette(path);
    expect(entries.map((entry) => entry.policyReplayCall?.ordinal)).toEqual([1, 0]);
    expect(
      entries.map((entry) => ("rawText" in entry.result ? entry.result.rawText : undefined)),
    ).toEqual(["safe slot 1", "safe slot 0"]);
    expect(new Set(entries.map((entry) => entry.policyReplayCall?.callId)).size).toBe(2);
  });
});
