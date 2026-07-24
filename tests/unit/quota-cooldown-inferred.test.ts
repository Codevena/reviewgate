// tests/unit/quota-cooldown-inferred.test.ts
//
// Honest inferred-quota labeling (field incident 2026-07-23): agy prints its
// quota banner to a TTY only, so Reviewgate INFERS quota from a zero-output
// kill — but a crawl-hang/transport flake is byte-identical, and the cooldown
// was recorded as a confident reason:"quota" ("quota until <time>") although
// the classification was a guess. The guess must be carried honestly:
// ReviewResult.quotaInferred → CooldownReason "inferred-quota" → an honest
// label — and the quota-degraded ESCALATION note must still count an
// inferred-capped provider as degrading the panel.
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLogger } from "../../src/audit/logger.ts";
import { defaultConfig } from "../../src/config/defaults.ts";
import { LoopDriver } from "../../src/core/loop-driver.ts";
import type { IterationResult } from "../../src/core/orchestrator.ts";
import { cooldownEffectFor } from "../../src/core/orchestrator.ts";
import { QuotaCooldownStore, cooldownReasonLabel } from "../../src/core/quota-cooldown.ts";
import { StateStore } from "../../src/core/state-store.ts";
import type { ReviewResult } from "../../src/providers/adapter-base.ts";
import { QuotaCooldownSchema } from "../../src/schemas/quota-cooldown.ts";
import { auditDir } from "../../src/utils/paths.ts";

const NOW = new Date("2026-07-24T12:00:00Z");

function result(overrides: Partial<ReviewResult>): ReviewResult {
  return {
    reviewerId: "gemini-security",
    verdict: "ERROR",
    findings: [],
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, quotaUsedPct: null },
    durationMs: 1000,
    exitCode: 1,
    rawEventsPath: "",
    status: "quota-exhausted",
    ...overrides,
  };
}

describe("cooldownEffectFor — inferred quota carries an honest reason", () => {
  it("quota-exhausted + quotaInferred → default backoff with reason 'inferred-quota'", () => {
    const effect = cooldownEffectFor("gemini", result({ quotaInferred: true }), NOW);
    expect(effect).toEqual({ provider: "gemini", source: "default", reason: "inferred-quota" });
  });

  it("quota-exhausted WITHOUT the flag keeps reason 'quota' (banner-confirmed, unchanged)", () => {
    const effect = cooldownEffectFor("gemini", result({}), NOW);
    expect(effect).toEqual({ provider: "gemini", source: "default", reason: "quota" });
  });

  it("a parseable reset time always wins: source 'parsed', quotaInferred ignored", () => {
    const effect = cooldownEffectFor(
      "gemini",
      result({ quotaInferred: true, statusDetail: "rate limited, retry after 120 seconds" }),
      NOW,
    );
    expect(effect).toEqual({
      provider: "gemini",
      resetAt: new Date(NOW.getTime() + 120_000).toISOString(),
      source: "parsed",
    });
  });
});

describe("cooldownReasonLabel — inferred is labeled as a guess, never as fact", () => {
  it("'inferred-quota' → explicit unconfirmed wording", () => {
    const label = cooldownReasonLabel("inferred-quota");
    expect(label).toContain("inferred");
    expect(label).toContain("backing off until");
    expect(label).not.toBe("quota until"); // never the confident wording
  });

  it("existing labels are unchanged (pinned)", () => {
    expect(cooldownReasonLabel(undefined)).toBe("quota until");
    expect(cooldownReasonLabel("quota")).toBe("quota until");
    expect(cooldownReasonLabel("timeout")).toBe("timed out — backing off until");
    expect(cooldownReasonLabel("error")).toBe("errored — backing off until");
  });
});

describe("schema + store round-trip", () => {
  it("persists and reloads reason 'inferred-quota'; legacy entries still parse", () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-inferred-"));
    const store = new QuotaCooldownStore(repo);
    store.recordBackoff("gemini", NOW, "inferred-quota");
    const reloaded = new QuotaCooldownStore(repo);
    expect(reloaded.activeReason("gemini", NOW)).toBe("inferred-quota");
    expect(reloaded.activeUntil("gemini", NOW)).not.toBeNull();

    // Legacy file shapes (no reason at all; old reasons) must keep parsing.
    expect(
      QuotaCooldownSchema.safeParse({
        schema: "reviewgate.quota-cooldown.v1",
        providers: {
          codex: { reset_at: "2026-07-29T07:21:00.000Z", recorded_at: "x", source: "parsed" },
          gemini: {
            reset_at: "2026-07-24T15:00:00.000Z",
            recorded_at: "x",
            source: "default",
            consecutive_failures: 2,
            reason: "quota",
          },
        },
      }).success,
    ).toBe(true);
  });
});

describe("cassette replay preserves the inference flag", () => {
  it("CassetteEntrySchema does not strip quotaInferred (replay must stay honest)", async () => {
    // zod strips unknown keys: without quotaInferred in ReviewResultSchema, a
    // recorded gemini silent-stall would replay as a CONFIDENT quota — silently
    // reintroducing the dishonest label in bench/demo replay mode.
    const { CassetteEntrySchema } = await import("../../src/schemas/cassette.ts");
    const entry = CassetteEntrySchema.parse({
      schema: "reviewgate.cassette.entry.v1",
      provider: "gemini",
      key: "gemini-security|review",
      method: "review",
      promptSha256: "a".repeat(64),
      result: { ...result({ quotaInferred: true }), rawEventsPath: "" },
    });
    expect((entry.result as ReviewResult).quotaInferred).toBe(true);
  });
});

describe("quotaDegradationNote — an inferred cap still degrades the panel", () => {
  function driverFor(repo: string, state: StateStore): LoopDriver {
    const config = {
      ...defaultConfig,
      phases: {
        ...defaultConfig.phases,
        review: {
          ...defaultConfig.phases.review,
          reviewers: [{ provider: "gemini" as const, persona: "security" }],
        },
      },
    };
    return new LoopDriver({
      repoRoot: repo,
      config,
      state,
      audit: new AuditLogger(auditDir(repo)),
      orchestrator: {
        runIteration: async (): Promise<IterationResult> => {
          throw new Error("not reached");
        },
      },
      stopHookActive: false,
      freshHeadSha: async () => null,
    });
  }
  const callNote = (driver: LoopDriver, now: Date): string | null =>
    (driver as unknown as { quotaDegradationNote(now: Date): string | null }).quotaDegradationNote(
      now,
    );

  it("reason 'inferred-quota' appears in the quota-degraded note", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-inferred-note-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    const state = new StateStore(repo);
    await state.initialise("01HXINFNOTE1");
    new QuotaCooldownStore(repo).recordBackoff("gemini", NOW, "inferred-quota");
    const note = callNote(driverFor(repo, state), NOW);
    expect(note).not.toBeNull();
    expect(note).toContain("gemini");
  });

  it("reason 'timeout' still stays OUT of the quota note (pinned — different degradation)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-timeout-note-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    const state = new StateStore(repo);
    await state.initialise("01HXINFNOTE2");
    new QuotaCooldownStore(repo).recordBackoff("gemini", NOW, "timeout");
    const note = callNote(driverFor(repo, state), NOW);
    expect(note).toBeNull();
  });
});
