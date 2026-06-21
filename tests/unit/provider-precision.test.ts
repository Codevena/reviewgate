// tests/unit/provider-precision.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  annotateFindingsWithPrecision,
  highPrecisionProviders,
  loadProviderPrecision,
  lowPrecisionAdvisory,
  perProviderPrecision,
} from "../../src/core/provider-precision.ts";
import type { DecisionOutcome } from "../../src/schemas/audit-event.ts";
import type { Finding } from "../../src/schemas/finding.ts";

function dec(
  bucket: DecisionOutcome["bucket"],
  providers: string[],
  severity: DecisionOutcome["severity"] = "CRITICAL",
): DecisionOutcome {
  return { finding_id: "F", severity, bucket, providers };
}

function finding(provider: string): Finding {
  return {
    id: "F-001",
    signature: "s",
    severity: "CRITICAL",
    category: "security",
    rule_id: "r",
    file: "a.ts",
    line_start: 1,
    line_end: 1,
    message: "m",
    details: "d",
    reviewer: { provider, model: "m", persona: "security" },
    confidence: 0.9,
    consensus: "singleton",
  };
}

describe("lowPrecisionAdvisory (P1)", () => {
  const withPrec = (
    cells: NonNullable<Finding["reviewer_precision"]>,
    severity: Finding["severity"] = "CRITICAL",
  ): Finding => ({ ...finding("openrouter"), severity, reviewer_precision: cells });

  it("flags a finding raised solely by a sub-50% reviewer with >= 8 samples", () => {
    const adv = lowPrecisionAdvisory(
      withPrec([{ provider: "openrouter", tp: 8, fp: 12, precision: 0.4 }]),
    );
    expect(adv).not.toBeNull();
    expect(adv).toContain("40%");
    expect(adv).toContain("openrouter");
  });

  it("returns null when the reviewer is at/above the floor", () => {
    expect(
      lowPrecisionAdvisory(withPrec([{ provider: "codex", tp: 12, fp: 8, precision: 0.6 }])),
    ).toBeNull();
  });

  it("returns null below the min-decisions sample floor (cold-start never flagged)", () => {
    expect(
      lowPrecisionAdvisory(withPrec([{ provider: "x", tp: 1, fp: 3, precision: 0.25 }])),
    ).toBeNull();
  });

  it("returns null when a high-precision provider also raised it (corroboration clears it)", () => {
    expect(
      lowPrecisionAdvisory(
        withPrec([
          { provider: "openrouter", tp: 8, fp: 12, precision: 0.4 },
          { provider: "codex", tp: 18, fp: 2, precision: 0.9 },
        ]),
      ),
    ).toBeNull();
  });

  it("returns null with no precision data at all", () => {
    expect(lowPrecisionAdvisory(finding("openrouter"))).toBeNull();
  });
});

describe("perProviderPrecision", () => {
  it("computes tp/(tp+fp) per provider, excludes INFO and declined", () => {
    const m = perProviderPrecision([
      dec("tp", ["codex"]),
      dec("tp", ["codex"]),
      dec("fp", ["codex"]),
      dec("declined", ["codex"]), // ignored
      dec("fp", ["codex"], "INFO"), // INFO excluded
      dec("tp", ["gemini"]),
    ]);
    expect(m.get("codex")).toEqual({ tp: 2, fp: 1, precision: 2 / 3 });
    expect(m.get("gemini")).toEqual({ tp: 1, fp: 0, precision: 1 });
  });

  it("counts a multi-provider decision toward EACH provider", () => {
    const m = perProviderPrecision([dec("fp", ["codex", "openrouter"])]);
    expect(m.get("codex")).toEqual({ tp: 0, fp: 1, precision: 0 });
    expect(m.get("openrouter")).toEqual({ tp: 0, fp: 1, precision: 0 });
  });

  it("returns an empty map for no qualifying decisions", () => {
    expect(perProviderPrecision([dec("declined", ["codex"])]).get("codex")).toBeUndefined();
  });

  it("highPrecisionProviders: includes >= floor with >= minDecisions, excludes a noisy newcomer (#4)", () => {
    const m = perProviderPrecision([
      // codex: 8 tp / 0 fp = 1.0 over 8 samples → protected
      ...Array.from({ length: 8 }, () => dec("tp", ["codex"])),
      // newcomer: 1/1 = 100% but only 1 sample → NOT protected (min-samples guard)
      dec("tp", ["newcomer"]),
      // lowtp: 2 tp / 8 fp = 0.2 over 10 samples → NOT protected (below floor)
      ...Array.from({ length: 2 }, () => dec("tp", ["lowtp"])),
      ...Array.from({ length: 8 }, () => dec("fp", ["lowtp"])),
    ]);
    const protectedSet = highPrecisionProviders(m, { floor: 0.7, minDecisions: 8 });
    expect(protectedSet.has("codex")).toBe(true);
    expect(protectedSet.has("newcomer")).toBe(false);
    expect(protectedSet.has("lowtp")).toBe(false);
  });
});

describe("annotateFindingsWithPrecision", () => {
  const precision = new Map([
    ["codex", { tp: 22, fp: 3, precision: 22 / 25 }],
    ["openrouter", { tp: 2, fp: 1, precision: 2 / 3 }], // only 3 samples
  ]);

  it("attaches reviewer_precision only for providers with >= minDecisions samples", () => {
    const out = annotateFindingsWithPrecision([finding("codex")], precision, { minDecisions: 5 });
    expect(out[0]?.reviewer_precision).toEqual([
      { provider: "codex", tp: 22, fp: 3, precision: 22 / 25 },
    ]);
  });

  it("omits a provider below minDecisions (no annotation when none qualify)", () => {
    const out = annotateFindingsWithPrecision([finding("openrouter")], precision, {
      minDecisions: 5,
    });
    expect(out[0]?.reviewer_precision).toBeUndefined();
  });

  it("does not mutate the input finding", () => {
    const input = [finding("codex")];
    annotateFindingsWithPrecision(input, precision, { minDecisions: 5 });
    expect(input[0]?.reviewer_precision).toBeUndefined();
  });
});

describe("loadProviderPrecision (best-effort)", () => {
  it("returns an empty map when there is no audit dir", () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-pp-"));
    const m = loadProviderPrecision(repo, { windowDays: 90, now: new Date() });
    expect(m.size).toBe(0);
  });
});
