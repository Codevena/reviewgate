import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reputationCheck } from "../../src/cli/commands/doctor.ts";
import type { ReviewgateConfig } from "../../src/config/define-config.ts";
import { ReputationStore } from "../../src/core/reputation/store.ts";

const repCfg = { enabled: true, minSamples: 8, trustFloor: 0.35, halfLifeDays: 45 };
const cfgOn = () => ({ phases: { reputation: repCfg } }) as unknown as ReviewgateConfig;

describe("reputationCheck", () => {
  it("returns null when reputation is disabled", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-docrep-off-"));
    const cfg = {
      phases: { reputation: { ...repCfg, enabled: false } },
    } as unknown as ReviewgateConfig;
    expect(await reputationCheck(repo, cfg)).toBeNull();
  });
  it("reports 'no data yet' when enabled but empty", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-docrep-empty-"));
    const c = await reputationCheck(repo, cfgOn());
    expect(c?.status).toBe("ok");
    expect(c?.detail).toMatch(/no reputation data|nothing/i);
  });
  it("flags a demoting provider with warn", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-docrep-warn-"));
    const now = new Date();
    await new ReputationStore(repo).record(
      Array.from({ length: 10 }, (_, i) => ({
        provider: "gemini" as const,
        outcome: "wrong" as const,
        eid: `w${i}`,
        ts: now.toISOString(),
      })),
    );
    const c = await reputationCheck(repo, cfgOn());
    expect(c?.status).toBe("warn");
    expect(c?.detail).toContain("gemini");
    expect(c?.detail).toContain("demoting");
  });
});
