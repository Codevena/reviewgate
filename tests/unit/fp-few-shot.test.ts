import { describe, expect, it } from "bun:test";
import { buildFpFewShot } from "../../src/core/fp-ledger/few-shot.ts";
import type { FpLedgerEntry } from "../../src/schemas/fp-ledger.ts";

function entry(over: Partial<FpLedgerEntry>): FpLedgerEntry {
  return {
    id: "FP-001",
    signature: "sig",
    rule_id: "magic-number",
    category: "quality",
    file: "src/a.ts",
    symbol: "foo",
    stage: "active",
    rejects: [],
    distinct_providers: ["codex", "gemini"],
    first_seen_at: "t",
    last_seen_at: "t",
    created_at: "t",
    ...over,
  };
}

describe("buildFpFewShot", () => {
  it("returns empty string when there are no active entries", () => {
    expect(buildFpFewShot({ active: new Map(), changedFiles: ["src/a.ts"] })).toBe("");
  });

  it("returns empty string when no active entry matches a changed file", () => {
    const active = new Map([["sig", entry({ file: "src/other.ts" })]]);
    expect(buildFpFewShot({ active, changedFiles: ["src/a.ts"] })).toBe("");
  });

  it("renders matching entries with file + rule + category + symbol", () => {
    const active = new Map([
      [
        "sig",
        entry({ file: "src/a.ts", rule_id: "magic-number", category: "quality", symbol: "foo" }),
      ],
    ]);
    const text = buildFpFewShot({ active, changedFiles: ["src/a.ts"] });
    expect(text).toContain("Known false positives");
    expect(text).toContain("src/a.ts");
    expect(text).toContain("magic-number");
    expect(text).toContain("quality");
    expect(text).toContain("foo");
  });

  it("respects the byte budget and notes the remainder", () => {
    const active = new Map<string, FpLedgerEntry>();
    for (let i = 0; i < 50; i++) {
      active.set(
        `sig${i}`,
        entry({ id: `FP-${i}`, signature: `sig${i}`, file: "src/a.ts", rule_id: `rule-${i}` }),
      );
    }
    const text = buildFpFewShot({ active, changedFiles: ["src/a.ts"], budgetBytes: 200 });
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(260); // budget + the (+N more) tail
    expect(text).toContain("more)");
  });
});
