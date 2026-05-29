// tests/integration/sandbox-exec-real.test.ts
//
// Real end-to-end proof that sandbox-exec filesystem isolation actually works on
// macOS: a denied path read fails (exit ≠ 0, no secret in stdout), an allowed
// path read succeeds (exit 0, content present).
//
// The outer describe is skipped on non-darwin platforms (synchronous check).
// Inside the single `it`, we probe sandboxExecAvailable() and return early
// (pass but do nothing) if sandbox-exec is absent on this host — no test failure.

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { __resetSandboxExecCache, sandboxExecAvailable } from "../../src/sandbox/availability.ts";
import type { SandboxProfile } from "../../src/sandbox/profile-builder.ts";
import { buildMacosSbpl, resolveForSandbox } from "../../src/sandbox/sbpl.ts";
import { spawnSafely } from "../../src/utils/spawn.ts";

(platform() === "darwin" ? describe : describe.skip)("sandbox-exec real isolation (macOS)", () => {
  it("denies read of a secret dir and allows read of the work dir", async () => {
    // Probe availability inside the test so it works as a clean early-exit
    __resetSandboxExecCache();
    const available = await sandboxExecAvailable();
    if (!available) {
      // sandbox-exec not available on this host — skip gracefully
      return;
    }

    // Set up temp directories
    const base = mkdtempSync(join(tmpdir(), "rg-sandbox-e2e-"));
    const fakeHome = join(base, "home");
    const secretDir = join(fakeHome, ".ssh");
    const workDir = join(base, "work");
    const outDir = join(base, "out");

    mkdirSync(fakeHome, { recursive: true });
    mkdirSync(secretDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });
    mkdirSync(outDir, { recursive: true });

    writeFileSync(join(secretDir, "id_rsa"), "TOPSECRET", { mode: 0o600 });
    writeFileSync(join(workDir, "ok.txt"), "PUBLIC");

    // Build a profile: allow reads from workDir, deny reads from secretDir.
    // Paths are already absolute realpaths from mkdtempSync; resolveForSandbox
    // will canonicalise them against fakeHome just as production code does.
    const resolvedSecretDir = resolveForSandbox(secretDir, fakeHome);
    const resolvedWorkDir = resolveForSandbox(workDir, fakeHome);

    const profile: SandboxProfile = {
      sandboxRequested: true,
      fs: {
        readAllow: [resolvedWorkDir],
        readDeny: [resolvedSecretDir],
        readDenyGlobs: [],
        writeAllow: [resolvedWorkDir],
      },
      net: { allow: [] },
      budget: { walltimeMs: 30_000 },
    };

    // Sanity check: SBPL contains the deny rule for the secret path
    const sbpl = buildMacosSbpl(profile);
    expect(sbpl).toContain("deny file-read*");
    expect(sbpl).toContain(resolvedSecretDir);

    try {
      // --- DENIED read: cat the secret file ---
      const secretStdout = join(outDir, "secret-stdout.txt");
      const secretStderr = join(outDir, "secret-stderr.txt");
      writeFileSync(secretStdout, "");
      writeFileSync(secretStderr, "");

      const deniedResult = await spawnSafely({
        command: "/bin/cat",
        args: [join(secretDir, "id_rsa")],
        stdoutFile: secretStdout,
        stderrFile: secretStderr,
        timeoutMs: 30_000,
        sandbox: { profile, mode: "strict" },
      });

      expect(deniedResult.sandboxApplied).toBe(true);
      expect(deniedResult.exitCode).not.toBe(0);
      const secretOut = readFileSync(secretStdout, "utf8");
      expect(secretOut).not.toContain("TOPSECRET");

      // --- ALLOWED read: cat the work file ---
      const workStdout = join(outDir, "work-stdout.txt");
      const workStderr = join(outDir, "work-stderr.txt");
      writeFileSync(workStdout, "");
      writeFileSync(workStderr, "");

      const allowedResult = await spawnSafely({
        command: "/bin/cat",
        args: [join(workDir, "ok.txt")],
        stdoutFile: workStdout,
        stderrFile: workStderr,
        timeoutMs: 30_000,
        sandbox: { profile, mode: "strict" },
      });

      expect(allowedResult.sandboxApplied).toBe(true);
      expect(allowedResult.exitCode).toBe(0);
      const workOut = readFileSync(workStdout, "utf8");
      expect(workOut).toContain("PUBLIC");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

import { buildSandboxProfile } from "../../src/sandbox/profile-builder.ts";

// PRODUCTION-PROFILE e2e: uses the REAL buildSandboxProfile (not a bespoke one), so
// it would catch a profile that throws before spawning (e.g. a broad readDeny of
// /tmp or /Users conflicting with writeAllow — the original BROAD_DENY bug) AND a
// glob deny that doesn't actually match (*.pem as literal subpath). DoD-caught.
describe("sandbox-exec REAL isolation via the PRODUCTION profile (macOS)", () => {
  it("repo read allowed · *.pem glob denied · findings write allowed · out-of-area write denied", async () => {
    if (platform() !== "darwin" || !(await sandboxExecAvailable())) return;
    const { mkdtempSync, writeFileSync, readFileSync, existsSync } = await import("node:fs");
    const tmp = await import("node:os");
    const work = mkdtempSync(join(tmp.tmpdir(), "rg-prodwork-"));
    const runDir = mkdtempSync(join(tmp.tmpdir(), "rg-prodrun-"));
    writeFileSync(join(work, "ok.txt"), "REPO_PUBLIC");
    writeFileSync(join(work, "secret.pem"), "PRIVATE_KEY"); // *.pem glob → must be denied even in workdir
    const findingsPath = join(runDir, "findings.md");

    const profile = buildSandboxProfile({
      providerId: "codex",
      mode: "strict",
      workingDir: work,
      findingsPath,
      tmpDir: runDir,
    });
    const sb = { profile, mode: "strict" as const };
    const out = (n: string) => ({
      stdoutFile: join(runDir, `${n}.out`),
      stderrFile: join(runDir, `${n}.err`),
      timeoutMs: 30_000,
    });

    // read repo file → ALLOWED (no broad deny, no conflict-throw)
    const r1 = await spawnSafely({
      command: "/bin/cat",
      args: [join(work, "ok.txt")],
      ...out("ok"),
      sandbox: sb,
    });
    expect(r1.exitCode).toBe(0);
    expect(readFileSync(join(runDir, "ok.out"), "utf8")).toContain("REPO_PUBLIC");

    // read *.pem (even inside the workdir) → DENIED by the glob regex
    const r2 = await spawnSafely({
      command: "/bin/cat",
      args: [join(work, "secret.pem")],
      ...out("pem"),
      sandbox: sb,
    });
    expect(r2.exitCode).not.toBe(0);
    expect(readFileSync(join(runDir, "pem.out"), "utf8")).not.toContain("PRIVATE_KEY");

    // write findings → ALLOWED
    const r3 = await spawnSafely({
      command: "/usr/bin/touch",
      args: [findingsPath],
      ...out("w1"),
      sandbox: sb,
    });
    expect(r3.exitCode).toBe(0);
    expect(existsSync(findingsPath)).toBe(true);

    // write OUTSIDE the writable area (the read-only workdir) → DENIED
    const r4 = await spawnSafely({
      command: "/usr/bin/touch",
      args: [join(work, "evil.txt")],
      ...out("w2"),
      sandbox: sb,
    });
    expect(r4.exitCode).not.toBe(0);
    expect(existsSync(join(work, "evil.txt"))).toBe(false);
  });
});
