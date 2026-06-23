// tests/unit/npm-launcher.test.ts
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LAUNCHER = join(import.meta.dir, "..", "..", "bin", "reviewgate.cjs");
const HOST_PKG = `@codevena/reviewgate-${process.platform}-${process.arch}`;

function tmp() {
  return mkdtempSync(join(tmpdir(), "rg-launch-"));
}

describe("bin/reviewgate.cjs launcher", () => {
  it("resolves the host platform package and forwards argv + exit code", () => {
    const root = tmp();
    const pkgDir = join(root, "node_modules", HOST_PKG);
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: HOST_PKG, version: "0.0.0" }),
    );
    // Fake "binary": a shell script that echoes its args and exits 7.
    const fakeBin = join(pkgDir, "reviewgate");
    writeFileSync(fakeBin, '#!/bin/sh\necho "ARGS:$*"\nexit 7\n');
    chmodSync(fakeBin, 0o755);

    const res = spawnSync(process.execPath, [LAUNCHER, "foo", "bar"], {
      encoding: "utf8",
      env: { ...process.env, NODE_PATH: join(root, "node_modules") },
    });
    expect(res.stdout).toContain("ARGS:foo bar");
    expect(res.status).toBe(7);
  });

  it("exits 1 with a clear message when no platform package resolves", () => {
    const root = tmp(); // empty: no node_modules at all
    const res = spawnSync(process.execPath, [LAUNCHER, "doctor"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, NODE_PATH: join(root, "node_modules") },
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("no prebuilt binary");
  });
});
