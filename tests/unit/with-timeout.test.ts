// tests/unit/with-timeout.test.ts
// Finding 5: withTimeout must (a) still reject on timeout with the legacy API,
// (b) optionally cancel the underlying op via an AbortController, and (c) swallow
// a LATE rejection from the abandoned promise so it never becomes an
// unhandledRejection (a fail-open hazard).
import { describe, expect, it } from "bun:test";
import { withTimeout } from "../../src/utils/with-timeout.ts";

const never = <T = never>() => new Promise<T>(() => {});

describe("withTimeout", () => {
  it("resolves with the value when the promise wins the race (legacy 3-arg API)", async () => {
    await expect(withTimeout(Promise.resolve(42), 1000, "op")).resolves.toBe(42);
  });

  it("rejects with '<label> timeout' when the timeout wins", async () => {
    await expect(withTimeout(never<number>(), 20, "dns")).rejects.toThrow("dns timeout");
  });

  it("aborts the supplied AbortController on timeout (opt-in cancellation)", async () => {
    const controller = new AbortController();
    let aborted = false;
    controller.signal.addEventListener("abort", () => {
      aborted = true;
    });
    // The wrapped op observes the same signal it would normally thread into fetch/DNS.
    const op = new Promise<number>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => reject(new Error("aborted by signal")));
    });
    await expect(withTimeout(op, 20, "fetch", { controller })).rejects.toThrow("fetch timeout");
    expect(aborted).toBe(true);
    expect(controller.signal.aborted).toBe(true);
  });

  it("does NOT abort when no controller is passed (backward compatible)", async () => {
    // The op runs to completion in the background; we just don't wait for it.
    await expect(withTimeout(never<number>(), 20, "noctl")).rejects.toThrow("noctl timeout");
    // No throw / no controller required — the legacy abandon-only behavior holds.
  });

  it("a late rejection from the abandoned promise does not surface as unhandledRejection", async () => {
    let unhandled: unknown;
    const onUnhandled = (e: unknown) => {
      unhandled = e;
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      // The op rejects AFTER the timeout already won the race.
      const op = new Promise<number>((_r, reject) => {
        setTimeout(() => reject(new Error("late failure from abandoned op")), 40);
      });
      await expect(withTimeout(op, 10, "late")).rejects.toThrow("late timeout");
      // Give the abandoned op time to reject, plus a microtask drain.
      await new Promise((r) => setTimeout(r, 80));
      await Promise.resolve();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toBeUndefined();
  });
});
