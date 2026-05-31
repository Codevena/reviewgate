// tests/integration/bwrap-real.test.ts
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { bwrapAvailable } from "../../src/sandbox/availability.ts";
import type { SandboxProfile } from "../../src/sandbox/profile-builder.ts";
import { resolveForSandbox } from "../../src/sandbox/sbpl.ts";
import { spawnSafely } from "../../src/utils/spawn.ts";

// Top-level await so we can use describe.skipIf (cleaner than an in-`it` early return).
const RUNNABLE = platform() === "linux" && (await bwrapAvailable());

describe.skipIf(!RUNNABLE)("bwrap REAL filesystem isolation (Linux)", () => {
  it("denies a secret read, allows a workdir read, allows a workdir write, denies an out-of-area write", async () => {
    const home = mkdtempSync(join(tmpdir(), "rg-home-"));
    const secretDir = join(home, ".ssh");
    const work = mkdtempSync(join(tmpdir(), "rg-work-"));
    mkdirSync(secretDir, { recursive: true });
    writeFileSync(join(secretDir, "id_rsa"), "TOPSECRET");
    writeFileSync(join(work, "ok.txt"), "PUBLIC");
    const outside = mkdtempSync(join(tmpdir(), "rg-outside-"));

    const profile: SandboxProfile = {
      sandboxRequested: true,
      fs: {
        readAllow: [resolveForSandbox(work, home)],
        readDeny: [resolveForSandbox(secretDir, home)],
        readDenyGlobs: [],
        writeAllow: [resolveForSandbox(work, home)],
        writeTargets: [{ path: resolveForSandbox(work, home), kind: "dir", createIfMissing: true }],
      },
      net: { allow: [] },
      budget: { walltimeMs: 30_000 },
    };
    const runDir = mkdtempSync(join(tmpdir(), "rg-bwrun-"));

    try {
      // 1. secret read denied (masked → empty dir, id_rsa gone)
      const deny = await spawnSafely({
        command: "/bin/cat",
        args: [join(secretDir, "id_rsa")],
        stdoutFile: join(runDir, "d.out"),
        stderrFile: join(runDir, "d.err"),
        timeoutMs: 30_000,
        sandbox: { profile, mode: "strict" },
      });
      // Guard against a false green: if bwrap had fallen back to unisolated, all
      // four isolation assertions could pass trivially — the very thing this test
      // exists to disprove. Require the sandbox to have actually been applied.
      expect(deny.sandboxApplied).toBe(true);
      expect(deny.exitCode).not.toBe(0);
      expect(readFileSync(join(runDir, "d.out"), "utf8")).not.toContain("TOPSECRET");

      // 2. workdir read allowed
      const allow = await spawnSafely({
        command: "/bin/cat",
        args: [join(work, "ok.txt")],
        stdoutFile: join(runDir, "a.out"),
        stderrFile: join(runDir, "a.err"),
        timeoutMs: 30_000,
        sandbox: { profile, mode: "strict" },
      });
      expect(allow.sandboxApplied).toBe(true);
      expect(allow.exitCode).toBe(0);
      expect(readFileSync(join(runDir, "a.out"), "utf8")).toContain("PUBLIC");

      // 3. workdir write allowed (and the file actually landed)
      const wOk = await spawnSafely({
        command: "/bin/sh",
        args: ["-c", `echo hi > ${join(work, "written.txt")}`],
        stdoutFile: join(runDir, "w.out"),
        stderrFile: join(runDir, "w.err"),
        timeoutMs: 30_000,
        sandbox: { profile, mode: "strict" },
      });
      expect(wOk.sandboxApplied).toBe(true);
      expect(wOk.exitCode).toBe(0);
      expect(readFileSync(join(work, "written.txt"), "utf8").trim()).toBe("hi");

      // 4. out-of-area write denied (read-only root)
      const wBad = await spawnSafely({
        command: "/bin/sh",
        args: ["-c", `echo hi > ${join(outside, "leak.txt")}`],
        stdoutFile: join(runDir, "wb.out"),
        stderrFile: join(runDir, "wb.err"),
        timeoutMs: 30_000,
        sandbox: { profile, mode: "strict" },
      });
      expect(wBad.sandboxApplied).toBe(true);
      expect(wBad.exitCode).not.toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});
