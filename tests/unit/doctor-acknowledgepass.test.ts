import { describe, expect, it } from "bun:test";
import { acknowledgePassCheck } from "../../src/cli/commands/doctor.ts";
import { defineConfig } from "../../src/config/define-config.ts";

describe("acknowledgePassCheck", () => {
  it("is silent (null) on the default config (acknowledgePass off)", () => {
    expect(acknowledgePassCheck(defineConfig({}))).toBeNull();
  });

  it("warns when loop.acknowledgePass is enabled (not agent-loop-safe)", () => {
    const cfg = defineConfig({ loop: { acknowledgePass: true } } as Parameters<
      typeof defineConfig
    >[0]);
    const c = acknowledgePassCheck(cfg);
    expect(c).not.toBeNull();
    expect(c?.status).toBe("warn");
    // names the mechanism (re-nag) and the TTY-only escape so the cause is actionable
    expect(c?.detail).toContain("config approve");
    expect(c?.hint).toContain("notify.desktop");
  });
});
