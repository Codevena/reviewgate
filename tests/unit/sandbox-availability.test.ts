import { describe, expect, it } from "bun:test";
import { platform } from "node:os";
import {
  __resetBwrapCache,
  __resetSandboxExecCache,
  bwrapAvailable,
  sandboxExecAvailable,
  sandboxRuntimeAvailable,
} from "../../src/sandbox/availability.ts";

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

describe("bwrapAvailable", () => {
  it("returns a boolean; false off-linux; memoizes", async () => {
    __resetBwrapCache();
    const a = await bwrapAvailable();
    expect(typeof a).toBe("boolean");
    if (platform() !== "linux") expect(a).toBe(false);
    const b = await bwrapAvailable();
    expect(a).toBe(b);
  });
});

describe("sandboxRuntimeAvailable", () => {
  it("delegates per platform and is false on unsupported OSes", async () => {
    const r = await sandboxRuntimeAvailable();
    expect(typeof r).toBe("boolean");
    if (platform() !== "darwin" && platform() !== "linux") expect(r).toBe(false);
  });
});
