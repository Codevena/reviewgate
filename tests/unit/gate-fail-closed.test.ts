// tests/unit/gate-fail-closed.test.ts
//
// M-A0.1 — The stop-hook gate must FAIL CLOSED on ANY uncaught error. If
// runGate throws (zod parse, fs error, adapter-build crash, etc.), the gate
// command must still emit a {"decision":"block"} on stdout and exit 0 — never
// let the exception escape to citty (→ stderr stack + exit 1 + empty stdout →
// Claude Code treats the turn as ALLOWED → un-reviewed turn ships = fail-open).
// A trigger/reset crash is NOT the review, so it must not block the turn.
import { describe, expect, it } from "bun:test";
import { type GateInput, type GateOutput, runGateSafe } from "../../src/cli/commands/gate.ts";

const baseInput: GateInput = { repoRoot: "/tmp/nope", hook: "stop", hookStdinRaw: "{}" };

describe("runGateSafe — fail-closed on internal error", () => {
  it("a thrown error during a STOP gate emits a fail-closed block (exit 0)", async () => {
    const boom = () => {
      throw new Error("boom-xyz");
    };
    const out = await runGateSafe(baseInput, boom);
    expect(out.exitCode).toBe(0);
    const parsed = JSON.parse(out.stdout || "{}") as { decision?: string; reason?: string };
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("internal error");
    expect(parsed.reason).toContain("boom-xyz");
  });

  it("a rejected promise during a STOP gate also fails closed", async () => {
    const reject = () => Promise.reject(new Error("async-boom"));
    const out = await runGateSafe(baseInput, reject);
    const parsed = JSON.parse(out.stdout || "{}") as { decision?: string; reason?: string };
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("async-boom");
  });

  it("a thrown error during a TRIGGER does NOT block the turn", async () => {
    const boom = () => {
      throw new Error("trigger-boom");
    };
    const out = await runGateSafe({ ...baseInput, hook: "trigger" }, boom);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe(""); // no block decision
    expect(out.stderr).toContain("trigger-boom");
  });

  it("a successful run passes through unchanged", async () => {
    const ok: GateOutput = { exitCode: 0, stdout: "passthrough", stderr: "sig" };
    const out = await runGateSafe(baseInput, async () => ok);
    expect(out).toEqual(ok);
  });
});
