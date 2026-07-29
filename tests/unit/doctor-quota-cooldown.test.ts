import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quotaCooldownCheck } from "../../src/cli/commands/doctor.ts";
import type { CooldownReason } from "../../src/core/quota-cooldown.ts";

// A cooldown's reset time either came from the provider's own error text
// (source:"parsed") or is reviewgate's own backoff guess (source:"default"). The
// doctor line used to render both identically as "until reset: <p> → <t>", which cost
// two sessions of investigating a *correct* week-long codex cooldown as if it were a
// bug. The provenance must be visible in the line itself.
// `reason` is typed as the real CooldownReason union, not `string` (gate finding F-002,
// 2026-07-29): a `string` helper lets a seed carry an out-of-union value, which
// QuotaCooldownSchema then rejects — read() falls back to EMPTY, quotaCooldownCheck returns
// null, and the test passes while exercising a completely different path than it claims.
function seedCooldown(
  entries: Record<
    string,
    { reset_at: string; source: "parsed" | "default"; reason?: CooldownReason }
  >,
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

  it("strips control characters so a crafted cooldown file cannot rewrite the terminal", () => {
    // The providers map is keyed `z.record(z.string(), …)`, so the provider NAME is an
    // arbitrary attacker-shaped string. Unstripped, an escape sequence here could blank the
    // real warnings doctor prints around this line — the output an operator makes a trust
    // decision on (gate finding F-001, 2026-07-29).
    //
    // `reset_at` is also a bare `z.string()`, and it is stripped too, but that path is not
    // reachable: `activeSnapshotDetailed` filters on `Date.parse(reset_at) > now`, and a
    // reset_at carrying a control character parses to NaN and is dropped before rendering.
    // The stripping there is belt, not the load-bearing guard — verified, not assumed.
    const repo = seedCooldown({
      "cod\u001b[2Kex": { reset_at: "2026-08-05T11:24:00.000Z", source: "parsed" },
    });
    const detail = quotaCooldownCheck(repo, NOW)?.detail ?? "";
    // The security property: no C0/C1 control character reaches the terminal.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting their ABSENCE is the test
    expect(/[\u0000-\u001f\u007f-\u009f]/.test(detail)).toBe(false);
    // NEUTRALISED, not prettified — the payload's remaining "[2K" stays as literal text.
    // Without its leading ESC no terminal interprets it, and rewriting it further would
    // hide from the operator that the cooldown file contains something crafted.
    expect(detail).toContain("cod[2Kex");
    // Everything the line exists to communicate still survives.
    expect(detail).toContain("2026-08-05T11:24:00.000Z");
    expect(detail).toContain("reported by the provider");
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
