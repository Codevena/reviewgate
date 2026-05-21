import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { computeRejectRate } from "../../src/core/fp-ledger/reject-rate.ts";
import { decisionsPath } from "../../src/utils/paths.ts";

function writeDecisions(repo: string, iter: number, lines: object[]) {
  const p = decisionsPath(repo, iter);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
}
const rejected = (id: string) => ({
  schema: "reviewgate.decision.v1",
  finding_id: id,
  verdict: "rejected",
  reason: "false positive on unchanged code xx",
  reviewer_was_wrong: true,
});
const accepted = (id: string) => ({
  schema: "reviewgate.decision.v1",
  finding_id: id,
  verdict: "accepted",
  action: "fixed",
});

describe("computeRejectRate", () => {
  it("rate + total over the iteration's decisions for expected (real) findings", () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-rr-"));
    writeDecisions(repo, 2, [rejected("F-001"), rejected("F-002"), accepted("F-003")]);
    const r = computeRejectRate(repo, 2, ["F-001", "F-002", "F-003"]);
    expect(r.total).toBe(3);
    expect(r.wrongRejects).toBe(2);
    expect(r.rate).toBeCloseTo(0.6667, 3);
  });

  it("ignores rejections without reviewer_was_wrong", () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-rr2-"));
    writeDecisions(repo, 1, [
      {
        schema: "reviewgate.decision.v1",
        finding_id: "F-001",
        verdict: "rejected",
        reason: "legitimately wont fix now xx",
      },
      accepted("F-002"),
    ]);
    const r = computeRejectRate(repo, 1, ["F-001", "F-002"]);
    expect(r.total).toBe(2);
    expect(r.wrongRejects).toBe(0);
    expect(r.rate).toBe(0);
  });

  it("is zero when there are no expected ids or no decisions file", () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-rr3-"));
    expect(computeRejectRate(repo, 1, [])).toEqual({ total: 0, wrongRejects: 0, rate: 0 });
    expect(computeRejectRate(repo, 9, ["F-001"])).toEqual({ total: 0, wrongRejects: 0, rate: 0 });
  });

  it("dedups duplicate finding_ids (cannot pad the count with repeated lines)", () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-rr4-"));
    writeDecisions(repo, 1, [
      rejected("F-001"),
      rejected("F-001"),
      rejected("F-001"),
      rejected("F-001"),
    ]);
    const r = computeRejectRate(repo, 1, ["F-001"]);
    expect(r.total).toBe(1);
    expect(r.wrongRejects).toBe(1);
  });

  it("ignores decisions for ids that were NOT real findings (cannot pad with fake ids)", () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-rr5-"));
    // One real finding rejected; three fabricated reviewer_was_wrong ids appended.
    writeDecisions(repo, 1, [
      rejected("F-001"),
      rejected("F-901"),
      rejected("F-902"),
      rejected("F-903"),
    ]);
    const r = computeRejectRate(repo, 1, ["F-001"]); // only F-001 was a real finding
    expect(r.total).toBe(1); // fabricated ids filtered out → below the min-sample guard
    expect(r.wrongRejects).toBe(1);
  });
});
