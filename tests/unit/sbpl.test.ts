import { describe, expect, it } from "bun:test";
import { realpathSync } from "node:fs";
import { resolveForSandbox } from "../../src/sandbox/sbpl.ts";

describe("resolveForSandbox", () => {
  it("resolves /tmp to its canonical path (macOS: /private/tmp)", () => {
    expect(resolveForSandbox("/tmp", "/Users/x")).toBe(realpathSync("/tmp"));
  });

  it("expands ~ in paths using homeDir", () => {
    expect(resolveForSandbox("~/.ssh", "/Users/x")).toBe("/Users/x/.ssh");
  });

  it("expands bare ~ to homeDir", () => {
    expect(resolveForSandbox("~", "/Users/x")).toBe("/Users/x");
  });

  it("resolves non-existent path by walking up to nearest real ancestor", () => {
    const result = resolveForSandbox("/tmp/does-not-exist-xyz/findings.md", "/Users/x");
    expect(result).toBe(`${realpathSync("/tmp")}/does-not-exist-xyz/findings.md`);
  });
});
