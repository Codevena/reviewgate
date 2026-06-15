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

  it("is BOUNDED by a timeout: a pipe that never sends EOF resolves to '' (gate proceeds)", async () => {
    // Bug: a connected-but-never-closing stdin pipe (a wedged parent / kept-open fd)
    // would hang readHookStdin forever BEFORE any review budget, until the OS Stop-
    // hook timeout kills the process with empty stdout = fail-OPEN. The diff comes
    // from dirty.flag on disk, so on timeout we return "" and let the gate run.
    const start = Date.now();
    const out = await readHookStdin({
      isTTY: false,
      // Never resolves — models a pipe with no EOF.
      read: () => new Promise<string>(() => {}),
      timeoutMs: 50,
    });
    expect(out).toBe("");
    // Must have returned via the timeout (fast), not hung.
    expect(Date.now() - start).toBeLessThan(2_000);
  });
});
