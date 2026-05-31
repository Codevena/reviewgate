// tests/unit/hook-stdin.test.ts
import { describe, expect, it } from "bun:test";
import { readHookStdin } from "../../src/cli/hook-stdin.ts";

describe("readHookStdin", () => {
  it("returns '' WITHOUT reading stdin when stdin is a TTY (interactive)", async () => {
    // Bug: `reviewgate gate --hook reset` typed in a terminal hung forever because
    // the CLI did `await Bun.stdin.text()` for every hook, blocking on a TTY that
    // never sends EOF. On a TTY there is no piped hook payload, so never read.
    let readCalled = false;
    const out = await readHookStdin({
      isTTY: true,
      read: async () => {
        readCalled = true;
        return "should not be read";
      },
    });
    expect(out).toBe("");
    expect(readCalled).toBe(false);
  });

  it("reads stdin when it is NOT a TTY (the real hook path: payload piped in)", async () => {
    const out = await readHookStdin({
      isTTY: false,
      read: async () => '{"stop_hook_active":true}',
    });
    expect(out).toBe('{"stop_hook_active":true}');
  });

  it("returns '' if reading stdin throws (fail-safe)", async () => {
    const out = await readHookStdin({
      isTTY: false,
      read: async () => {
        throw new Error("stdin read failed");
      },
    });
    expect(out).toBe("");
  });
});
