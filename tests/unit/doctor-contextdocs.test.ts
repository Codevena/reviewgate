import { describe, expect, it } from "bun:test";
import { contextDocsCheck } from "../../src/cli/commands/doctor.ts";
import { defineConfig } from "../../src/config/define-config.ts";

describe("contextDocsCheck", () => {
  it("returns null when contextDocs is disabled", () => {
    expect(contextDocsCheck(defineConfig({}), {})).toBeNull();
  });

  it("ok + 'set' when contextDocs enabled and key present", () => {
    const cfg = defineConfig({ phases: { contextDocs: { enabled: true } } } as Parameters<
      typeof defineConfig
    >[0]);
    const c = contextDocsCheck(cfg, { CONTEXT7_API_KEY: "x" });
    expect(c?.status).toBe("ok");
    expect(c?.detail).toContain("set");
  });

  it("ok + keyless hint when enabled and key unset", () => {
    const cfg = defineConfig({ phases: { contextDocs: { enabled: true } } } as Parameters<
      typeof defineConfig
    >[0]);
    const c = contextDocsCheck(cfg, {});
    expect(c?.status).toBe("ok");
    expect(c?.detail).toContain("keyless");
  });
});
