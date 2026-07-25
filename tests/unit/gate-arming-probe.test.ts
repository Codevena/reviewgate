import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runGate, runGateSafe } from "../../src/cli/commands/gate.ts";
import { controlPlaneFlagPath, managedHookPath, reviewgateDir } from "../../src/utils/paths.ts";
import { armCheckout } from "../helpers/arm.ts";

function repo(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function addManagedHook(cwd: string): void {
  // Sourced from the same helper the probe uses, so the simulated "init armed this
  // checkout" state cannot silently drift away from what managedHookExists checks.
  mkdirSync(dirname(managedHookPath(cwd)), { recursive: true });
  writeFileSync(managedHookPath(cwd), "#!/bin/sh\n");
}

describe("gate arming probe (S2)", () => {
  it("stop in an UNARMED checkout with a project config: allow, loud notice, ZERO writes", async () => {
    const cwd = repo("rg-arm-cfg-");
    writeFileSync(join(cwd, "reviewgate.config.ts"), "export default {};\n");
    const out = await runGate({ repoRoot: cwd, hook: "stop", hookStdinRaw: "" });
    expect(out.exitCode).toBe(0);
    // No decision at all — an unarmed checkout must neither block nor claim a pass.
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("NOT ARMED");
    expect(out.stderr).toContain("config approve");
    // The load-bearing assertion: nothing was created. Before S2 this path ran
    // resolveControlPlaneConfig, which throws for a first-contact project config
    // (S1) — and for a bare tree auto-baselined an LKG into a fresh .reviewgate/.
    expect(existsSync(reviewgateDir(cwd))).toBe(false);
  });

  it("stop in an UNARMED BARE checkout: allow, SILENT, zero writes", async () => {
    const cwd = repo("rg-arm-bare-");
    const out = await runGate({ repoRoot: cwd, hook: "stop", hookStdinRaw: "" });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe("");
    // Silence is deliberate: a user-scoped hook (S4) fires in every repo, and a
    // notice here would be noise in every unrelated project.
    expect(out.stderr).toBe("");
    expect(existsSync(reviewgateDir(cwd))).toBe(false);
  });

  it("a DELETED approval does not disarm a checkout that init armed: still fail-closed", async () => {
    const cwd = repo("rg-arm-deleted-");
    addManagedHook(cwd); // init's managed hook survives; control-plane.json does not
    const out = await runGateSafe({ repoRoot: cwd, hook: "stop", hookStdinRaw: "" });
    const decision = JSON.parse(out.stdout) as { decision?: string };
    expect(decision.decision).toBe("block");
  });

  it("trigger in an UNARMED checkout writes nothing", async () => {
    const cwd = repo("rg-arm-trigger-");
    writeFileSync(join(cwd, "reviewgate.config.ts"), "export default {};\n");
    const out = await runGate({
      repoRoot: cwd,
      hook: "trigger",
      hookStdinRaw: JSON.stringify({
        tool_name: "Edit",
        tool_input: { file_path: join(cwd, "a.ts") },
      }),
    });
    expect(out.exitCode).toBe(0);
    // No notice on trigger — it would repeat on every single tool call.
    expect(out.stderr).toBe("");
    expect(existsSync(reviewgateDir(cwd))).toBe(false);
  });

  it("reset in an UNARMED checkout writes nothing", async () => {
    const cwd = repo("rg-arm-reset-");
    const out = await runGate({ repoRoot: cwd, hook: "reset", hookStdinRaw: "{}" });
    expect(out.exitCode).toBe(0);
    expect(existsSync(reviewgateDir(cwd))).toBe(false);
  });

  it("an ARMED checkout still arms the control-plane flag on an INVALID config", async () => {
    // Guards the pre-existing invariant that triggering must not depend on config
    // VALIDITY: the edit that BREAKS reviewgate.config.ts is exactly the one whose
    // signal must survive. The probe only asks whether a project source exists.
    const cwd = repo("rg-arm-invalid-");
    await armCheckout(cwd);
    writeFileSync(join(cwd, "reviewgate.config.ts"), "this is not valid typescript {{{\n");
    const out = await runGate({
      repoRoot: cwd,
      hook: "trigger",
      hookStdinRaw: JSON.stringify({
        tool_name: "Edit",
        tool_input: { file_path: join(cwd, "reviewgate.config.ts") },
      }),
    });
    expect(out.exitCode).toBe(0);
    expect(existsSync(controlPlaneFlagPath(cwd))).toBe(true);
  });
});
