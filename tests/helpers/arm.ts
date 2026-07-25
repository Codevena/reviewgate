import { homedir } from "node:os";
import { bootstrapControlPlane } from "../../src/config/control-plane.ts";

// Create a REAL, schema-valid approved baseline for `cwd`, so the checkout counts as
// ARMED for the S2 probe.
//
// Two traps this helper exists to avoid:
//
// 1. Hand-written control-plane.json fixtures. approved_source_fingerprint and
//    approved_effective_fingerprint are `z.string().min(64).max(64)` and
//    approved_config is the full ConfigSchema, so a short-string fixture fails to
//    parse, readState returns null, and the test silently exercises the UNARMED path
//    while looking green.
//
// 2. Mismatched config context. `runGate` resolves the control plane with
//    `process.env` + `homedir()`. Arming with a FAKE home bootstraps the LKG from
//    defaults only, and on a machine that has a global
//    ~/.config/reviewgate/reviewgate.config.ts the very next runGate call sees a
//    different effective config → an `approval-required` candidate → the forced review
//    path → unrelated assertions break. Both sides must use identical inputs; that is
//    also what keeps this consistent in CI, which has no global config.
export async function armCheckout(cwd: string): Promise<void> {
  await bootstrapControlPlane({
    cwd,
    env: process.env as Record<string, string | undefined>,
    home: homedir(),
    approvedVia: "init",
  });
}
