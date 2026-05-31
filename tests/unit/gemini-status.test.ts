// tests/unit/gemini-status.test.ts
import { describe, expect, it } from "bun:test";
import { classifyAgyOutcome, isAgyPrintTimeout } from "../../src/providers/gemini.ts";

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

  it("agy's own print-timeout sentinel (exit 0, no review) is cooldown-worthy", () => {
    // agy is a coding agent: on a large review prompt it runs an agentic tool loop
    // and never emits a review — it self-aborts at --print-timeout with this exact
    // stdout sentinel and STILL exits 0. Without special handling that parses as an
    // ordinary "error" (no cooldown), so agy is re-run and burns the full timeout
    // EVERY iteration. Classify it as quota-exhausted so the orchestrator cools it
    // down and fails over to the next reviewer instead.
    const r = classifyAgyOutcome({
      killedByTimeout: false,
      killedByWatchdog: false,
      exitCode: 0,
      outText: "Error: timed out waiting for response",
      errText: "",
    });
    expect(r.status).toBe("quota-exhausted");
    expect(r.silentStall).toBe(false);
  });

  it("the print-timeout sentinel is cooldown-worthy even when the process was killed", () => {
    // --print-timeout and the spawn wall-timeout can race; either way the sentinel
    // means agy gave up without a review and must not be retried next iteration.
    const r = classifyAgyOutcome({
      killedByTimeout: true,
      killedByWatchdog: false,
      exitCode: -1,
      outText: "Error: timed out waiting for response",
      errText: "",
    });
    expect(r.status).toBe("quota-exhausted");
    expect(r.silentStall).toBe(false);
  });

  it("isAgyPrintTimeout matches the sentinel but not a real review mentioning timeouts", () => {
    expect(isAgyPrintTimeout("Error: timed out waiting for response")).toBe(true);
    expect(isAgyPrintTimeout("  Error: timed out waiting for response\n")).toBe(true);
    // A genuine review (even one whose findings discuss timeouts) must NOT match —
    // the sentinel only counts when it is what agy printed INSTEAD of a review.
    expect(
      isAgyPrintTimeout(
        '{"verdict":"FAIL","findings":[{"message":"request can time out waiting for response"}]}',
      ),
    ).toBe(false);
    // Agentic chatter prefixing a real review (agy sometimes does this) is a success.
    expect(
      isAgyPrintTimeout('No tool call. Waiting for ESLint task to finish. {"verdict":"PASS"}'),
    ).toBe(false);
  });
});
