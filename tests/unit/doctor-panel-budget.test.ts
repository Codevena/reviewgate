// tests/unit/doctor-panel-budget.test.ts
//
// Advisory sizing check: WARN when the configured worst-case panel wall-clock
// (slowest slot chain: primary + declared fallbacks, sequential inside one slot)
// plus the two-reserve tail (max(panel reserve, critic + critic reserve)) exceeds
// loop.runTimeoutMs — reviewer clamping will degrade such a config (truncated
// reviews / skipped fallbacks / skipped critic) instead of timing out, but the
// user should size the budget deliberately.
import { describe, expect, it } from "bun:test";
import { panelBudgetCheck } from "../../src/cli/commands/doctor.ts";
import { defineConfig } from "../../src/config/define-config.ts";

describe("doctor panel budget check", () => {
  it("warns when worst-case chain + critic exceeds runTimeoutMs", () => {
    const cfg = defineConfig({
      providers: {
        codex: { enabled: true, auth: "oauth", model: "m", timeoutMs: 600_000 },
        gemini: { enabled: true, auth: "oauth", model: "m", timeoutMs: 600_000 },
        "claude-code": { enabled: true, auth: "oauth", model: "m", timeoutMs: 600_000 },
      },
      phases: {
        review: {
          reviewers: [
            { provider: "codex", persona: "security", fallback: ["gemini", "claude-code"] },
          ],
        },
        critic: { provider: "claude-code", persona: "adversarial" },
      },
      loop: { runTimeoutMs: 720_000 },
    });
    const c = panelBudgetCheck(cfg);
    // chain 600+600+600 = 1800s + max(60s panel tail, 600s critic + 30s critic
    // tail) = 2430s > 720s → warn.
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("2430");
  });

  it("passes when the worst case fits", () => {
    const cfg = defineConfig({
      providers: {
        codex: { enabled: true, auth: "oauth", model: "m", timeoutMs: 300_000 },
        gemini: { enabled: true, auth: "oauth", model: "m", timeoutMs: 300_000 },
      },
      phases: {
        review: {
          reviewers: [{ provider: "codex", persona: "security", fallback: ["gemini"] }],
        },
        critic: null,
      },
      loop: { runTimeoutMs: 1_800_000 },
    });
    // chain 300+300 = 600s + max(60s, 0) = 660s ≤ 1800s → ok.
    expect(panelBudgetCheck(cfg).status).toBe("ok");
  });
});
