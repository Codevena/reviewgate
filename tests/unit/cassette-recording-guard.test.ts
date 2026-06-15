// tests/unit/cassette-recording-guard.test.ts
// Finding 10: the cassette path comes from REVIEWGATE_CASSETTE (attacker-influenced
// env) and we write raw reviewer output to it. The RecordingAdapter must (a) reject
// a path that escapes the repo/tmp roots (traversal / arbitrary file write) and
// (b) redact secrets from the stored body before it lands on disk (leak-at-rest).
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordingAdapter } from "../../src/cassette/recording-adapter.ts";
import { loadCassette } from "../../src/cassette/store.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";

function adapterEmittingSecret(secret: string): ProviderAdapter {
  return {
    id: "openrouter",
    async preflight() {
      return { available: true, version: "x", authMode: "oauth", error: null };
    },
    async review(inp) {
      return {
        reviewerId: inp.reviewerId,
        verdict: "FAIL",
        findings: [
          {
            id: "F-1",
            signature: "sig",
            severity: "WARN",
            category: "security",
            rule_id: "leak",
            file: "a.ts",
            line_start: 1,
            line_end: 1,
            message: "leaked credential present",
            details: `the reviewer echoed a secret: ${secret} — redact at rest`,
            reviewer: { provider: "openrouter", model: "m", persona: "security" },
            confidence: 0.9,
            consensus: "singleton",
          },
        ],
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
        durationMs: 1,
        exitCode: 0,
        rawEventsPath: "",
        rawText: `raw: ${secret}`,
        status: "ok",
      } satisfies ReviewResult;
    },
    async complete() {
      return `completion leaking ${secret}`;
    },
  };
}

describe("RecordingAdapter path containment (F-10)", () => {
  it("rejects a traversal path outside the repo and tmp roots", () => {
    expect(
      () => new RecordingAdapter(adapterEmittingSecret("x"), "/etc/cron.d/evil.jsonl"),
    ).toThrow(/refusing to record/i);
  });

  it("rejects a relative `..` path that climbs above the repo", () => {
    expect(
      () => new RecordingAdapter(adapterEmittingSecret("x"), "../../../../../../tmp/../etc/evil"),
    ).toThrow(/refusing to record/i);
  });

  it("accepts a path inside the OS tmp dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-guard-ok-"));
    expect(
      () => new RecordingAdapter(adapterEmittingSecret("x"), join(dir, "c.jsonl")),
    ).not.toThrow();
  });
});

describe("RecordingAdapter secret redaction at rest (F-10)", () => {
  it("redacts a high-entropy secret from the stored review + complete bodies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-guard-redact-"));
    const p = join(dir, "c.jsonl");
    const prompt = join(dir, "prompt.txt");
    writeFileSync(prompt, "the prompt");
    // A realistic high-entropy token (base64-ish, length >= 24, entropy >= 4.0).
    const secret = "AbCd3fGh1jKlMnOpQrSt7vWxYz09QwErTy45";
    const rec = new RecordingAdapter(adapterEmittingSecret(secret), p) as RecordingAdapter & {
      complete?: (prompt: string, opts: unknown) => Promise<string>;
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
    await rec.complete?.("judge prompt", { model: "m" });

    const raw = require("node:fs").readFileSync(p, "utf8") as string;
    expect(raw).not.toContain(secret); // the secret never hit disk verbatim
    expect(raw).toContain("<REDACTED:HIGH_ENTROPY>");

    // The cassette still parses (schema shape preserved by redacting only strings).
    const entries = loadCassette(p);
    expect(entries.length).toBe(2);
    const review = entries.find((e) => e.method === "review");
    expect(review).toBeDefined();
  });
});
