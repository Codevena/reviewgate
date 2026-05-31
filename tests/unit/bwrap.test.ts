import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNoSandboxOverlap, buildBwrapArgs } from "../../src/sandbox/bwrap.ts";
import type { SandboxProfile } from "../../src/sandbox/profile-builder.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rg-bwrap-"));
  const workDir = join(root, "work");
  const findFile = join(root, "findings.md");
  const secretDir = join(root, ".ssh");
  const secretFile = join(root, ".netrc");
  const absent = join(root, "does-not-exist");
  mkdirSync(workDir, { recursive: true });
  writeFileSync(findFile, "");
  mkdirSync(secretDir, { recursive: true });
  writeFileSync(secretFile, "secret");
  const profile: SandboxProfile = {
    sandboxRequested: true,
    fs: {
      readAllow: [],
      readDeny: [secretDir, secretFile, absent],
      readDenyGlobs: ["*.pem", ".env"],
      writeAllow: [workDir, findFile],
      writeTargets: [],
    },
    net: { allow: [] },
    budget: { walltimeMs: 30_000 },
  };
  return { profile, workDir, findFile, secretDir, secretFile, absent };
}

describe("assertNoSandboxOverlap", () => {
  it("throws when a writeAllow is under a readDeny (and vice versa), passes when disjoint", () => {
    expect(() => assertNoSandboxOverlap(["/a/b"], ["/a"])).toThrow(/write-only|nested|conflict/i);
    expect(() => assertNoSandboxOverlap(["/a"], ["/a/b"])).toThrow(/write-only|nested|conflict/i);
    expect(() => assertNoSandboxOverlap(["/x"], ["/y"])).not.toThrow();
  });
});

describe("buildBwrapArgs", () => {
  it("emits the namespace flags, ro-root, isolated dev/proc, and a -- terminator", () => {
    const { profile } = fixture();
    const a = buildBwrapArgs(profile);
    expect(a.slice(0, 3)).toEqual(["--die-with-parent", "--unshare-user", "--unshare-pid"]);
    expect(a.join(" ")).toContain("--ro-bind / /");
    expect(a.join(" ")).toContain("--dev /dev");
    expect(a.join(" ")).toContain("--proc /proc");
    expect(a[a.length - 1]).toBe("--");
    expect(a).not.toContain("--unshare-net");
  });

  it("binds each EXISTING writeAllow at its own location (file->file, dir->dir)", () => {
    const { profile, workDir, findFile } = fixture();
    const j = buildBwrapArgs(profile).join(" ");
    expect(j).toContain(`--bind ${workDir} ${workDir}`);
    expect(j).toContain(`--bind ${findFile} ${findFile}`);
  });

  it("masks an existing secret DIR with --tmpfs and an existing secret FILE with --ro-bind /dev/null; skips a non-existent secret", () => {
    const { profile, secretDir, secretFile, absent } = fixture();
    const a = buildBwrapArgs(profile);
    const j = a.join(" ");
    expect(j).toContain(`--tmpfs ${secretDir}`);
    expect(j).toContain(`--ro-bind /dev/null ${secretFile}`);
    expect(a).not.toContain(absent);
  });

  it("emits every deny-mask AFTER every writable bind (mask-last)", () => {
    const { profile } = fixture();
    const a = buildBwrapArgs(profile);
    expect(a.indexOf("--tmpfs")).toBeGreaterThan(a.lastIndexOf("--bind"));
  });

  it("ignores readDenyGlobs entirely (documented Linux gap)", () => {
    const j = buildBwrapArgs(fixture().profile).join(" ");
    expect(j).not.toContain("*.pem");
    expect(j).not.toContain(".env");
  });

  it("throws when writeAllow and readDeny are nested (either direction)", () => {
    const { profile, secretDir } = fixture();
    expect(() =>
      buildBwrapArgs({ ...profile, fs: { ...profile.fs, writeAllow: [join(secretDir, "leak")] } }),
    ).toThrow(/write-only|nested|conflict/i);
    expect(() =>
      buildBwrapArgs({
        ...profile,
        fs: { ...profile.fs, writeAllow: [secretDir.replace(/\.ssh$/, "")] },
      }),
    ).toThrow(/write-only|nested|conflict/i);
  });
});
