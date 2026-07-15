// tests/unit/doctor.test.ts
import { describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Check,
  agentHostHooksCheck,
  checkBinary,
  doctorExitCode,
  runDoctor,
} from "../../src/cli/commands/doctor.ts";

describe("runDoctor", () => {
  it("returns exit 0 or 1 based on environment, prints a structured report", async () => {
    const code = await runDoctor({ repoRoot: process.cwd(), capture: true });
    expect([0, 1, 2]).toContain(code);
  }, 30_000);

  it("bounds a wedged CLI version probe instead of hanging doctor", () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-doctor-hung-bin-"));
    const bin = join(dir, "hung-provider");
    writeFileSync(bin, "#!/bin/sh\nsleep 2\n");
    chmodSync(bin, 0o755);

    const started = Date.now();
    const check = checkBinary(bin, "hung provider", 50);

    expect(check.status).toBe("fail");
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("doctorExitCode", () => {
  const ok: Check = { name: "a", status: "ok", detail: "" };
  const warn: Check = { name: "b", status: "warn", detail: "" };
  const fail: Check = { name: "c", status: "fail", detail: "" };

  it("returns 0 when all checks are ok", () => {
    expect(doctorExitCode([ok, ok])).toBe(0);
  });

  it("returns 0 when checks are only advisory warnings (e.g. valid codex-only install)", () => {
    // A green-by-design minimal install (no agy/claude/rg, no OPENROUTER_API_KEY)
    // emits warns, not fails. Warnings are advisory — a non-zero exit would break
    // `reviewgate doctor && ...` chains and CI health gates on a perfectly valid setup.
    expect(doctorExitCode([ok, warn, warn])).toBe(0);
  });

  it("returns 2 when any check fails (fail dominates warn)", () => {
    expect(doctorExitCode([ok, warn, fail])).toBe(2);
  });

  it("a strict sandbox check that fails makes doctor exit 2", () => {
    const checks: Check[] = [
      { name: "sandbox isolation", status: "fail", detail: "strict but sandbox-exec unavailable" },
    ];
    expect(doctorExitCode(checks)).toBe(2);
  });
});

describe("agentHostHooksCheck", () => {
  it("warns honestly when no host hooks are installed", () => {
    const c = agentHostHooksCheck("/definitely/missing/reviewgate/repo");
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("no Claude Code or Codex");
  });

  it("distinguishes an installed Codex hook from user-controlled activation", () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-doctor-codex-trust-"));
    mkdirSync(join(repo, ".codex"), { recursive: true });
    writeFileSync(
      join(repo, ".codex", "hooks.json"),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: ".reviewgate/bin/gate", timeout: 2400 }] }],
        },
      }),
    );

    const c = agentHostHooksCheck(repo);
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("installed");
    expect(c.detail).toContain("not visible to Reviewgate");
    expect(c.hint).toContain("/hooks");
    expect(c.hint).toContain("SessionStart/PostToolUse/Stop");
  });
});
