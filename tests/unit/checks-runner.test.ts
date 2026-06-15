import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { runChecks } from "../../src/core/checks/runner.ts";

const repo = () => mkdtempSync(`${tmpdir()}/rg-checks-`);

describe("runChecks", () => {
  it("passes when every command exits 0", async () => {
    const r = await runChecks({ repoRoot: repo(), commands: [{ name: "ok", run: "true" }] });
    expect(r.ok).toBe(true);
  });

  it("fails on the first non-zero command (fail-fast) and does not run later ones", async () => {
    const dir = repo();
    const r = await runChecks({
      repoRoot: dir,
      commands: [
        { name: "typecheck", run: "false" },
        { name: "second", run: "touch ran-second" },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.finding.signature).toBe("check:typecheck");
      expect(r.finding.deterministic).toBe(true);
      expect(r.finding.severity).toBe("CRITICAL");
    }
    expect(await Bun.file(`${dir}/ran-second`).exists()).toBe(false);
  });

  it("treats command-not-found as a FAIL (fail-closed)", async () => {
    const r = await runChecks({
      repoRoot: repo(),
      commands: [{ name: "missing", run: "this-binary-does-not-exist-xyz" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.finding.details).toContain("Status:");
  });

  it("treats a timeout as a FAIL", async () => {
    const r = await runChecks({
      repoRoot: repo(),
      commands: [{ name: "slow", run: "sleep 5", timeoutMs: 100 }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.finding.details.toLowerCase()).toContain("timed out");
  });

  it("captures command output into the finding details (capped)", async () => {
    const r = await runChecks({
      repoRoot: repo(),
      commands: [{ name: "noisy", run: "echo BUILD_BROKEN_MARKER; exit 1" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.finding.details).toContain("BUILD_BROKEN_MARKER");
  });

  it("aborts immediately when the signal is already aborted (fail-closed)", async () => {
    const r = await runChecks({
      repoRoot: repo(),
      commands: [{ name: "x", run: "true" }],
      signal: AbortSignal.abort(),
    });
    expect(r.ok).toBe(false);
  });
});
