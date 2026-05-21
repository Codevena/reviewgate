import { describe, expect, it } from "bun:test";
import { FpLedgerEntrySchema, FpLedgerIndexSchema } from "../../src/schemas/fp-ledger.ts";

const entry = {
  id: "FP-001",
  signature: "sig",
  rule_id: "magic-number",
  category: "quality",
  file: "src/a.ts",
  symbol: "foo",
  stage: "candidate",
  rejects: [{ run_id: "r", provider: "codex", ts: "2026-05-21T00:00:00Z", reason: "x" }],
  distinct_providers: ["codex"],
  first_seen_at: "t",
  last_seen_at: "t",
  created_at: "t",
};

describe("FpLedgerEntrySchema", () => {
  it("parses a valid candidate entry", () => {
    expect(FpLedgerEntrySchema.parse(entry).stage).toBe("candidate");
  });
  it("rejects an unknown stage", () => {
    expect(() => FpLedgerEntrySchema.parse({ ...entry, stage: "bogus" })).toThrow();
  });
  it("FpLedgerIndexSchema wraps entries with a schema literal", () => {
    const idx = FpLedgerIndexSchema.parse({ schema: "reviewgate.fpledger.v1", entries: [entry] });
    expect(idx.entries).toHaveLength(1);
  });
});
