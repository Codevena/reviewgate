// tests/unit/spawn-sandbox.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxUnavailableError } from "../../src/sandbox/errors.ts";
import type { SandboxProfile } from "../../src/sandbox/profile-builder.ts";
import { spawnSafely } from "../../src/utils/spawn.ts";

/** A minimal SandboxProfile with all fs arrays empty (permits everything by default via SBPL `allow default`). */
const minimalProfile: SandboxProfile = {
  sandboxRequested: true,
  fs: {
    readAllow: [],
    readDeny: [],
    readDenyGlobs: [],
    writeAllow: [],
  },
  net: { allow: [] },
  budget: { walltimeMs: 30_000 },
};

/**
 * A minimal profile that also carries writeTargets so the linux path
 * can pre-create bind targets. On macOS this is ignored (SBPL path).
 */
const okProfile: SandboxProfile = {
  sandboxRequested: true,
  fs: {
    readAllow: [],
    readDeny: [],
    readDenyGlobs: [],
    writeAllow: [],
    writeTargets: [],
  },
  net: { allow: [] },
  budget: { walltimeMs: 30_000 },
};

/** Returns the stdoutFile / stderrFile paths for a given temp dir. */
function run(dir: string): { stdoutFile: string; stderrFile: string; timeoutMs: number } {
  return { stdoutFile: join(dir, "out"), stderrFile: join(dir, "err"), timeoutMs: 30_000 };
}

describe("spawnSafely — sandbox wrapping (macOS only)", () => {
  it("runs /bin/echo under sandbox-exec on macOS and sets sandboxApplied=true", async () => {
    if (platform() !== "darwin") {
      // This test only makes sense on macOS where sandbox-exec is available.
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "rg-sbtest-"));
    const outFile = join(dir, "out");
    const errFile = join(dir, "err");
    const res = await spawnSafely({
      command: "/bin/echo",
      args: ["hi"],
      stdoutFile: outFile,
      stderrFile: errFile,
      timeoutMs: 30_000,
      sandbox: { profile: minimalProfile, mode: "strict" },
    });
    expect(res.exitCode).toBe(0);
    expect(res.sandboxApplied).toBe(true);
    expect(res.sandboxFellBack).toBe(false);
    const out = readFileSync(outFile, "utf8");
    expect(out).toContain("hi");
  });
});

describe("spawnSafely — sandbox wrapping (non-macOS only)", () => {
  it("strict + sandbox unavailable → throws SandboxUnavailableError", async () => {
    const { sandboxRuntimeAvailable } = await import("../../src/sandbox/availability.ts");
    if (await sandboxRuntimeAvailable()) return; // only meaningful where NO runtime exists
    const dir = mkdtempSync(join(tmpdir(), "rg-spawnsb2-"));
    await expect(
      spawnSafely({
        command: "/bin/echo",
        args: ["hi"],
        ...run(dir),
        sandbox: { profile: okProfile, mode: "strict" },
      }),
    ).rejects.toBeInstanceOf(SandboxUnavailableError);
  });

  it("(linux) applies bwrap and the command still runs + reports sandboxApplied", async () => {
    const { bwrapAvailable } = await import("../../src/sandbox/availability.ts");
    if (platform() !== "linux" || !(await bwrapAvailable())) return; // linux+bwrap only
    const dir = mkdtempSync(join(tmpdir(), "rg-spawnsb-lnx-"));
    const res = await spawnSafely({
      command: "/bin/echo",
      args: ["hi"],
      ...run(dir),
      sandbox: { profile: okProfile, mode: "strict" },
    });
    expect(res.exitCode).toBe(0);
    expect(res.sandboxApplied).toBe(true);
    expect(readFileSync(join(dir, "out"), "utf8").trim()).toBe("hi");
  });
});

describe("spawnSafely — regression: no sandbox option", () => {
  it("normal spawn (no sandbox) still works and sandboxApplied is false", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-sbtest-"));
    const outFile = join(dir, "out");
    const errFile = join(dir, "err");
    const res = await spawnSafely({
      command: "bash",
      args: ["-c", "echo hello-world"],
      stdoutFile: outFile,
      stderrFile: errFile,
      timeoutMs: 30_000,
    });
    expect(res.exitCode).toBe(0);
    expect(res.sandboxApplied).toBe(false);
    expect(res.sandboxFellBack).toBe(false);
    expect(readFileSync(outFile, "utf8")).toContain("hello-world");
  });
});
