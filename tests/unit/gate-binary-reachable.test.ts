// tests/unit/gate-binary-reachable.test.ts
//
// The #1 first-run failure: the Claude Code Stop hook runs `.reviewgate/bin/gate`
// under a (non-login) PATH; a bare `exec reviewgate` that isn't on it exits 127
// with empty stdout, which Claude Code reads as "allow stop" — a SILENT no-op
// gate. Fix: init bakes an absolute path + the shim falls back to PATH and FAILS
// CLOSED (emits a block decision) when nothing resolves; doctor verifies it.
import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateBinaryReachableCheck } from "../../src/cli/commands/doctor.ts";
import { runInit, shSingleQuote } from "../../src/cli/commands/init.ts";

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
    expect(shim).toContain("RG_BIN=''");
  });

  it("the gate shim also fails closed if the binary can't run on this host (wrong arch / 126/127)", async () => {
    const repo = tmpRepo();
    await runInit({ repoRoot: repo, mode: "agent-loop" });
    const shim = readFileSync(join(repo, ".reviewgate", "bin", "gate"), "utf8");
    expect(shim).toContain("could not run it on this host"); // 126/127 fail-closed block
    // two block decisions: (1) nothing resolved, (2) resolved but can't run on this host
    expect(shim.match(/"decision":"block"/g)?.length).toBe(2);
  });

  it("gate shim FAILS CLOSED (not fail-open) when the binary is +x but un-runnable (ENOEXEC / wrong arch → exit 126)", async () => {
    const repo = tmpRepo();
    await runInit({ repoRoot: repo, mode: "agent-loop" });

    // Create a file that is executable (+x) but NOT a valid program on this host.
    // Writing raw non-ELF, non-Mach-O bytes ensures the kernel returns ENOEXEC,
    // which bash translates to exit 126.
    const badBin = join(repo, "fake-reviewgate");
    writeFileSync(badBin, Buffer.from([0x00, 0x01, 0x02, 0xff]));
    chmodSync(badBin, 0o755);

    // Overwrite the shim with __REVIEWGATE_BIN__ substituted to our bad binary.
    const template = readFileSync(join(import.meta.dirname, "../../bin-templates/gate.sh"), "utf8");
    const shimContent = template.replace("__REVIEWGATE_BIN__", shSingleQuote(badBin));
    writeFileSync(join(repo, ".reviewgate", "bin", "gate"), shimContent, { mode: 0o755 });

    // Run the shim with stdin closed (mimics Claude Code's Stop hook invocation).
    const proc = Bun.spawnSync(["bash", join(repo, ".reviewgate", "bin", "gate")], {
      stdin: null,
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = new TextDecoder().decode(proc.stdout);
    // Must exit 0 (a block decision, not an unhandled error exit).
    expect(proc.exitCode).toBe(0);
    // Must emit a block decision so Claude Code is not silently allowed to stop.
    expect(stdout).toContain('"decision":"block"');
    expect(stdout).toContain("could not run it on this host");
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

describe("shSingleQuote (baked-path shell-injection safety)", () => {
  it("leaves a normal path unchanged", () => {
    expect(shSingleQuote("/usr/local/bin/reviewgate")).toBe("/usr/local/bin/reviewgate");
  });

  it("passes shell metacharacters through literally (single-quote context disables expansion)", () => {
    // No single quote → unchanged; wrapped in RG_BIN='…' these stay literal, so a
    // path like `/tmp/a";$(touch pwned)/reviewgate` cannot execute at hook time.
    expect(shSingleQuote('a";$(touch pwned)`id`')).toBe('a";$(touch pwned)`id`');
  });

  it("escapes an embedded single quote so the value can't break out of RG_BIN='…'", () => {
    expect(shSingleQuote("x';rm -rf ~")).toBe("x'\\'';rm -rf ~");
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

  it("checks the shared shim for a Codex-only installation", async () => {
    const repo = tmpRepo();
    await runInit({ repoRoot: repo, mode: "agent-loop", host: "codex" });
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

  it("decodes a single-quote-escaped baked path (no truncation at the quote)", async () => {
    const repo = tmpRepo();
    await runInit({ repoRoot: repo, mode: "agent-loop" });
    // A real executable at a path containing a single quote.
    const qbin = join(repo, "a'b-reviewgate");
    writeFileSync(qbin, "#!/bin/sh\n");
    chmodSync(qbin, 0o755);
    // Simulate init baking that quoted path (RG_BIN='…' with ' escaped as '\'').
    writeFileSync(
      join(repo, ".reviewgate", "bin", "gate"),
      `#!/usr/bin/env bash\nset -u\nRG_BIN='${shSingleQuote(qbin)}'\nexec "$RG_BIN" gate --hook stop\n`,
    );
    const seen: string[] = [];
    const c = gateBinaryReachableCheck(repo, (bin) => {
      seen.push(bin);
      return bin === qbin;
    });
    expect(c?.status).toBe("ok"); // decode → existsSync(qbin) → runs(qbin) → ok
    expect(seen).toContain(qbin); // probed the FULL decoded path, not a truncation
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
