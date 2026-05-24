// tests/unit/orchestrator-cooldown.test.ts
// Quota cooldown: a capped primary is skipped straight to the fallback while its
// reset time is in the future, and resumed automatically once it passes.
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../src/config/defaults.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import type {
  ProviderAdapter,
  ReviewResult,
  ReviewStatus,
} from "../../src/providers/adapter-base.ts";

const NOW = new Date("2026-05-23T12:00:00.000Z");
const DIFF = "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-a\n+b\n";

function countingStub(
  id: ProviderAdapter["id"],
  status: ReviewStatus,
  calls: { n: number },
  statusDetail?: string,
): ProviderAdapter {
  return {
    id,
    async preflight() {
      return { available: true, version: "x", authMode: "oauth", error: null };
    },
    async review(inp) {
      calls.n += 1;
      return {
        reviewerId: inp.reviewerId,
        verdict: status === "ok" ? "PASS" : "ERROR",
        findings: [],
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, quotaUsedPct: null },
        durationMs: 1,
        exitCode: status === "ok" ? 0 : 1,
        rawEventsPath: "",
        rawText: "",
        status,
        ...(statusDetail ? { statusDetail } : {}),
      } satisfies ReviewResult;
    },
  };
}

function setup(opts: {
  cooldownFile?: { reset_at: string; recorded_at?: string };
  codexStatus: ReviewStatus;
  codexDetail?: string;
}) {
  const repo = mkdtempSync(join(tmpdir(), "rg-cd-orch-"));
  writeFileSync(join(repo, "foo.ts"), "x");
  if (opts.cooldownFile) {
    mkdirSync(join(repo, ".reviewgate"), { recursive: true });
    writeFileSync(
      join(repo, ".reviewgate", "quota-cooldowns.json"),
      JSON.stringify({
        schema: "reviewgate.quota-cooldown.v1",
        providers: {
          codex: {
            reset_at: opts.cooldownFile.reset_at,
            recorded_at: opts.cooldownFile.recorded_at ?? NOW.toISOString(),
            source: "parsed",
          },
        },
      }),
    );
  }
  const codexCalls = { n: 0 };
  const geminiCalls = { n: 0 };
  const config = {
    ...defaultConfig,
    providers: {
      ...defaultConfig.providers,
      gemini: { enabled: false, auth: "oauth" as const, model: "g", timeoutMs: 1000 },
    },
    phases: {
      review: {
        reviewers: [
          { provider: "codex" as const, persona: "security", fallback: ["gemini" as const] },
        ],
      },
      critic: null,
      triage: null,
    },
  };
  const orch = new Orchestrator({
    repoRoot: repo,
    // biome-ignore lint/suspicious/noExplicitAny: test config shape
    config: config as any,
    adapters: {
      codex: countingStub("codex", opts.codexStatus, codexCalls, opts.codexDetail),
      gemini: countingStub("gemini", "ok", geminiCalls),
    },
    sandboxMode: "off",
    hostTier: "opus",
    diff: DIFF,
    reasonOnFailEnabled: true,
    providerAvailable: () => true,
    now: () => NOW,
  });
  return { repo, orch, codexCalls, geminiCalls };
}

const readReviewer = (repo: string) =>
  JSON.parse(readFileSync(join(repo, ".reviewgate", "pending.json"), "utf8")).reviewers[0];
const readCooldown = (repo: string) =>
  JSON.parse(readFileSync(join(repo, ".reviewgate", "quota-cooldowns.json"), "utf8"));

