// tests/unit/fp-fragmentation.test.ts
import { describe, expect, it } from "bun:test";
import { fragmentingFpClasses } from "../../src/core/fp-ledger/fragmentation.ts";
import type { FpLedgerEntry } from "../../src/schemas/fp-ledger.ts";

const NOW = "2026-06-17T12:00:00.000Z";
function ago(days: number): string {
  return new Date(Date.parse(NOW) - days * 86_400_000).toISOString();
}
// Minimal valid FpLedgerEntry; the detector reads only file/signature/rule_id/rejects[].ts.
function entry(
  file: string,
  signature: string,
  rule_id: string,
  rejectTs: string[],
): FpLedgerEntry {
  return {
    id: signature,
    signature,
    rule_id,
    category: "security",
    file,
    symbol: "",
    stage: "candidate",
    rejects: rejectTs.map((ts) => ({ run_id: "r", provider: "codex", ts, reason: "fp" })),
    distinct_providers: ["codex"],
    first_seen_at: rejectTs[0] ?? NOW,
    last_seen_at: rejectTs.at(-1) ?? NOW,
    created_at: rejectTs[0] ?? NOW,
  };
}
const OPTS = {
  minDistinctSignatures: 3,
  minRejects: 3,
  windowDays: 60,
  suppressedFiles: new Set<string>(),
};

describe("fragmentingFpClasses", () => {
  it("flags a file with >= 3 distinct in-window signatures and >= 3 in-window rejects", () => {
    const out = fragmentingFpClasses(
      [
        entry("a.ts", "s1", "color-hsl", [ago(1)]),
        entry("a.ts", "s2", "css-var", [ago(2)]),
        entry("a.ts", "s3", "hsl-usage", [ago(3)]),
      ],
      NOW,
      OPTS,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.file).toBe("a.ts");
    expect(out[0]?.distinct_signatures).toBe(3);
    expect(out[0]?.total_rejects).toBe(3);
    expect(out[0]?.sample_rule_ids).toEqual(["color-hsl", "css-var", "hsl-usage"]);
  });

  it("does NOT flag below minDistinctSignatures (only 2 distinct sigs)", () => {
    const out = fragmentingFpClasses(
      [entry("a.ts", "s1", "r1", [ago(1), ago(2)]), entry("a.ts", "s2", "r2", [ago(1)])],
      NOW,
      OPTS,
    );
    expect(out).toEqual([]);
  });

  it("excludes a file in suppressedFiles entirely", () => {
    const out = fragmentingFpClasses(
      [
        entry("a.ts", "s1", "r1", [ago(1)]),
        entry("a.ts", "s2", "r2", [ago(2)]),
        entry("a.ts", "s3", "r3", [ago(3)]),
      ],
      NOW,
      { ...OPTS, suppressedFiles: new Set(["a.ts"]) },
    );
    expect(out).toEqual([]);
  });

  it("ignores stale (out-of-window) rejects — a signature with no in-window reject does not count", () => {
    const out = fragmentingFpClasses(
      [
        entry("a.ts", "s1", "r1", [ago(1)]),
        entry("a.ts", "s2", "r2", [ago(2)]),
        entry("a.ts", "s3", "r3", [ago(90)]), // stale → s3 not counted, only 2 distinct in-window
      ],
      NOW,
      OPTS,
    );
    expect(out).toEqual([]);
  });

  it("sorts multiple flagged files by total_rejects desc", () => {
    const out = fragmentingFpClasses(
      [
        entry("a.ts", "a1", "r", [ago(1)]),
        entry("a.ts", "a2", "r", [ago(1)]),
        entry("a.ts", "a3", "r", [ago(1)]),
        entry("b.ts", "b1", "r", [ago(1), ago(2)]),
        entry("b.ts", "b2", "r", [ago(1)]),
        entry("b.ts", "b3", "r", [ago(1)]),
      ],
      NOW,
      OPTS,
    );
    expect(out.map((f) => f.file)).toEqual(["b.ts", "a.ts"]); // b has 4 rejects, a has 3
  });
});
