import { describe, expect, it } from "bun:test";
import { SandboxUnavailableError } from "../../src/sandbox/errors.ts";

describe("SandboxUnavailableError", () => {
  it("is an instance of Error", () => {
    const err = new SandboxUnavailableError("sandbox not available");
    expect(err).toBeInstanceOf(Error);
  });

  it("has name === 'SandboxUnavailableError'", () => {
    const err = new SandboxUnavailableError("sandbox not available");
    expect(err.name).toBe("SandboxUnavailableError");
  });

  it("passes message through", () => {
    const err = new SandboxUnavailableError("test message");
    expect(err.message).toBe("test message");
  });
});
