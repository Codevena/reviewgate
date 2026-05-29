import { describe, expect, it } from "bun:test";
import { buildSandboxProfile } from "../../src/sandbox/profile-builder.ts";

describe("buildSandboxProfile", () => {
  it("produces strict profile for codex with credential path allowed", () => {
    const p = buildSandboxProfile({
      providerId: "codex",
      mode: "strict",
      workingDir: "/repo",
      findingsPath: "/repo/.reviewgate/findings/codex.md",
      tmpDir: "/tmp/rg-run-1",
    });
    expect(p.fs.readDeny).toContain("~/.ssh");
    expect(p.fs.readAllow).toContain("/repo");
    expect(p.fs.readAllow).toContain("/tmp/rg-run-1");
    expect(p.fs.readAllow.some((path) => path.includes(".codex"))).toBe(true);
    expect(p.fs.readAllow.some((path) => path.includes(".claude"))).toBe(false);
    // own-cred dirs are also in writeAllow (OAuth token refresh); check required entries present
    expect(p.fs.writeAllow).toEqual(
      expect.arrayContaining(["/repo/.reviewgate/findings/codex.md", "/tmp/rg-run-1"]),
    );
    expect(p.net.allow).toContain("api.openai.com");
    expect(p.net.allow).not.toContain("api.anthropic.com");
  });

  it("threads config writablePaths/deniedReads into the profile (F-058: not dead keys)", () => {
    // The sandbox.writablePaths / sandbox.deniedReads config keys must actually
    // influence the profile — previously they were defined in schema/defaults but
    // never read, presenting a security knob that did nothing.
    const p = buildSandboxProfile({
      providerId: "codex",
      mode: "strict",
      workingDir: "/repo",
      findingsPath: "/repo/.reviewgate/findings/codex.md",
      tmpDir: "/tmp/rg-run-1",
      writablePaths: ["/repo/.reviewgate/"],
      deniedReads: ["~/.kube", "/repo/secrets"],
    });
    expect(p.fs.writeAllow).toContain("/repo/.reviewgate/");
    expect(p.fs.readDeny).toContain("~/.kube");
    expect(p.fs.readDeny).toContain("/repo/secrets");
    // Hard-coded protections remain in place alongside the config additions.
    expect(p.fs.readDeny).toContain("~/.ssh");
  });

  it("off mode returns sandboxRequested=false", () => {
    const p = buildSandboxProfile({
      providerId: "codex",
      mode: "off",
      workingDir: "/repo",
      findingsPath: "/repo/x.md",
      tmpDir: "/tmp/x",
    });
    expect(p.sandboxRequested).toBe(false);
  });

  it("makes the OWN provider credential dir writable (OAuth token refresh)", () => {
    const p = buildSandboxProfile({
      providerId: "codex",
      mode: "strict",
      workingDir: "/repo",
      findingsPath: "/repo/.reviewgate/findings/codex.md",
      tmpDir: "/tmp/rg-run-1",
    });
    expect(p.fs.writeAllow.some((w) => w.includes(".codex"))).toBe(true);
  });

  it("denies reads of the expanded secret baseline", () => {
    const p = buildSandboxProfile({
      providerId: "codex",
      mode: "strict",
      workingDir: "/repo",
      findingsPath: "/repo/.reviewgate/findings/codex.md",
      tmpDir: "/tmp/rg-run-1",
    });
    expect(p.fs.readDeny).toContain("~/.netrc");
    expect(p.fs.readDeny).toContain("~/.git-credentials");
    expect(p.fs.readDeny).toContain("~/.npmrc");
    expect(p.fs.readDeny).toContain("~/.bash_history");
  });
});
