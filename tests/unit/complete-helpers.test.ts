// tests/unit/complete-helpers.test.ts
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMPLETE_TIMEOUT_MS, failureReason } from "../../src/providers/complete-helpers.ts";

describe("COMPLETE_TIMEOUT_MS (single-sourced, F-069)", () => {
  it("is the shared 20s judge/complete() default", () => {
    expect(COMPLETE_TIMEOUT_MS).toBe(20_000);
  });

  it("is no longer re-declared as a module-local const in any adapter", () => {
    // The whole point of F-069: edit the value in one place. A re-declared
    // `const COMPLETE_TIMEOUT_MS = …` in an adapter would silently shadow the
    // shared import and drift.
    for (const adapter of ["codex.ts", "claude.ts", "gemini.ts", "opencode.ts"]) {
      const src = readFileSync(join(process.cwd(), "src/providers", adapter), "utf8");
      expect(src).not.toMatch(/const\s+COMPLETE_TIMEOUT_MS\s*=/);
      // …and each still references the shared constant.
      expect(src).toContain("COMPLETE_TIMEOUT_MS");
    }
  });
});

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
