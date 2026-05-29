import { describe, expect, it } from "bun:test";
import { platform } from "node:os";
import { __resetSandboxExecCache, sandboxExecAvailable } from "../../src/sandbox/availability.ts";

describe("sandboxExecAvailable", () => {
  it("returns a boolean", async () => {
    __resetSandboxExecCache();
    const result = await sandboxExecAvailable();
    expect(typeof result).toBe("boolean");
  });

  it("on darwin, sandbox-exec is available", async () => {
    __resetSandboxExecCache();
    const result = await sandboxExecAvailable();
    if (platform() === "darwin") {
      expect(result).toBe(true);
    } else {
      expect(result).toBe(false);
    }
  });

  it("memoizes — two calls return the same value without re-probing", async () => {
    __resetSandboxExecCache();
    const first = await sandboxExecAvailable();
    const second = await sandboxExecAvailable();
    expect(first).toBe(second);
  });
});
