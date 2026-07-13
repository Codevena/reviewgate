// tests/integration/binary.test.ts
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pkg from "../../package.json";

const BIN = "./dist/reviewgate";

(existsSync(BIN) ? describe : describe.skip)("compiled binary", () => {
  it("reports the package.json version (JSON import survives --compile)", () => {
    const r = spawnSync(BIN, ["--version"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(pkg.version);
  });

  it("doctor exits with a defined code", () => {
    const r = spawnSync(BIN, ["doctor"], { encoding: "utf8" });
    expect([0, 1, 2]).toContain(r.status ?? -1);
  }, 20000);

  it("runs the complete quick init and installs native Claude + Codex hooks", () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-binary-init-"));
    const r = spawnSync(resolve(BIN), ["init", "--quick", "--host", "both", "--skip-doctor"], {
      cwd: repo,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(existsSync(join(repo, ".claude", "settings.json"))).toBe(true);
    expect(existsSync(join(repo, ".codex", "hooks.json"))).toBe(true);
    expect(existsSync(join(repo, ".reviewgate", "control-plane.json"))).toBe(true);
    const codex = readFileSync(join(repo, ".codex", "hooks.json"), "utf8");
    expect(codex).toContain("REVIEWGATE_AGENT_HOST=codex");
  });
});
