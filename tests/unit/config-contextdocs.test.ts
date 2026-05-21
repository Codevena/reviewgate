import { describe, expect, it } from "bun:test";
import { defineConfig } from "../../src/config/define-config.ts";

describe("config contextDocs", () => {
  it("defaults to off (null)", () => {
    expect(defineConfig({}).phases.contextDocs ?? null).toBeNull();
  });

  it("accepts enabled:true and applies field defaults", () => {
    const c = defineConfig({
      phases: { contextDocs: { enabled: true } },
    } as Parameters<typeof defineConfig>[0]);
    expect(c.phases.contextDocs?.enabled).toBe(true);
    expect(c.phases.contextDocs?.apiKeyEnv).toBe("CONTEXT7_API_KEY");
    expect(c.phases.contextDocs?.host).toBe("context7.com");
    expect(c.phases.contextDocs?.budgetBytes).toBe(8000);
    expect(c.phases.contextDocs?.perLibBytes).toBe(2500);
    expect(c.phases.contextDocs?.maxLibs).toBe(5);
    expect(c.phases.contextDocs?.ttlDays).toBe(30);
  });

  it("accepts overrides", () => {
    const c = defineConfig({
      phases: { contextDocs: { enabled: true, maxLibs: 2, ttlDays: 7, host: "ctx.example" } },
    } as Parameters<typeof defineConfig>[0]);
    expect(c.phases.contextDocs?.maxLibs).toBe(2);
    expect(c.phases.contextDocs?.ttlDays).toBe(7);
    expect(c.phases.contextDocs?.host).toBe("ctx.example");
  });
});
