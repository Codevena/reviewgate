import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quotaCooldownCheck } from "../../src/cli/commands/doctor.ts";

// A cooldown's reset time either came from the provider's own error text
// (source:"parsed") or is reviewgate's own backoff guess (source:"default"). The
// doctor line used to render both identically as "until reset: <p> → <t>", which cost
// two sessions of investigating a *correct* week-long codex cooldown as if it were a
// bug. The provenance must be visible in the line itself.
function seedCooldown(
  entries: Record<string, { reset_at: string; source: "parsed" | "default"; reason?: string }>,
): string {
  const repo = mkdtempSync(join(tmpdir(), "rg-cooldown-"));
  mkdirSync(join(repo, ".reviewgate"), { recursive: true });
  writeFileSync(
    join(repo, ".reviewgate", "quota-cooldowns.json"),
    JSON.stringify({
      schema: "reviewgate.quota-cooldown.v1",
      providers: Object.fromEntries(
        Object.entries(entries).map(([p, e]) => [
          p,
          { recorded_at: "2026-07-29T20:30:33.492Z", ...e },
        ]),
      ),
    }),
  );
  return repo;
}

const NOW = new Date("2026-07-29T21:00:00.000Z");

describe("quotaCooldownCheck provenance", () => {
  it("is silent when no cooldown is active", () => {
    const repo = seedCooldown({
      // already expired → not active
      gemini: { reset_at: "2026-07-24T22:16:10.080Z", source: "default" },
    });
    expect(quotaCooldownCheck(repo, NOW)).toBeNull();
  });

  it("says a parsed reset was reported by the provider, so it is not doubted as a bug", () => {
    const repo = seedCooldown({
      codex: { reset_at: "2026-08-05T11:24:00.000Z", source: "parsed" },
    });
    const c = quotaCooldownCheck(repo, NOW);
    expect(c?.detail).toContain("2026-08-05T11:24:00.000Z");
    expect(c?.detail).toContain("reported by the provider");
    // Must not be describable as reviewgate's own guess — that is the whole point.
    expect(c?.detail).not.toContain("own backoff");
  });

  it("marks a default-source backoff as reviewgate's own, never as a provider-reported reset", () => {
    const repo = seedCooldown({
      gemini: {
        reset_at: "2026-07-29T22:00:00.000Z",
        source: "default",
        reason: "inferred-quota",
      },
    });
    const c = quotaCooldownCheck(repo, NOW);
    expect(c?.detail).toContain("own backoff");
    expect(c?.detail).not.toContain("reported by the provider");
  });

  it("reuses the honest reason wording instead of calling every backoff a quota", () => {
    const repo = seedCooldown({
      gemini: {
        reset_at: "2026-07-29T22:00:00.000Z",
        source: "default",
        reason: "timeout",
      },
    });
    // cooldownReasonLabel("timeout") === "timed out — backing off until"
    expect(quotaCooldownCheck(repo, NOW)?.detail).toContain("timed out");
  });
});
