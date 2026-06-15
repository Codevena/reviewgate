// tests/unit/gate-binary-reachable.test.ts
//
// The #1 first-run failure: the Claude Code Stop hook runs `.reviewgate/bin/gate`
// under a (non-login) PATH; a bare `exec reviewgate` that isn't on it exits 127
// with empty stdout, which Claude Code reads as "allow stop" — a SILENT no-op
// gate. Fix: init bakes an absolute path + the shim falls back to PATH and FAILS
// CLOSED (emits a block decision) when nothing resolves; doctor verifies it.
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateBinaryReachableCheck } from "../../src/cli/commands/doctor.ts";
import { runInit } from "../../src/cli/commands/init.ts";

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "rg-gatebin-"));
}

describe("init generates a PATH-resilient, fail-closed gate shim", () => {
  it("resolves a binary then FAILS CLOSED — never a bare `exec reviewgate`", async () => {
    const repo = tmpRepo();
    const res = await runInit({ repoRoot: repo, mode: "agent-loop" });
    const shim = readFileSync(join(repo, ".reviewgate", "bin", "gate"), "utf8");
    expect(shim).toContain("RG_BIN="); // resolution preamble present
    expect(shim).toContain("command -v reviewgate"); // PATH fallback
    expect(shim).toContain('"decision":"block"'); // fail closed on unresolved
    expect(shim).not.toMatch(/^exec reviewgate /m); // no bare exec (the old fail-open)
    // Under `bun test` process.execPath is the bun runtime (not a `reviewgate`
    // binary), so nothing is baked and the shim relies on PATH.
    expect(res.bakedBin).toBe("");
    expect(shim).toContain('RG_BIN=""');
  });

  it("trigger/reset shims are best-effort (exit 0 on unresolved, never block)", async () => {
    const repo = tmpRepo();
    await runInit({ repoRoot: repo, mode: "agent-loop" });
    for (const n of ["trigger", "reset"]) {
      const s = readFileSync(join(repo, ".reviewgate", "bin", n), "utf8");
      expect(s).toContain("RG_BIN=");
      expect(s).toContain("exit 0"); // best-effort, never blocks
      expect(s).not.toContain('"decision":"block"');
    }
  });
});

describe("gateBinaryReachableCheck (doctor)", () => {
  it("returns null when the Stop hook isn't installed", () => {
    expect(gateBinaryReachableCheck(tmpRepo(), () => true)).toBeNull();
  });

  it("ok when `reviewgate` resolves on PATH", async () => {
    const repo = tmpRepo();
    await runInit({ repoRoot: repo, mode: "agent-loop" });
    const c = gateBinaryReachableCheck(repo, (bin) => bin === "reviewgate");
    expect(c?.status).toBe("ok");
  });

  it("FAILS when neither a baked path nor PATH resolves (broken install)", async () => {
    const repo = tmpRepo();
    await runInit({ repoRoot: repo, mode: "agent-loop" });
    const c = gateBinaryReachableCheck(repo, () => false);
    expect(c?.status).toBe("fail");
    expect(c?.detail).toContain("fails closed");
  });

  it("warns on an OLD bare-exec shim (silent no-op risk) even if PATH resolves", async () => {
    const repo = tmpRepo();
    await runInit({ repoRoot: repo, mode: "agent-loop" });
    writeFileSync(
      join(repo, ".reviewgate", "bin", "gate"),
      "#!/usr/bin/env bash\nset -u\nexec reviewgate gate --hook stop\n",
    );
    const c = gateBinaryReachableCheck(repo, (bin) => bin === "reviewgate");
    expect(c?.status).toBe("warn");
    expect(c?.detail.toLowerCase()).toContain("old hook shim");
  });
});
