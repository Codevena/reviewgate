import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { priorAdjudications } from "../../src/core/loop-driver.ts";
import { decisionsPath, pendingJsonPath } from "../../src/utils/paths.ts";

type Finding = {
  id: string;
  signature: string;
  file: string;
  line_start: number;
  line_end: number;
};

function fixture(findings: Finding[], decisions: object[], iter = 1): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-adj-"));
  const pj = pendingJsonPath(dir);
  const dp = decisionsPath(dir, iter);
  mkdirSync(join(dir, ".reviewgate", "decisions"), { recursive: true });
  writeFileSync(pj, JSON.stringify({ findings }));
  writeFileSync(dp, decisions.map((d) => JSON.stringify(d)).join("\n"));
  return dir;
}

const f = (id: string, line: number): Finding => ({
  id,
  signature: `sig-${id}`,
  file: "src/quiz.ts",
  line_start: line,
  line_end: line,
});

describe("priorAdjudications (S1)", () => {
  it("returns [] when there is no prior iteration", () => {
    expect(priorAdjudications("/tmp/does-not-exist", 0)).toEqual([]);
  });

  it("joins a fixed (accepted) decision to the finding location", () => {
    const dir = fixture(
      [f("F-001", 40)],
      [
        {
          schema: "reviewgate.decision.v1",
          finding_id: "F-001",
          verdict: "accepted",
          action: "fixed",
        },
      ],
    );
    const adj = priorAdjudications(dir, 1);
    expect(adj).toHaveLength(1);
    expect(adj[0]).toMatchObject({ file: "src/quiz.ts", lineStart: 40, disposition: "addressed" });
  });

  it("joins a rejected decision and carries the agent reason", () => {
    const dir = fixture(
      [f("F-002", 52)],
      [
        {
          schema: "reviewgate.decision.v1",
          finding_id: "F-002",
          verdict: "rejected",
          reason: "TS narrows discriminated unions fine here",
          reviewer_was_wrong: true,
        },
      ],
    );
    const adj = priorAdjudications(dir, 1);
    expect(adj[0]).toMatchObject({
      disposition: "rejected",
      reason: "TS narrows discriminated unions fine here",
    });
  });

  it("last-decision-per-id wins (a superseding line overwrites an earlier one)", () => {
    const dir = fixture(
      [f("F-003", 10)],
      [
        {
          schema: "reviewgate.decision.v1",
          finding_id: "F-003",
          verdict: "accepted",
          action: "fixed",
        },
        {
          schema: "reviewgate.decision.v1",
          finding_id: "F-003",
          verdict: "rejected",
          reason: "actually the reviewer was wrong about this one",
        },
      ],
    );
    const adj = priorAdjudications(dir, 1);
    expect(adj).toHaveLength(1);
    expect(adj[0]?.disposition).toBe("rejected");
  });

  it("skips a decision whose finding id is absent from pending.json", () => {
    const dir = fixture(
      [f("F-001", 40)],
      [
        {
          schema: "reviewgate.decision.v1",
          finding_id: "F-999",
          verdict: "accepted",
          action: "fixed",
        },
      ],
    );
    expect(priorAdjudications(dir, 1)).toEqual([]);
  });

  it("never throws on a malformed decisions line (returns the valid ones)", () => {
    const dir = fixture(
      [f("F-001", 40)],
      [
        {
          schema: "reviewgate.decision.v1",
          finding_id: "F-001",
          verdict: "accepted",
          action: "fixed",
        },
      ],
    );
    // append a garbage line
    writeFileSync(
      decisionsPath(dir, 1),
      `{not json\n${JSON.stringify({ schema: "reviewgate.decision.v1", finding_id: "F-001", verdict: "accepted", action: "fixed" })}`,
    );
    expect(priorAdjudications(dir, 1)).toHaveLength(1);
  });
});
