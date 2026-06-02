// tests/unit/orchestrator-persona-reaffirm.test.ts
import { describe, expect, it } from "bun:test";
import { reaffirmFor } from "../../src/core/orchestrator.ts";

describe("reaffirmFor (persona reaffirmation)", () => {
  it("returns the security auditor reaffirmation for the security persona", () => {
    expect(reaffirmFor("security").toLowerCase()).toContain("security");
  });

  it("gives quality/performance/testing their OWN reaffirmation, not the security one", () => {
    const security = reaffirmFor("security");
    for (const p of ["quality", "performance", "testing", "correctness"]) {
      const r = reaffirmFor(p);
      expect(r).not.toBe(security);
      expect(r.toLowerCase()).not.toContain("security auditor");
    }
  });

  it("falls back to a NEUTRAL default for an unknown persona, not the security text", () => {
    const fallback = reaffirmFor("totally-unknown-persona");
    expect(fallback).not.toBe(reaffirmFor("security"));
    expect(fallback.toLowerCase()).not.toContain("security auditor");
    expect(fallback.length).toBeGreaterThan(0);
  });
});
