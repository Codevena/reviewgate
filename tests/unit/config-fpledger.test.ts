import { describe, expect, it } from "bun:test";
import { defineConfig } from "../../src/config/define-config.ts";

describe("config fpLedger", () => {
  it("defaults to off (null)", () => {
    expect(defineConfig({}).phases.fpLedger ?? null).toBeNull();
  });
  it("accepts enabled:true", () => {
    const c = defineConfig({
      phases: { fpLedger: { enabled: true } },
    } as Parameters<typeof defineConfig>[0]);
    expect(c.phases.fpLedger?.enabled).toBe(true);
  });
});
