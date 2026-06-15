import { spawn } from "node:child_process";
import { platform } from "node:os";

// Bound every availability probe: a hung `sandbox-exec`/`bwrap` would otherwise
// hang the probe (and `reviewgate doctor`) forever. On timeout we kill the probe
// and treat the runtime as UNAVAILABLE (probe failed → fail-closed for strict).
const PROBE_TIMEOUT_MS = 5_000;

let cached: boolean | null = null;

export function sandboxExecAvailable(): Promise<boolean> {
  if (cached !== null) return Promise.resolve(cached);
  if (platform() !== "darwin") {
    cached = false;
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    const child = spawn("sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cached = ok;
      resolve(ok);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      finish(false);
    }, PROBE_TIMEOUT_MS);
    if (typeof timer.unref === "function") timer.unref();
    child.on("exit", (code) => finish(code === 0));
    child.on("error", () => finish(false));
  });
}

export function __resetSandboxExecCache(): void {
  cached = null;
}

let bwrapCached: boolean | null = null;

// True when `bwrap` can actually build a namespace with the SAME flags production
// uses (so a probe-pass / production-fail mismatch can't happen). Linux only;
// memoized. Deliberately NO `--uid 0` (production runs as the mapped real user).
// A locked-down host (Ubuntu 24.04 unprivileged-userns AppArmor restriction) makes
// the --unshare-* trip and this returns false -> strict fails closed.
export function bwrapAvailable(): Promise<boolean> {
  if (bwrapCached !== null) return Promise.resolve(bwrapCached);
  if (platform() !== "linux") {
    bwrapCached = false;
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    const child = spawn(
      "bwrap",
      [
        "--unshare-user",
        "--unshare-pid",
        "--ro-bind",
        "/",
        "/",
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        "--",
        "true",
      ],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      bwrapCached = ok;
      resolve(ok);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      finish(false);
    }, PROBE_TIMEOUT_MS);
    if (typeof timer.unref === "function") timer.unref();
    child.on("exit", (code) => finish(code === 0));
    child.on("error", () => finish(false));
  });
}

// The single availability entry point used by spawnSafely AND doctor, so they agree.
export function sandboxRuntimeAvailable(): Promise<boolean> {
  const plat = platform();
  if (plat === "darwin") return sandboxExecAvailable();
  if (plat === "linux") return bwrapAvailable();
  return Promise.resolve(false);
}

// Test-only: reset the bwrap memo so a test can re-probe.
export function __resetBwrapCache(): void {
  bwrapCached = null;
}
