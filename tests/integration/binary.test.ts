// tests/integration/binary.test.ts
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const BIN = "./dist/reviewgate";

(existsSync(BIN) ? describe : describe.skip)("compiled binary", () => {
  it("reports a version", () => {
    const r = spawnSync(BIN, ["--version"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/0\.1\.0-m1/);
  });

  it("doctor exits with a defined code", () => {
    const r = spawnSync(BIN, ["doctor"], { encoding: "utf8" });
    expect([0, 1, 2]).toContain(r.status ?? -1);
  });
});
