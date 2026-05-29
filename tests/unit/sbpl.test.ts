import { describe, expect, it } from "bun:test";
import { realpathSync } from "node:fs";
import { buildMacosSbpl, resolveForSandbox } from "../../src/sandbox/sbpl.ts";
import type { SandboxProfile } from "../../src/sandbox/profile-builder.ts";

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

describe("buildMacosSbpl", () => {
  const profile: SandboxProfile = {
    sandboxRequested: true,
    fs: {
      readAllow: ["/repo", "/private/tmp/run"],
      readDeny: ["/Users/x/.ssh"],
      writeAllow: ["/private/tmp/run", "/repo/.reviewgate/findings/codex.md"],
    },
    net: { allow: ["api.openai.com"] },
    budget: { walltimeMs: 300_000 },
  };

  it("starts with (version 1)", () => {
    const sbpl = buildMacosSbpl(profile);
    expect(sbpl.startsWith("(version 1)")).toBe(true);
  });

  it("contains (allow default)", () => {
    const sbpl = buildMacosSbpl(profile);
    expect(sbpl).toContain("(allow default)");
  });

  it("contains (deny file-write*)", () => {
    const sbpl = buildMacosSbpl(profile);
    expect(sbpl).toContain("(deny file-write*)");
  });

  it("contains write-allow subpath for /private/tmp/run", () => {
    const sbpl = buildMacosSbpl(profile);
    expect(sbpl).toContain('(subpath "/private/tmp/run")');
  });

  it("contains (deny file-read* ...)", () => {
    const sbpl = buildMacosSbpl(profile);
    expect(sbpl).toContain("(deny file-read*");
  });

  it("contains read-deny subpath for /Users/x/.ssh", () => {
    const sbpl = buildMacosSbpl(profile);
    expect(sbpl).toContain('(subpath "/Users/x/.ssh")');
  });

  it("(deny file-write*) appears before (allow file-write*)", () => {
    const sbpl = buildMacosSbpl(profile);
    expect(sbpl.indexOf("(deny file-write*)")).toBeLessThan(
      sbpl.indexOf("(allow file-write*"),
    );
  });

  it("throws on write-only conflict: writeAllow nested under readDeny", () => {
    const conflictProfile: SandboxProfile = {
      sandboxRequested: true,
      fs: {
        readAllow: [],
        readDeny: ["/Users/x/.ssh"],
        writeAllow: ["/Users/x/.ssh/leak"],
      },
      net: { allow: [] },
      budget: { walltimeMs: 300_000 },
    };
    expect(() => buildMacosSbpl(conflictProfile)).toThrow(/write-only|nested|conflict/i);
  });
});
