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
  it("returns rate + total across the cycle's decisions", () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-rr-"));
    writeDecisions(repo, 1, [rejected("F-001"), rejected("F-002"), accepted("F-003")]);
    writeDecisions(repo, 2, [rejected("F-001")]);
    const r = computeRejectRate(repo, 2);
    expect(r.total).toBe(4);
    expect(r.wrongRejects).toBe(3);
    expect(r.rate).toBeCloseTo(0.75, 5);
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
    const r = computeRejectRate(repo, 1);
    expect(r.total).toBe(2);
    expect(r.wrongRejects).toBe(0);
    expect(r.rate).toBe(0);
  });

  it("is zero for no decisions", () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-rr3-"));
    const r = computeRejectRate(repo, 3);
    expect(r).toEqual({ total: 0, wrongRejects: 0, rate: 0 });
  });
});