describe("Orchestrator quota cooldown", () => {
  it("SKIPS a capped primary (does not call it) and uses the fallback", async () => {
    const future = new Date(NOW.getTime() + 3_600_000).toISOString();
    const { repo, orch, codexCalls, geminiCalls } = setup({
      cooldownFile: { reset_at: future },
      codexStatus: "ok",
    });
    await orch.runIteration({ runId: "R", iter: 1 });
    expect(codexCalls.n).toBe(0); // skipped — never invoked
    expect(geminiCalls.n).toBe(1); // fallback ran
    expect(readReviewer(repo).provider).toBe("gemini");
  });

  it("RE-PROBES a still-cooled primary past the re-probe window (early recovery) and clears it", async () => {
    // reset is far off (3 days), but it was recorded > 30 min ago → re-probe due.
    const future = new Date(NOW.getTime() + 3 * 24 * 3_600_000).toISOString();
    const recordedOld = new Date(NOW.getTime() - 31 * 60_000).toISOString();
    const { repo, orch, codexCalls } = setup({
      cooldownFile: { reset_at: future, recorded_at: recordedOld },
      codexStatus: "ok", // codex has recovered early
    });
    await orch.runIteration({ runId: "R", iter: 1 });
    expect(codexCalls.n).toBe(1); // re-probed (NOT skipped) despite the future reset
    expect(readReviewer(repo).provider).toBe("codex");
    expect(readCooldown(repo).providers.codex).toBeUndefined(); // recovered → cleared
  });

  it("RESUMES the primary once the cooldown has expired (and clears it)", async () => {
    const past = new Date(NOW.getTime() - 3_600_000).toISOString();
    const { repo, orch, codexCalls } = setup({
      cooldownFile: { reset_at: past },
      codexStatus: "ok",
    });
    await orch.runIteration({ runId: "R", iter: 1 });
    expect(codexCalls.n).toBe(1); // expired cooldown → primary tried again
    expect(readReviewer(repo).provider).toBe("codex");
    expect(readCooldown(repo).providers.codex).toBeUndefined(); // cleared after success
  });

  it("RECORDS a cooldown (parsed reset time) when the primary is quota-exhausted", async () => {
    const { repo, orch } = setup({
      codexStatus: "quota-exhausted",
      codexDetail: "You've hit your usage limit. try again at May 27th, 2026 12:57 AM.",
    });
    await orch.runIteration({ runId: "R", iter: 1 });
    expect(readReviewer(repo).provider).toBe("gemini"); // failed over
    const cd = readCooldown(repo).providers.codex;
    expect(cd.source).toBe("parsed");
    expect(new Date(cd.reset_at).getTime()).toBeGreaterThan(NOW.getTime());
  });

  it("records a cooldown for a FALLBACK that also hits quota (not just the primary)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-cd-fb-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    const calls = { codex: { n: 0 }, gemini: { n: 0 }, claude: { n: 0 } };
    const config = {
      ...defaultConfig,
      providers: {
        ...defaultConfig.providers,
        gemini: { enabled: false, auth: "oauth" as const, model: "g", timeoutMs: 1000 },
      },
      phases: {
        review: {
          reviewers: [
            {
              provider: "codex" as const,
              persona: "security",
              fallback: ["gemini" as const, "claude-code" as const],
            },
          ],
        },
        critic: null,
        triage: null,
      },
    };
    const orch = new Orchestrator({
      repoRoot: repo,
      // biome-ignore lint/suspicious/noExplicitAny: test config shape
      config: config as any,
      adapters: {
        codex: countingStub("codex", "quota-exhausted", calls.codex, "you've hit your usage limit"),
        gemini: countingStub("gemini", "quota-exhausted", calls.gemini, "RESOURCE_EXHAUSTED 429"),
        "claude-code": countingStub("claude-code", "ok", calls.claude),
      },
      sandboxMode: "off",
      hostTier: "opus",
      diff: DIFF,
      reasonOnFailEnabled: true,
      providerAvailable: () => true,
      now: () => NOW,
    });
    await orch.runIteration({ runId: "R", iter: 1 });
    const cd = readCooldown(repo).providers;
    expect(cd.codex).toBeDefined(); // primary quota recorded
    expect(cd.gemini).toBeDefined(); // FALLBACK quota ALSO recorded (the fix)
    expect(readReviewer(repo).provider).toBe("claude-code"); // walked to the working one
  });
});
