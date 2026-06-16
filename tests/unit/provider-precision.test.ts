// tests/unit/provider-precision.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  annotateFindingsWithPrecision,
  loadProviderPrecision,
  perProviderPrecision,
} from "../../src/core/provider-precision.ts";
import type { DecisionOutcome } from "../../src/schemas/audit-event.ts";
import type { Finding } from "../../src/schemas/finding.ts";

function dec(bucket: DecisionOutcome["bucket"], providers: string[], severity: DecisionOutcome["severity"] = "CRITICAL"): DecisionOutcome {
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
});

describe("annotateFindingsWithPrecision", () => {
  const precision = new Map([
    ["codex", { tp: 22, fp: 3, precision: 22 / 25 }],
    ["openrouter", { tp: 2, fp: 1, precision: 2 / 3 }], // only 3 samples
  ]);

  it("attaches reviewer_precision only for providers with >= minDecisions samples", () => {
    const out = annotateFindingsWithPrecision([finding("codex")], precision, { minDecisions: 5 });
    expect(out[0]?.reviewer_precision).toEqual([{ provider: "codex", tp: 22, fp: 3, precision: 22 / 25 }]);
  });

  it("omits a provider below minDecisions (no annotation when none qualify)", () => {
    const out = annotateFindingsWithPrecision([finding("openrouter")], precision, { minDecisions: 5 });
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
