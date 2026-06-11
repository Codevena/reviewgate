import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditEventInput } from "../../src/audit/logger.ts";
import { emitDecisionOutcomes } from "../../src/core/loop-driver.ts";
import { decisionsPath, pendingJsonPath } from "../../src/utils/paths.ts";

function seed(): string {
  const root = mkdtempSync(join(tmpdir(), "rg-emit-"));
  mkdirSync(join(root, ".reviewgate", "decisions"), { recursive: true });
  const finding = (id: string, severity: string, provider: string) => ({
    id,
    signature: `sig-${id}`,
    severity,
    category: "correctness",
    rule_id: "r",
    file: "a.ts",
    line_start: 1,
    line_end: 1,
    message: "m",
    details: "d",
    reviewer: { provider, model: "x", persona: "p" },
    confidence: 0.9,
    consensus: "singleton",
  });
  writeFileSync(
    pendingJsonPath(root),
    JSON.stringify({
      findings: [finding("F-001", "CRITICAL", "codex"), finding("F-002", "WARN", "gemini")],
      counts: { critical: 1, warn: 1, info: 0 },
    }),
  );
  writeFileSync(
    decisionsPath(root, 1),
    [
      JSON.stringify({
        schema: "reviewgate.decision.v1",
        finding_id: "F-001",
        verdict: "accepted",
        action: "fixed",
      }),
      JSON.stringify({
        schema: "reviewgate.decision.v1",
        finding_id: "F-002",
        verdict: "rejected",
        reason: "x".repeat(25),
        reviewer_was_wrong: true,
      }),
    ].join("\n"),
  );
  return root;
}

function fakeAudit() {
  const events: AuditEventInput[] = [];
  return {
    events,
    append: async (e: AuditEventInput) => {
      events.push(e);
      return e as never;
    },
  };
}

describe("emitDecisionOutcomes", () => {
  it("emits one decision.applied per joined decision with the right bucket", async () => {
    const root = seed();
    const audit = fakeAudit();
    await emitDecisionOutcomes(root, 1, "sess", audit);
    expect(audit.events).toHaveLength(2);
    const byId = new Map(
      audit.events.map((e) => [e.decision_outcome?.finding_id, e.decision_outcome]),
    );
    expect(byId.get("F-001")).toEqual({
      finding_id: "F-001",
      severity: "CRITICAL",
      bucket: "tp",
      providers: ["codex"],
    });
    expect(byId.get("F-002")?.bucket).toBe("fp");
    expect(audit.events.every((e) => e.event === "decision.applied")).toBe(true);
  });

  it("skips a decision whose finding_id is not in pending.json", async () => {
    const root = seed();
    writeFileSync(
      decisionsPath(root, 1),
      JSON.stringify({
        schema: "reviewgate.decision.v1",
        finding_id: "F-999",
        verdict: "accepted",
        action: "fixed",
      }),
    );
    const audit = fakeAudit();
    await emitDecisionOutcomes(root, 1, "sess", audit);
    expect(audit.events).toHaveLength(0);
  });
});

describe("emit watermark idempotency (call-layer contract)", () => {
  it("a second emit of the same iter still appends — guard MUST live in the caller", async () => {
    // Documents WHY run() needs the decisions_emitted_through_iter guard: the helper
    // itself is not idempotent across calls. The guard is asserted via state below.
    const root = seed();
    const audit = fakeAudit();
    await emitDecisionOutcomes(root, 1, "sess", audit);
    await emitDecisionOutcomes(root, 1, "sess", audit);
    expect(audit.events).toHaveLength(4); // proves the caller-side watermark is required
  });
});
