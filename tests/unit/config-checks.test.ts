import { describe, expect, it } from "bun:test";
import { defineConfig } from "../../src/config/define-config.ts";

describe("phases.checks config", () => {
  it("accepts a valid checks block", () => {
    const c = defineConfig({
      phases: {
        checks: { commands: [{ name: "typecheck", run: "bun run typecheck", timeoutMs: 120000 }] },
      },
    } as Parameters<typeof defineConfig>[0]);
    expect(c.phases.checks).not.toBeNull();
    if (c.phases.checks) expect(c.phases.checks.commands[0]?.name).toBe("typecheck");
  });
  it("rejects a command missing `run`", () => {
    expect(() =>
      defineConfig({
        phases: {
          checks: { commands: [{ name: "typecheck" } as { name: string; run: string }] },
        },
      } as Parameters<typeof defineConfig>[0]),
    ).toThrow();
  });
  it("rejects an empty commands array", () => {
    expect(() =>
      defineConfig({
        phases: {
          checks: { commands: [] },
        },
      } as Parameters<typeof defineConfig>[0]),
    ).toThrow();
  });
  it("defaults checks to null when omitted", () => {
    expect(defineConfig({}).phases.checks ?? null).toBeNull();
  });
});
