import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { probeArming } from "../../src/config/control-plane.ts";
import { managedHookPath } from "../../src/utils/paths.ts";
import { armCheckout } from "../helpers/arm.ts";

function repo(): string {
  return mkdtempSync(join(tmpdir(), "rg-arming-"));
}

function input(cwd: string) {
  return { cwd, env: process.env as Record<string, string | undefined>, home: cwd };
}

function addManagedHook(cwd: string): void {
  // Sourced from the same helper the probe uses, so the simulated "init armed this
  // checkout" state cannot silently drift away from what managedHookExists checks.
  mkdirSync(dirname(managedHookPath(cwd)), { recursive: true });
  writeFileSync(managedHookPath(cwd), "#!/bin/sh\n");
}

describe("probeArming", () => {
  test("approved LKG present → armed, even with a managed hook present", async () => {
    const cwd = repo();
    // The managed hook is deliberate: without it, swapping the order of the two checks
    // inside probeArming would STILL yield {armed:true} and the order mutation would
    // not go red. The hook is what makes this case discriminating.
    addManagedHook(cwd);
    await armCheckout(cwd);
    expect(await probeArming(input(cwd))).toEqual({ armed: true });
  });

  test("managed hook but no LKG → state-missing (caller must keep blocking)", async () => {
    const cwd = repo();
    addManagedHook(cwd);
    expect(await probeArming(input(cwd))).toEqual({ armed: false, kind: "state-missing" });
  });

  test("project config, no hook, no LKG → unarmed-with-config", async () => {
    const cwd = repo();
    writeFileSync(join(cwd, "reviewgate.config.ts"), "export default {};\n");
    expect(await probeArming(input(cwd))).toEqual({
      armed: false,
      kind: "unarmed-with-config",
    });
  });

  test("bare tree → unarmed-bare", async () => {
    expect(await probeArming(input(repo()))).toEqual({ armed: false, kind: "unarmed-bare" });
  });

  test("an UNPARSEABLE project config is still unarmed-with-config (never parsed)", async () => {
    // Guards the gate.ts invariant that arming must not depend on config VALIDITY:
    // the probe asks whether a project source exists, never whether it parses.
    const cwd = repo();
    writeFileSync(join(cwd, "reviewgate.config.ts"), "this is not valid typescript {{{\n");
    expect(await probeArming(input(cwd))).toEqual({
      armed: false,
      kind: "unarmed-with-config",
    });
  });

  test("probing an unarmed checkout creates nothing", async () => {
    const cwd = repo();
    writeFileSync(join(cwd, "reviewgate.config.ts"), "export default {};\n");
    await probeArming(input(cwd));
    expect(existsSync(join(cwd, ".reviewgate"))).toBe(false);
  });
});
