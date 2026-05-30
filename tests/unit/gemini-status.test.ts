// tests/unit/gemini-status.test.ts
import { describe, expect, it } from "bun:test";
import { classifyAgyOutcome } from "../../src/providers/gemini.ts";

describe("classifyAgyOutcome", () => {
  it("treats a watchdog/timeout kill with ZERO captured output as a quota/stall", () => {
    // agy emits its quota banner to the TTY only; quota'd + non-interactive it hangs
    // silently (0 bytes stdout+stderr) until the watchdog kills it. That silent stall
    // is agy's only observable quota signal → classify as quota-exhausted so the
    // orchestrator cools it down instead of retrying it every iteration.
    const r = classifyAgyOutcome({
      killedByTimeout: false,
      killedByWatchdog: true,
      exitCode: -1,
      outText: "",
      errText: "",
    });
    expect(r.status).toBe("quota-exhausted");
    expect(r.silentStall).toBe(true);
  });

  it("a timeout that DID emit partial output stays a plain timeout (not a stall)", () => {
    const r = classifyAgyOutcome({
      killedByTimeout: true,
      killedByWatchdog: false,
      exitCode: -1,
      outText: "partial {json...",
      errText: "",
    });
    expect(r.status).toBe("timeout");
    expect(r.silentStall).toBe(false);
  });

  it("an exit!=0 error carrying quota text is quota-exhausted (not a stall)", () => {
    const r = classifyAgyOutcome({
      killedByTimeout: false,
      killedByWatchdog: false,
      exitCode: 1,
      outText: "",
      errText: "Contact your administrator to enable overages.",
    });
    expect(r.status).toBe("quota-exhausted");
    expect(r.silentStall).toBe(false);
  });

  it("a clean exit 0 is ok", () => {
    const r = classifyAgyOutcome({
      killedByTimeout: false,
      killedByWatchdog: false,
      exitCode: 0,
      outText: '{"verdict":"PASS","findings":[]}',
      errText: "",
    });
    expect(r.status).toBe("ok");
    expect(r.silentStall).toBe(false);
  });

  it("an exit!=0 with a real crash message is a plain error", () => {
    const r = classifyAgyOutcome({
      killedByTimeout: false,
      killedByWatchdog: false,
      exitCode: 1,
      outText: "",
      errText: "SyntaxError: unexpected token",
    });
    expect(r.status).toBe("error");
    expect(r.silentStall).toBe(false);
  });
});
