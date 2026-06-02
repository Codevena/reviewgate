import { describe, expect, it } from "bun:test";
import { realpathSync } from "node:fs";
import type { SandboxProfile } from "../../src/sandbox/profile-builder.ts";
import { buildMacosSbpl, globToSbplRegex, resolveForSandbox } from "../../src/sandbox/sbpl.ts";

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
      readDenyGlobs: ["*.pem", ".env"],
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
    expect(sbpl.indexOf("(deny file-write*)")).toBeLessThan(sbpl.indexOf("(allow file-write*"));
  });

  it("throws on write-only conflict: writeAllow nested under readDeny", () => {
    const conflictProfile: SandboxProfile = {
      sandboxRequested: true,
      fs: {
        readAllow: [],
        readDeny: ["/Users/x/.ssh"],
        readDenyGlobs: [],
        writeAllow: ["/Users/x/.ssh/leak"],
      },
      net: { allow: [] },
      budget: { walltimeMs: 300_000 },
    };
    expect(() => buildMacosSbpl(conflictProfile)).toThrow(/write-only|nested|conflict/i);
  });

  it("throws on the REVERSE overlap: a readDeny nested under a broad writeAllow (writable-but-unreadable secret)", () => {
    // Mirrors the bidirectional bwrap guard (assertNoSandboxOverlap). The missing
    // direction is isUnder(readDeny, writeAllow): a BROAD writeAllow (/Users/x)
    // that CONTAINS a readDeny (/Users/x/.ssh) emits (allow file-write* …/Users/x)
    // AND (deny file-read* …/.ssh), leaving the reviewer able to OVERWRITE
    // authorized_keys etc. while unable to read them — an integrity hole that
    // Linux already rejects.
    const conflictProfile: SandboxProfile = {
      sandboxRequested: true,
      fs: {
        readAllow: [],
        readDeny: ["/Users/x/.ssh"],
        readDenyGlobs: [],
        writeAllow: ["/Users/x"],
      },
      net: { allow: [] },
      budget: { walltimeMs: 300_000 },
    };
    expect(() => buildMacosSbpl(conflictProfile)).toThrow(/write-only|nested|conflict|un-?mask/i);
  });
});

describe("buildMacosSbpl — glob denies become anchored regexes (F: read-secret bypass)", () => {
  it("renders readDenyGlobs as (regex …), NOT a literal (subpath *.pem)", () => {
    const sbpl = buildMacosSbpl({
      sandboxRequested: true,
      fs: { readAllow: [], readDeny: [], readDenyGlobs: ["*.pem", ".env"], writeAllow: [] },
      net: { allow: [] },
      budget: { walltimeMs: 300_000 },
    });
    expect(sbpl).toContain("(deny file-read*");
    expect(sbpl).toContain("(regex ");
    // *.pem → anchored to a path segment ending in .pem; NOT a literal "*.pem" subpath
    expect(sbpl).not.toContain('(subpath "*.pem")');
    expect(sbpl).toContain("[^/]*");
  });
});

describe("globToSbplRegex", () => {
  it("anchors an extension glob to the file end and a basename to a path segment", () => {
    expect(globToSbplRegex("*.pem")).toBe('#"(^|/)[^/]*\\.pem$"');
    expect(globToSbplRegex(".env")).toBe('#"(^|/)\\.env$"');
  });
});
