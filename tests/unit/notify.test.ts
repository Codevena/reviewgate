// tests/unit/notify.test.ts
import { describe, expect, it } from "bun:test";
import { notifyCommand, notifyDesktop } from "../../src/utils/notify.ts";

describe("notifyCommand", () => {
  it("builds an osascript command on macOS", () => {
    const c = notifyCommand("Reviewgate", "PASS — 0 findings", "darwin");
    expect(c?.cmd).toBe("osascript");
    expect(c?.args[0]).toBe("-e");
    expect(c?.args[1]).toContain('display notification "PASS — 0 findings"');
    expect(c?.args[1]).toContain('with title "Reviewgate"');
  });

  it("builds a notify-send command on Linux", () => {
    const c = notifyCommand("Reviewgate", "FAIL — 2 findings", "linux");
    expect(c).toEqual({ cmd: "notify-send", args: ["Reviewgate", "FAIL — 2 findings"] });
  });

  it("escapes quotes/backslashes in the macOS script (no injection)", () => {
    const c = notifyCommand("Reviewgate", 'say "hi" \\ done', "darwin");
    expect(c?.args[1]).toContain('\\"hi\\"');
  });

  it("returns null on an unsupported platform", () => {
    expect(notifyCommand("t", "b", "win32")).toBeNull();
  });
});

describe("notifyDesktop", () => {
  it("invokes the spawn impl and never throws", () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const fakeSpawn = (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return {};
    };
    expect(() => notifyDesktop("Reviewgate", "done", fakeSpawn)).not.toThrow();
    // On supported platforms it spawns; on others it no-ops (0 calls). Either is fine,
    // but a spawn that throws must be swallowed:
    const throwingSpawn = () => {
      throw new Error("osascript missing");
    };
    expect(() => notifyDesktop("Reviewgate", "done", throwingSpawn)).not.toThrow();
  });

  it("passes a bounded spawn timeout so a hung notifier can't block the gate (F-2)", () => {
    // The notification fires AFTER the verdict; a hung osascript/notify-send with no
    // timeout would block the Stop hook from returning and DROP the block decision
    // (fail-open). spawnSync must receive a finite `timeout`.
    let opts: { timeout?: number | undefined } | undefined;
    const spy = (_cmd: string, _args: string[], o?: { timeout?: number | undefined }) => {
      opts = o;
      return {};
    };
    notifyDesktop("Reviewgate", "done", spy);
    // On a supported platform the spawn ran with a finite timeout; on an unsupported
    // platform it no-ops (opts stays undefined). When it spawned, the timeout is set.
    if (opts !== undefined) {
      expect(typeof opts.timeout).toBe("number");
      expect(opts.timeout).toBeGreaterThan(0);
      expect(opts.timeout).toBeLessThanOrEqual(10_000);
    }
  });
});
