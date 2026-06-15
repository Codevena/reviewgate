// tests/unit/cassette-replay-adapter.test.ts
import { describe, expect, it } from "bun:test";
import { completeKey, embedKey, sha256 } from "../../src/cassette/matching.ts";
import { ReplayAdapter } from "../../src/cassette/replay-adapter.ts";
import type { CassetteEntry } from "../../src/schemas/cassette.ts";

function review(
  provider: "codex" | "openrouter",
  reviewerId: string,
  verdict: "PASS" | "FAIL",
): CassetteEntry {
  return {
    schema: "reviewgate.cassette.entry.v1",
    provider,
    key: reviewerId,
    method: "review",
    promptSha256: "a".repeat(64),
    result: {
      reviewerId,
      verdict,
      findings: [],
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
      durationMs: 1,
      exitCode: 0,
      rawEventsPath: "",
      status: "ok",
    },
  };
}
const baseInput = (reviewerId: string) => ({
  promptFile: "/dev/null",
  workingDir: "/tmp",
  findingsPath: "/tmp/f",
  persona: "security",
  diffPath: "/tmp/d",
  cfg: { enabled: true, auth: "oauth" as const, model: "m", timeoutMs: 1000 },
  reviewerId,
});

describe("ReplayAdapter", () => {
  it("serves review entries by reviewerId, scoped to its provider (critic not stolen)", async () => {
    const entries = [
      review("codex", "codex-security", "FAIL"),
      review("codex", "critic-codex", "PASS"),
    ];
    const codex = new ReplayAdapter(entries, "codex");
    expect((await codex.review(baseInput("codex-security"))).verdict).toBe("FAIL");
    expect((await codex.review(baseInput("critic-codex"))).verdict).toBe("PASS");
  });

  it("consumes the same reviewerId FIFO across iterations", async () => {
    const entries = [
      review("codex", "codex-security", "FAIL"),
      review("codex", "codex-security", "PASS"),
    ];
    const codex = new ReplayAdapter(entries, "codex");
    expect((await codex.review(baseInput("codex-security"))).verdict).toBe("FAIL");
    expect((await codex.review(baseInput("codex-security"))).verdict).toBe("PASS");
  });

  it("throws on a miss", async () => {
    const codex = new ReplayAdapter([], "codex");
    await expect(codex.review(baseInput("codex-security"))).rejects.toThrow(/no recorded/);
  });

  it("exposes embed() only when embed entries exist; serves by text hash", async () => {
    const text = "embed me";
    const e: CassetteEntry = {
      schema: "reviewgate.cassette.entry.v1",
      provider: "openrouter",
      key: embedKey("openrouter", sha256(text)),
      method: "embed",
      promptSha256: sha256(text),
      result: { vector: [1, 2, 3] },
    };
    const withEmbed = new ReplayAdapter([e], "openrouter") as ReplayAdapter & {
      embed?: (t: string, o: unknown) => Promise<number[]>;
    };
    expect(typeof withEmbed.embed).toBe("function");
    expect(await withEmbed.embed?.(text, {})).toEqual([1, 2, 3]);
    const noEmbed = new ReplayAdapter([], "openrouter") as ReplayAdapter & { embed?: unknown };
    expect(typeof noEmbed.embed).toBe("undefined");
  });

  it("exposes complete() only when complete entries exist (mirrors real adapter capability)", async () => {
    const completeEntry: CassetteEntry = {
      schema: "reviewgate.cassette.entry.v1",
      provider: "openrouter",
      // complete() is content-addressed by prompt hash (RecordingAdapter keys it as
      // completeKey(id, sha256(prompt)); replay pops the same), so the entry key and
      // its promptSha256 must match the prompt the test plays back.
      key: completeKey("openrouter", sha256("judge prompt")),
      method: "complete",
      promptSha256: sha256("judge prompt"),
      result: { text: '{"accept":true}' },
    };
    const withComplete = new ReplayAdapter([completeEntry], "openrouter");
    expect(typeof withComplete.complete).toBe("function");
    expect(await withComplete.complete?.("judge prompt")).toContain("accept");
    const noComplete = new ReplayAdapter([], "openrouter") as ReplayAdapter & {
      complete?: unknown;
    };
    expect(typeof noComplete.complete).toBe("undefined");
  });

  it("strict mode throws on prompt drift; default warns", async () => {
    const entries = [review("codex", "codex-security", "PASS")]; // recorded promptSha256 = "a"*64
    const strict = new ReplayAdapter(entries, "codex", { strict: true });
    await expect(strict.review(baseInput("codex-security"))).rejects.toThrow(/drift/);
  });
});
