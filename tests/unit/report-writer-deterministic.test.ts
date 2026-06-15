import { describe, expect, it } from "bun:test";
import { findingBadges } from "../../src/core/report-writer.ts";
import type { Finding } from "../../src/schemas/finding.ts";

const finding = (extra: Partial<Finding>): Finding => ({
  id: "check-typecheck",
  signature: "check:typecheck",
  severity: "CRITICAL",
  category: "correctness",
  rule_id: "deterministic-check/typecheck",
  file: "(deterministic check: typecheck)",
  line_start: 1,
  line_end: 1,
  message: "Deterministic check failed",
  details: "Command: bun run typecheck\nStatus: exited 1\n\nerror TS2532",
  reviewer: { provider: "checks", model: "deterministic", persona: "checks" },
  confidence: 1,
  consensus: "singleton",
  ...extra,
});

describe("report-writer deterministic badge", () => {
  it("renders a non-rejectable badge for a deterministic finding", () => {
    const badges = findingBadges(finding({ deterministic: true }));
    expect(badges).not.toBeNull();
    expect(badges?.toLowerCase()).toContain("deterministic check");
  });
  it("renders no such badge for a normal finding", () => {
    const badges = findingBadges(finding({}));
    expect(badges === null || !badges.toLowerCase().includes("deterministic check")).toBe(true);
  });
});
