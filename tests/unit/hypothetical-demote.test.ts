// tests/unit/hypothetical-demote.test.ts
// non-convergence #2 (field report 2026-06-17): demote a CRITICAL the reviewer's own text frames
// as currently-safe / hypothetical / future fragility one step to WARN. Fail-safe.
import { describe, expect, it } from "bun:test";
import { demoteHypotheticalCriticals } from "../../src/core/hypothetical-demote.ts";
import { demoteSelfRefuting } from "../../src/core/self-refutation.ts";
import type { Finding } from "../../src/schemas/finding.ts";

function f(over: Partial<Finding> = {}): Finding {
  return {
    id: "F-001",
    signature: "s",
    severity: "CRITICAL",
    category: "testing",
    rule_id: "r",
    file: "a.test.ts",
    line_start: 1,
    line_end: 1,
    message: "afterEach ordering",
    details: "d",
    reviewer: { provider: "claude-code", model: "x", persona: "security" },
    confidence: 0.9,
    consensus: "singleton",
    ...over,
  };
}
const one = (over: Partial<Finding>) => demoteHypotheticalCriticals([f(over)])[0];

describe("demoteHypotheticalCriticals — POSITIVE (CRITICAL→WARN)", () => {
  const positives: Array<[string, string]> = [
    ["currently safe + future", "This is currently safe, but a future change could reorder these."],
    ["no current issue", "No current issue here — afterEach runs last today."],
    ["hypothetical", "Hypothetical fragility if the suite later adds a global mock."],
    ["if a future change", "If a future change moves the reset, this would break."],
    ["future + refactor", "A future refactor of the setup could make this order-dependent."],
    ["not yet a problem", "Not yet a problem, but ordering is implicit."],
  ];
  for (const [name, details] of positives) {
    it(`demotes: ${name}`, () => {
      const out = one({ details });
      expect(out?.severity).toBe("WARN");
      expect(out?.hypothetical_demoted).toBe(true);
    });
  }

  it("G0: stamps demoted_from_critical provenance on the CRITICAL→WARN demote", () => {
    const out = one({ details: "Currently safe, but a future change could reorder these." });
    expect(out?.severity).toBe("WARN");
    expect(out?.demoted_from_critical).toBe(true);
  });
});

describe("demoteHypotheticalCriticals — NEGATIVE (stays CRITICAL)", () => {
  it("present-defect backstop: 'currently safe' AND 'already fails right now' stays CRITICAL", () => {
    const out = one({ details: "Currently safe in theory but this test already fails right now." });
    expect(out?.severity).toBe("CRITICAL");
  });
  it("EXEMPT security even with a hypothetical marker", () => {
    const out = one({
      category: "security",
      details: "Currently safe, but a future change could leak the token.",
    });
    expect(out?.severity).toBe("CRITICAL");
  });
  it("EXEMPT correctness even with a hypothetical marker", () => {
    const out = one({
      category: "correctness",
      details: "No current issue, but a future change might break the bound.",
    });
    expect(out?.severity).toBe("CRITICAL");
  });
  it("no hypothetical marker → unchanged", () => {
    const out = one({ details: "afterEach resets shared state; the order is wrong." });
    expect(out?.severity).toBe("CRITICAL");
  });
  it("WARN with a hypothetical marker → unchanged (CRITICAL-only)", () => {
    const out = one({
      severity: "WARN",
      details: "Currently safe; a future change could break it.",
    });
    expect(out?.severity).toBe("WARN");
    expect(out?.hypothetical_demoted).toBeUndefined();
  });
  it("deterministic check-tier finding is never demoted", () => {
    const out = one({ deterministic: true, details: "Currently safe; hypothetical future risk." });
    expect(out?.severity).toBe("CRITICAL");
  });
  it("no-op when disabled", () => {
    expect(
      demoteHypotheticalCriticals([f({ details: "currently safe; hypothetical" })], false)[0]
        ?.severity,
    ).toBe("CRITICAL");
  });
});

describe("distinct from self-refutation (#1)", () => {
  it("self-refutation does NOT fire on forward-looking text (so this pass is needed)", () => {
    const forward = f({ details: "This is currently safe, but a future change could break it." });
    // self-refutation's conditional guard rejects 'could/future' → leaves it CRITICAL
    expect(demoteSelfRefuting([forward])[0]?.severity).toBe("CRITICAL");
    // the hypothetical pass catches it
    expect(demoteHypotheticalCriticals([forward])[0]?.severity).toBe("WARN");
  });
});
