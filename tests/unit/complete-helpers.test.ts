// tests/unit/complete-helpers.test.ts
import { describe, expect, it } from "bun:test";
import { failureReason } from "../../src/providers/complete-helpers.ts";

describe("failureReason", () => {
  it("reports 'timeout' when killedByTimeout (exitCode is uninformative -1)", () => {
    expect(failureReason({ killedByTimeout: true, killedByWatchdog: false, exitCode: -1 })).toBe(
      "timeout",
    );
  });

  it("reports 'watchdog-timeout' when killedByWatchdog", () => {
    expect(failureReason({ killedByTimeout: false, killedByWatchdog: true, exitCode: -1 })).toBe(
      "watchdog-timeout",
    );
  });

  it("reports the exit code for a plain non-zero exit", () => {
    expect(failureReason({ killedByTimeout: false, killedByWatchdog: false, exitCode: 7 })).toBe(
      "exit=7",
    );
  });

  it("prefers timeout over a non-zero exit code", () => {
    expect(failureReason({ killedByTimeout: true, killedByWatchdog: false, exitCode: 7 })).toBe(
      "timeout",
    );
  });
});
